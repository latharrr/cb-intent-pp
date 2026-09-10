/* Pull explodeModes() straight out of Code.gs and exercise its branches.
   It is the only new backend logic with real branching, and it is the thing
   that decides whether pre-multi-select rows survive the migration. */
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
const start = src.indexOf('function explodeModes(');
const end = src.indexOf('function rebuildTravelModes(');
eval(src.slice(start, end));

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
// column map as colMap() would return it: 1-based, blob at 28, summary at 13
const c = { travelModesJSON: 28, travelMode: 13 };
const row = (json, summary) => { const r = []; r[27] = json; r[12] = summary; return r; };
const shape = a => a.map(x => x.mode + ':' + x.source).join(' | ');

ok(shape(explodeModes(row('["Walking","Metro"]', 'Walking, Metro'), c)) === 'Walking:preset | Metro:preset',
   'blob wins and both modes explode as preset');
ok(explodeModes(row('["Walking"]', 'Walking'), c).length === 1, 'single-item blob -> one row');
ok(explodeModes(row('[]', ''), c).length === 0, 'empty array -> no rows (not a legacy fallback)');
ok(shape(explodeModes(row('', 'Metro + walking'), c)) === 'Metro + walking:legacy-single',
   'pre-multi-select row recovered from the old single value');
ok(shape(explodeModes(row('', 'Walking, Metro'), c)) === 'Walking:legacy-single | Metro:legacy-single',
   'comma summary with no blob splits and is tagged legacy');
ok(shape(explodeModes(row('{not json', 'Bus'), c)) === 'Bus:legacy-single',
   'malformed blob falls through to the legacy column instead of throwing');
ok(explodeModes(row('', ''), c).length === 0, 'partial row with nothing answered -> no rows');
ok(explodeModes(row(undefined, undefined), c).length === 0, 'blank cells -> no rows');
ok(explodeModes(row('["Rapid (Rapido)"]', 'Rapid (Rapido)'), c)[0].mode === 'Rapid (Rapido)',
   'parentheses in a label survive the round trip');
ok(explodeModes(row('["  "]', ''), c).length === 1, 'whitespace-only entry is kept rather than crashing');
ok(explodeModes(row('"a string"', 'Metro'), c)[0].source === 'legacy-single',
   'valid JSON that is not an array falls through to legacy');
// a sheet that has not been re-set-up yet has no travelModesJSON column at all
ok(shape(explodeModes(row('', 'Metro'), { travelMode: 13 })) === 'Metro:legacy-single',
   'works even before getSheet() has appended the new columns');

console.log(fail === 0 ? '\nEXPLODE LOGIC OK\n' : '\n' + fail + ' FAILED\n');
process.exit(fail ? 1 : 0);
