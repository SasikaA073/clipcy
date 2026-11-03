// Run: gjs -m tests/history.test.js
import GLib from 'gi://GLib';
import {History, matchText} from '../history.js';

let failures = 0, passed = 0;
function check(name, cond) {
    if (cond) passed++; else { failures++; print(`FAIL: ${name}`); }
}

const dir = GLib.dir_make_tmp('clipcy-test-XXXXXX');
const h = new History(dir, {maxSize: 3});
h.load();

h.addText('alpha', 'app1', 1);
h.addText('beta', 'app1', 2);
h.addText('   ', 'app1', 3);
check('blank text ignored', h.length === 2);
h.addText('alpha', 'app2', 4);
check('dedupe keeps one copy', h.length === 2);
check('dedupe bumps to top', h.items[0].text === 'alpha');
check('dedupe counts copies', h.items[0].count === 2);
check('dedupe updates app', h.items[0].app === 'app2');

h.addText('gamma', '', 5);
h.addText('delta', '', 6);
check('trim to maxSize', h.length === 3 && !h.items.some(i => i.text === 'beta'));

const gamma = h.items.find(i => i.text === 'gamma');
h.togglePin(gamma.id);
h.addText('eps', '', 7);
h.addText('zeta', '', 8);
h.addText('eta', '', 9);
check('pinned survives trim', h.items.some(i => i.text === 'gamma'));
check('pinned at top', h.items[0].text === 'gamma');
check('unpinned limited to maxSize', h.items.filter(i => !i.pinned).length === 3);
h.pinPosition = 'bottom';
check('pinned at bottom', h.items.at(-1).text === 'gamma');
h.pinPosition = 'top';

h.sortBy = 'copyCount';
h.addText('eta', '', 10);
h.addText('eta', '', 11);
check('sort by copy count', h.items[1].text === 'eta');
h.sortBy = 'lastCopied';

check('exact search', h.search('ET', 'exact').map(r => r.item.text).join() === 'eta,zeta');
check('exact ranges', JSON.stringify(h.search('ta', 'exact')[0].ranges) === '[[1,3]]');
check('fuzzy match', matchText('hello world', 'hwd', 'fuzzy') !== null);
check('fuzzy order', matchText('abc', 'cb', 'fuzzy') === null);
check('fuzzy consecutive merged', JSON.stringify(matchText('hello', 'hel', 'fuzzy').ranges) === '[[0,3]]');
check('regexp match', matchText('id=1234', '\\d{3}', 'regexp').ranges[0][0] === 3);
check('invalid regexp no throw', matchText('abc', '(', 'regexp') === null);
check('mixed falls back to fuzzy', matchText('hello world', 'hwd', 'mixed') !== null);
check('empty query returns all', h.search('', 'exact').length === h.length);

// Images
const png = new GLib.Bytes(new Uint8Array([137, 80, 78, 71, 1, 2, 3]));
const img = h.addImage(png, 'gimp', 12);
check('image stored', GLib.file_test(h.imagePath(img), GLib.FileTest.EXISTS));
h.addImage(png, 'gimp', 13);
check('image dedupe', h.items.filter(i => i.type === 'image').length === 1);
check('images excluded from text search', !h.search('a', 'fuzzy').some(r => r.item.type === 'image'));

// Persistence
h.saveNow();
const h2 = new History(dir, {maxSize: 3});
h2.load();
check('reload same items', JSON.stringify(h2.items) === JSON.stringify(h.items));
const mode = Gio_mode(GLib.build_filenamev([dir, 'history.json']));
check('history file is 0600', mode === 0o600);

h.remove(img.id);
check('image file deleted on remove', !GLib.file_test(h.imagePath(img), GLib.FileTest.EXISTS));
h.clear(false);
check('clear keeps pinned', h.length === 1 && h.items[0].pinned);
h.clear(true);
check('clear all', h.length === 0);
h.destroy();

function Gio_mode(path) {
    const [, out] = GLib.spawn_command_line_sync(`stat -c %a ${path}`);
    return parseInt(new TextDecoder().decode(out).trim(), 8);
}

GLib.spawn_command_line_sync(`rm -rf ${dir}`);
print(`${passed} passed, ${failures} failed`);
if (failures) imports.system.exit(1);
