// The Maccy-style popup: search field, keyboard-driven list, preview, footer.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';

import {ItemType} from './history.js';
import {titleMarkup} from './util.js';

const PREVIEW_MAX_CHARS = 2000;
const VERTICAL = Clutter.Orientation.VERTICAL;

function modifiers(event) {
    return event.get_state() & (Clutter.ModifierType.CONTROL_MASK |
        Clutter.ModifierType.SHIFT_MASK | Clutter.ModifierType.MOD1_MASK);
}

function formatTime(ms) {
    return GLib.DateTime.new_from_unix_local(Math.floor(ms / 1000)).format('%Y-%m-%d %H:%M');
}

export class ClipcyPopup {
    /**
     * @param {object} ext the extension: history, settings, choose(item, paste),
     *   openPreferences(), setPaused(bool)
     */
    constructor(ext) {
        this._ext = ext;
        this._grab = null;
        this._rows = [];
        this._results = [];
        this._selected = -1;

        this.actor = new St.BoxLayout({
            style_class: 'clipcy-popup', orientation: VERTICAL, reactive: true, visible: false,
        });

        this._entry = new St.Entry({
            style_class: 'clipcy-search', hint_text: 'Type to search…',
            can_focus: true, x_expand: true,
        });
        this._entry.set_primary_icon(new St.Icon({
            icon_name: 'edit-find-symbolic', style_class: 'clipcy-search-icon',
        }));
        this._entry.clutter_text.connect('text-changed', () => this._refresh(0));
        this.actor.add_child(this._entry);

        this._list = new St.BoxLayout({orientation: VERTICAL, style_class: 'clipcy-list'});
        this._scroll = new St.ScrollView({
            style_class: 'clipcy-scroll', hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC, overlay_scrollbars: true,
            child: this._list,
        });
        this.actor.add_child(this._scroll);

        this._preview = new St.BoxLayout({orientation: VERTICAL, style_class: 'clipcy-preview'});
        this._previewText = new St.Label({style_class: 'clipcy-preview-text'});
        this._previewText.clutter_text.line_wrap = true;
        this._previewText.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        this._previewText.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._previewImage = new St.Icon({style_class: 'clipcy-preview-image', icon_size: 160});
        this._previewMeta = new St.Label({style_class: 'clipcy-preview-meta'});
        this._preview.add_child(this._previewText);
        this._preview.add_child(this._previewImage);
        this._preview.add_child(this._previewMeta);
        this.actor.add_child(this._preview);

        this.actor.add_child(this._buildFooter());

        this.actor.connect('captured-event', (_a, event) => this._onCapturedEvent(event));
        Main.layoutManager.uiGroup.add_child(this.actor);
    }

    _buildFooter() {
        const footer = new St.BoxLayout({style_class: 'clipcy-footer'});
        const button = (label, cb, tooltip) => {
            const b = new St.Button({label, style_class: 'clipcy-footer-button', can_focus: false});
            if (tooltip)
                b.accessible_name = tooltip;
            b.connect('clicked', cb);
            footer.add_child(b);
            return b;
        };
        button('Clear', () => this._ext.history.clear(false), 'Clear unpinned history');
        button('Clear all', () => this._ext.history.clear(true), 'Clear history including pinned');
        this._pauseButton = button('', () => {
            this._ext.setPaused(!this._ext.settings.get_boolean('paused'));
            this._syncPause();
        });
        footer.add_child(new St.Widget({x_expand: true}));
        this._hint = new St.Label({
            style_class: 'clipcy-hint', y_align: Clutter.ActorAlign.CENTER,
        });
        footer.add_child(this._hint);
        const prefs = new St.Button({
            style_class: 'clipcy-footer-button', can_focus: false,
            child: new St.Icon({icon_name: 'preferences-system-symbolic', icon_size: 14}),
        });
        prefs.connect('clicked', () => {
            this.close();
            this._ext.openPreferences();
        });
        footer.add_child(prefs);
        return footer;
    }

    _syncPause() {
        this._pauseButton.label = this._ext.settings.get_boolean('paused') ? 'Resume' : 'Pause';
    }

    get isOpen() {
        return this._grab !== null;
    }

    toggle(position, anchor) {
        if (this.isOpen)
            this.close();
        else
            this.open(position, anchor);
    }

    /**
     * @param {string} position 'cursor' | 'center' | 'panel'
     * @param {Clutter.Actor} [anchor] actor to open under for 'panel'
     */
    open(position, anchor) {
        if (this.isOpen)
            return;
        const s = this._ext.settings;
        this._preview.visible = s.get_boolean('show-preview');
        const paste = s.get_boolean('paste-automatically');
        this._hint.text = paste
            ? '↵ paste  Alt+↵ copy  Alt+P pin  Alt+⌫ delete'
            : '↵ copy  Alt+↵ paste  Alt+P pin  Alt+⌫ delete';
        this._syncPause();
        this._entry.text = '';
        this._refresh(0);

        this.actor.show();
        this._place(position, anchor);

        this._grab = Main.pushModal(this.actor, {actionMode: Shell.ActionMode.POPUP});
        this._entry.grab_key_focus();
    }

    close() {
        if (!this.isOpen)
            return;
        Main.popModal(this._grab);
        this._grab = null;
        this.actor.hide();
        this._clearRows();
    }

    _place(position, anchor) {
        let [px, py] = global.get_pointer();
        let monitorIndex = global.display.get_current_monitor();
        if (position === 'panel' && anchor) {
            const [ax, ay] = anchor.get_transformed_position();
            const [, ah] = anchor.get_transformed_size();
            px = ax;
            py = ay + ah;
            monitorIndex = Main.layoutManager.findIndexForActor(anchor);
        }
        const area = Main.layoutManager.getWorkAreaForMonitor(monitorIndex);
        const [, , natW, natH] = this.actor.get_preferred_size();

        let x, y;
        if (position === 'center') {
            x = area.x + (area.width - natW) / 2;
            y = area.y + (area.height - natH) / 3;
        } else {
            x = px;
            y = py;
        }
        x = Math.max(area.x, Math.min(x, area.x + area.width - natW));
        y = Math.max(area.y, Math.min(y, area.y + area.height - natH));
        this.actor.set_position(Math.round(x), Math.round(y));
    }

    /** Re-render the list (e.g. after history changed) if open. */
    refreshIfOpen() {
        if (!this.isOpen)
            return;
        const id = this._results[this._selected]?.item.id;
        this._refresh(this._selected);
        const idx = this._results.findIndex(r => r.item.id === id);
        if (idx >= 0)
            this._select(idx);
    }

    _clearRows() {
        this._list.destroy_all_children();
        this._rows = [];
        this._results = [];
        this._selected = -1;
    }

    _refresh(selectIndex) {
        const s = this._ext.settings;
        const query = this._entry.text;
        const all = this._ext.history.search(query, s.get_string('search-mode'));
        this._results = all.slice(0, s.get_int('menu-size'));
        const titleLength = s.get_int('title-length');

        this._list.destroy_all_children();
        // Rows appearing under a stationary pointer must not steal the selection.
        this._pointerMoved = false;
        this._rows = this._results.map((r, i) => this._buildRow(r, i, titleLength));
        if (this._rows.length === 0) {
            this._list.add_child(new St.Label({
                style_class: 'clipcy-empty',
                text: query ? 'No matches' : 'Clipboard history is empty',
            }));
        }
        this._selected = -1;
        this._select(Math.min(Math.max(selectIndex, 0), this._rows.length - 1));
    }

    _buildRow({item, ranges}, index, titleLength) {
        const row = new St.Button({
            style_class: 'clipcy-item', can_focus: false, x_expand: true,
            x_align: Clutter.ActorAlign.FILL, track_hover: true,
        });
        const box = new St.BoxLayout({x_expand: true});
        row.set_child(box);

        const pin = new St.Icon({
            icon_name: 'view-pin-symbolic', style_class: 'clipcy-pin', icon_size: 12,
            opacity: item.pinned ? 255 : 0, y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(pin);

        if (item.type === ItemType.IMAGE) {
            const file = Gio.File.new_for_path(this._ext.history.imagePath(item));
            box.add_child(new St.Icon({
                gicon: new Gio.FileIcon({file}), icon_size: 40, style_class: 'clipcy-thumb',
            }));
            box.add_child(new St.Label({
                text: 'Image', style_class: 'clipcy-title', y_align: Clutter.ActorAlign.CENTER,
            }));
        } else {
            const label = new St.Label({
                style_class: 'clipcy-title', x_expand: true, y_align: Clutter.ActorAlign.CENTER,
            });
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            label.clutter_text.set_markup(titleMarkup(item.text, ranges, titleLength));
            box.add_child(label);
        }
        box.add_child(new St.Widget({x_expand: true}));
        if (index < 9) {
            box.add_child(new St.Label({
                text: `Ctrl+${index + 1}`, style_class: 'clipcy-shortcut',
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }

        row.connect('notify::hover', () => {
            if (row.hover && this._pointerMoved)
                this._select(index, false);
        });
        row.connect('clicked', () => {
            const alt = (modifiers(Clutter.get_current_event()) & Clutter.ModifierType.MOD1_MASK) !== 0;
            this._choose(index, alt);
        });
        this._list.add_child(row);
        return row;
    }

    _select(index, scroll = true) {
        if (index === this._selected)
            return;
        this._rows[this._selected]?.remove_style_pseudo_class('selected');
        this._selected = index;
        const row = this._rows[index];
        if (row) {
            row.add_style_pseudo_class('selected');
            if (scroll)
                ensureActorVisibleInScrollView(this._scroll, row);
        }
        this._updatePreview();
    }

    _updatePreview() {
        if (!this._preview.visible)
            return;
        const item = this._results[this._selected]?.item;
        if (!item) {
            this._previewText.text = '';
            this._previewText.visible = true;
            this._previewImage.visible = false;
            this._previewMeta.text = '';
            return;
        }
        const isImage = item.type === ItemType.IMAGE;
        this._previewText.visible = !isImage;
        this._previewImage.visible = isImage;
        if (isImage) {
            this._previewImage.gicon = new Gio.FileIcon({
                file: Gio.File.new_for_path(this._ext.history.imagePath(item)),
            });
        } else {
            const t = item.text;
            this._previewText.text = t.length > PREVIEW_MAX_CHARS ? `${t.slice(0, PREVIEW_MAX_CHARS)}…` : t;
        }
        const parts = [];
        if (item.app)
            parts.push(item.app);
        parts.push(`Copied ${item.count}×`);
        parts.push(`Last ${formatTime(item.lastCopied)}`);
        if (item.count > 1)
            parts.push(`First ${formatTime(item.firstCopied)}`);
        if (!isImage)
            parts.push(`${item.text.length} chars`);
        this._previewMeta.text = parts.join('  ·  ');
    }

    _choose(index, invertPaste) {
        const result = this._results[index];
        if (!result)
            return;
        const paste = this._ext.settings.get_boolean('paste-automatically') !== invertPaste;
        this.close();
        this._ext.choose(result.item, paste);
    }

    _move(delta) {
        const n = this._rows.length;
        if (n === 0)
            return;
        this._select(((this._selected + delta) % n + n) % n);
    }

    _onCapturedEvent(event) {
        const type = event.type();
        if (type === Clutter.EventType.BUTTON_PRESS || type === Clutter.EventType.TOUCH_BEGIN) {
            if (!this.actor.contains(global.stage.get_event_actor(event))) {
                this.close();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }
        if (type === Clutter.EventType.MOTION) {
            this._pointerMoved = true;
            return Clutter.EVENT_PROPAGATE;
        }
        if (type !== Clutter.EventType.KEY_PRESS)
            return Clutter.EVENT_PROPAGATE;

        const sym = event.get_key_symbol();
        const mods = modifiers(event);
        const ctrl = mods === Clutter.ModifierType.CONTROL_MASK;
        const alt = mods === Clutter.ModifierType.MOD1_MASK;
        const selected = this._results[this._selected]?.item;

        switch (sym) {
        case Clutter.KEY_Escape:
            if (this._entry.text)
                this._entry.text = '';
            else
                this.close();
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Up:
        case Clutter.KEY_KP_Up:
            this._move(-1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Down:
        case Clutter.KEY_KP_Down:
            this._move(1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Page_Up:
            this._select(Math.max(0, this._selected - 10));
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Page_Down:
            this._select(Math.min(this._rows.length - 1, this._selected + 10));
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
        case Clutter.KEY_ISO_Enter:
            this._choose(this._selected, alt);
            return Clutter.EVENT_STOP;
        }

        if (ctrl && (sym === Clutter.KEY_n || sym === Clutter.KEY_j)) {
            this._move(1);
            return Clutter.EVENT_STOP;
        }
        if (ctrl && (sym === Clutter.KEY_p || sym === Clutter.KEY_k)) {
            this._move(-1);
            return Clutter.EVENT_STOP;
        }
        if (ctrl && sym >= Clutter.KEY_1 && sym <= Clutter.KEY_9) {
            this._choose(sym - Clutter.KEY_1, false);
            return Clutter.EVENT_STOP;
        }
        if (ctrl && sym === Clutter.KEY_comma) {
            this.close();
            this._ext.openPreferences();
            return Clutter.EVENT_STOP;
        }
        if (alt && (sym === Clutter.KEY_p || sym === Clutter.KEY_P) && selected) {
            this._ext.history.togglePin(selected.id);
            return Clutter.EVENT_STOP;
        }
        const deleteKey = (alt && (sym === Clutter.KEY_Delete || sym === Clutter.KEY_BackSpace)) ||
            (ctrl && sym === Clutter.KEY_Delete);
        if (deleteKey && selected) {
            this._ext.history.remove(selected.id);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    destroy() {
        this.close();
        this.actor.destroy();
    }
}
