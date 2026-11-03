// Clipcy: a Maccy-like clipboard history manager for GNOME Shell.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {History, ItemType, bytesHash, textHash} from './history.js';
import {ClipcyPopup} from './popup.js';

const TEXT_MIMETYPES = ['text/plain;charset=utf-8', 'UTF8_STRING', 'text/plain', 'STRING', 'TEXT'];
const PASSWORD_HINT_MIMETYPE = 'x-kde-passwordManagerHint';
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const PASTE_DELAY_MS = 120;
// The popup shortcut may be set to the chord we synthesize (e.g. Ctrl+Shift+V),
// so it stays unbound until the synthetic keys have been processed.
const REBIND_DELAY_MS = 300;

const ClipcyIndicator = GObject.registerClass(
class ClipcyIndicator extends PanelMenu.Button {
    _init(onClick) {
        super._init(0.0, 'Clipcy', true);
        this._icon = new St.Icon({icon_name: 'edit-paste-symbolic', style_class: 'system-status-icon'});
        this.add_child(this._icon);
        const click = new Clutter.ClickGesture();
        click.set_recognize_on_press(true);
        click.connect('recognize', () => onClick(this));
        this.add_action(click);
    }

    setPaused(paused) {
        this._icon.opacity = paused ? 110 : 255;
    }
});

export default class ClipcyExtension extends Extension {
    enable() {
        this.settings = this.getSettings();
        this.history = new History(GLib.build_filenamev([GLib.get_user_data_dir(), 'clipcy']), {
            maxSize: this.settings.get_int('history-size'),
            sortBy: this.settings.get_string('sort-by'),
            pinPosition: this.settings.get_string('pin-position'),
        });
        this.history.load();
        this.history.onChanged = () => this._popup?.refreshIfOpen();

        this._clipboard = St.Clipboard.get_default();
        this._selfHash = null;
        this._pasteTimeoutId = 0;
        this._rebindTimeoutId = 0;
        this._popup = new ClipcyPopup(this);

        this.settings.connectObject(
            'changed::history-size', () => this.history.setMaxSize(this.settings.get_int('history-size')),
            'changed::sort-by', () => {
                this.history.sortBy = this.settings.get_string('sort-by');
            },
            'changed::pin-position', () => {
                this.history.pinPosition = this.settings.get_string('pin-position');
            },
            'changed::show-panel-icon', () => this._syncIndicator(),
            'changed::paused', () => this._indicator?.setPaused(this.settings.get_boolean('paused')),
            this);
        this._syncIndicator();

        this._bindShortcut();

        global.display.get_selection().connectObject('owner-changed',
            (_sel, type, source) => this._onOwnerChanged(type, source), this);
    }

    disable() {
        global.display.get_selection().disconnectObject(this);
        this._unbindShortcut();
        this.settings.disconnectObject(this);
        if (this._pasteTimeoutId) {
            GLib.source_remove(this._pasteTimeoutId);
            this._pasteTimeoutId = 0;
        }
        if (this._rebindTimeoutId) {
            GLib.source_remove(this._rebindTimeoutId);
            this._rebindTimeoutId = 0;
        }
        this._popup.destroy();
        this._popup = null;
        this._indicator?.destroy();
        this._indicator = null;
        this._virtualKeyboard = null;
        this.history.destroy();
        this.history = null;
        this._clipboard = null;
        this.settings = null;
    }

    _bindShortcut() {
        if (this._shortcutBound)
            return;
        Main.wm.addKeybinding('popup-shortcut', this.settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._popup.toggle(this.settings.get_string('popup-position'), this._indicator));
        this._shortcutBound = true;
    }

    _unbindShortcut() {
        if (!this._shortcutBound)
            return;
        Main.wm.removeKeybinding('popup-shortcut');
        this._shortcutBound = false;
    }

    _syncIndicator() {
        const show = this.settings.get_boolean('show-panel-icon');
        if (show && !this._indicator) {
            this._indicator = new ClipcyIndicator(
                anchor => this._popup.toggle('panel', anchor));
            this._indicator.setPaused(this.settings.get_boolean('paused'));
            Main.panel.addToStatusArea(this.uuid, this._indicator);
        } else if (!show && this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }

    setPaused(paused) {
        this.settings.set_boolean('paused', paused);
    }

    // --- capture --------------------------------------------------------

    _focusedApp() {
        const win = global.display.focus_window;
        if (!win)
            return {ids: [], name: ''};
        const ids = [win.get_wm_class(), win.get_wm_class_instance(),
            win.get_gtk_application_id(), win.get_sandboxed_app_id()].filter(Boolean);
        const app = Shell.WindowTracker.get_default().get_window_app(win);
        return {ids, name: app?.get_name() ?? ids[0] ?? ''};
    }

    _isIgnoredApp(ids) {
        const ignored = this.settings.get_strv('ignored-apps').map(s => s.toLowerCase());
        return ids.some(id => ignored.includes(id.toLowerCase()));
    }

    _isIgnoredText(text) {
        for (const pattern of this.settings.get_strv('ignored-patterns')) {
            try {
                if (new RegExp(pattern).test(text))
                    return true;
            } catch {
                // Invalid patterns are ignored rather than breaking capture.
            }
        }
        return false;
    }

    _onOwnerChanged(type, source) {
        if (type !== Meta.SelectionType.SELECTION_CLIPBOARD || !source)
            return;
        if (this.settings.get_boolean('paused'))
            return;
        const app = this._focusedApp();
        if (this._isIgnoredApp(app.ids))
            return;

        const mimetypes = this._clipboard.get_mimetypes(St.ClipboardType.CLIPBOARD);
        if (this.settings.get_boolean('ignore-password-managers') &&
            mimetypes.includes(PASSWORD_HINT_MIMETYPE))
            return;

        if (TEXT_MIMETYPES.some(m => mimetypes.includes(m))) {
            this._clipboard.get_text(St.ClipboardType.CLIPBOARD, (_c, text) => {
                if (!text || !this.history)
                    return;
                if (this._consumeSelfHash(textHash(text)) || this._isIgnoredText(text))
                    return;
                this.history.addText(text, app.name);
            });
        } else if (mimetypes.includes('image/png') && this.settings.get_boolean('capture-images')) {
            this._clipboard.get_content(St.ClipboardType.CLIPBOARD, 'image/png', (_c, bytes) => {
                if (!bytes || !this.history || bytes.get_size() > MAX_IMAGE_BYTES)
                    return;
                if (this._consumeSelfHash(bytesHash(bytes)))
                    return;
                this.history.addImage(bytes, app.name);
            });
        }
    }

    /** True (once) if the clipboard change was caused by our own choose(). */
    _consumeSelfHash(hash) {
        if (this._selfHash !== hash)
            return false;
        this._selfHash = null;
        return true;
    }

    // --- selection / paste ------------------------------------------------

    choose(item, paste) {
        // While paused no capture runs to consume the marker, so don't set it.
        this._selfHash = this.settings.get_boolean('paused') ? null : item.hash;
        if (item.type === ItemType.IMAGE) {
            let bytes;
            try {
                const [, contents] = GLib.file_get_contents(this.history.imagePath(item));
                bytes = new GLib.Bytes(contents);
            } catch (e) {
                console.warn(`clipcy: image missing: ${e.message}`);
                this.history.remove(item.id);
                return;
            }
            this._clipboard.set_content(St.ClipboardType.CLIPBOARD, 'image/png', bytes);
            this.history.addImage(bytes, '');
        } else {
            this._clipboard.set_text(St.ClipboardType.CLIPBOARD, item.text);
            this.history.addText(item.text, '');
        }
        if (paste)
            this._schedulePaste();
    }

    _schedulePaste() {
        if (this._pasteTimeoutId)
            GLib.source_remove(this._pasteTimeoutId);
        // Give the compositor a moment to hand keyboard focus back to the window.
        this._pasteTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PASTE_DELAY_MS, () => {
            this._pasteTimeoutId = 0;
            this._sendPasteKeys();
            return GLib.SOURCE_REMOVE;
        });
    }

    _sendPasteKeys() {
        const win = global.display.focus_window;
        if (!win)
            return;
        const terminals = this.settings.get_strv('terminal-apps').map(s => s.toLowerCase());
        const isTerminal = [win.get_wm_class(), win.get_wm_class_instance(), win.get_gtk_application_id()]
            .filter(Boolean).some(id => terminals.includes(id.toLowerCase()));

        if (!this._virtualKeyboard) {
            const seat = global.stage.context.get_backend().get_default_seat();
            this._virtualKeyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        }
        const keys = isTerminal
            ? [Clutter.KEY_Control_L, Clutter.KEY_Shift_L, Clutter.KEY_v]
            : [Clutter.KEY_Control_L, Clutter.KEY_v];
        const vk = this._virtualKeyboard;
        const time = GLib.get_monotonic_time();
        this._unbindShortcut();
        if (this._rebindTimeoutId)
            GLib.source_remove(this._rebindTimeoutId);
        this._rebindTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REBIND_DELAY_MS, () => {
            this._rebindTimeoutId = 0;
            this._bindShortcut();
            return GLib.SOURCE_REMOVE;
        });
        for (const k of keys)
            vk.notify_keyval(time, k, Clutter.KeyState.PRESSED);
        for (const k of [...keys].reverse())
            vk.notify_keyval(time, k, Clutter.KeyState.RELEASED);
    }
}
