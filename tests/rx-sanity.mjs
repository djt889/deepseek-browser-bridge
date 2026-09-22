// Offline sanity: the Windows-path backslash repair in tryRepairJson.
// Backslashes are built programmatically - they die in shells/heredocs.
const fs = await import('node:fs');
const BS = String.fromCharCode(92);
const src = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
const start = src.indexOf('function tryRepairJson');
const end = src.indexOf('\nconst hashKey', start);
const f = new Function(src.slice(start, end) + '; return tryRepairJson;')();

let bad = 0;
const chk = (label, cond, extra = '') => {
  if (!cond) { bad++; console.log('BROKEN', label, extra); }
};

// ILLEGAL JSON escapes make JSON.parse fail -> the repair chain fires and
// must escape the backslash: {"p":"D:\ax"} -> D:\ax
for (const c of 'acdgjkmoqsvwxyzACDGJKMOQSVWXYZ0123456789 ._-') {
  const raw = '{"p":"D:' + BS + c + 'x"}';
  const r = f(raw);
  chk('illegal esc ' + JSON.stringify(c), r && typeof r === 'object' && r.p === 'D:' + BS + c + 'x', JSON.stringify(r?.p));
}
// Backslash-u without 4 hex digits is illegal too -> repaired.
{
  const raw = '{"p":"D:' + BS + 'ux"}';
  const r = f(raw);
  chk('illegal esc u-short', r?.p === 'D:' + BS + 'ux', JSON.stringify(r?.p));
}
// LEGAL JSON escapes (b f n r t) parse fine on attempt #0 - the repair
// chain never runs, and the VALUE legally contains the control char. That
// is correct JSON semantics: no parser can tell 'model meant backslash'
// from 'model meant formfeed'. Those round-trip as _unparsed next turn.
for (const pair of [['b','BS+b'], ['f','BS+f'], ['n','BS+n'], ['r','BS+r'], ['t','BS+t']]) {
  const esc = pair[1].slice(-1);
  const raw = '{"p":"D:' + BS + esc + 'x"}';
  const r = f(raw);
  const ctrl = JSON.parse('"' + BS + esc + '"');
  chk('legal esc ' + esc + ' (ctrl value)', r?.p === 'D:' + ctrl + 'x', JSON.stringify(r?.p));
}
// Already-doubled backslashes parse on attempt #0: D:\srv -> D:\srv.
{
  const raw = '{"p":"D:' + BS + BS + 'srv' + BS + BS + 'share"}';
  const r = f(raw);
  chk('doubled', r?.p === 'D:' + BS + 'srv' + BS + 'share', JSON.stringify(r?.p));
}
// Trailing comma still repaired.
chk('trailing comma', (() => { const r = f('{"a":1,}'); return r && r.a === 1; })());

console.log(bad ? bad + ' BROKEN' : 'rx-sanity: ALL OK');
process.exit(bad ? 1 : 0);