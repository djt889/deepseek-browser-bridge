// Offline: DSML output from DeepSeek web models must be recognised as tool calls.
const fs = await import('node:fs');
const src = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
const start = src.indexOf('function tryRepairJson');
const end = src.indexOf('\nconst hashKey', start);
const fnSrc = src.slice(start, end);
const make = (names) => new Function(`${fnSrc}; return createToolStreamFilter(${JSON.stringify(names)});`)();

let bad = 0;
const chk = (label, cond, extra = '') => { if (!cond) { bad++; console.log('BROKEN', label, extra); } };

// 1. The exact shape observed in the wild (opencode write tool):
//    fullwidth-pipe DSML with filePath/content string params.
const FP = String.fromCharCode(0xff5c); // ｜
const dsmlWrite = [
  `<${FP}${FP}DSML${FP}${FP} calls>`,
  `<${FP}${FP}DSML${FP}${FP} invoke name="write">`,
  `<${FP}${FP}DSML${FP}${FP} parameter name="filePath" string="true">E:\AI\t5.txt</${FP}${FP}DSML${FP}${FP} parameter>`,
  `<${FP}${FP}DSML${FP}${FP} parameter name="content" string="true">17*23=391</${FP}${FP}DSML${FP}${FP} parameter>`,
  `</${FP}${FP}DSML${FP}${FP} invoke>`,
  `</${FP}${FP}DSML${FP}${FP} calls>`,
].join('\n');
{
  const f = make(['write']);
  f.push(dsmlWrite);
  const text = f.flush();
  chk('dsml write parsed', f.calls.length === 1 && f.calls[0].name === 'write'
      && f.calls[0].args.filePath === 'E:\AI\t5.txt' && f.calls[0].args.content === '17*23=391',
      JSON.stringify(f.calls) + ' text=' + JSON.stringify(text.slice(0, 80)));
  chk('dsml leaves no residue text', text.trim() === '', JSON.stringify(text.slice(0, 80)));
}

// 2. ASCII-pipe variant + text around the block passes through.
{
  const f = make(['get_weather']);
  const out = f.push('好的，我查一下。\n<||DSML|| calls><||DSML|| invoke name="get_weather"><||DSML|| parameter name="city">广州</||DSML|| parameter></||DSML|| invoke></||DSML|| calls>\n查询完成');
  const tail = f.flush();
  chk('ascii-pipe parsed', f.calls.length === 1 && f.calls[0].args.city === '广州', JSON.stringify(f.calls));
  chk('surrounding text kept', (out + tail).includes('好的，我查一下。') && (out + tail).includes('查询完成'), JSON.stringify((out + tail).slice(0, 100)));
}

// 3. Non-string param types round-trip (numbers, booleans, JSON arrays).
{
  const f = make(['search']);
  f.push(`<||DSML|| calls><||DSML|| invoke name="search"><||DSML|| parameter name="limit">10</||DSML|| parameter><||DSML|| parameter name="deep">true</||DSML|| parameter><||DSML|| parameter name="tags">["a","b"]</||DSML|| parameter></||DSML|| invoke></||DSML|| calls>`);
  f.flush();
  chk('typed params', f.calls.length === 1 && f.calls[0].args.limit === 10 && f.calls[0].args.deep === true && Array.isArray(f.calls[0].args.tags) && f.calls[0].args.tags[1] === 'b', JSON.stringify(f.calls));
}

// 4. CDATA body values.
{
  const f = make(['write']);
  f.push(`<||DSML|| calls><||DSML|| invoke name="write"><||DSML|| parameter name="content"><![CDATA[hello <world>]]></||DSML|| parameter></||DSML|| invoke></||DSML|| calls>`);
  f.flush();
  chk('cadata value', f.calls.length === 1 && f.calls[0].args.content === 'hello <world>', JSON.stringify(f.calls));
}

// 5. Non-DSML text is untouched (no 'DSML' keyword anywhere).
{
  const f = make(['write']);
  const out = f.push('普通回答，含 <b>html</b> 和 JSON {"a":1}');
  const tail = f.flush();
  chk('plain text untouched', (out + tail) === '普通回答，含 <b>html</b> 和 JSON {"a":1}', JSON.stringify(out + tail));
}

// 6. Unterminated DSML (stream cut): held/passthrough, no crash.
{
  const f = make(['write']);
  f.push(`前文 <||DSML|| calls><||DSML|| invoke name="write"><||DSML|| parameter name="content">部分`);
  const text = f.flush();
  chk('unterminated no crash', typeof text === 'string', 'n/a');
  chk('unterminated no call', f.calls.length === 0, JSON.stringify(f.calls));
}

console.log(bad ? bad + ' BROKEN' : 'dsml: ALL OK');
process.exit(bad ? 1 : 0);
