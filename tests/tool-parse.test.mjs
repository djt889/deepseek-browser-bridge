// Offline tests for the tool-call parser (no network, no Bridge needed).
// Extracts the real functions out of server.mjs so the tests always exercise
// shipped code. Run: node tests/tool-parse.test.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(dir, '..', 'server.mjs'), 'utf8');
const a = src.indexOf('// Best-effort repair of the mildly malformed JSON');
const b = src.indexOf('const hashKey = (msgs)');
const { parseToolArgs, createToolStreamFilter } = new Function(
  src.slice(a, b) + '\nreturn { parseToolArgs, createToolStreamFilter };',
)();

function sim(pieces, isStream) {
  const f = createToolStreamFilter(['get_weather', 'write', 'edit', 'search']);
  let visible = '', text = '';
  for (const p of pieces) { text += p; if (isStream) visible += f.push(p); }
  // Non-streaming feeds the accumulated text exactly once, in the done handler.
  if (!isStream) visible = f.push(text) + f.flush();
  else visible += f.flush();
  return { calls: f.calls.map((x) => x.name + ' ' + JSON.stringify(x.args)), visible, unknown: f.unknownTags };
}
let pass=0, fail=0;
const check=(l,c,d)=>{ if(c){console.log(`  PASS  ${l}`);pass++;} else {console.log(`  FAIL  ${l} -> ${d}`);fail++;} };

console.log('=== P0-1 非流式不再重复 ===');
const ns = sim(['今天 ','<get_weather>','{"city":"北京"}','</get_weather>',' 完'], false);
check('非流式只有 1 个 tool_call', ns.calls.length===1, `got ${ns.calls.length}`);
check('非流式正文正确', ns.visible.trim()==='今天  完', JSON.stringify(ns.visible));

console.log('\n=== P0-2 同名标签不再截断 ===');
const c1 = sim(['<write>','{"c":"a</write>b"}','</write>'], true);
check('body 含 </write> 正确解析', c1.calls.length===1 && !c1.calls[0].includes('_unparsed'), c1.calls.join(''));
const c2 = sim(['<write>','<write>inner</write>','</write>'], true);
check('嵌套同名不泄漏文本', c2.visible==='', JSON.stringify(c2.visible));
const c3 = sim(['<write>','{"c":"<script>x</script>"}','</write>'], true);
check('body 含 </script> 正确', c3.calls.length===1 && !c3.calls[0].includes('_unparsed'), c3.calls.join(''));

console.log('\n=== 回归：流式 ===');
const st = sim(['你好 ','<get_weather>','{"city":"上海"}','</get_weather>','再见'], true);
check('流式 1 个调用', st.calls.length===1, st.calls.join(''));
check('流式正文无标签泄漏', !st.visible.includes('get_weather'), JSON.stringify(st.visible));
const mt = sim(['<get_weather>{"a":1}</get_weather>','中间','<write>{"b":2}</write>'], true);
check('多工具调用', mt.calls.length===2, mt.calls.join(' | '));

console.log('\n=== 新增：参数加固 ===');
const pf = sim(['<write>','```json\n{"path":"x"}\n```','</write>'], true);
check('markdown 包裹被剥离', pf.calls.length===1 && !pf.calls[0].includes('_unparsed'), pf.calls.join(''));
const pt = sim(['<write>','{"path":"x",}','</write>'], true);
check('尾逗号被修复', pt.calls.length===1 && !pt.calls[0].includes('_unparsed'), pt.calls.join(''));
const pq = sim(['<write>',"{'path':'x'}",'</write>'], true);
check('单引号 JSON 被修复', pq.calls.length===1 && !pq.calls[0].includes('_unparsed'), pq.calls.join(''));

console.log('\n=== 新增：拼错工具名被记录 ===');
const ut = sim(['<search_web>{"q":"x"}</search_web>'], true);
check('未知标签被记录', ut.unknown.includes('search_web'), JSON.stringify(ut.unknown));

console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
