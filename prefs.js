import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

function comboRow(settings, key, title, options) {
    const row = new Adw.ComboRow({
        title, model: Gtk.StringList.new(options.map(([, label]) => label)),
    });
    const sync = () => {
        row.selected = Math.max(0, options.findIndex(([nick]) => nick === settings.get_string(key)));
    };
    sync();
    settings.connect(`changed::${key}`, sync);
    row.connect('notify::selected', () => settings.set_string(key, options[row.selected][0]));
    return row;
}

function switchRow(settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function spinRow(settings, key, title, lower, upper, subtitle = '') {
    const row = Adw.SpinRow.new_with_range(lower, upper, 1);
    row.title = title;
    row.subtitle = subtitle;
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

/** Comma-separated editor for a string-array key. */
function listRow(settings, key, title) {
    const row = new Adw.EntryRow({title, show_apply_button: true});
    row.text = settings.get_strv(key).join(', ');
    row.connect('apply', () => {
        settings.set_strv(key, row.text.split(',').map(s => s.trim()).filter(Boolean));
    });
    return row;
}

/** One regex per line; invalid patterns are reported instead of saved. */
function patternsGroup(settings) {
    const group = new Adw.PreferencesGroup({
        title: 'Ignored patterns',
        description: 'Copied text matching any of these regular expressions (one per line) is not recorded.',
    });
    const buffer = new Gtk.TextBuffer({text: settings.get_strv('ignored-patterns').join('\n')});
    const view = new Gtk.TextView({
        buffer, monospace: true, top_margin: 8, bottom_margin: 8, left_margin: 8, right_margin: 8,
    });
    const frame = new Gtk.Frame({child: view, height_request: 90});
    const status = new Gtk.Label({xalign: 0, css_classes: ['dim-label', 'caption']});
    const save = new Gtk.Button({label: 'Save patterns', halign: Gtk.Align.END, css_classes: ['suggested-action']});
    save.connect('clicked', () => {
        const lines = buffer.text.split('\n').map(s => s.trim()).filter(Boolean);
        const bad = lines.filter(l => {
            try {
                new RegExp(l);
                return false;
            } catch {
                return true;
            }
        });
        if (bad.length) {
            status.label = `Invalid: ${bad.join(', ')}`;
            return;
        }
        settings.set_strv('ignored-patterns', lines);
        status.label = `Saved ${lines.length} pattern(s).`;
    });
    const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6});
    box.append(frame);
    box.append(status);
    box.append(save);
    group.add(box);
    return group;
}

function shortcutRow(settings) {
    const row = new Adw.EntryRow({
        title: 'Open popup shortcut (e.g. <Control><Shift>v)', show_apply_button: true,
    });
    row.text = settings.get_strv('popup-shortcut')[0] ?? '';
    row.connect('apply', () => {
        const accel = row.text.trim();
        const [ok, key] = Gtk.accelerator_parse(accel);
        if (accel && (!ok || key === 0)) {
            row.add_css_class('error');
            return;
        }
        row.remove_css_class('error');
        settings.set_strv('popup-shortcut', accel ? [accel] : []);
    });
    return row;
}

export default class ClipcyPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(640, 760);

        const general = new Adw.PreferencesPage({title: 'General', icon_name: 'preferences-system-symbolic'});
        const behaviour = new Adw.PreferencesGroup({title: 'Behaviour'});
        behaviour.add(shortcutRow(settings));
        behaviour.add(switchRow(settings, 'paste-automatically', 'Paste automatically',
            'Enter pastes into the focused window. Alt+Enter only copies (inverted when off).'));
        behaviour.add(comboRow(settings, 'popup-position', 'Popup position', [
            ['cursor', 'At mouse cursor'], ['center', 'Screen center'], ['panel', 'Below top bar icon'],
        ]));
        behaviour.add(comboRow(settings, 'search-mode', 'Search mode', [
            ['exact', 'Exact'], ['fuzzy', 'Fuzzy'], ['regexp', 'Regular expression'],
            ['mixed', 'Mixed (exact → regexp → fuzzy)'],
        ]));
        behaviour.add(switchRow(settings, 'paused', 'Pause recording'));
        general.add(behaviour);

        const storage = new Adw.PreferencesGroup({title: 'Storage'});
        storage.add(spinRow(settings, 'history-size', 'History size', 1, 2000,
            'Unpinned items kept. Pinned items are never removed automatically.'));
        storage.add(switchRow(settings, 'capture-images', 'Save images'));
        general.add(storage);

        const appearance = new Adw.PreferencesPage({title: 'Appearance', icon_name: 'applications-graphics-symbolic'});
        const look = new Adw.PreferencesGroup();
        look.add(spinRow(settings, 'menu-size', 'Items shown in popup', 5, 200));
        look.add(spinRow(settings, 'title-length', 'Characters per row', 20, 200));
        look.add(comboRow(settings, 'sort-by', 'Sort by', [
            ['lastCopied', 'Last copied'], ['firstCopied', 'First copied'], ['copyCount', 'Number of copies'],
        ]));
        look.add(comboRow(settings, 'pin-position', 'Pinned items', [['top', 'Top'], ['bottom', 'Bottom']]));
        look.add(switchRow(settings, 'show-preview', 'Show preview'));
        look.add(switchRow(settings, 'show-panel-icon', 'Show top bar icon'));
        appearance.add(look);

        const privacy = new Adw.PreferencesPage({title: 'Ignore', icon_name: 'security-high-symbolic'});
        const apps = new Adw.PreferencesGroup({
            title: 'Applications',
            description: 'Window class / app ID, comma separated. Use Looking Glass (Alt+F2 → lg → Windows) to find a window class.',
        });
        apps.add(switchRow(settings, 'ignore-password-managers', 'Ignore password manager entries',
            'Skips copies flagged with x-kde-passwordManagerHint (KeePassXC and others).'));
        apps.add(listRow(settings, 'ignored-apps', 'Ignored applications'));
        apps.add(listRow(settings, 'terminal-apps', 'Terminals (paste with Ctrl+Shift+V)'));
        privacy.add(apps);
        privacy.add(patternsGroup(settings));

        window.add(general);
        window.add(appearance);
        window.add(privacy);
        window._settings = settings;
    }
}
