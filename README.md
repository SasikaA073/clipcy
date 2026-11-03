# Clipcy — Maccy-style clipboard history for Ubuntu (GNOME)

A GNOME Shell extension that recreates [Maccy](https://maccy.app/)'s workflow:
press a shortcut, type to search, hit Enter to paste.

**Why an extension and not a standalone app?** Ubuntu 26.04 runs GNOME 50 on
Wayland only. On Wayland, a normal app can't read the clipboard in the
background or register a global hotkey, and Mutter has no `wlr-data-control`.
Code that runs inside GNOME Shell can do both.

## Install

```bash
./install.sh
```

Then log out and back in (Wayland can't reload the shell), and run:

```bash
gnome-extensions enable clipcy@sasikaa073.github.io
```

After an update, run `./install.sh` again and log out/in.

## Usage

| Key | Action |
|---|---|
| `Ctrl+Shift+V` | Open the popup (configurable) |
| type | Filter history |
| `↑` `↓` / `Ctrl+N` `Ctrl+P` / `Ctrl+J` `Ctrl+K` | Move the selection |
| `PgUp` `PgDn` | Move 10 rows |
| `Enter` | Paste into the focused window (or only copy, if "Paste automatically" is off) |
| `Alt+Enter` / `Alt+click` | The opposite action (copy only, or paste) |
| `Ctrl+1` … `Ctrl+9` | Pick row 1–9 |
| `Alt+P` | Pin or unpin |
| `Alt+Delete` / `Alt+Backspace` / `Ctrl+Delete` | Delete the item |
| `Esc` | Clear the search, then close |
| `Ctrl+,` | Preferences |

The top bar icon opens the same popup and dims while recording is paused.
The footer has Clear (keeps pinned items), Clear all, and Pause/Resume.

## Features compared with Maccy

| Maccy | Clipcy |
|---|---|
| Global hotkey, popup at the cursor | ✅ Cursor, screen centre, or under the top bar icon |
| Search: exact, fuzzy, regexp, mixed | ✅ With match highlighting |
| Pinned items | ✅ Shown at top or bottom; never trimmed |
| Paste automatically | ✅ Uses `Ctrl+V`, or `Ctrl+Shift+V` for terminals in the list |
| Images | ✅ PNG, up to 20 MB each |
| Ignore apps, ignore regex patterns | ✅ |
| Ignore password managers (concealed type) | ✅ Uses `x-kde-passwordManagerHint` (KeePassXC and others) |
| Sort by last copied, first copied, or copy count | ✅ |
| Preview with app, copy count, and timestamps | ✅ |
| Pause | ✅ |
| Files (Finder copy) | ⚠️ Saved as text (the file URIs), not as files |
| Rich text / HTML | ⚠️ Plain text only |
| Paste without formatting | Always plain text |

## Data and privacy

- History is stored in `~/.local/share/clipcy/history.json`, and images in
  `~/.local/share/clipcy/images/`. Files are mode `0600`. They are **not
  encrypted**.
- The popup doesn't run on the lock screen; extensions are disabled there.
- Nothing is sent over the network.

## Development

```bash
gjs -m tests/history.test.js
```

```bash
gjs -m tests/util.test.js
```

`history.js` and `util.js` depend only on GLib, so they can be tested
outside the shell. To run the full extension in a sandboxed nested shell
instead of your real session:

```bash
sudo apt install mutter-dev-bin
```

```bash
dbus-run-session gnome-shell --devkit --wayland
```

Logs: `journalctl --user -f -o cat /usr/bin/gnome-shell | grep -i clipcy`

## Manual test checklist (not yet run in a live shell)

1. Copy text in three apps → `Ctrl+Shift+V` → newest first; the preview shows the app name.
2. Copy the same text twice → one entry, "Copied 2×".
3. Type part of a string → results filter and the match is bold; switch to
   fuzzy/regexp in Preferences and repeat.
4. Enter in a text editor → pastes. Enter in GNOME Terminal/Ptyxis → pastes
   (`Ctrl+Shift+V`). Alt+Enter → copies only.
5. Alt+P on an item → it moves to the top with a pin. Set history size to 1,
   copy more → the pinned item survives.
6. Copy a password from KeePassXC → not recorded.
7. Screenshot to clipboard (`Ctrl+PrtSc`) → an image row with a thumbnail;
   Enter pastes it into an image editor or chat.
8. Pause → copies are not recorded and the icon dims.
9. Log out/in → history is still there.
10. Disable the extension → icon and shortcut gone; no errors in the journal.

## Known limitations / risks

- The default shortcut `Ctrl+Shift+V` is taken over everywhere, so it no
  longer pastes directly in terminals, or as "paste as plain text" in browsers
  and editors. Use the popup instead (`Ctrl+Shift+V`, then `Enter` pastes the
  latest item). Clipcy unbinds the shortcut for 300 ms while it sends its own
  paste keys, so terminal auto-paste still works. Pick another shortcut in
  Preferences if you need the original behaviour.

- Only tested against GNOME Shell **50**'s APIs (`shell-version: ["50"]`).
  Older GNOME versions need API changes (`St.BoxLayout.orientation`,
  `Clutter.ClickGesture`, and others).
- Auto-paste sends synthetic keys about 120 ms after the popup closes. Apps
  that use an unusual paste shortcut need to be added to the terminal list,
  or you can use copy mode.
- Apps that don't set the password-manager hint (some browser password
  managers) will be recorded unless you add them to the ignored apps or
  patterns.
- Very large text items are kept in full in memory and in the JSON file.

## License

MIT — see [LICENSE](LICENSE).
