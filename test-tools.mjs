/* Offline tests for the v2 tool-call stream filter in server.mjs. */
import fs from 'node:fs';
import assert from 'node:assert/strict';

const src = fs.readFileSync(new URL('./server.mjs', import.meta.url), 'utf8');
const start = src.indexOf('function createToolStreamFilter');
const end = src.indexOf('\nconst hashKey', start);
const fnSrc = src.slice(start, end);
const make = (names) => new Function(`${fnSrc}; return createToolStreamFilter(${JSON.stringify(names)});`)();

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };

test('single complete call extracted, text around it emitted', () => {
  const f = make(['get_weather']);
  const a = f.push('今天天气：\n<get_weather>{"city":"北京"}</get_weather>\n完毕');
  const b = f.flush();
  assert.equal(a + b, '今天天气：\n\n完毕');
  assert.deepEqual(f.calls, [{ name: 'get_weather', args: { city: '北京' } }]);
});

test('partial tag held across chunk boundary', () => {
  const f = make(['get_weather']);
  const a = f.push('text <get_wea');
  assert.equal(a, 'text ');
  const b = f.push('ther>{"city":"上海"}</get_weather>');
  const c = f.flush();
  assert.equal(b + c, '');
  assert.deepEqual(f.calls, [{ name: 'get_weather', args: { city: '上海' } }]);
});

test('multiple calls in one stream, ids ordered', () => {
  const f = make(['a_tool', 'b_tool']);
  f.push('<a_tool>{"x":1}</a_tool>mid<b_tool>{"y":[2]}</b_tool>');
  f.flush();
  assert.deepEqual(f.calls, [
    { name: 'a_tool', args: { x: 1 } },
    { name: 'b_tool', args: { y: [2] } },
  ]);
});

test('unknown tags pass through as text', () => {
  const f = make(['get_weather']);
  const out = f.push('看 <div class="x">tag</div> 和 <invoke name="get_weather">{}</invoke> 尾');
  assert.ok(out.includes('<div class="x">tag</div>'));
  assert.ok(out.includes('<invoke name="get_weather">'));
  assert.equal(f.calls.length, 0);
});

test('invalid JSON body lands in _unparsed call', () => {
  const f = make(['get_weather']);
  f.push('<get_weather>不是json</get_weather>');
  f.flush();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].name, 'get_weather');
  assert.equal(f.calls[0].args._unparsed, '不是json');
});

test('unclosed call at stream end emitted raw', () => {
  const f = make(['get_weather']);
  const a = f.push('前 <get_weather>{"city":"广州"}');
  const b = f.flush();
  assert.equal(a + b, '前 <get_weather>{"city":"广州"}');
  assert.equal(f.calls.length, 0);
});

test('empty body call yields empty args object', () => {
  const f = make(['ping_tool']);
  f.push('<ping_tool></ping_tool>');
  f.flush();
  assert.deepEqual(f.calls, [{ name: 'ping_tool', args: {} }]);
});

test('non-tool tag that shares tool prefix passes through', () => {
  const f = make(['get_weather']);
  const out = f.push('<get_weather_now>{"x":1}</get_weather_now> 尾');
  assert.ok(out.includes('<get_weather_now>'));
  assert.equal(f.calls.length, 0);
});

console.log(`\n${passed} tool-filter tests passed`);
