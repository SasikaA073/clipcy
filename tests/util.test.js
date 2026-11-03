// Run: gjs -m tests/util.test.js
import {titleMarkup} from '../util.js';

let failures = 0, passed = 0;
function eq(name, got, want) {
    if (got === want) passed++; else { failures++; print(`FAIL: ${name}\n  got:  ${got}\n  want: ${want}`); }
}
eq('plain', titleMarkup('hello', [], 50), 'hello');
eq('collapse whitespace', titleMarkup('  a \n\t b  ', [], 50), 'a b');
eq('truncate', titleMarkup('abcdef', [], 3), 'abc…');
eq('escape', titleMarkup('<a&b>', [], 50), '&lt;a&amp;b&gt;');
eq('highlight', titleMarkup('hello world', [[6, 11]], 50), 'hello <b>world</b>');
eq('highlight across collapsed space', titleMarkup('ab  cd', [[1, 5]], 50), 'a<b>b</b> <b>c</b>d');
eq('highlight closed on truncate', titleMarkup('abcdef', [[1, 6]], 3), 'a<b>bc</b>…');
eq('highlight after multiline', titleMarkup('x\ny', [[2, 3]], 50), 'x <b>y</b>');
print(`${passed} passed, ${failures} failed`);
if (failures) imports.system.exit(1);
