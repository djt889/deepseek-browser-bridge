/* DeepSeek Browser Bridge — in-page client.
 * Injected into https://chat.deepseek.com via CDP Page.addScriptToEvaluateOnNewDocument.
 * All DeepSeek HTTP traffic is emitted by the page itself (real Chrome TLS stack,
 * HttpOnly cookies, live Shumei device SDK signals), so environment-level
 * fingerprints match normal web usage exactly.
 *
 * Commands arrive via window.__dqCmd(jsonString); results stream back through the
 * CDP binding window.__dqReport(jsonString).
 *
 * Protocol ported from zhu1090093659/deepseek-pp (Apache-2.0):
 *   core/deepseek/{contracts,request-codec,pow,active-client,stream-codec}.ts
 */
(() => {
  'use strict';
  if (window.__dqBridge) return;
  window.__dqBridge = true;

  const ORIGIN = 'https://chat.deepseek.com';
  const ROUTES = {
    completion: '/api/v0/chat/completion',
    regenerate: '/api/v0/chat/regenerate',
    editMessage: '/api/v0/chat/edit_message',
    continue: '/api/v0/chat/continue',
    createSession: '/api/v0/chat_session/create',
    powChallenge: '/api/v0/chat/create_pow_challenge',
  };
  const APP_VERSION = '2.0.0';
  const CLIENT_PLATFORM = 'web';

  const report = (obj) => { try { window.__dqReport(JSON.stringify(obj)); } catch { /* binding gone */ } };
  const enc = new TextEncoder();

  // ---------- token (port of active-client.ts readDeepSeekUserToken) ----------
  function readToken() {
    try {
      const raw = localStorage.getItem('userToken');
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed === 'string') return parsed.trim() || null;
        if (parsed && typeof parsed === 'object') {
          return parsed.token ?? parsed.value ?? parsed.accessToken ?? null;
        }
      } catch { /* not JSON — treat as raw token */ }
      return raw.trim() || null;
    } catch { return null; }
  }

  function clientHeaders() {
    const token = readToken();
    if (!token) return null;
    return {
      Authorization: `Bearer ${token}`,
      'X-App-Version': APP_VERSION,
      'x-client-platform': CLIENT_PLATFORM,
      'x-client-version': APP_VERSION,
      'x-client-locale': document.documentElement.lang || navigator.language || 'en-US',
      'x-client-timezone-offset': String(-new Date().getTimezoneOffset() * 60),
    };
  }

  // ---------- PoW (port of pow.ts; wasm bytes are pushed by the bridge as base64) ----------
  let wasmLoad = null;
  window.__dqLoadWasm = (b64) => {
    if (wasmLoad) return wasmLoad.promise;
    wasmLoad = instantiate(b64).catch((e) => { wasmLoad = null; throw e; });
    return wasmLoad;
  };

  async function instantiate(b64) {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const { instance } = await WebAssembly.instantiate(bin, {});
    const e = instance.exports;
    if (!e.wasm_solve || !e.memory || !e.__wbindgen_add_to_stack_pointer || !e.__wbindgen_export_0) {
      throw new Error('DQ_WASM_BAD_EXPORTS');
    }
    return e;
  }

  function writeStr(wasm, value) {
    const bytes = enc.encode(value);
    const ptr = wasm.__wbindgen_export_0(bytes.length, 1);
    new Uint8Array(wasm.memory.buffer).set(bytes, ptr);
    return { ptr, len: bytes.length };
  }

  function solvePowWithWasm(wasm, target, prefix, difficulty) {
    const retPtr = wasm.__wbindgen_add_to_stack_pointer(-16);
    try {
      const challengeAlloc = writeStr(wasm, target);
      const prefixAlloc = writeStr(wasm, prefix);
      wasm.wasm_solve(retPtr, challengeAlloc.ptr, challengeAlloc.len, prefixAlloc.ptr, prefixAlloc.len, difficulty);
      const view = new DataView(wasm.memory.buffer);
      const status = view.getInt32(retPtr, true);
      const answer = view.getFloat64(retPtr + 8, true);
      if (status !== 1 || !Number.isSafeInteger(answer) || answer < 0) {
        throw new Error(`DQ_POW_NO_SOLUTION difficulty=${difficulty}`);
      }
      return answer;
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16);
    }
  }

  async function solvePow(challenge) {
    if (challenge.algorithm !== 'DeepSeekHashV1') throw new Error(`DQ_POW_ALGO ${challenge.algorithm}`);
    if (!/^[0-9a-f]{64}$/i.test(challenge.challenge)) throw new Error('DQ_POW_BAD_DIGEST');
    if (!Number.isSafeInteger(challenge.difficulty) || challenge.difficulty <= 0) throw new Error(`DQ_POW_BAD_DIFFICULTY ${challenge.difficulty}`);
    if (!Number.isFinite(challenge.expireAt) || challenge.expireAt <= 0) throw new Error('DQ_POW_BAD_EXPIRE');
    if (!wasmLoad) throw new Error('DQ_WASM_NOT_LOADED');
    const wasm = await wasmLoad;
    const answer = solvePowWithWasm(
      wasm,
      challenge.challenge.toLowerCase(),
      `${challenge.salt}_${challenge.expireAt}_`,
      challenge.difficulty,
    );
    return {
      algorithm: challenge.algorithm,
      challenge: challenge.challenge,
      salt: challenge.salt,
      answer,
      signature: challenge.signature,
    };
  }

  const b64utf8 = (s) => {
    const bytes = enc.encode(s);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  };

  // ---------- API helpers ----------
  async function apiPost(path, body, extraHeaders, signal) {
    const headers = clientHeaders();
    if (!headers) { const e = new Error('DQ_NO_TOKEN'); e.code = 'DQ_NO_TOKEN'; throw e; }
    return fetch(ORIGIN + path, {
      method: 'POST',
      credentials: 'include',
      signal,
      headers: { 'content-type': 'application/json', ...headers, ...(extraHeaders || {}) },
      body: JSON.stringify(body),
    });
  }

  async function apiGet(path, signal) {
    const headers = clientHeaders();
    if (!headers) { const e = new Error('DQ_NO_TOKEN'); e.code = 'DQ_NO_TOKEN'; throw e; }
    return fetch(ORIGIN + path, { credentials: 'include', signal, headers });
  }

  async function newSession(signal) {
    const res = await apiPost(ROUTES.createSession, {}, null, signal);
    const json = await res.json().catch(() => null);
    const id = json?.data?.biz_data?.chat_session?.id;
    if (!res.ok || json?.data?.biz_code !== 0 || typeof id !== 'string' || !id) {
      throw new Error(`DQ_SESSION_FAIL ${res.status} ${JSON.stringify(json ?? '').slice(0, 300)}`);
    }
    return id;
  }

  async function powHeaders(targetPath, signal) {
    const res = await apiPost(ROUTES.powChallenge, { target_path: targetPath ?? ROUTES.completion }, null, signal);
    if (res.status === 401 || res.status === 403) throw new Error(`DQ_AUTH_${res.status}`);
    const json = await res.json().catch(() => null);
    const ch = json?.data?.biz_data?.challenge;
    if (!res.ok || json?.data?.biz_code !== 0 || !ch) {
      throw new Error(`DQ_POW_CHALLENGE_FAIL ${res.status} ${JSON.stringify(json ?? '').slice(0, 300)}`);
    }
    const challenge = {
      algorithm: String(ch.algorithm),
      challenge: String(ch.challenge),
      salt: String(ch.salt),
      difficulty: Number(ch.difficulty),
      signature: String(ch.signature),
      expireAt: Number(ch.expire_at ?? ch.expireAt ?? 0),
    };
    const answer = await solvePow(challenge);
    return {
      'X-DS-PoW-Response': b64utf8(JSON.stringify({
        algorithm: answer.algorithm,
        challenge: answer.challenge,
        salt: answer.salt,
        answer: answer.answer,
        signature: answer.signature,
        target_path: targetPath ?? ROUTES.completion,
      })),
    };
  }

  // ---------- SSE decoding (port of stream-codec.ts) ----------
  /*__SSE_CORE__*/
  function createFrameDecoder() {
    let buf = '';
    const makeFrame = (block) => {
      let data = null;
      for (const line of block.split(/\r\n|\r|\n/)) {
        if (line.startsWith('data:')) {
          const d = line.slice(5).trim();
          data = data != null ? data + '\n' + d : d;
        }
      }
      return data;
    };
    const drain = (final) => {
      const frames = [];
      // Emit only complete frames; the remainder stays buffered for the next
      // chunk. Never re-slice consumed bytes — a delimiter split across chunks
      // must not cause the same frame to be emitted twice.
      const re = /\r?\n\r?\n/g;
      let sliceFrom = 0, m;
      while ((m = re.exec(buf)) !== null) {
        frames.push(makeFrame(buf.slice(sliceFrom, m.index)));
        sliceFrom = m.index + m[0].length;
      }
      buf = buf.slice(sliceFrom);
      if (final && buf) { frames.push(makeFrame(buf)); buf = ''; }
      return frames;
    };
    return {
      push(text) { buf += text; return drain(false); },
      finish() { return drain(true); },
    };
  }

  function newState() {
    return { types: [], cur: -1, observed: false, text: '', reasoning: '', messageId: null, requestId: null, finished: false };
  }

  function isTextSeg(p) {
    if (typeof p !== 'string') return false;
    const seg = p.split('/').pop();
    return seg === 'content' || seg === 'text' || seg === 'markdown' || seg === 'delta';
  }
  function isRespPath(p) { return typeof p === 'string' && (p === 'response' || p.startsWith('response/')); }
  function isThinkPath(p) {
    if (typeof p !== 'string') return false;
    const seg = p.split('/').pop();
    return seg === 'reasoning_content' || seg === 'thinking_content';
  }
  function fragIdx(path) {
    const m = /^response\/fragments\/(-?\d+)\//.exec(path);
    return m ? Number(m[1]) : -1;
  }
  function fragText(f) {
    if (!f || typeof f !== 'object') return null;
    if (typeof f.content === 'string') return f.content;
    if (typeof f.text === 'string') return f.text;
    return null;
  }
  function typeAt(st, i) {
    if (i === -1) i = st.cur;
    return i >= 0 && i < st.types.length ? st.types[i] : null;
  }

  // Upstream routes unknown fragment types into the text channel and strips tool
  // XML downstream; we have no downstream filter, so whitelist instead:
  // RESPONSE -> answer text, THINK -> reasoning, everything else (TOOL/SEARCH
  // progress fragments) is dropped.
  function routeByType(type, content) {
    const t = String(type ?? 'RESPONSE').toUpperCase();
    if (t === 'THINK') return { text: null, reasoning: content };
    if (t === 'RESPONSE') return { text: content, reasoning: null };
    return { text: null, reasoning: null };
  }

  function consumeInitial(fragments, types) {
    let text = null, reasoning = null;
    fragments.forEach((f, i) => {
      const c = fragText(f);
      if (!c) return;
      const part = routeByType(types[i], c);
      if (part.text) text = (text ?? '') + part.text;
      if (part.reasoning) reasoning = (reasoning ?? '') + part.reasoning;
    });
    return { text, reasoning };
  }

  function split(parsed, st) {
    if (!parsed || typeof parsed !== 'object') return { text: null, reasoning: null };

    if (parsed.o === 'BATCH' && Array.isArray(parsed.v)) {
      let text = null, reasoning = null;
      for (const item of parsed.v) {
        const part = split(item, st);
        if (part.text) text = (text ?? '') + part.text;
        if (part.reasoning) reasoning = (reasoning ?? '') + part.reasoning;
      }
      return { text, reasoning };
    }

    // Fragment creation: {"p":"response/fragments","o":"APPEND","v":[...]}
    if (typeof parsed.p === 'string' && parsed.p.endsWith('/fragments') && parsed.o === 'APPEND' && Array.isArray(parsed.v)) {
      const types = parsed.v.map((f) => String(f?.type ?? 'RESPONSE'));
      st.types.push(...types);
      st.cur = st.types.length - 1;
      st.observed = true;
      return consumeInitial(parsed.v, types);
    }

    // Full response snapshot: {"v":{"response":{...,"fragments":[...]}}}
    if (parsed.p === undefined && parsed.v && typeof parsed.v === 'object' && !Array.isArray(parsed.v)) {
      const response = parsed.v.response;
      if (response && typeof response === 'object' && Array.isArray(response.fragments) && response.fragments.length > 0) {
        const first = !st.observed;
        st.types = response.fragments.map((f) => String(f?.type ?? 'RESPONSE'));
        st.cur = st.types.length - 1;
        st.observed = true;
        return first ? consumeInitial(response.fragments, st.types) : { text: null, reasoning: null };
      }
    }

    if (isThinkPath(parsed.p) && typeof parsed.v === 'string') return { text: null, reasoning: parsed.v };

    if (typeof parsed.p === 'string' && isTextSeg(parsed.p) && isRespPath(parsed.p) && typeof parsed.v === 'string') {
      return routeByType(typeAt(st, fragIdx(parsed.p)), parsed.v);
    }

    if (!parsed.p && typeof parsed.v === 'string') return routeByType(typeAt(st, st.cur), parsed.v);

    return { text: null, reasoning: null };
  }

  function isFinished(parsed) {
    if (parsed?.p === 'response/status' && parsed.v === 'FINISHED') return true;
    if (parsed?.o === 'BATCH' && Array.isArray(parsed.v)) {
      return parsed.v.some((it) => it?.p === 'quasi_status' && it.v === 'FINISHED');
    }
    return false;
  }

  function normId(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xFFFFFFFF) return v;
    if (typeof v !== 'string') return null;
    const t = v.trim();
    if (!/^\d+$/.test(t)) return null;
    const n = Number(t);
    return Number.isInteger(n) && n >= 0 && n <= 0xFFFFFFFF ? n : null;
  }

  function collectIds(parsed, st) {
    if (!parsed || typeof parsed !== 'object') return;
    const rid = normId(parsed.response_message_id ?? parsed.responseMessageId);
    if (rid !== null) st.messageId = rid;
    const qid = normId(parsed.request_message_id ?? parsed.requestMessageId);
    if (qid !== null) st.requestId = qid;
    if (parsed.o === 'BATCH' && Array.isArray(parsed.v)) {
      for (const it of parsed.v) collectIds(it, st);
    }
    if (typeof parsed.p === 'string' && parsed.p.includes('response_message_id')) {
      const id = normId(parsed.v);
      if (id !== null) st.messageId = id;
    }
    if (Array.isArray(parsed.v)) {
      for (const it of parsed.v) collectIds(it, st);
    } else if (parsed.v && typeof parsed.v === 'object') {
      collectIds(parsed.v, st);
    }
  }
  /*__SSE_CORE_END__*/

  // ---------- completion stream ----------
  const controllers = new Map();

  async function complete(cmd) {
    const ac = new AbortController();
    controllers.set(cmd.id, ac);
    try {
      // cmd.type: 'completion' (default) | 'regenerate' | 'editMessage' | 'continue'
      const type = ROUTES[cmd.type] ? cmd.type : 'completion';
      const pow = type === 'continue' ? {} : await powHeaders(ROUTES[type], ac.signal);
      
      // Thinking control. The web API has NO numeric level field: it exposes
      // a boolean `thinking_enabled` plus a `model_type` (default|expert|vision).
      // So we map requested levels onto what the protocol actually honours:
      //   off/minimal/none  -> thinking off
      //   anything else     -> thinking on
      //   high/xhigh/max    -> model_type 'expert' (the web's deeper model)
      const lvl = typeof cmd.thoughtLevel === 'string' ? cmd.thoughtLevel.toLowerCase() : null;
      const WANT_OFF = lvl === 'off' || lvl === 'none' || lvl === 'minimal';
      const WANT_EXPERT = lvl === 'high' || lvl === 'xhigh' || lvl === 'max';
      const thinkingEnabled = WANT_OFF ? false : !!cmd.thinking;
      const modelType = cmd.vision ? 'vision'
        : (cmd.thinkExpert === true || WANT_EXPERT) ? 'expert'
        : 'default';

      const base = { thinking_enabled: thinkingEnabled, search_enabled: !!cmd.search };
      let body;
      if (type === 'regenerate') {
        body = { chat_session_id: cmd.sessionId, child_message_id: cmd.childMessageId, ...base };
      } else if (type === 'editMessage') {
        body = { chat_session_id: cmd.sessionId, message_id: cmd.messageId, ref_file_ids: [], prompt: cmd.prompt, ...base, action: null };
      } else if (type === 'continue') {
        body = { chat_session_id: cmd.sessionId, message_id: cmd.messageId, fallback_to_resume: true };
      } else {
        body = {
          chat_session_id: cmd.sessionId,
          parent_message_id: Number.isInteger(cmd.parentId) ? cmd.parentId : null,
          model_type: modelType,
          prompt: cmd.prompt,
          ref_file_ids: cmd.refFileIds ?? [],
          ...base,
          action: null,
          preempt: cmd.preempt === true,
        };
      }
      const res = await apiPost(ROUTES[type], body, pow, ac.signal);
      if (!res.ok || !res.body) {
        const t = await res.text().catch(() => '');
        throw new Error(`DQ_COMPLETION_HTTP_${res.status} ${t.slice(0, 300)}`);
      }
      report({ id: cmd.id, type: 'start' });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      const frames = createFrameDecoder();
      const st = newState();
      let reportedMessageId = null, reportedRequestId = null;
      const feed = (text) => {
        for (const data of frames.push(text)) {
          if (data == null) continue;
          if (window.__dqDebug) (window.__dqRawSse ??= []).push(data);
          let parsed = null;
          try { parsed = JSON.parse(data); } catch { continue; }
          collectIds(parsed, st);
          if ((st.messageId !== null && st.messageId !== reportedMessageId) || (st.requestId !== null && st.requestId !== reportedRequestId)) {
            reportedMessageId = st.messageId;
            reportedRequestId = st.requestId;
            report({ id: cmd.id, type: 'meta', messageId: st.messageId, requestId: st.requestId });
          }
          const s = split(parsed, st);
          if (s.text) { st.text += s.text; report({ id: cmd.id, type: 'chunk', text: s.text }); }
          if (s.reasoning) { st.reasoning += s.reasoning; report({ id: cmd.id, type: 'reasoning', text: s.reasoning }); }
          if (isFinished(parsed)) st.finished = true;
        }
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        feed(dec.decode(value, { stream: true }));
        if (st.finished) { try { await reader.cancel(); } catch { /* already done */ } break; }
      }
      if (!st.finished) {
        for (const data of frames.finish()) {
          if (data == null) continue;
          let parsed = null;
          try { parsed = JSON.parse(data); } catch { continue; }
          collectIds(parsed, st);
          const s = split(parsed, st);
          if (s.text) { st.text += s.text; report({ id: cmd.id, type: 'chunk', text: s.text }); }
          if (s.reasoning) { st.reasoning += s.reasoning; report({ id: cmd.id, type: 'reasoning', text: s.reasoning }); }
          if (isFinished(parsed)) st.finished = true;
        }
      }
      report({
        id: cmd.id,
        type: 'done',
        text: st.text,
        reasoning: st.reasoning,
        messageId: st.messageId,
        finished: st.finished,
      });
    } finally {
      controllers.delete(cmd.id);
    }
  }

  // ---------- command dispatcher ----------
  window.__dqCmd = (json) => {
    let cmd;
    try { cmd = JSON.parse(json); } catch { return; }
    (async () => {
      try {
        if (cmd.op === 'status') {
          report({ id: cmd.id, type: 'status', loggedIn: !!clientHeaders(), url: location.href, lang: navigator.language });
          // lightweight account display name (mobile_number) for the dashboard
          (async () => {
            try {
              const h = clientHeaders();
              if (!h) return;
              const r = await fetch(ORIGIN + '/api/v0/users/current', { credentials: 'include', headers: h });
              const j = await r.json().catch(() => null);
              const d = j?.data?.biz_data ?? {};
              report({ id: cmd.id + ':u', type: 'meta-user', displayName: d.mobile_number ? String(d.mobile_number) : (d.email ?? d.name ?? null) });
            } catch { /* best effort */ }
          })();
        } else if (cmd.op === 'newSession') {
          report({ id: cmd.id, type: 'session', sessionId: await newSession(null) });
        } else if (cmd.op === 'complete') {
          await complete(cmd);
        } else if (cmd.op === 'abort') {
          controllers.get(cmd.targetId)?.abort();
          report({ id: cmd.id, type: 'ok' });
        } else if (cmd.op === 'stopStream') {
          // No PoW: the stop endpoint rejects PoW signed for it, and solving
          // the WASM challenge would block the page's event loop anyway.
          const res = await apiPost('/api/v0/chat/stop_stream',
            { chat_session_id: cmd.sessionId, message_id: cmd.messageId }, {}, null);
          report({ id: cmd.id, type: 'stopped', status: res.status });
        } else if (cmd.op === 'deleteSessions') {
          // Web UI "delete conversation": POST /api/v0/chat_session/delete
          // {chat_session_ids: [...]} (batch). biz_code 0 = success. No PoW.
          try {
            const res = await apiPost('/api/v0/chat_session/delete',
              { chat_session_ids: cmd.ids }, {}, null);
            const j = await res.json().catch(() => null);
            report({ id: cmd.id, type: 'deleted', status: res.status, biz: j?.data?.biz_code ?? null });
          } catch (e) {
            report({ id: cmd.id, type: 'deleted', status: 0, biz: null, error: String((e && e.message) || e) });
          }
        } else if (cmd.op === 'uploadFile') {
          // Web UI file attach: POST /api/v0/file/upload_file — multipart with
          // a single "file" field, PoW signed for the upload route. The browser
          // sets the multipart content-type itself; do NOT set one manually.
          try {
            const bytes = Uint8Array.from(atob(cmd.b64), (c) => c.charCodeAt(0));
            const fd = new FormData();
            fd.append('file', new Blob([bytes], { type: cmd.mime || 'application/octet-stream' }), cmd.name || 'file');
            const pow = await powHeaders('/api/v0/file/upload_file', null);
            const headers = clientHeaders();
            if (!headers) throw new Error('DQ_NO_TOKEN');
            const res = await fetch(ORIGIN + '/api/v0/file/upload_file', {
              method: 'POST', credentials: 'include',
              headers: { ...headers, ...pow },
              body: fd,
            });
            const j = await res.json().catch(() => null);
            const bd = j?.data?.biz_data ?? null;
            const ok = res.ok && j?.data?.biz_code === 0 && bd;
            report({ id: cmd.id, type: 'uploaded', status: res.status, biz: j?.data?.biz_code ?? null, file: ok ? bd : null });
          } catch (e) {
            report({ id: cmd.id, type: 'uploaded', status: 0, biz: null, file: null, error: String((e && e.message) || e) });
          }
        } else if (cmd.op === 'fetchFiles') {
          // File audit states: GET /api/v0/file/fetch_files?file_ids=a,b
          try {
            const res = await apiGet('/api/v0/file/fetch_files?file_ids='
              + encodeURIComponent(cmd.ids.join(',')), null);
            const j = await res.json().catch(() => null);
            if (!j || j.data?.biz_code !== 0) throw new Error(`DQ_FILES_FAIL ${res.status}`);
            report({ id: cmd.id, type: 'files', files: j.data.biz_data.files ?? [] });
          } catch (e) {
            report({ id: cmd.id, type: 'files', files: [], error: String((e && e.message) || e) });
          }
        } else if (cmd.op === 'listSessions') {
          // Web session list for the dashboard sweeper: GET fetch_page with
          // cursor pagination (lte_cursor.updated_at = previous page's min).
          try {
            const out = [];
            let cursor = null;
            for (let page = 0; page < 15; page++) {
              let path = '/api/v0/chat_session/fetch_page?lte_cursor.pinned=false&count=50';
              if (cursor !== null) path += '&lte_cursor.updated_at=' + cursor;
              const res = await apiGet(path, null);
              const j = await res.json().catch(() => null);
              if (!j || j.data?.biz_code !== 0) throw new Error(`DQ_LIST_FAIL ${res.status}`);
              const list = j.data.biz_data.chat_sessions ?? [];
              for (const s of list) out.push({ id: s.id, title: s.title ?? '', ut: s.updated_at ?? 0 });
              if (!j.data.biz_data.has_more || !list.length) break;
              const times = list.map((s) => s.updated_at ?? 0).filter((x) => x > 0);
              const minT = Math.min(...times);
              if (cursor !== null && minT >= cursor) break;
              cursor = minT;
            }
            report({ id: cmd.id, type: 'sessions', sessions: out });
          } catch (e) {
            report({ id: cmd.id, type: 'error', error: String((e && e.message) || e) });
          }
        } else {
          report({ id: cmd.id, type: 'error', error: 'DQ_UNKNOWN_OP' });
        }
      } catch (e) {
        report({ id: cmd.id, type: 'error', error: String((e && e.message) || e) });
      }
    })();
  };
})();
