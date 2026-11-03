#!/usr/bin/env bash
# Install (or update) Clipcy into the current user's GNOME Shell extensions.
set -euo pipefail

cd "$(dirname "$0")"
UUID=$(python3 -c 'import json; print(json.load(open("metadata.json"))["uuid"])')
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

glib-compile-schemas --strict schemas
mkdir -p "$DEST/schemas"
cp metadata.json extension.js history.js popup.js prefs.js util.js stylesheet.css "$DEST/"
cp schemas/*.gschema.xml schemas/gschemas.compiled "$DEST/schemas/"

echo "Installed to $DEST"
if gnome-extensions info "$UUID" >/dev/null 2>&1; then
    gnome-extensions enable "$UUID"
    echo "Enabled. If you updated an already-running copy, log out and back in to reload it."
else
    echo "GNOME Shell has not seen the extension yet (Wayland can't reload the shell)."
    echo "Log out and back in, then run:  gnome-extensions enable $UUID"
fi
