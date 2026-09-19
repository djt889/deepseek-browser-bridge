/* Offline tests for the SSE core of inject.js — no browser or login needed.
 * Extracts the __SSE_CORE__ marker section and runs canned DeepSeek patch
 * streams through it.
 */
import fs from 'node:fs';
import assert from 'node:assert/strict';

const src = fs.readFileSync(new URL('./inject.js', import.meta.url), 'utf8');
const core = src.split('/*__SSE_CORE__*/')[1].split('/*__SSE_CORE_END__*/')[0];
const api = new Function(`${core}
  return { createFrameDecoder, newState, split, isFinished, collectIds };`)();

function feedLines(events) {
  const frames = api.createFrameDecoder();
  const st = api.newState();
  const out = { text: '', reasoning: '', messageId: null, finished: false };
  const consume = (data) => {
    if (data == null) return;
    let parsed = null;
    try { parsed = JSON.parse(data); } catch { return; }
    api.collectIds(parsed, st);
    const s = api.split(parsed, st);
    if (s.text) out.text += s.text;
    if (s.reasoning) out.reasoning += s.reasoning;
    if (s.messageId !== undefined) out.messageId = st.messageId;
    if (api.isFinished(parsed)) out.finished = true;
  };
  for (const data of frames.push(events)) consume(data);
  for (const data of frames.finish()) consume(data);
  out.messageId = st.messageId;
  return out;
}

const frame = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// 1. Snapshot declares THINK+RESPONSE fragments; shorthand appends go to RESPONSE.
test('snapshot + shorthand routing', () => {
  const out = feedLines(
    frame({ v: { response: { fragments: [{ type: 'THINK', content: 'thin' }, { type: 'RESPONSE' }] } } })
    + frame({ v: '答A' })
    + frame({ p: 'response/status', v: 'FINISHED' }),
  );
  assert.equal(out.reasoning, 'thin');
  assert.equal(out.text, '答A');
  assert.equal(out.finished, true);
});

// 2. Fragment APPEND with initial content + explicit content patches.
test('fragment append + content patches', () => {
  const out = feedLines(
    frame({ p: 'response/fragments', o: 'APPEND', v: [{ type: 'RESPONSE', content: 'he' }] })
    + frame({ p: 'response/fragments/-1/content', v: 'llo' })
    + frame({ p: 'response/content', v: ' world' }),
  );
  assert.equal(out.text, 'hello world');
});

// 3. BATCH expansion: text items, nested patches, ids, quasi_status finish.
test('BATCH with nested events', () => {
  const out = feedLines(
    frame({ response_message_id: 100 })
    + frame({ o: 'BATCH', v: [
      { v: 'x' },
      { p: 'response/fragments/-1/content', v: 'y' },
      { p: 'quasi_status', v: 'FINISHED' },
    ] }),
  );
  assert.equal(out.text, 'xy');
  assert.equal(out.messageId, 100);
  assert.equal(out.finished, true);
});

// 4. THINK switch mid-stream: new THINK fragment captures subsequent patches.
test('thinking fragment switch', () => {
  const out = feedLines(
    frame({ p: 'response/fragments', o: 'APPEND', v: [{ type: 'RESPONSE', content: 'a' }] })
    + frame({ p: 'response/fragments', o: 'APPEND', v: [{ type: 'THINK' }] })
    + frame({ v: '思考中' })
    + frame({ p: 'response/fragments', o: 'APPEND', v: [{ type: 'RESPONSE' }] })
    + frame({ v: '答案' }),
  );
  assert.equal(out.text, 'a答案');
  assert.equal(out.reasoning, '思考中');
});

// 5. Whitelist: TOOL/SEARCH fragments are dropped, not merged into text.
test('non RESPONSE/THINK fragments dropped', () => {
  const out = feedLines(
    frame({ p: 'response/fragments', o: 'APPEND', v: [
      { type: 'TOOL', content: 'tool-xml-junk' },
      { type: 'RESPONSE', content: 'kept' },
    ] })
    + frame({ p: 'response/fragments/-1/content', v: 'more' }),
  );
  assert.equal(out.text, 'keptmore');
  assert.equal(out.reasoning, null || '');
});

// 6. Message id variants: string id, patch-path id, BATCH-nested id.
test('message id extraction', () => {
  const out1 = feedLines(frame({ response_message_id: '4294967295' }));
  assert.equal(out1.messageId, 0xFFFFFFFF);
  const out2 = feedLines(frame({ o: 'BATCH', v: [{ p: 'response/response_message_id', v: 7 }] }));
  assert.equal(out2.messageId, 7);
  const out3 = feedLines(frame({ response_message_id: 'nope' }));
  assert.equal(out3.messageId, null);
});

// 7. Streaming chunk boundaries split mid-frame and mid-multibyte.
test('chunk boundary robustness', () => {
  const stream = frame({ v: { response: { fragments: [{ type: 'RESPONSE', content: '' }] } } })
    + frame({ v: '_part1' }) + '\n\n' + 'data: {"v":"_par'
    + 't2"}\n\ndata: {"p":"response/status","v":"FINI' + 'SHED"}\n\n';
  const dec = api.createFrameDecoder();
  const st = api.newState();
  let text = '', finished = false;
  const half = Math.ceil(stream.length / 2);
  for (const chunk of [stream.slice(0, half), stream.slice(half)]) {
    for (const data of dec.push(chunk)) {
      if (data == null) continue;
      const parsed = JSON.parse(data);
      const s = api.split(parsed, st);
      if (s.text) text += s.text;
      if (api.isFinished(parsed)) finished = true;
    }
  }
  for (const data of dec.finish()) {
    if (data == null) continue;
    const parsed = JSON.parse(data);
    const s = api.split(parsed, st);
    if (s.text) text += s.text;
    if (api.isFinished(parsed)) finished = true;
  }
  assert.equal(text, '_part1_part2');
  assert.equal(finished, true);
});

// 8. Multi-line data rows join with \n per SSE spec (server splitting one JSON).
test('multi-line data join', () => {
  const out = feedLines('data: {"v":\ndata: "split"}\n\n');
  assert.equal(out.text, 'split');
});

console.log(`\n${passed} tests passed`);
