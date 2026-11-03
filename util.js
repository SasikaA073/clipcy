// Text helpers shared by the popup; GLib-only so they can be unit-tested.

import GLib from 'gi://GLib';

/**
 * Single-line title with whitespace collapsed; characters inside `ranges`
 * (offsets into the original text) are rendered bold.
 */
export function titleMarkup(text, ranges, maxLen) {
    const inRange = i => ranges.some(([s, e]) => i >= s && i < e);
    let out = '', len = 0, bold = false, pendingSpace = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (/\s/.test(ch)) {
            pendingSpace = len > 0;
            continue;
        }
        if (len >= maxLen) {
            if (bold)
                out += '</b>';
            return `${out}…`;
        }
        if (pendingSpace) {
            if (bold) {
                out += '</b>';
                bold = false;
            }
            out += ' ';
            len++;
            pendingSpace = false;
        }
        const hl = inRange(i);
        if (hl !== bold) {
            out += hl ? '<b>' : '</b>';
            bold = hl;
        }
        out += GLib.markup_escape_text(ch, -1);
        len++;
    }
    return bold ? `${out}</b>` : out;
}
