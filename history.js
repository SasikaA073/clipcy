// Clipboard history model: storage, de-duplication, ordering and search.
// Only depends on GLib/Gio so it can be unit-tested with plain `gjs -m`.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const FILE_VERSION = 1;
const SAVE_DELAY_MS = 1000;

export const ItemType = Object.freeze({TEXT: 'text', IMAGE: 'image'});

export function textHash(text) {
    return GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, text, -1);
}

export function bytesHash(bytes) {
    return GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, bytes);
}

export class History {
    /**
     * @param {string} dataDir directory for history.json and image files
     * @param {object} options
     * @param {number} options.maxSize max number of unpinned items kept
     * @param {string} options.sortBy 'lastCopied' | 'firstCopied' | 'copyCount'
     * @param {string} options.pinPosition 'top' | 'bottom'
     */
    constructor(dataDir, options = {}) {
        this._dataDir = dataDir;
        this._file = GLib.build_filenamev([dataDir, 'history.json']);
        this._imageDir = GLib.build_filenamev([dataDir, 'images']);
        this._items = [];
        this._nextId = 1;
        this._saveId = 0;
        this.maxSize = options.maxSize ?? 200;
        this.sortBy = options.sortBy ?? 'lastCopied';
        this.pinPosition = options.pinPosition ?? 'top';
        this.onChanged = null;
    }

    load() {
        GLib.mkdir_with_parents(this._imageDir, 0o700);
        try {
            const [ok, contents] = GLib.file_get_contents(this._file);
            if (!ok)
                return;
            const data = JSON.parse(new TextDecoder().decode(contents));
            if (data.version !== FILE_VERSION || !Array.isArray(data.items))
                return;
            this._items = data.items.filter(i =>
                i.type === ItemType.TEXT ||
                (i.type === ItemType.IMAGE && GLib.file_test(this.imagePath(i), GLib.FileTest.EXISTS)));
            this._nextId = Math.max(0, ...this._items.map(i => i.id)) + 1;
        } catch (e) {
            if (!(e instanceof GLib.Error && e.matches(GLib.FileError, GLib.FileError.NOENT)))
                console.warn(`clipcy: could not load history: ${e.message}`);
        }
    }

    saveNow() {
        if (this._saveId) {
            GLib.source_remove(this._saveId);
            this._saveId = 0;
        }
        GLib.mkdir_with_parents(this._dataDir, 0o700);
        const json = JSON.stringify({version: FILE_VERSION, items: this._items});
        GLib.file_set_contents(this._file, json);
        // History can hold sensitive data; keep it private to the user.
        GLib.chmod(this._file, 0o600);
    }

    _scheduleSave() {
        if (this._saveId)
            return;
        this._saveId = GLib.timeout_add(GLib.PRIORITY_LOW, SAVE_DELAY_MS, () => {
            this._saveId = 0;
            try {
                this.saveNow();
            } catch (e) {
                console.warn(`clipcy: could not save history: ${e.message}`);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _changed() {
        this._scheduleSave();
        this.onChanged?.();
    }

    destroy() {
        if (this._saveId)
            this.saveNow();
        this.onChanged = null;
    }

    imagePath(item) {
        return GLib.build_filenamev([this._imageDir, `${item.hash}.png`]);
    }

    /** Items in display order: pinned block + unpinned block. */
    get items() {
        const cmp = {
            lastCopied: (a, b) => b.lastCopied - a.lastCopied || b.id - a.id,
            firstCopied: (a, b) => b.firstCopied - a.firstCopied || b.id - a.id,
            copyCount: (a, b) => b.count - a.count || b.lastCopied - a.lastCopied,
        }[this.sortBy] ?? ((a, b) => b.lastCopied - a.lastCopied);
        const pinned = this._items.filter(i => i.pinned).sort((a, b) => a.pinnedAt - b.pinnedAt);
        const rest = this._items.filter(i => !i.pinned).sort(cmp);
        return this.pinPosition === 'bottom' ? [...rest, ...pinned] : [...pinned, ...rest];
    }

    get length() {
        return this._items.length;
    }

    getById(id) {
        return this._items.find(i => i.id === id) ?? null;
    }

    _upsert(type, hash, fields, app, now) {
        let item = this._items.find(i => i.type === type && i.hash === hash);
        if (item) {
            item.count += 1;
            item.lastCopied = now;
            if (app)
                item.app = app;
        } else {
            item = {
                id: this._nextId++, type, hash, ...fields,
                pinned: false, pinnedAt: 0, count: 1,
                firstCopied: now, lastCopied: now, app: app ?? '',
            };
            this._items.push(item);
            this._trim();
        }
        this._changed();
        return item;
    }

    addText(text, app = '', now = Date.now()) {
        if (!text || !text.trim())
            return null;
        return this._upsert(ItemType.TEXT, textHash(text), {text}, app, now);
    }

    /** @param {GLib.Bytes} bytes PNG data */
    addImage(bytes, app = '', now = Date.now()) {
        if (!bytes || bytes.get_size() === 0)
            return null;
        const hash = bytesHash(bytes);
        const item = {hash};
        const path = this.imagePath(item);
        if (!GLib.file_test(path, GLib.FileTest.EXISTS)) {
            GLib.mkdir_with_parents(this._imageDir, 0o700);
            GLib.file_set_contents(path, bytes.toArray());
            GLib.chmod(path, 0o600);
        }
        return this._upsert(ItemType.IMAGE, hash, {text: ''}, app, now);
    }

    _trim() {
        const unpinned = this._items.filter(i => !i.pinned)
            .sort((a, b) => b.lastCopied - a.lastCopied || b.id - a.id);
        for (const old of unpinned.slice(Math.max(0, this.maxSize)))
            this._remove(old);
    }

    setMaxSize(n) {
        this.maxSize = n;
        this._trim();
        this._changed();
    }

    _remove(item) {
        const idx = this._items.indexOf(item);
        if (idx < 0)
            return;
        this._items.splice(idx, 1);
        if (item.type === ItemType.IMAGE &&
            !this._items.some(i => i.type === ItemType.IMAGE && i.hash === item.hash)) {
            try {
                Gio.File.new_for_path(this.imagePath(item)).delete(null);
            } catch {}
        }
    }

    remove(id) {
        const item = this.getById(id);
        if (!item)
            return;
        this._remove(item);
        this._changed();
    }

    togglePin(id) {
        const item = this.getById(id);
        if (!item)
            return;
        item.pinned = !item.pinned;
        item.pinnedAt = item.pinned ? Date.now() : 0;
        this._trim();
        this._changed();
    }

    /** @param {boolean} includePinned also wipe pinned items */
    clear(includePinned = false) {
        for (const item of [...this._items]) {
            if (includePinned || !item.pinned)
                this._remove(item);
        }
        this._changed();
    }

    /**
     * Filter + rank items.
     * @returns {Array<{item, ranges: Array<[number, number]>}>} ranges are
     *   [start, end) character offsets into item.text to highlight.
     */
    search(query, mode = 'exact') {
        const items = this.items;
        if (!query)
            return items.map(item => ({item, ranges: []}));
        const results = [];
        for (const item of items) {
            if (item.type !== ItemType.TEXT)
                continue;
            const m = matchText(item.text, query, mode);
            if (m)
                results.push({item, ranges: m.ranges, score: m.score});
        }
        if (mode === 'fuzzy' || mode === 'mixed')
            results.sort((a, b) => b.score - a.score);
        return results;
    }
}

function exactMatch(text, query) {
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    return idx < 0 ? null : {ranges: [[idx, idx + query.length]], score: 3000 - idx};
}

function regexpMatch(text, query) {
    let re;
    try {
        re = new RegExp(query, 'i');
    } catch {
        return null;
    }
    const m = re.exec(text);
    if (!m || m[0].length === 0)
        return m ? {ranges: [], score: 2000} : null;
    return {ranges: [[m.index, m.index + m[0].length]], score: 2000 - m.index};
}

// Subsequence match: every query char must appear in order. Rewards
// consecutive runs and matches at word starts, penalises gaps.
function fuzzyMatch(text, query) {
    const t = text.toLowerCase();
    const q = query.toLowerCase().replace(/\s+/g, '');
    if (!q)
        return {ranges: [], score: 0};
    const ranges = [];
    let score = 0, ti = 0, prev = -2;
    for (const ch of q) {
        const found = t.indexOf(ch, ti);
        if (found < 0)
            return null;
        if (found === prev + 1) {
            score += 5;
            ranges[ranges.length - 1][1] = found + 1;
        } else {
            ranges.push([found, found + 1]);
            score -= Math.min(found - ti, 10);
        }
        if (found === 0 || /[\s\-_./:]/.test(t[found - 1]))
            score += 3;
        prev = found;
        ti = found + 1;
    }
    return {ranges, score: 1000 + score};
}

export function matchText(text, query, mode) {
    switch (mode) {
    case 'regexp':
        return regexpMatch(text, query);
    case 'fuzzy':
        return fuzzyMatch(text, query);
    case 'mixed':
        // Same idea as Maccy's "mixed": exact first, then regexp, then fuzzy.
        return exactMatch(text, query) ?? regexpMatch(text, query) ?? fuzzyMatch(text, query);
    default:
        return exactMatch(text, query);
    }
}
