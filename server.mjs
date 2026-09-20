#!/usr/bin/env node
/* DeepSeek Browser Bridge — OpenAI-compatible endpoint over real logged-in Chrome tabs.
 *
 * All DeepSeek traffic is emitted by the page itself via CDP-injected fetch:
 * real Chrome TLS stack, HttpOnly cookies, live Shumei device SDK signals.
 * The bridge adds account pooling, session reuse and pacing so the request
 * profile stays close to normal human web usage.
 *
 * Accounts: accounts.json next to this file — [{ "name": "main", "cdpPort": 9222 }, ...].
 * Each account gets its own Chrome instance + profile dir; missing accounts.json
 * means single-account mode on DQ_CDP_PORT. Chrome instances are launched
 * automatically (silent, off-screen; DQ_SHOW=1 puts them on screen for login).
 *
 * Requires: Node >= 22 (built-in WebSocket).
 * Protocol ported from zhu1090093659/deepseek-pp (Apache-2.0).
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INJECT_SRC = fs.readFileSync(path.join(__dirname, 'inject.js'), 'utf8');
const WASM_B64 = fs.readFileSync(path.join(__dirname, 'wasm', 'sha3_wasm_bg.wasm')).toString('base64');

const ENV = (name, dflt) => {
  const v = process.env[name];
  return v === undefined || v === '' ? dflt : v;
};
const CFG = {
  port: Number(ENV('DQ_PORT', 39751)),
  concurrency: Math.max(1, Number(ENV('DQ_CONCURRENCY', 6))),
  queueMax: Math.max(1, Number(ENV('DQ_QUEUE_MAX', 32))),
  minGapMs: Math.max(0, Number(ENV('DQ_MIN_GAP_MS', 8000))),
  jitterMs: Math.max(0, Number(ENV('DQ_JITTER_MS', 4000))),
  maxPerHour: Number(ENV('DQ_MAX_PER_HOUR', 90)),
  maxPerDay: Number(ENV('DQ_MAX_PER_DAY', 500)), // per account, 0 = unlimited
  think: ENV('DQ_THINK', '1') !== '0',
  // DeepSeek silently returns a 200 + EMPTY stream for a second completion on
  // the same session fired too soon after the previous one (humans can't do
  // that in the web UI). Enforced per-session for ALL requests; an empty
  // stream that still slips through is retried once automatically.
  sessionContGapMs: Number(ENV('DQ_SESSION_CONT_GAP_MS', 15000)),
  idleTimeoutMs: Number(ENV('DQ_IDLE_TIMEOUT_MS', 180000)),
  // Page accepted the request (message id arrived) but generation never
  // starts => official soft rate limit. Fail fast with DQ_SOFT_THROTTLED
  // instead of hanging until the idle timeout. Very long prompts being
  // preprocessed can also be silent this long — raise the env if so.
  softThrottleMs: Number(ENV('DQ_SOFT_THROTTLE_MS', 60000)),
  sessionTtlMs: Number(ENV('DQ_SESSION_TTL_MS', 2 * 3600_000)),
  sessionMax: Number(ENV('DQ_SESSION_MAX', 50)),
  quietHours: ENV('DQ_QUIET_HOURS', ''), // 'HH:MM-HH:MM'
  chrome: ENV('DQ_CHROME', ''),
  show: ENV('DQ_SHOW', '') === '1' || process.argv.includes('--show'),
  authFailLimit: Number(ENV('DQ_AUTH_FAIL_LIMIT', 2)), // consecutive auth failures -> account dead
  sessionDeleteTtlMs: Number(ENV('DQ_SESSION_DELETE_TTL_MS', 10 * 86400_000)), // retire web sessions inactive this long (0 = off); activity-based, NOT age-based
  sessionSweepMs: Number(ENV('DQ_SESSION_SWEEP_MS', 10 * 60_000)),            // retirement sweep cadence
  fileAuditTimeoutMs: Number(ENV('DQ_FILE_AUDIT_TIMEOUT_MS', 45000)),         // wait for DeepSeek file audit to settle
  fileAuditPollMs: Number(ENV('DQ_FILE_AUDIT_POLL_MS', 3000)),                // audit poll interval
  fileCacheTtlMs: Number(ENV('DQ_FILE_CACHE_TTL_MS', 7 * 86400_000)),         // uploaded-file id cache lifetime
  autoRevive: ENV('DQ_AUTO_REVIVE', '1') === '1',                             // un-dead an account once its page is logged in again
};

const nowHMS = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
let log = (...args) => console.log(`[dq ${nowHMS()}]`, ...args);

// ---------------------------------------------------------------------------
// Account initialization
// ---------------------------------------------------------------------------

const sleep = (ms, signal) => delay(ms, null, { signal }).catch(() => {
  throw new Error('DQ_CLIENT_CLOSED');
});

// Webhook sender (fire-and-forget with timeout)
async function sendWebhook(event, payload) {
  if (!CFG.webhooks || !Array.isArray(CFG.webhooks) || CFG.webhooks.length === 0) return;
  for (const url of CFG.webhooks) {
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, payload, at: new Date().toISOString() }),
      signal: AbortSignal.timeout(5000), // 5s timeout per URL
    }).catch(() => { /* ignore failed webhook delivery */ });
  }
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`DQ_CDP_HTTP_${res.status}`);
  return res.json();
}

const LOCALAPPDATA = process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE ?? '', 'AppData', 'Local');

function loadAccounts() {
  const file = path.join(__dirname, 'accounts.json');
  let list = null;
  try {
    list = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { /* single-account mode */ }
  if (!Array.isArray(list) || list.length === 0) {
    list = [{ name: 'default', cdpPort: Number(ENV('DQ_CDP_PORT', 9222)) }];
  }
  return list.map((a, i) => ({
    name: String(a.name ?? `acc${i}`),
    cdpPort: Number(a.cdpPort ?? 9222 + i),
    profileDir: a.profileDir ?? path.join(LOCALAPPDATA, `dq-bridge-profile-${String(a.name ?? `acc${i}`)}`),
  }));
}
const accounts = loadAccounts();

// ---------------------------------------------------------------------------
// CDP connection per account
// ---------------------------------------------------------------------------
const CHROME_CANDIDATES = [
  ENV('DQ_CHROME', ''),
  path.join(process.env['ProgramFiles'] ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env['ProgramFiles(x86)'] ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
].filter(Boolean);

function findChrome() {
  return CHROME_CANDIDATES.find((p) => fs.existsSync(p)) ?? null;
}

function launchChrome(account) {
  const chrome = findChrome();
  if (!chrome) { log(`account ${account.name}: chrome.exe not found, start it manually on port ${account.cdpPort}`); return; }
  fs.mkdirSync(account.profileDir, { recursive: true });
  const pos = CFG.show ? '--window-position=60,60' : '--window-position=-32000,-32000';
  const args = [
    `--remote-debugging-port=${account.cdpPort}`,
    `--user-data-dir=${account.profileDir}`,
    '--no-first-run', '--no-default-browser-check',
    '--window-size=1200,900', pos,
    'https://chat.deepseek.com/',
  ];
  
  // Add proxy argument if configured
  const proxyUrl = account.proxyUrl || ENV('DQ_DEFAULT_PROXY');
  if (proxyUrl) {
    args.unshift('--ignore-certificate-errors');
    args.unshift('--allow-insecure-localhost');
    args.push(`--proxy-server=${proxyUrl}`);
    log(`account ${account.name}: will use proxy ${proxyUrl}`);
  }
  
  const child = spawn(chrome, args, { detached: true, stdio: 'ignore' });
  child.unref();
  log(`account ${account.name}: launched chrome (port ${account.cdpPort}, profile ${account.profileDir}${CFG.show ? ', on-screen' : ', off-screen'})`);
}

class Cdp {
  constructor(account) {
    this.account = account;
    this.ws = null;
    this.msgId = 0;
    this.pending = new Map();
    this.injected = false;
    this.connecting = null;
  }

  async ensureConnected() {
    if (this.ws && this.ws.readyState === 1 && this.injected) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.connect().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async findPageWsUrl() {
    let list;
    try {
      list = await fetchJson(`http://127.0.0.1:${this.account.cdpPort}/json/list`);
    } catch (e) {
      const reason = e.cause?.code ?? e.message;
      if (Date.now() - (this.lastLaunchAt ?? 0) > 60_000) {
        this.lastLaunchAt = Date.now();
        launchChrome(this.account);
      }
      throw new Error(`DQ_CDP_UNREACHABLE account=${this.account.name} (${reason})`);
    }
    const page = list.find((t) => t.type === 'page'
      && /^https:\/\/chat\.deepseek\.com/.test(t.url)
      && !String(t.url).startsWith('devtools'));
    if (page) return page.webSocketDebuggerUrl;
    const created = await fetchJson(
      `http://127.0.0.1:${this.account.cdpPort}/json/new?${encodeURIComponent('https://chat.deepseek.com/')}`,
      { method: 'PUT' },
    );
    return created.webSocketDebuggerUrl;
  }

  async connect() {
    const wsUrl = await this.findPageWsUrl();
    // Drop any previous socket first: a stale, still-open connection keeps
    // receiving Runtime.bindingCalled and would deliver every report twice.
    const prev = this.ws;
    if (prev) {
      this.ws = null;
      try { prev.onmessage = null; prev.onclose = null; prev.onerror = null; prev.close(); } catch { /* already closed */ }
    }
    this.injected = false;
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      let settled = false;
      ws.onopen = async () => {
        // A newer connect() may have superseded this socket while it opened.
        if (this.ws && this.ws !== ws) { try { ws.close(); } catch { /* noop */ } return; }
        this.ws = ws;
        try {
          await this.send('Runtime.enable');
          await this.send('Page.enable');
          await this.send('Runtime.addBinding', { name: '__dqReport' });
          await this.send('Page.addScriptToEvaluateOnNewDocument', { source: INJECT_SRC });
          await this.evaluate(`(() => { ${INJECT_SRC} ; return true; })()`);
          await this.evaluate(`window.__dqLoadWasm(${JSON.stringify(WASM_B64)})`, { awaitPromise: true });
          this.injected = true;
          if (!settled) { settled = true; resolve(); }
        } catch (e) {
          if (!settled) { settled = true; reject(e); }
        }
      };
      ws.onmessage = (ev) => {
        // Ignore events from a socket that is no longer the active one.
        if (this.ws !== ws) return;
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          msg.error ? p.reject(new Error(msg.error.message || 'DQ_CDP_ERROR')) : p.resolve(msg.result);
          return;
        }
        if (msg.method === 'Runtime.bindingCalled' && msg.params.name === '__dqReport') {
          try { onReport(JSON.parse(msg.params.payload)); } catch { /* bad payload */ }
          return;
        }
        if (msg.method === 'Runtime.executionContextsCleared') {
          this.injected = false;
          for (const p of this.pending.values()) p.reject(new Error('DQ_TAB_NAVIGATED'));
          this.pending.clear();
        }
      };
      ws.onclose = () => {
        if (this.ws !== ws) return;
        this.ws = null;
        this.injected = false;
        for (const p of this.pending.values()) p.reject(new Error('DQ_TAB_CLOSED'));
        this.pending.clear();
      };
      ws.onerror = () => {
        if (!settled) { settled = true; reject(new Error('DQ_CDP_CONNECT_FAIL')); }
      };
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) return reject(new Error('DQ_NOT_CONNECTED'));
      const id = ++this.msgId;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`DQ_CDP_TIMEOUT ${method}`));
        }
      }, 15000);
    });
  }

  async evaluate(expression, opts = {}) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: !!opts.awaitPromise,
      returnByValue: true,
    });
    if (res.exceptionDetails) throw new Error(`DQ_PAGE_EVAL_FAIL ${res.exceptionDetails.text ?? ''}`);
    return res.result?.value;
  }

  async cmd(obj) {
    await this.ensureConnected();
    const alive = await this.evaluate('window.__dqBridge === true').catch(() => false);
    if (!alive) {
      await this.evaluate(`(() => { ${INJECT_SRC} ; return true; })()`);
      await this.evaluate(`window.__dqLoadWasm(${JSON.stringify(WASM_B64)})`, { awaitPromise: true });
      this.injected = true;
    }
    this.send('Runtime.evaluate', {
      expression: `window.__dqCmd(${JSON.stringify(JSON.stringify(obj))})`,
      awaitPromise: false,
      returnByValue: false,
    }).catch(() => { /* result arrives via binding or watchdog */ });
  }
}

const cdps = new Map(accounts.map((a) => [a.name, new Cdp(a)]));
const accountOf = (name) => accounts.find((a) => a.name === name);

// Report routing: one-shot waiters (status/session) and streaming jobs.
const reportWaiters = new Map(); // id -> fn(ev)
const activeCmds = new Map();    // completion cmdId -> job

function onReport(ev) {
  const waiter = reportWaiters.get(ev.id);
  if (waiter) { waiter(ev); return; }
  const job = activeCmds.get(ev.id);
  if (job) job.onEvent?.(ev);
}

function awaitReport(id, timeoutMs, timeoutError) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reportWaiters.delete(id);
      reject(new Error(timeoutError));
    }, timeoutMs);
    reportWaiters.set(id, (ev) => {
      clearTimeout(timer);
      reportWaiters.delete(id);
      ev.type === 'error' ? reject(new Error(ev.error || 'DQ_PAGE_ERROR')) : resolve(ev);
    });
  });
}

async function pageStatus(accountName) {
  const id = `st${crypto.randomBytes(4).toString('hex')}`;
  const idUser = id + ':u';
  const p1 = (async () => { await cdps.get(accountName).cmd({ op: 'status', id }); return awaitReport(id, 8000, 'DQ_STATUS_TIMEOUT'); })();
  const p2 = awaitReport(idUser, 9000, 'DQ_NO_USER').catch(() => null);
  const [st] = await Promise.all([p1, p2]);
  st.displayName = (await p2)?.displayName ?? null;
  return st;
}

async function newSessionViaPage(accountName) {
  const id = `ns${crypto.randomBytes(4).toString('hex')}`;
  await cdps.get(accountName).cmd({ op: 'newSession', id });
  const ev = await awaitReport(id, 20000, 'DQ_SESSION_TIMEOUT');
  return ev.sessionId;
}

// Ask DeepSeek to stop the in-flight generation of a message (web UI stop
// button): POST /api/v0/chat/stop_stream {chat_session_id, message_id}.
async function stopStreamViaPage(account, sessionId, messageId) {
  const id = `sp${crypto.randomBytes(4).toString('hex')}`;
  await cdps.get(account).cmd({ op: 'stopStream', id, sessionId, messageId });
  const ev = await awaitReport(id, 15000, 'DQ_STOP_TIMEOUT');
  return ev.status;
}

// Web UI "delete conversation": POST /api/v0/chat_session/delete
// {chat_session_ids: [...]} (batch), biz_code 0 = success. No PoW on this route.
async function deleteSessionsViaPage(account, sessionIds) {
  const id = `dl${crypto.randomBytes(4).toString('hex')}`;
  await cdps.get(account).cmd({ op: 'deleteSessions', id, ids: sessionIds });
  return await awaitReport(id, 15000, 'DQ_DELETE_TIMEOUT'); // {type:'deleted', status, biz}
}

// Web session list for the dashboard sweeper: GET fetch_page, cursor pagination.
async function listSessionsViaPage(account) {
  const id = `ls${crypto.randomBytes(4).toString('hex')}`;
  await cdps.get(account).cmd({ op: 'listSessions', id });
  const ev = await awaitReport(id, 30000, 'DQ_LIST_TIMEOUT');
  return ev.sessions ?? [];
}

// Calculate a health score (0-100) for an account based on recent performance.
function calculateAccountScore(th, h) {
  // Start from perfect score and deduct based on risk factors
  let score = 100;
  
  // 1. Daily usage ratio (40% weight): using too many requests per day = risky
  const usageRatio = CFG.maxPerDay > 0 ? th.dayCount / CFG.maxPerDay : 0;
  if (usageRatio > 0.9) score -= 25; // >90% used → dangerous
  else if (usageRatio > 0.7) score -= 15; // >70% → caution
  else if (usageRatio > 0.5) score -= 5; // >50% → mild
  
  // 2. Consecutive failures or soft throttle hits (30% weight)
  if (th.authFailStreak >= 3) score -= 30;
  else if (th.authFailStreak >= 1) score -= 15;
  if (th.softThrottleHit && Date.now() - th.softThrottleTime < 600000) {
    // within 10min of soft throttle → significant penalty
    score -= 20;
  } else if (th.coolUntil > Date.now()) {
    score -= 10;
  }
  
  // 3. Last error time recency (20% weight): recent errors = worse
  // (simplified: use consecutiveSuccess instead)
  if (th.consecutiveSuccess === 0) score -= 10; // no success streak yet
  else if (th.consecutiveSuccess >= 5) score += 5; // bonus for good streak
  
  // 4. Dead/cooling state (10% weight)
  if (th.dead) score = 0; // immediate zero
  else if (th.coolUntil > Date.now()) score -= 5;
  
  return Math.max(0, Math.min(100, Math.round(score)));
}

// Web UI file attach: POST /api/v0/file/upload_file (multipart, PoW signed for
// the upload route). biz_data carries the file id; DeepSeek audits content
// server-side — an audited-out file surfaces as a completion error later.
async function uploadFileViaPage(account, file) {
  const id = `uf${crypto.randomBytes(4).toString('hex')}`;
  await cdps.get(account).cmd({ op: 'uploadFile', id, name: file.name, mime: file.mime, b64: file.b64 });
  const ev = await awaitReport(id, 120000, 'DQ_UPLOAD_TIMEOUT');
  if (!ev.file) throw new Error(`DQ_UPLOAD_FAIL ${ev.status ?? ''} ${ev.error ?? ''}`.trim());
  const bd = ev.file;
  const fid = bd.id ?? bd.file_id ?? bd.file_info?.id ?? bd.fileInfo?.id;
  if (!fid) throw new Error(`DQ_UPLOAD_NO_ID ${JSON.stringify(bd).slice(0, 200)}`);
  return { id: String(fid), audit: String(bd.audit_result ?? bd.auditResult ?? 'unknown'), retryable: bd.retryable !== false };
}

// Poll file audit states: GET /api/v0/file/fetch_files?file_ids=a,b
async function fetchFilesViaPage(account, ids) {
  const id = `ff${crypto.randomBytes(4).toString('hex')}`;
  await cdps.get(account).cmd({ op: 'fetchFiles', id, ids });
  const ev = await awaitReport(id, 15000, 'DQ_FILES_TIMEOUT');
  return ev.files ?? [];
}

// Resolve an attachment (data: URL or http(s) URL) to bytes and upload it.
const ATTACH_MAX_B64 = 24 * 1024 * 1024; // ~18MB binary
async function uploadAttachmentToPage(account, att) {
  let mime = att.kind === 'image' ? 'image/png' : 'application/octet-stream';
  let name = att.name ?? (att.kind === 'image' ? 'image.png' : 'file');
  let b64;
  if (typeof att.url === 'string' && att.url.startsWith('data:')) {
    const m = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(att.url);
    if (!m) throw new Error('DQ_ATTACH_BAD_DATA_URL');
    if (m[1]) mime = m[1];
    b64 = m[2] ? m[3] : Buffer.from(decodeURIComponent(m[3]), 'binary').toString('base64');
    if (!att.name && /^image\//.test(mime)) name = 'image.' + mime.split('/')[1];
  } else if (typeof att.url === 'string' && /^https?:\/\//.test(att.url)) {
    const r = await fetch(att.url);
    if (!r.ok) throw new Error(`DQ_ATTACH_FETCH_${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    mime = r.headers.get('content-type')?.split(';')[0] || mime;
    b64 = buf.toString('base64');
    if (!att.name) name = new URL(att.url).pathname.split('/').pop() || name;
  } else throw new Error('DQ_ATTACH_UNSUPPORTED');
  if (b64.length > ATTACH_MAX_B64) throw new Error('DQ_ATTACH_TOO_LARGE');

  // Content-hash cache: same bytes reuse the already-audited file id.
  const sha = crypto.createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex');
  const cacheKey = `${account}/${sha}`;
  const cached = fileCache.get(cacheKey);
  if (cached) { cached.at = Date.now(); saveFileCache(); return { id: cached.id }; }

  // Upload -> wait for the audit to settle -> use. audit_result: pass | reject
  // | unknown (still auditing). The server flags each rejection retryable or
  // not; retryable ones get re-uploaded (bounded), final ones error out.
  for (let attempt = 0; ; attempt++) {
    const f = await uploadFileViaPage(account, { name, mime, b64 });
    const deadline = Date.now() + CFG.fileAuditTimeoutMs;
    let audit = f.audit;
    let retryable = true;
    while (audit === 'unknown' && Date.now() < deadline) {
      await sleep(CFG.fileAuditPollMs);
      const infos = await fetchFilesViaPage(account, [f.id]).catch(() => []);
      const info = infos.find((x) => String(x?.id) === f.id);
      audit = String(info?.audit_result ?? info?.auditResult ?? 'unknown');
      retryable = info?.retryable !== false;
    }
    if (audit === 'pass' || audit === 'unknown') { // unknown past deadline: try it anyway
      fileCache.set(cacheKey, { id: f.id, at: Date.now(), name, bytes: Buffer.from(b64, 'base64').length });
      while (fileCache.size > 200) {
        const oldest = [...fileCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        fileCache.delete(oldest[0]);
      }
      saveFileCache();
      return { id: f.id };
    }
    if (audit !== 'reject') throw new Error(`DQ_FILE_AUDIT_TIMEOUT (${name})`);
    if (!retryable || attempt >= 2) {
      throw new Error(`DQ_FILE_AUDIT_REJECTED${retryable ? '' : '_FINAL'} (${name})`);
    }
    log(`file audit rejected (retryable=${retryable}, attempt=${attempt + 1}) — re-uploading: ${name}`);
    await sleep(3000);
  }
}

// ---------------------------------------------------------------------------
// Per-account pacing + health
// ---------------------------------------------------------------------------
class AccountThrottle {
  constructor() {
    this.hourWindow = [];
    this.dayCount = 0;
    this.dayKey = new Date().toDateString();
    this.lastDone = 0;
    this.authFailStreak = 0;
    this.dead = false;          // set after repeated auth rejections (needs re-login)
    this.coolUntil = 0;         // pow/network cooldown
    // Smart throttling: track recent behavior pattern
    this.requestTimes = [];     // last 20 request timestamps for smoothing
    this.consecutiveSuccess = 0;
    this.lastOk = true;         // track previous request outcome
    this.softThrottleHit = false;
  }

  parseQuiet() {
    if (!CFG.quietHours) return null;
    const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(CFG.quietHours.trim());
    if (!m) return null;
    return { from: Number(m[1]) * 60 + Number(m[2]), to: Number(m[3]) * 60 + Number(m[4]) };
  }

  quietWaitMs(now = new Date()) {
    const q = this.parseQuiet();
    if (!q) return 0;
    const mins = now.getHours() * 60 + now.getMinutes();
    const inQuiet = q.from <= q.to
      ? (mins >= q.from && mins < q.to)
      : (mins >= q.from || mins < q.to);
    if (!inQuiet) return 0;
    return ((q.to - mins + 1440) % 1440) * 60_000 + 30_000;
  }

  async gate(signal) {
    for (;;) {
      if (signal?.aborted) throw new Error('DQ_CLIENT_CLOSED');
      if (this.dead) throw new Error('DQ_ACCOUNT_DEAD');
      const cool = this.coolUntil - Date.now();
      if (cool > 0) { await sleep(cool, signal); continue; }

      const today = new Date().toDateString();
      if (today !== this.dayKey) { this.dayKey = today; this.dayCount = 0; }
      if (CFG.maxPerDay > 0 && this.dayCount >= CFG.maxPerDay) throw new Error('DQ_DAILY_LIMIT_REACHED');

      const qWait = this.quietWaitMs();
      if (qWait > 0) { log(`quiet hours, waiting ${Math.round(qWait / 60000)}min`); await sleep(qWait, signal); continue; }

      const now = Date.now();
      this.hourWindow = this.hourWindow.filter((t) => now - t < 3600_000);
      if (this.hourWindow.length >= CFG.maxPerHour) {
        const waitMs = 3600_000 - (now - this.hourWindow[0]) + 1000;
        log(`hourly limit ${CFG.maxPerHour} reached, waiting ${Math.round(waitMs / 1000)}s`);
        await sleep(waitMs, signal);
        continue;
      }

      // === SMART THROTTLING: DYNAMIC INTERVAL BASED ON BEHAVIOR PATTERN ===
      // Keep last 20 requests for smoothing
      this.requestTimes.push(now);
      if (this.requestTimes.length > 20) this.requestTimes.shift();
      
      // Calculate base gap with adaptive jitter (more natural than fixed intervals)
      let baseGap = CFG.minGapMs;
      let jitter = CFG.jitterMs;
      
      // If soft throttle hit recently → extend to 30~60 seconds
      if (this.softThrottleHit) {
        const timeSinceSoftThrottle = now - this.softThrottleTime;
        if (timeSinceSoftThrottle < 600000) { // within 10min of soft throttle
          baseGap = 30000 + Math.random() * 30000; // 30-60s
        } else {
          this.softThrottleHit = false; // recovered after 10min
        }
      }
      // If consecutive success (>5), gradually reduce interval (simulate human acceleration)
      else if (this.consecutiveSuccess >= 5) {
        baseGap = Math.max(6000, baseGap - (this.consecutiveSuccess - 4) * 500); // max reduce 1s
        jitter = Math.floor(jitter * 0.8); // also reduce variance slightly
      }
      // If failed last request → increase interval by 5s
      else if (!this.lastOk) {
        baseGap += 5000;
      }
      
      const dynamicInterval = baseGap + Math.random() * jitter;
      
      const since = now - this.lastDone;
      if (this.lastDone && since < dynamicInterval) { 
        const waitTime = dynamicInterval - since;
        log(`smart throttle: waiting ${Math.round(waitTime/1000)}s (dynamic=${Math.round(dynamicInterval/1000)}s, success=${this.consecutiveSuccess})`);
        await sleep(waitTime, signal); 
        continue; 
      }

      this.hourWindow.push(Date.now());
      this.dayCount += 1;
      return;
    }
  }

  done(ok, error) {
    this.lastDone = Date.now();
    this.lastOk = ok; // track previous request outcome
    
    if (ok) { 
      this.authFailStreak = 0;
      this.consecutiveSuccess += 1;
      return; 
    }
    
    // Track soft throttle hits for adaptive backoff
    if (String(error ?? '').includes('DQ_SOFT_THROTTLED')) {
      this.softThrottleHit = true;
      this.softThrottleTime = Date.now();
      this.consecutiveSuccess = 0;
    } else {
      this.consecutiveSuccess = 0;
    }
    
    const code = String(error ?? '').split(' ')[0];
    if (String(error ?? '').includes('INVALID_TARGET_PATH')) {
      this.authFailStreak = 0; // param bug, not risk-control — do not cool down
    } else if (code === 'DQ_AUTH_401' || code === 'DQ_AUTH_403' || code === 'DQ_NO_TOKEN') {
      this.authFailStreak += 1;
      if (this.authFailStreak >= CFG.authFailLimit) {
        this.dead = true;
        log(`account marked DEAD (${this.authFailStreak}x auth failures) — log in again to revive`);
      }
    } else if (code.startsWith('DQ_POW') || code === 'DQ_COMPLETION_HTTP_429') {
      // risk-control pressure on this account: back off, don't hammer
      this.coolUntil = Date.now() + 5 * 60_000;
      log('risk-control cooldown 5min');
    }
  }
}

const throttles = new Map(accounts.map((a) => [a.name, new AccountThrottle()]));

// Select the account that has been idle the longest (ds-free-api rotation policy).
function pickAccount() {
  const live = accounts.filter((a) => !throttles.get(a.name).dead);
  if (live.length === 0) return null;
  return live.sort((a, b) => throttles.get(a.name).lastDone - throttles.get(b.name).lastDone)[0].name;
}

// ---------------------------------------------------------------------------
// Session reuse — per account: prefix hash -> {sessionId, parentId}
// Persisted to sessions.json so a bridge restart keeps the mappings.
// ---------------------------------------------------------------------------
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');
const sessions = new Map(); // account -> Map(key -> {sessionId, parentId, at})

function loadSessions() {
  try {
    const raw = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    const now = Date.now();
    for (const [account, entries] of Object.entries(raw)) {
      const store = sessionStore(account);
      for (const [key, hit] of Object.entries(entries)) {
        if (now - hit.at <= CFG.sessionTtlMs) store.set(key, hit);
      }
    }
    if (sessions.size) log(`sessions restored: ${[...sessions.values()].reduce((n, m) => n + m.size, 0)}`);
  } catch { /* first run or corrupt file */ }
}
let saveTimer = null;
function writeSessionsSync() {
  const out = {};
  for (const [account, store] of sessions) {
    if (store.size) out[account] = Object.fromEntries(store);
  }
  try { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(out)); } catch { /* read-only fs, ignore */ }
}
function saveSessions() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeSessionsSync, 500);
}

// Uploaded-file id cache: sha256(content) -> file id. Agent loops re-send the
// same screenshots every turn; the cache skips re-upload AND re-audit.
const FILES_FILE = path.join(__dirname, 'files.json');
const fileCache = new Map(); // `${account}/${sha256}` -> {id, at}
function loadFileCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILES_FILE, 'utf8'));
    const now = Date.now();
    for (const [k, v] of Object.entries(raw)) {
      if (now - v.at <= CFG.fileCacheTtlMs) fileCache.set(k, v);
    }
    if (fileCache.size) log(`file cache restored: ${fileCache.size}`);
  } catch { /* first run */ }
}
let fileSaveTimer = null;
function saveFileCache() {
  clearTimeout(fileSaveTimer);
  fileSaveTimer = setTimeout(() => {
    const out = {};
    for (const [k, v] of fileCache) out[k] = v;
    try { fs.writeFileSync(FILES_FILE, JSON.stringify(out)); } catch { /* ignore */ }
  }, 500);
}

function sessionStore(account) {
  let m = sessions.get(account);
  if (!m) { m = new Map(); sessions.set(account, m); }
  return m;
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (p && typeof p === 'object' && typeof p.text === 'string' ? p.text : '')).join('');
  }
  return '';
}
const normMessage = (m, atts, mi) => {
  const content = m?.content;
  if (Array.isArray(content) && atts) {
    // OpenAI multimodal parts: images/files become page uploads (ref_file_ids);
    // only text survives into the transcript prompt.
    const texts = [];
    for (const p of content) {
      if (p?.type === 'image_url' && typeof p.image_url?.url === 'string') {
        atts.push({ kind: 'image', url: p.image_url.url, mi });
        texts.push('[图片已附上]');
      } else if (p?.type === 'file' && typeof p.file?.file_data === 'string') {
        atts.push({ kind: 'file', name: String(p.file?.filename ?? 'file'), url: p.file.file_data, mi });
        texts.push(`[文件已附上: ${p.file?.filename ?? 'file'}]`);
      } else if (typeof p?.text === 'string') texts.push(p.text);
    }
    return { role: String(m?.role ?? 'user'), content: texts.join('\n') };
  }
  return { role: String(m?.role ?? 'user'), content: contentToText(content) };
};

// Normalize an OpenAI messages array, resolving tool_call_id -> tool name so
// `tool` result messages can be rendered next to their calls.
function normMessages(msgsRaw, atts) {
  const out = [];
  const toolNameById = new Map();
  for (const m of msgsRaw) {
    if (m?.role === 'assistant' && Array.isArray(m?.tool_calls)) {
      const calls = m.tool_calls.map((c, i) => ({
        id: String(c?.id ?? `call_${i}`),
        name: String(c?.function?.name ?? ''),
        argumentsJson: typeof c?.function?.arguments === 'string'
          ? c.function.arguments
          : JSON.stringify(c?.function?.arguments ?? {}),
      })).filter((c) => c.name);
      for (const c of calls) toolNameById.set(c.id, c.name);
      out.push({ role: 'assistant', content: contentToText(m?.content), toolCalls: calls });
      continue;
    }
    if (m?.role === 'tool') {
      out.push({
        role: 'tool',
        content: contentToText(m?.content),
        toolName: m._toolName ?? toolNameById.get(String(m?.tool_call_id ?? '')) ?? 'tool',
      });
      continue;
    }
    out.push(normMessage(m, atts, out.length));
  }
  return out;
}

// ---------------------------------------------------------------------------
// v2 tool calling — XML protocol ported from deepseek-pp core/prompt/augmentation.ts
// (### Tool schema blocks + system rules), core/interceptor/tool-parser.ts
// (<name>{json}</name>), and the i18n toolFormatReminder. The bridge translates
// OpenAI tools <-> XML; ALL tool execution stays client-side (standard
// function calling). No server-side builtin tools.
// ---------------------------------------------------------------------------
const TOOL_RULES = [
  'You have access to a set of tools. To call a tool, output an XML block with the tool name itself as the tag and a JSON object as the body, exactly like this:',
  '',
  '<tool_name>',
  '{"param": "value"}',
  '</tool_name>',
  '',
  'The JSON body MUST be valid JSON on its own. Do NOT add any other text inside the tags, only JSON. Use forward slashes or escaped backslashes for local file paths. You can place tool calls anywhere in your reply (not only at the end).',
  'The system only executes direct tool-name tags. Never use wrapper formats such as <invoke name="tool_name">...</invoke> or <tool_call>...</tool_call>.',
  'The tag name MUST exactly match one of the available tool names.',
  'If a tool is listed in Available Tools, it is connected and you can call it by emitting the XML tag. Do NOT say you cannot call listed tools.',
  'Never output pseudo tool-call JSON such as {"tool":"name","arguments":{...}} in a Markdown code block. That is explanation text, not an executable call.',
  'Never place executable tool XML in a thinking/reasoning section. Put tool XML in the final assistant answer content so the system can execute it.',
].join('\n');

const TOOL_FORMAT_REMINDER = [
  '---',
  '工具调用格式提醒：',
  '可用工具标签名：{names}',
  '这些工具已连接，可以执行。不要声称自己无法调用列表中的工具。',
  '调用工具时，只能使用与工具名一致的直接 XML 标签，并把合法 JSON 放在标签体内。',
  '不要使用 <invoke name="...">、<tool_call>、Markdown 代码块、{"tool":"...","arguments":{...}} 或任何包装格式。',
].join('\n');

function buildToolSection(tools) {
  const defs = (tools ?? []).map((t) => t?.function).filter((d) => d && d.name);
  if (!defs.length) return null;
  const schemas = defs.map((d) => {
    const props = d.parameters?.properties ?? {};
    const required = d.parameters?.required ?? Object.keys(props);
    const example = {};
    for (const k of required) {
      const s = props[k];
      example[k] = s?.type === 'number' || s?.type === 'integer' ? 0
        : s?.type === 'boolean' ? false
        : s?.type === 'array' ? []
        : s?.type === 'object' ? {}
        : 'value';
    }
    return [
      `### Tool ${d.name}`,
      d.description ? `Description: ${d.description}` : '',
      `Valid call format for ${d.name}:`,
      `<${d.name}>`,
      JSON.stringify(example, null, 2),
      `</${d.name}>`,
      d.parameters ? `Parameters JSON Schema: ${JSON.stringify(d.parameters)}` : '',
    ].filter(Boolean).join('\n');
  }).join('\n\n');
  const guidance = '';
  return [
    '# Tools',
    '',
    TOOL_RULES,
    '',
    '### Available Tools',
    '',
    schemas,
    guidance,
    '',
    'You MUST strictly follow the above defined tool name and parameter schemas to invoke tool calls.',
  ].join('\n');
}

function toolReminder(names) {
  if (!names?.length) return '';
  return '\n\n' + TOOL_FORMAT_REMINDER.replace('{names}', names.join(', '));
}

function joinTranscript(msgs, tools) {
  const toolSection = buildToolSection(tools);
  const sys = msgs.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const rest = msgs
    .filter((m) => m.role !== 'system')
    .map((m) => {
      if (m.role === 'assistant' && m.toolCalls?.length) {
        const tags = m.toolCalls.map((c) => `<${c.name}>${c.argumentsJson}</${c.name}>`).join('\n');
        return `[assistant]\n${m.content ? m.content + '\n' : ''}${tags}`;
      }
      if (m.role === 'tool') {
        return `<tool_result name="${m.toolName ?? 'tool'}">\n${m.content}\n</tool_result>`;
      }
      return `${m.role === 'assistant' ? '[assistant]' : '[user]'}\n${m.content}`;
    })
    .join('\n\n');
  const head = (sys || toolSection)
    ? `[System instructions]\n${[sys, toolSection].filter(Boolean).join('\n\n')}\n[/System instructions]\n\n`
    : '';
  // deepseek-pp appends the format reminder after the user prompt (recency
  // bias measurably improves tag compliance).
  const reminder = toolSection
    ? toolReminder((tools ?? []).map((t) => t?.function?.name).filter(Boolean))
    : '';
  return head + rest + reminder;
}

// Parse the inside of a tool tag into an arguments object. The model emits
// either a JSON body (`<name>{"q":"x"}</name>`) or one nested tag per parameter
// (`<name><path>p</path><content>c</content></name>`) — the latter is common for
// multi-argument tools, so handle both instead of dumping it into _unparsed.
function parseToolArgs(body) {
  const s = String(body ?? '').trim();
  if (!s) return {};
  if (s.startsWith('{') || s.startsWith('[')) {
    try { return JSON.parse(s); } catch { /* fall through to tag parsing */ }
  }
  const args = {};
  const tagRe = /<([A-Za-z_][A-Za-z0-9_.:-]*)\s*>([\s\S]*?)<\/\1>/g;
  let m, matched = false;
  while ((m = tagRe.exec(s)) !== null) {
    matched = true;
    const key = m[1];
    let val = m[2].trim();
    // A parameter that itself holds JSON (arrays/objects) round-trips as JSON.
    if ((val.startsWith('{') && val.endsWith('}')) || (val.startsWith('[') && val.endsWith(']'))) {
      try { val = JSON.parse(val); } catch { /* keep as string */ }
    }
    args[key] = val;
  }
  return matched ? args : { _unparsed: s };
}

// Linear scanner turning model text into {content, toolCalls}, buffering
// partial tool tags while streaming (port of deepseek-pp tool-parser semantics:
// `<name>{json}</name>` with name in the catalog; unknown tags pass through).
function createToolStreamFilter(toolNames) {
  const names = [...toolNames];
  if (!names.length) return null;
  const nameSet = new Set(names);
  const namePrefixRe = /^<\/?([A-Za-z_][A-Za-z0-9_.:-]*)?$/;
  const calls = [];
  let pending = '';

  const isToolNamePrefix = (s) => names.some((n) => n === s || n.startsWith(s));

  // Consume `pending`; return safe-to-emit content, hold incomplete tails.
  function scan(final) {
    let pos = 0;
    let emit = '';
    for (;;) {
      const lt = pending.indexOf('<', pos);
      if (lt === -1) { emit += pending.slice(pos); pos = pending.length; break; }
      const rest = pending.slice(lt);
      const complete = /^<\/?([A-Za-z_][A-Za-z0-9_.:-]*)\s*>/.exec(rest);
      if (complete) {
        const name = complete[1];
        const isOpenTool = !complete[0].startsWith('</') && nameSet.has(name);
        if (isOpenTool) {
          const close = pending.indexOf(`</${name}>`, lt + complete[0].length);
          if (close === -1) {
            // call still streaming in — hold from the open tag
            if (final) { emit += rest; pos = pending.length; break; }
            emit += pending.slice(pos, lt);
            pending = pending.slice(lt);
            return emit;
          }
          const body = pending.slice(lt + complete[0].length, close).trim();
          calls.push({ name, args: parseToolArgs(body) });
          emit += pending.slice(pos, lt);
          pos = close + name.length + 3;
          continue;
        }
        // non-tool tag: plain text, emit whole tag
        emit += pending.slice(pos, lt) + complete[0];
        pos = lt + complete[0].length;
        continue;
      }
      const partial = namePrefixRe.test(rest) && isToolNamePrefix(rest.replace(/^<\/?/, ''));
      if (partial && !final) {
        emit += pending.slice(pos, lt);
        pending = pending.slice(lt);
        return emit;
      }
      // unrelated '<': emit it, move on
      emit += pending.slice(pos, lt + 1);
      pos = lt + 1;
    }
    pending = pending.slice(pos);
    return emit;
  }

  return {
    push(text) { pending += text; return scan(false); },
    flush() { const out = scan(true); const tail = pending; pending = ''; return out + tail; },
    calls,
  };
}

const hashKey = (msgs) => crypto.createHash('sha256').update(JSON.stringify(msgs)).digest('hex').slice(0, 24);

function lookupSession(account, prefix) {
  if (!prefix.length) return null;
  const store = sessionStore(account);
  const key = hashKey(prefix);
  const hit = store.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CFG.sessionTtlMs) { store.delete(key); return null; }
  hit.at = Date.now();
  return hit;
}

// --- Web-session retirement ------------------------------------------------
// A bridge-created DeepSeek web session is garbage once none of its mapping
// entries has been hit for sessionDeleteTtlMs (one entry per conversation
// turn; early entries age out first, so retirement needs the freshest entry,
// not per-entry expiry). Fail-safe per design: call the web delete API FIRST
// and drop local mapping entries ONLY on confirmed success (HTTP 200 +
// biz_code 0). On failure everything is kept and retried with backoff, so a
// mapping never points at a session we failed to remove.
const deleteQueue = new Map(); // `${account}/${sessionId}` -> {account, sessionId, retryAt, attempts}

function enqueueRetire(account, sessionId) {
  const gk = `${account}/${sessionId}`;
  if (!deleteQueue.has(gk)) deleteQueue.set(gk, { account, sessionId, retryAt: 0, attempts: 0 });
}

function scanRetireCandidates() {
  if (CFG.sessionDeleteTtlMs <= 0) return;
  const now = Date.now();
  const newestAt = new Map(); // `${account}/${sessionId}` -> freshest mapping hit
  for (const [account, store] of sessions) {
    for (const hit of store.values()) {
      const gk = `${account}/${hit.sessionId}`;
      if (hit.at > (newestAt.get(gk) ?? 0)) newestAt.set(gk, hit.at);
    }
  }
  for (const [gk, at] of newestAt) {
    if (now - at >= CFG.sessionDeleteTtlMs) {
      const slash = gk.indexOf('/');
      enqueueRetire(gk.slice(0, slash), gk.slice(slash + 1));
    }
  }
}

async function sweepRetire() {
  try { scanRetireCandidates(); } catch { /* rescan next round */ }
  const now = Date.now();
  const byAccount = new Map();
  for (const it of deleteQueue.values()) {
    if (it.retryAt > now) continue;
    if (!byAccount.has(it.account)) byAccount.set(it.account, []);
    byAccount.get(it.account).push(it);
  }
  for (const [account, items] of byAccount) {
    const cdp = cdps.get(account);
    // Browser down or not yet re-injected: skip quietly, never launch Chrome
    // just to clean up. Items wait for a later sweep.
    if (!cdp || !(cdp.ws && cdp.ws.readyState === 1 && cdp.injected)) continue;
    try {
      const ev = await deleteSessionsViaPage(account, items.map((it) => it.sessionId));
      if (ev.status === 200 && ev.biz === 0) {
        const store = sessionStore(account);
        for (const it of items) {
          for (const [k, hit] of [...store]) if (hit.sessionId === it.sessionId) store.delete(k);
          deleteQueue.delete(`${account}/${it.sessionId}`);
          log(`retired web session ${it.sessionId.slice(0, 8)} [${account}]`);
        }
        saveSessions();
      } else {
        for (const it of items) {
          it.attempts += 1;
          it.retryAt = now + Math.min(30 * 60_000 * 2 ** it.attempts, 24 * 3600_000);
        }
        log(`retire batch [${account}] not confirmed (http=${ev.status} biz=${ev.biz}) — mappings kept, ${items.length} session(s) back off`);
      }
    } catch (e) {
      for (const it of items) {
        it.attempts += 1;
        it.retryAt = now + Math.min(30 * 60_000 * 2 ** it.attempts, 24 * 3600_000);
      }
      log(`retire batch [${account}] error: ${e.message} — mappings kept, back off`);
    }
  }
}
setInterval(sweepRetire, CFG.sessionSweepMs);

function rememberSession(account, prefix, sessionId, parentId, ids = {}) {
  if (!prefix.length) return;
  const store = sessionStore(account);
  store.set(hashKey(prefix), { sessionId, parentId, at: Date.now(), ...ids });
  const evicted = [];
  while (store.size > CFG.sessionMax) {
    const oldest = [...store.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    store.delete(oldest[0]);
    evicted.push(oldest[1]);
  }
  // LRU-evicted entries leave their web session unreachable via the store;
  // queue it for retirement unless another entry still references it. The
  // same inactivity rule applies: an entry evicted while still fresh means
  // the session was active too recently to retire.
  const evictedMaxAt = new Map();
  for (const hit of evicted) {
    if (hit.at > (evictedMaxAt.get(hit.sessionId) ?? 0)) evictedMaxAt.set(hit.sessionId, hit.at);
  }
  for (const [sid, at] of evictedMaxAt) {
    if (sid === sessionId) continue;
    if (Date.now() - at < CFG.sessionDeleteTtlMs) continue;
    let refs = 0;
    for (const hit of store.values()) if (hit.sessionId === sid) refs += 1;
    if (!refs) enqueueRetire(account, sid);
  }
  saveSessions();
}

// ---------------------------------------------------------------------------
// Job queue, worker pool, per-session serialization
// ---------------------------------------------------------------------------
const queue = [];
let active = 0;
const sessionLocks = new Map(); // `${account}/${sessionId}` -> promise tail
const sessionLastDone = new Map(); // `${account}/${sessionId}` -> last completion ts
const generatingBySession = new Map(); // `${account}/${sessionId}` -> in-flight job

function withSessionLock(lockKey, fn) {
  const prev = sessionLocks.get(lockKey) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  sessionLocks.set(lockKey, run.catch(() => {}));
  return run;
}

function finishJob(job, messageId) {
  if (job.finished) return;
  job.finished = true;
  if (job.cmdId) activeCmds.delete(job.cmdId);
  clearTimeout(job.watchdog);
  clearTimeout(job.graceStopFallback);
  job.releaseSlot?.();   // free the concurrency slot without waiting on the lock chain
  throttles.get(job.account)?.done(true);
  const consumed = job.usedDelta ? job.prefix : job.messages;
  rememberSession(
    job.account,
    [...consumed, { role: 'assistant', content: job.text }],
    job.sessionId,
    Number.isInteger(messageId) ? messageId : job.parentId,
    { lastAssistantId: Number.isInteger(messageId) ? messageId : job.responseMessageId,
      lastUserId: job.requestMessageId },
  );
  recordRequest(job);
  log(`complete [${job.account}] sess=${job.sessionId.slice(0, 8)} ${job.usedDelta ? 'delta' : 'full'} msgs=${job.messages.length} in=${job.prompt.length}c out=${job.text.length}c${job.reasoning ? ` think=${job.reasoning.length}c` : ''}${job.toolCalls?.length ? ` tool_calls=${job.toolCalls.length}` : ''}`);
  // Webhook: request completed successfully
  sendWebhook('request_complete', {
    account: job.account,
    sessionId: job.sessionId.slice(0, 8),
    mode: job.usedDelta ? 'delta' : 'full',
    promptChars: job.prompt.length,
    outputChars: job.text.length,
    reasoningChars: job.reasoning?.length ?? 0,
    tools: job.toolCalls?.length ?? 0,
    elapsedMs: job.roundDoneAt && job.startedAt ? job.roundDoneAt - job.startedAt : null,
  });
  job.resolveSend?.();
  job.settle?.();
}

function failJob(job, error) {
  if (job.finished) return;
  job.finished = true;
  job.error = String(error || 'DQ_UNKNOWN');
  if (job.cmdId) activeCmds.delete(job.cmdId);
  clearTimeout(job.watchdog);
  clearTimeout(job.graceStopFallback);
  clearTimeout(job.softTimer); job.softTimer = null;
  throttles.get(job.account)?.done(false, job.error);
  if (job.startedAt) recordRequest(job);
  log(`fail [${job.account ?? '?'}] sess=${String(job.sessionId ?? '').slice(0, 8)} ${job.error}`);
  // A job that fails while still QUEUED (e.g. the client disconnected before it
  // was ever dispatched) leaves queue.length permanently occupied, and pump()
  // only runs when a *running* job settles — so the queue would never drain.
  // Drop finished entries and refill slots here.
  const before = queue.length;
  if (before && queue.some((q) => q.finished || q.abortController.signal.aborted)) {
    for (let i = queue.length - 1; i >= 0; i--) {
      const q = queue[i];
      if (q.finished || q.abortController.signal.aborted) queue.splice(i, 1);
    }
    if (queue.length !== before) log(`queue drained ${before - queue.length} abandoned job(s) — ${queue.length} remaining`);
  }
  // Webhook: request failed
  sendWebhook('request_failed', {
    account: job.account,
    sessionId: String(job.sessionId ?? '').slice(0, 8),
    error: job.error,
  });
  job.resolveSend?.();
  job.settle?.();
  // Release the concurrency slot now: this job may be parked inside the session
  // lock (its own .finally can be delayed arbitrarily long behind that chain),
  // and holding the slot would starve the queue. Idempotent — a later
  // runWithRotation finally is a no-op.
  job.releaseSlot?.();
  // Last: refill freed slots now that this job has fully settled.
  pump();
}

function sendComplete(job) {
  return new Promise((resolve) => {
    job.startedAt = Date.now();
    const cmdId = `c${crypto.randomBytes(6).toString('hex')}`;
    activeCmds.set(cmdId, job);
    job.cmdId = cmdId;
    job.resolveSend = resolve;
    // Per-round cleanup: runs on EVERY completion round,
    // not just when the whole job settles.
    const cleanupRound = () => {
      if (job.cmdId) activeCmds.delete(job.cmdId);
      clearTimeout(job.watchdog);
      job.roundDoneAt = Date.now();
      if (job.sessionId) {
        sessionLastDone.set(`${job.account}/${job.sessionId}`, job.roundDoneAt);
        const gKey = `${job.account}/${job.sessionId}`;
        if (generatingBySession.get(gKey) === job) generatingBySession.delete(gKey);
        const store = sessionStore(job.account);
        for (const [, hit] of store) {
          if (hit.sessionId !== job.sessionId) continue;
          if (Number.isInteger(job.responseMessageId)) hit.lastAssistantId = job.responseMessageId;
          if (Number.isInteger(job.requestMessageId)) hit.lastUserId = job.requestMessageId;
        }
      }
      throttles.get(job.account)?.done(!job.error, job.error);
    };
    if (job.sessionId) generatingBySession.set(`${job.account}/${job.sessionId}`, job);
    job.onEvent = (ev) => {
      if (ev.id !== cmdId || job.finished) return;
      if (ev.type === 'meta') {
        if (Number.isInteger(ev.messageId)) job.responseMessageId = ev.messageId;
        if (Number.isInteger(ev.requestId)) job.requestMessageId = ev.requestId;
        if (!job.firstDeltaAt && !job.softTimer) {
          job.softTimer = setTimeout(() => {
            job.softTimer = null;
            if (!job.firstDeltaAt && !job.finished) failJob(job, 'DQ_SOFT_THROTTLED — accepted but no generation (official soft rate limit? pause requests)');
          }, CFG.softThrottleMs);
        }
      } else if (ev.type === 'start') {
        if (job.stream) emitDelta(job, 'start');
      } else if (ev.type === 'chunk') {
        job.firstDeltaAt = job.firstDeltaAt || Date.now();
        clearTimeout(job.softTimer); job.softTimer = null;
        if (process.env.DQ_TRACE_CHUNK === '1') log(`[chunk] ${JSON.stringify(ev.text)}`);
        job.text += ev.text;
        const shown = job.toolFilter ? job.toolFilter.push(ev.text) : ev.text;
        if (job.stream && shown) emitDelta(job, 'text', shown);
      } else if (ev.type === 'reasoning') {
        job.firstDeltaAt = job.firstDeltaAt || Date.now();
        clearTimeout(job.softTimer); job.softTimer = null;
        job.reasoning += ev.text;
        if (job.stream) emitDelta(job, 'reasoning', ev.text);
      } else if (ev.type === 'done') {
        clearTimeout(job.softTimer); job.softTimer = null;
        cleanupRound();
        job.text = ev.text || job.text;
        job.reasoning = ev.reasoning || job.reasoning;
        if (job.toolFilter) {
          if (!job.stream) {
            job.shownText = job.toolFilter.push(job.text) + job.toolFilter.flush();
          } else {
            const tail = job.toolFilter.flush();
            if (tail) emitDelta(job, 'text', tail);
          }
          job.toolCalls = job.toolFilter.calls.map((c, i) => ({
            id: `call_dq${job.created}${i}${crypto.randomBytes(2).toString('hex')}`,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          }));
        }
        // Built-in tools were removed by design: ALL tool calls go back to
        // the client (standard OpenAI function calling).
        // Empty-answer guard: the web stream can end with NO visible text while
        // still emitting reasoning (long thinking can consume the whole turn),
        // or with a fully empty 200 stream on a same-session follow-up. Both
        // are useless to the caller, so retry once. Reasoning alone is NOT a
        // valid answer — require job.text (or a real tool call).
        const hasAnswer = !!job.text || !!(job.toolFilter?.calls?.length);
        if (!hasAnswer && job.sessionId && !job.emptyRetry) {
          job.emptyRetry = true;
          log(`empty answer detected (text=${job.text.length}c reasoning=${job.reasoning.length}c) — retrying once on a fresh session (sess=${job.sessionId.slice(0, 8)})`);
          (async () => {
            await throttles.get(job.account).gate(job.abortController.signal);
            const sKey = `${job.account}/${job.sessionId}`;
            const since = Date.now() - (sessionLastDone.get(sKey) ?? 0);
            if (since < CFG.sessionContGapMs) {
              await sleep(CFG.sessionContGapMs - since, job.abortController.signal);
            }
            // Replaying into the SAME session tends to reproduce the empty
            // answer (the web keeps returning reasoning-only for that turn).
            // Start a clean session instead, and re-send the full transcript.
            job.text = ''; job.reasoning = ''; job.shownText = undefined; job.toolCalls = [];
            job.toolFilter = createToolStreamFilter(job.toolNames);
            job.sessionId = await newSessionViaPage(job.account);
            job.parentId = null;
            job.usedDelta = false;
            job.sessionBound = false;
            if (!job.usedDelta) rememberSession(job.account, job.prefix, job.sessionId, null);
            await sendComplete(job);
          })().catch((e) => failJob(job, e.message || e));
          return;
        }
        finishJob(job, ev.messageId);
      } else if (ev.type === 'error') {
        failJob(job, ev.error);
      }
    };
    job.watchdog = setTimeout(
      () => failJob(job, `DQ_IDLE_TIMEOUT ${CFG.idleTimeoutMs}ms`),
      CFG.idleTimeoutMs,
    );
    (async () => {
      // Upload message attachments (images/files) before dispatch; images
      // switch the completion to the web's vision model type.
      if (job.attachments?.length) {
        try {
          for (const att of job.attachments.slice(0, 4)) {
            if (att.refId) { job.refFileIds.push(att.refId); continue; } // pre-uploaded via /v1/files
            const up = await uploadAttachmentToPage(job.account, att);
            job.refFileIds.push(up.id);
            if (att.kind === 'image') job.vision = true;
          }
        } catch (e) { return failJob(job, e.message || e); }
      }
      cdps.get(job.account).cmd({
        op: 'complete',
        type: job.reqType ?? 'completion',
        id: cmdId,
        prompt: job.prompt,
        sessionId: job.sessionId,
        parentId: job.parentId,
        childMessageId: job.childMessageId,
        messageId: job.targetMessageId,
        thinking: job.think, // Supports boolean or string level ("max", "xhigh", etc.)
        search: job.search,
        refFileIds: job.refFileIds ?? [],
        vision: job.vision === true,
        // Optional: pass through thinking level (max/xhigh/high/medium/low)
        thoughtLevel: job.thoughtLevel ?? null,
        // Optional: pass through thought budget (may be ignored by page)
        thoughtBudget: job.thoughtBudget ?? null,
      }).catch((e) => failJob(job, e.message || e));
    })();
  });
}

async function runJob(job) {
  try {
    // Delta jobs are bound to the account that owns the session; fresh jobs
    // rotate to the longest-idle live account.
    if (!job.account) {
      const name = pickAccount();
      if (!name) throw new Error('DQ_NO_LIVE_ACCOUNT — all accounts need re-login');
      job.account = name;
    }
    if (!job.sessionId) {
      job.sessionId = await newSessionViaPage(job.account);
      // Register the mapping as soon as the session exists so a follow-up
      // request (user appending/correcting the task) can find — and preempt —
      // this session while job A is still generating.
      if (!job.usedDelta) rememberSession(job.account, job.prefix, job.sessionId, null);
    }
    // Preempt: an explicit dq_preempt request stops the in-flight generation
    // on the same session (web UI stop button) instead of waiting for it.
    const preKey = `${job.account}/${job.sessionId}`;
    const genJob = generatingBySession.get(preKey);
    if (job.preempt && genJob && genJob !== job && genJob.responseMessageId) {
      log(`preempt: stopping in-flight gen (sess=${job.sessionId.slice(0, 8)} mid=${genJob.responseMessageId})`);
      try { await stopStreamViaPage(job.account, job.sessionId, genJob.responseMessageId); } catch (e) { log(`preempt stop failed: ${e.message}`); }
      job.parentId = genJob.responseMessageId; // new user node hangs off the partial assistant node
      job.preemptDone = true;
    }
    await withSessionLock(`${job.account}/${job.sessionId}`, async () => {
      await throttles.get(job.account).gate(job.abortController.signal);
      // Same-session cooldown: a second completion fired too soon after the
      // previous one gets a silently EMPTY stream from DeepSeek.
      const sKey = `${job.account}/${job.sessionId}`;
      const since = job.preemptDone ? Infinity : Date.now() - (sessionLastDone.get(sKey) ?? 0);
      if (since < CFG.sessionContGapMs) {
        const wait = CFG.sessionContGapMs - since;
        log(`session cooldown ${Math.round(wait / 1000)}s (${sKey.split('/')[0]} sess=${job.sessionId.slice(0, 8)})`);
        await sleep(wait, job.abortController.signal);
      }
      await sendComplete(job);
    });
  } catch (e) {
    failJob(job, e.message || e);
  }
}

function pump() {
  while (active < CFG.concurrency && queue.length) {
    const job = queue.shift();
    // Abandoned queued jobs (client disconnected / aborted) are dropped here;
    // they never ran, so no slot is consumed and no counter needs releasing.
    if (job.finished || job.abortController.signal.aborted) continue;
    active++;
    job.slotHeld = true;
    // Release the slot exactly once, from whichever path settles first. A job
    // that fails while parked inside the session lock would otherwise keep its
    // slot forever (runWithRotation's finally can be delayed behind that lock,
    // leaving active === concurrency with an empty queue → total deadlock).
    const release = () => {
      if (!job.slotHeld) return;
      job.slotHeld = false;
      active--;
      pump();
    };
    job.releaseSlot = release;
    runWithRotation(job).finally(release);
  }
}

// One retry on a fresh account when the first attempt hits auth/rotatable
// failure and the job hadn't bound a session yet.
async function runWithRotation(job) {
  await runJob(job);
  if (job.finished && job.error && !job.sessionBound) {
    const code = job.error.split(' ')[0];
    const rotatable = ['DQ_NO_TOKEN', 'DQ_AUTH_401', 'DQ_AUTH_403', 'DQ_ACCOUNT_DEAD',
      'DQ_CDP_UNREACHABLE', 'DQ_NO_LIVE_ACCOUNT'].includes(code);
    if (rotatable) {
      const fresh = pickAccount();
      if (fresh && fresh !== job.account) {
        log(`rotating ${job.account} -> ${fresh} after ${code}`);
        job.account = fresh;
        job.sessionId = null;
        job.error = null;
        job.finished = false;
        job.text = ''; job.reasoning = '';
        job.shownText = undefined;
        job.toolCalls = [];
        if (job.toolNames?.length) job.toolFilter = createToolStreamFilter(job.toolNames);
        await runJob(job);
      }
    }
  }
  // Dangling mapping self-heal: the mapped web session vanished (deleted in
  // the web UI or by DeepSeek-side cleanup). Drop its mappings and replay
  // once in full mode so the conversation keeps working without a manual
  // flush. IDLE timeouts are excluded — those are throttling, not dangling.
  if (job.finished && job.error && job.sessionBound && !job.healed
      && /DQ_COMPLETION_HTTP_[45]|DQ_SESSION_FAIL|DQ_SESSION_TIMEOUT/.test(job.error)) {
    job.healed = true;
    log(`dangling mapping (${job.error.split(' ')[0]}, sess=${String(job.sessionId ?? '').slice(0, 8)}) — dropping mappings, replaying full`);
    const sid = job.sessionId;
    for (const a of accounts) {
      const store = sessionStore(a.name);
      for (const [k, hit] of [...store]) if (hit.sessionId === sid) store.delete(k);
    }
    saveSessions();
    job.sessionId = null;
    job.sessionBound = false;
    job.usedDelta = false;
    job.parentId = null;
    job.childMessageId = null;
    job.targetMessageId = null;
    job.prompt = joinTranscript(job.messages, job.tools);
    job.error = null;
    job.finished = false;
    job.text = ''; job.reasoning = ''; job.shownText = undefined; job.toolCalls = [];
    if (job.toolNames?.length) job.toolFilter = createToolStreamFilter(job.toolNames);
    await runJob(job);
  }
}

// ---------------------------------------------------------------------------
// OpenAI-compatible HTTP layer
// ---------------------------------------------------------------------------
const estTokens = (s) => Math.ceil((s || '').length / 3.7);
const completionId = () => `chatcmpl-dq${crypto.randomBytes(8).toString('hex')}`;

function sseWrite(job, delta, finishReason = null) {
  if (job.res.writableEnded) return;
  const payload = {
    id: job.completionId,
    object: 'chat.completion.chunk',
    created: job.created,
    model: job.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  job.res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

// ---------------------------------------------------------------------------
// Outbound protocol adapters - Anthropic Messages & OpenAI Responses.
// job.protocol: 'openai' (default) | 'anthropic' | 'responses'
// ---------------------------------------------------------------------------
const antMsgId = () => `msg_${crypto.randomBytes(10).toString('hex')}`;

function antStop(job) {
  return job.toolCalls?.length ? 'tool_use' : 'end_turn';
}

function sseRaw(job, event, payload) {
  if (job.res.writableEnded) return;
  job.res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function anthropicStart(job) {
  job.anth = { index: -1, cur: null };
  sseRaw(job, 'message_start', {
    type: 'message_start',
    message: {
      id: antMsgId(), type: 'message', role: 'assistant', model: job.model,
      content: [], stop_reason: null,
      usage: { input_tokens: estTokens(job.prompt), output_tokens: 0 },
    },
  });
}

function antEnsureBlock(job, type, extra = null) {
  if (job.anth.cur === type) return job.anth.index;
  if (job.anth.cur !== null) {
    sseRaw(job, 'content_block_stop', { type: 'content_block_stop', index: job.anth.index });
  }
  job.anth.index += 1;
  job.anth.cur = type;
  const block = type === 'thinking' ? { type: 'thinking', thinking: '' }
    : type === 'tool_use' ? { type: 'tool_use', id: extra.id, name: extra.name, input: {} }
    : { type: 'text', text: '' };
  sseRaw(job, 'content_block_start', { type: 'content_block_start', index: job.anth.index, content_block: block });
  return job.anth.index;
}

function anthropicDelta(job, kind, data) {
  if (kind === 'start') return anthropicStart(job);
  if (kind === 'reasoning') {
    const i = antEnsureBlock(job, 'thinking');
    return sseRaw(job, 'content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'thinking_delta', thinking: data } });
  }
  if (kind === 'text') {
    const i = antEnsureBlock(job, 'text');
    return sseRaw(job, 'content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: data } });
  }
  if (kind === 'tool_calls') {
    for (const c of data) {
      if (job.anth.cur !== null) sseRaw(job, 'content_block_stop', { type: 'content_block_stop', index: job.anth.index });
      job.anth.index += 1;
      job.anth.cur = 'tool_use';
      sseRaw(job, 'content_block_start', { type: 'content_block_start', index: job.anth.index, content_block: { type: 'tool_use', id: c.id, name: c.function.name, input: {} } });
      sseRaw(job, 'content_block_delta', { type: 'content_block_delta', index: job.anth.index, delta: { type: 'input_json_delta', partial_json: c.function.arguments } });
      sseRaw(job, 'content_block_stop', { type: 'content_block_stop', index: job.anth.index });
      job.anth.cur = null;
    }
    return;
  }
  if (kind === 'finish') {
    if (job.anth.cur !== null) sseRaw(job, 'content_block_stop', { type: 'content_block_stop', index: job.anth.index });
    sseRaw(job, 'message_delta', { type: 'message_delta', delta: { stop_reason: antStop(job) }, usage: { output_tokens: estTokens(job.text) + estTokens(job.reasoning) } });
    return sseRaw(job, 'message_stop', { type: 'message_stop' });
  }
}

function anthropicRespond(job) {
  const content = [];
  if (job.reasoning) content.push({ type: 'thinking', thinking: job.reasoning });
  if (job.shownText ?? job.text) content.push({ type: 'text', text: job.shownText ?? job.text });
  for (const c of job.toolCalls ?? []) {
    content.push({ type: 'tool_use', id: c.id, name: c.function.name, input: JSON.parse(c.function.arguments || '{}') });
  }
  sendJson(job.res, 200, {
    id: antMsgId(), type: 'message', role: 'assistant', model: job.model,
    content, stop_reason: antStop(job),
    stop_sequence: null,
    usage: { input_tokens: estTokens(job.prompt), output_tokens: estTokens(job.text) + estTokens(job.reasoning) },
  });
}

// ---- OpenAI Responses ----
function respSkeleton(job, status) {
  return {
    id: job.completionId.replace('chatcmpl', 'resp'), object: 'response',
    created_at: job.created, status, model: job.model, output: [],
    usage: { input_tokens: estTokens(job.prompt), output_tokens: estTokens(job.text) + estTokens(job.reasoning), total_tokens: estTokens(job.prompt) + estTokens(job.text) + estTokens(job.reasoning) },
    metadata: {},
  };
}

function respOutputItems(job) {
  const items = [];
  if (job.reasoning) {
    items.push({ type: 'reasoning', id: `rs_${crypto.randomBytes(6).toString('hex')}`, summary: [{ type: 'summary_text', text: job.reasoning }] });
  }
  if (job.shownText ?? job.text) {
    items.push({ type: 'message', id: `msg_${crypto.randomBytes(6).toString('hex')}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: job.shownText ?? job.text, annotations: [] }] });
  }
  for (const c of job.toolCalls ?? []) {
    items.push({ type: 'function_call', id: `fc_${crypto.randomBytes(6).toString('hex')}`, call_id: c.id, name: c.function.name, arguments: c.function.arguments, status: 'completed' });
  }
  return items;
}

function respStream(job, type, payload) {
  if (job.res.writableEnded) return;
  job.res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function responsesDelta(job, kind, data) {
  if (kind === 'start') {
    const sk = respSkeleton(job, 'in_progress');
    respStream(job, 'response.created', { type: 'response.created', response: sk });
    const item = { type: 'message', id: `msg_${crypto.randomBytes(6).toString('hex')}`, role: 'assistant', status: 'in_progress', content: [] };
    job.respMsgItem = item;
    return respStream(job, 'response.output_item.added', { type: 'response.output_item.added', output_index: 0, item });
  }
  if (kind === 'reasoning') {
    // Responses reasoning streaming is model-specific; the summary item is
    // emitted in the final response object instead.
    return;
  }
  if (kind === 'text') {
    return respStream(job, 'response.output_text.delta', { type: 'response.output_text.delta', item_id: job.respMsgItem?.id, output_index: 0, content_index: 0, delta: data });
  }
  if (kind === 'tool_calls') {
    job.respToolItems = (data || []).map((c) => ({
      type: 'function_call', id: `fc_${crypto.randomBytes(6).toString('hex')}`, call_id: c.id,
      name: c.function.name, arguments: c.function.arguments, status: 'completed',
    }));
    return;
  }
  if (kind === 'finish') {
    let out = 1; // index 0 is the streamed message item
    for (const item of respOutputItems(job)) {
      if (item.type === 'message') continue;
      respStream(job, 'response.output_item.added', { type: 'response.output_item.added', output_index: out, item });
      if (item.type === 'function_call') {
        respStream(job, 'response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: item.id, output_index: out, delta: item.arguments });
      }
      respStream(job, 'response.output_item.done', { type: 'response.output_item.done', output_index: out, item });
      out += 1;
    }
    const full = respSkeleton(job, 'completed');
    full.output = respOutputItems(job);
    return respStream(job, 'response.completed', { type: 'response.completed', response: full });
  }
}

function responsesRespond(job) {
  sendJson(job.res, 200, { ...respSkeleton(job, 'completed'), output: respOutputItems(job) });
}

// protocol-dispatching delta emitter used by job.onEvent
function emitDelta(job, kind, data) {
  if (job.protocol === 'anthropic') return anthropicDelta(job, kind, data);
  if (job.protocol === 'responses') return responsesDelta(job, kind, data);
  if (kind === 'start') return sseWrite(job, { role: 'assistant', content: '' });
  if (kind === 'text') return sseWrite(job, { content: data });
  if (kind === 'reasoning') return sseWrite(job, { reasoning_content: data });
  if (kind === 'tool_calls') {
    (job.toolCalls ?? []).forEach((c, i) => sseWrite(job, { tool_calls: [{ index: i, ...c }] }));
    return;
  }
  if (kind === 'finish') {
    sseWrite(job, {}, job.toolCalls?.length ? 'tool_calls' : 'stop');
    if (!job.res.writableEnded) {
      job.res.write('data: [DONE]\n\n');
      job.res.end();
    }
  }
}


function respond(job) {
  if (job.stream) {
    // Stream finish is protocol-specific; the non-stream JSON responders
    // below would throw (headers already sent) and kill the process.
    if (job.protocol === 'anthropic') {
      if ((job.toolCalls ?? []).length) emitDelta(job, 'tool_calls', job.toolCalls);
      return emitDelta(job, 'finish');
    }
    if (job.protocol === 'responses') return emitDelta(job, 'finish');
    const finish = job.toolCalls?.length ? 'tool_calls' : 'stop';
    if (job.toolCalls?.length) {
      job.toolCalls.forEach((c, i) => sseWrite(job, { tool_calls: [{ index: i, ...c }] }));
    }
    sseWrite(job, {}, finish);
    if (!job.res.writableEnded) {
      job.res.write('data: [DONE]\n\n');
      job.res.end();
    }
    return;
  }
  if (job.protocol === 'anthropic') return anthropicRespond(job);
  if (job.protocol === 'responses') return responsesRespond(job);
  const finish = job.toolCalls?.length ? 'tool_calls' : 'stop';
  if (job.error) return sendError(job.res, 502, job.error);
  const message = { role: 'assistant', content: job.shownText ?? job.text };
  if (job.reasoning) message.reasoning_content = job.reasoning;
  if (job.toolCalls?.length) message.tool_calls = job.toolCalls;
  const promptTokens = estTokens(job.prompt);
  const completionTokens = estTokens(job.shownText ?? job.text) + estTokens(job.reasoning);
  sendJson(job.res, 200, {
    id: job.completionId,
    object: 'chat.completion',
    created: job.created,
    model: job.model,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function sendError(res, status, message) {
  sendJson(res, status, { error: { message, type: 'deepseek_bridge_error', code: String(message).split(' ')[0] } });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('DQ_PAYLOAD_TOO_LARGE')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
// Binary-safe body reader (multipart uploads).
function readBodyRaw(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('DQ_PAYLOAD_TOO_LARGE')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
// Minimal multipart/form-data parser: returns [{name, filename, mime, data}].
function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType || ''));
  if (!m) return [];
  const bBuf = Buffer.from(`--${(m[1] || m[2]).trim()}`);
  const out = [];
  let pos = buf.indexOf(bBuf);
  while (pos !== -1) {
    const next = buf.indexOf(bBuf, pos + bBuf.length);
    if (next === -1) break;
    const part = buf.slice(pos + bBuf.length, next);
    pos = next;
    const headEnd = part.indexOf('\r\n\r\n');
    if (headEnd === -1) continue;
    const head = part.slice(0, headEnd).toString('utf8');
    const nameM = /name="([^"]*)"/i.exec(head);
    const fileM = /filename="([^"]*)"/i.exec(head);
    const ctM = /content-type:\s*([^\r\n;]+)/i.exec(head);
    out.push({
      name: nameM?.[1] ?? '',
      filename: fileM?.[1] ?? '',
      mime: ctM?.[1]?.trim() ?? '',
      data: part.slice(headEnd + 4, part.length - 2), // strip trailing \r\n
    });
  }
  return out;
}
const fileObj = (dsId, rec) => ({
  id: `file-${dsId}`,
  object: 'file',
  bytes: rec.bytes ?? null,
  created_at: rec.at ? Math.floor(rec.at / 1000) : Math.floor(Date.now() / 1000),
  filename: rec.name ?? null,
  purpose: 'assistants',
});

// First live, non-dead account with an attached page (admin helpers only).
function liveAccountForAdmin() {
  return accounts.find((a) => !throttles.get(a.name).dead && cdps.get(a.name)?.ws?.readyState === 1) ?? null;
}

let healthCache = { at: 0, value: null };
async function getHealth() {
  if (Date.now() - healthCache.at < 10000 && healthCache.value) return healthCache.value;
  const list = await Promise.all(accounts.map(async (a) => {
    const th = throttles.get(a.name);
    try {
      const st = await pageStatus(a.name);
      if (st.displayName) a.displayName = st.displayName;
      // Auto-revive: a dead mark means the token was rejected repeatedly; if
      // the page now carries a token again (user re-logged in), un-dead it.
      // A still-invalid token just fails auth twice more and re-marks dead —
      // the loop is bounded and self-correcting.
      if (CFG.autoRevive && th.dead && st.loggedIn) {
        th.dead = false;
        th.authFailStreak = 0;
        th.coolUntil = 0;
        log(`account ${a.name} auto-revived (page logged in again)`);
      }
      const score = calculateAccountScore(th, { dayCount: th.dayCount });
      return {
        name: a.name, displayName: a.displayName ?? null, cdpPort: a.cdpPort, dead: th.dead,
        loggedIn: !!st.loggedIn, page: st.url,
        dayCount: th.dayCount, lastDone: th.lastDone,
        healthScore: score,
      };
    } catch (e) {
      return { name: a.name, cdpPort: a.cdpPort, dead: th.dead, loggedIn: false, error: String(e.message || e) };
    }
  }));
  healthCache = {
    at: Date.now(),
    value: {
      ok: list.some((a) => a.loggedIn && !a.dead),
      accounts: list,
    },
  };
  return healthCache.value;
}

// ---------------------------------------------------------------------------
// Inbound protocol translators (Anthropic Messages / OpenAI Responses ->
// internal OpenAI-shaped messages/tools for the shared completion pipeline).
// ---------------------------------------------------------------------------
function anthropicToInternal(parsed) {
  const messages = [];
  const attachments = [];
  const sys = parsed?.system;
  const systemText = typeof sys === 'string' ? sys : Array.isArray(sys) ? sys.map((b) => b?.text ?? '').join('\n\n') : '';
  if (systemText) messages.push({ role: 'system', content: systemText });
  const toolNameById = new Map();
  for (const m of parsed?.messages ?? []) {
    const role = m?.role === 'assistant' ? 'assistant' : 'user';
    const content = m?.content;
    if (typeof content === 'string') { messages.push({ role, content }); continue; }
    if (!Array.isArray(content)) continue;
    if (role === 'user') {
      const texts = [];
      const groupAtts = [];
      for (const b of content) {
        if (b?.type === 'text') texts.push(b.text);
        else if (b?.type === 'image') {
          const s = b.source ?? {};
          if (s.type === 'base64' && typeof s.data === 'string') {
            groupAtts.push({ kind: 'image', url: `data:${s.media_type ?? 'image/png'};base64,${s.data}` });
            texts.push('[图片已附上]');
          } else if (s.type === 'url' && typeof s.url === 'string') {
            groupAtts.push({ kind: 'image', url: s.url });
            texts.push('[图片已附上]');
          }
        } else if (b?.type === 'document') {
          const s = b.source ?? {};
          if (s.type === 'base64' && typeof s.data === 'string') {
            const name = String(b.title ?? 'document');
            groupAtts.push({ kind: 'file', url: `data:${s.media_type ?? 'application/pdf'};base64,${s.data}`, name });
            texts.push(`[文件已附上: ${name}]`);
          } else if (s.type === 'file_id' && typeof s.file_id === 'string') {
            const name = String(b.title ?? 'file');
            groupAtts.push({ kind: 'file', refId: String(s.file_id).replace(/^file[-_]/, ''), name });
            texts.push(`[文件已附上: ${name}]`);
          }
        } else if (b?.type === 'tool_result') {
          const inner = Array.isArray(b.content) ? b.content.map((x) => x?.text ?? '').join('\n') : String(b.content ?? '');
          messages.push({ role: 'tool', tool_call_id: String(b.tool_use_id ?? ''), content: inner, _toolName: String(b.tool_use_id ?? '') });
        }
      }
      if (groupAtts.length) {
        const mi = messages.length;
        for (const a of groupAtts) a.mi = mi;
        attachments.push(...groupAtts);
      }
      if (texts.length) messages.push({ role: 'user', content: texts.join('\n\n') });
    } else {
      const texts = [];
      const calls = [];
      for (const b of content) {
        if (b?.type === 'text') texts.push(b.text);
        else if (b?.type === 'tool_use') {
          calls.push({ id: String(b.id ?? ''), type: 'function', function: { name: String(b.name ?? ''), arguments: JSON.stringify(b.input ?? {}) } });
          toolNameById.set(String(b.id ?? ''), String(b.name ?? ''));
        }
        // thinking blocks are not replayed
      }
      messages.push({ role: 'assistant', content: texts.join('\n\n'), tool_calls: calls.length ? calls : undefined });
    }
  }
  // resolve tool names for the tool results we emitted
  for (const m of messages) {
    if (m.role === 'tool' && m._toolName) {
      m._toolName = toolNameById.get(m._toolName) ?? m._toolName;
      delete m._toolName;
    }
  }
  const tools = (parsed?.tools ?? []).filter((t) => t?.name).map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description ?? '', parameters: t.input_schema ?? { type: 'object', properties: {} } },
  }));
  return { messages, tools: tools.length ? tools : null, attachments };
}

function responsesToInternal(parsed) {
  const messages = [];
  const attachments = [];
  if (parsed?.instructions) messages.push({ role: 'system', content: parsed.instructions });
  const input = parsed?.input;
  if (typeof input === 'string') messages.push({ role: 'user', content: input });
  else if (Array.isArray(input)) {
    for (const item of input) {
      if (item?.type === 'message' || (!item?.type && item?.role)) {
        const role = item.role === 'assistant' ? 'assistant' : 'user';
        const c = item.content;
        let text = '';
        const groupAtts = [];
        if (typeof c === 'string') text = c;
        else if (Array.isArray(c)) {
          const texts = [];
          for (const b of c) {
            if (typeof b?.text === 'string') texts.push(b.text);
            else if (b?.type === 'input_image' && typeof b.image_url === 'string') {
              groupAtts.push({ kind: 'image', url: b.image_url });
              texts.push('[图片已附上]');
            } else if (b?.type === 'input_file' && typeof b.file_data === 'string') {
              const name = String(b.filename ?? 'file');
              groupAtts.push({ kind: 'file', url: b.file_data, name });
              texts.push(`[文件已附上: ${name}]`);
            } else if (b?.type === 'input_file' && typeof b.file_id === 'string') {
              const name = String(b.filename ?? 'file');
              groupAtts.push({ kind: 'file', refId: String(b.file_id).replace(/^file[-_]/, ''), name });
              texts.push(`[文件已附上: ${name}]`);
            }
          }
          text = texts.join('\n');
        }
        messages.push({ role, content: text });
        if (groupAtts.length) {
          const mi = messages.length - 1;
          for (const a of groupAtts) a.mi = mi;
          attachments.push(...groupAtts);
        }
      } else if (item?.type === 'function_call') {
        messages.push({
          role: 'assistant', content: '',
          tool_calls: [{ id: String(item.call_id ?? ''), type: 'function', function: { name: String(item.name ?? ''), arguments: String(item.arguments ?? '{}') } }],
        });
      } else if (item?.type === 'function_call_output') {
        messages.push({ role: 'tool', tool_call_id: String(item.call_id ?? ''), content: String(item.output ?? '') });
      }
    }
  }
  const tools = (parsed?.tools ?? []).filter((t) => t?.name).map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description ?? '', parameters: t.parameters ?? { type: 'object', properties: {} } },
  }));
  return { messages, tools: tools.length ? tools : null, attachments };
}

async function processCompletion(req, res, parsed, protocol) {
  const msgsRaw = parsed?.messages;
  if (!Array.isArray(msgsRaw) || msgsRaw.length === 0) return sendError(res, 400, 'DQ_MESSAGES_REQUIRED');
  const special = parsed?.dq_regenerate === true ? 'regenerate'
    : parsed?.dq_edit === true ? 'editMessage'
    : parsed?.dq_continue === true ? 'continue' : null;
  // Adapters may deliver protocol-native attachments (Anthropic image/document
  // blocks, Responses input_image/input_file) pre-collected; the OpenAI path
  // collects them inside normMessages.
  const attachments = Array.isArray(parsed?._attachments) ? parsed._attachments : [];
  const messages = normMessages(msgsRaw, attachments);
  if (!special && messages.some((m) => !m.content && !m.toolCalls)) return sendError(res, 400, 'DQ_EMPTY_MESSAGE');

  const model = String(parsed?.model ?? 'deepseek-v4.1-flash');
  const think = model.includes('nothink') ? false : model.includes('think') ? true : CFG.think;
  const search = model.includes('search');

  // Thinking level: OpenAI-style clients (pi, etc.) send `reasoning_effort`;
  // some clients use `thinking_level`/`thought_level`. Normalise to a small
  // vocabulary. The web API only honours on/off + model_type, so these levels
  // are a best-effort intent signal, not a native numeric depth.
  const rawThought = parsed?.reasoning_effort
    ?? parsed?.thinking_level
    ?? parsed?.thought_level
    ?? parsed?.extra?.reasoning_effort
    ?? null;
  const LEVEL_ALIASES = {
    off: 'off', none: 'off', minimal: 'off', disable: 'off', disabled: 'off',
    low: 'low',
    medium: 'medium', mid: 'medium',
    high: 'high', xhigh: 'xhigh', max: 'max', maximum: 'max',
  };
  const thoughtLevel = rawThought == null ? null
    : (LEVEL_ALIASES[String(rawThought).toLowerCase().trim()] ?? null);
  // off/none/minimal force thinking off; any other explicit level forces it on.
  const thinkEffective = thoughtLevel == null ? think
    : thoughtLevel === 'off' ? false
    : true;
  const tools = Array.isArray(parsed?.tools) && parsed.tools.length ? parsed.tools : null;
  const preemptFlag = parsed?.dq_preempt === true;
  const toolNames = (tools ?? []).map((t) => t?.function?.name).filter(Boolean);

  const prefix = messages.slice(0, -1);
  let hit = null;
  let hitAccount = null;
  if (special || !tools) {
    for (const a of accounts) {
      const h = lookupSession(a.name, prefix);
      if (h) { hit = h; hitAccount = a.name; break; }
    }
    if (special) {
      if (!hit) return sendError(res, 400, `DQ_${special.toUpperCase()}_NO_SESSION - conversation not known to the bridge`);
      const target = special === 'editMessage' ? hit.lastUserId : hit.lastAssistantId;
      if (!Number.isInteger(target)) return sendError(res, 400, `DQ_${special.toUpperCase()}_NO_TARGET - no prior completion recorded on this session`);
    }
  }
  const last = messages[messages.length - 1];
  let prompt;
  let usedDelta = false;
  let parentId = null;
  let sessionId = null;
  let account = hitAccount ?? null;
  let childMessageId = null;
  let targetMessageId = null;
  if (special && hit) {
    sessionId = hit.sessionId;
    usedDelta = true;
    childMessageId = hit.lastAssistantId;
    targetMessageId = special === 'editMessage' ? hit.lastUserId : hit.lastAssistantId;
    prompt = special === 'editMessage' ? last.content : '';
  } else if (hit && last.role === 'user') {
    prompt = last.content;
    usedDelta = true;
    parentId = hit.parentId;
    sessionId = hit.sessionId;
  } else {
    prompt = joinTranscript(messages, tools);
  }

  const job = {
    completionId: completionId(),
    created: Math.floor(Date.now() / 1000),
    model, messages, prefix, prompt, usedDelta, sessionId, parentId, account,
    sessionBound: usedDelta, reqType: special, childMessageId, targetMessageId,
    think: thinkEffective, search, tools, toolNames, preempt: preemptFlag,
    // Thinking level (max/xhigh/high/medium/low) resolved from reasoning_effort
    thoughtLevel,
    // Optional: thinking budget (may be ignored by web UI)
    thoughtBudget: parsed?.extra?.thinking_budget ?? parsed?.thought_limit ?? null,
    // Delta turns re-send history whose images already live in the session:
    // reference only attachments from the NEW (last) message. Full turns
    // reference everything in the transcript.
    attachments: usedDelta ? attachments.filter((a) => a.mi === messages.length - 1) : attachments,
    refFileIds: [], vision: false,
    toolFilter: toolNames.length ? createToolStreamFilter(toolNames) : null,
    toolCalls: [],
    protocol,
    stream: !!parsed?.stream,
    text: '', reasoning: '', error: null,
    finished: false,
    res,
    abortController: new AbortController(),
  };

  if (queue.length >= CFG.queueMax) return sendError(res, 429, `DQ_QUEUE_FULL ${CFG.queueMax}`);
  if (job.stream) {
    if (protocol === 'anthropic') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    } else {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    }
  }
  const settled = new Promise((r) => { job.settle = r; });
  res.on('close', () => {
    if (job.finished || job.stopRequested) return;
    job.stopRequested = true;
    const mid = job.responseMessageId;
    if (!mid) return failJob(job, 'DQ_CLIENT_GONE');
    log(`client gone - graceful stop (sess=${String(job.sessionId ?? '').slice(0, 8)} mid=${mid})`);
    (async () => {
      try { await stopStreamViaPage(job.account, job.sessionId, mid); } catch { /* page fetch hard-stopped below */ }
      failJob(job, 'DQ_CLIENT_GONE');
      job.graceStopFallback = setTimeout(() => {
        job.abortController.abort();
        if (job.cmdId) cdps.get(job.account)?.cmd({ op: 'abort', targetId: job.cmdId }).catch(() => {});
      }, 8000);
    })();
  });
  queue.push(job);
  pump();
  await settled;
  respond(job);
  return;
}


const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  try {
    const isAuthEndpoint = url.pathname === '/admin/auth/login' || url.pathname === '/admin/auth/logout';
    if ((url.pathname.startsWith('/admin/') && !isAuthEndpoint) || url.pathname.startsWith('/v1/')) {
      const isDashboardStatic = false;
      const c = /dq_session=([a-f0-9]+)/.exec(String(req.headers.cookie ?? ''));
      const cookieOk = c && authSession(c[1]);
      const keyOk = checkApiKey(req);
      // /admin/stats & /admin/logs accept cookie or key; everything else under
      // /v1 requires a configured key.
      if (!cookieOk && !keyOk) return sendError(res, 401, 'DQ_UNAUTHORIZED — set an API key (see auth.json / dashboard)');
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, await getHealth());
    }

    if (req.method === 'GET' && url.pathname === '/v1/models') {
      return sendJson(res, 200, {
        object: 'list',
        data: ['deepseek-v4.1-flash', 'deepseek-v4.1-flash-nothink', 'deepseek-v4.1-flash-search'].map((id) => ({
          id, object: 'model', owned_by: 'deepseek-browser-bridge',
        })),
      });
    }

    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      const rawBody = await readBody(req, 32 * 1024 * 1024);
      if (process.env.DQ_DUMP_REQUEST === '1') {
        try { fs.appendFileSync(path.join(__dirname, 'request-dump.jsonl'), rawBody.trim() + '\n'); } catch { /* ignore */ }
      }
      const parsed = JSON.parse(rawBody);
      await processCompletion(req, res, parsed, 'openai');
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/messages') {
      // Anthropic Messages protocol -> internal completion pipeline.
      const parsed = JSON.parse(await readBody(req, 32 * 1024 * 1024));
      const internal = anthropicToInternal(parsed);
      const shaped = {
        model: parsed?.model ?? 'deepseek-v4.1-flash',
        messages: internal.messages,
        tools: internal.tools,
        stream: !!parsed?.stream,
        _attachments: internal.attachments ?? [],
      };
      return processCompletion(req, res, shaped, 'anthropic');
    }

    if (req.method === 'POST' && url.pathname === '/v1/responses') {
      // OpenAI Responses protocol -> internal completion pipeline.
      const parsed = JSON.parse(await readBody(req, 32 * 1024 * 1024));
      const internal = responsesToInternal(parsed);
      const shaped = {
        model: parsed?.model ?? 'deepseek-v4.1-flash',
        messages: internal.messages,
        tools: internal.tools,
        stream: !!parsed?.stream,
        _attachments: internal.attachments ?? [],
      };
      return processCompletion(req, res, shaped, 'responses');
    }

    if (req.method === 'POST' && url.pathname === '/v1/files') {
      // Minimal OpenAI Files API: multipart upload -> page upload (audit
      // polling + content-hash cache shared with inline attachments).
      // The returned id (`file-<webFileId>`) is accepted back by
      // input_file.file_id (Responses) and document source.file_id (Anthropic).
      const raw = await readBodyRaw(req, 64 * 1024 * 1024);
      const parts = parseMultipart(raw, req.headers['content-type']);
      const part = parts.find((p) => p.name === 'file' && p.data.length) ?? parts.find((p) => p.data.length);
      if (!part) return sendError(res, 400, 'DQ_FILE_FIELD_REQUIRED — multipart form with a "file" field');
      const account = pickAccount();
      if (!account) return sendError(res, 503, 'DQ_NO_LIVE_ACCOUNT');
      const dataUrl = `data:${part.mime || 'application/octet-stream'};base64,${part.data.toString('base64')}`;
      const up = await uploadAttachmentToPage(account, { kind: 'file', url: dataUrl, name: part.filename || 'file' });
      return sendJson(res, 200, fileObj(up.id, { name: part.filename || 'file', bytes: part.data.length, at: Date.now() }));
    }

    if (req.method === 'GET' && url.pathname === '/v1/files') {
      const seen = new Map();
      for (const v of fileCache.values()) {
        if (v.id != null && !seen.has(v.id)) seen.set(v.id, v);
      }
      return sendJson(res, 200, { object: 'list', data: [...seen.values()].map((v) => fileObj(v.id, v)) });
    }

    const fileIdMatch = /^\/v1\/files\/([^/]+)$/.exec(url.pathname);
    if (fileIdMatch) {
      const oid = decodeURIComponent(fileIdMatch[1]);
      const dsId = oid.replace(/^file[-_]/, '');
      if (req.method === 'GET') {
        const hit = [...fileCache.values()].find((v) => String(v.id) === dsId);
        return hit ? sendJson(res, 200, fileObj(hit.id, hit)) : sendError(res, 404, 'DQ_FILE_NOT_FOUND');
      }
      if (req.method === 'DELETE') {
        let deleted = false;
        for (const [k, v] of fileCache) {
          if (String(v.id) === dsId) { fileCache.delete(k); deleted = true; }
        }
        if (deleted) saveFileCache();
        return sendJson(res, 200, { id: oid, object: 'file', deleted });
      }
    }

    if (req.method === 'POST' && url.pathname === '/admin/flush-sessions') {
      // Optional {deleteWeb:true}: try to delete the mapped web sessions on
      // DeepSeek too. Success-gated per the retirement rule — only mappings
      // of CONFIRMED-deleted sessions are dropped before the flush; the rest
      // are simply cleared (flush is the corrective tool, no retry queue).
      const body = await readBody(req, 64 * 1024).then((b) => { try { return JSON.parse(b || '{}'); } catch { return {}; } });
      let webDeleted = 0, webFailed = 0;
      if (body.deleteWeb === true) {
        const byAccount = new Map();
        for (const [account, store] of sessions) {
          for (const hit of store.values()) {
            if (!byAccount.has(account)) byAccount.set(account, new Set());
            byAccount.get(account).add(hit.sessionId);
          }
        }
        const confirmed = new Map(); // account -> Set(confirmed ids)
        for (const [account, ids] of byAccount) {
          const cdp = cdps.get(account);
          if (!cdp || !(cdp.ws && cdp.ws.readyState === 1 && cdp.injected)) { webFailed += ids.size; continue; }
          const arr = [...ids];
          for (let i = 0; i < arr.length; i += 40) {
            try {
              const ev = await deleteSessionsViaPage(account, arr.slice(i, i + 40));
              if (ev.status === 200 && ev.biz === 0) {
                webDeleted += arr.slice(i, i + 40).length;
                if (!confirmed.has(account)) confirmed.set(account, new Set());
                for (const id of arr.slice(i, i + 40)) confirmed.get(account).add(id);
              } else webFailed += arr.slice(i, i + 40).length;
            } catch { webFailed += arr.slice(i, i + 40).length; }
            if (i + 40 < arr.length) await new Promise((r) => setTimeout(r, 1500));
          }
        }
        for (const [account, store] of sessions) {
          const ok = confirmed.get(account);
          if (!ok) continue;
          for (const [k, hit] of [...store]) if (ok.has(hit.sessionId)) store.delete(k);
        }
      }
      sessions.clear();
      saveSessions();
      return sendJson(res, 200, { ok: true, cleared: true, webDeleted, webFailed });
    }

    if (req.method === 'GET' && url.pathname === '/admin/sessions') {
      const acc = liveAccountForAdmin();
      if (!acc) return sendError(res, 503, 'DQ_NO_LIVE_ACCOUNT — browser offline or logged out');
      try {
        const list = await listSessionsViaPage(acc.name);
        const mapped = new Set([...sessionStore(acc.name).values()].map((h) => h.sessionId));
        const sessionsOut = list.map((s) => ({ ...s, mapped: mapped.has(s.id), queued: deleteQueue.has(`${acc.name}/${s.id}`) }));
        return sendJson(res, 200, { account: acc.name, sessions: sessionsOut });
      } catch (e) {
        return sendError(res, 502, e.message || 'DQ_LIST_FAIL');
      }
    }

    if (req.method === 'POST' && url.pathname === '/admin/sessions/purge') {
      const acc = liveAccountForAdmin();
      if (!acc) return sendError(res, 503, 'DQ_NO_LIVE_ACCOUNT — browser offline or logged out');
      const body = await readBody(req, 1024 * 1024).then((b) => { try { return JSON.parse(b || '{}'); } catch { return {}; } });
      const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === 'string') : [];
      if (!ids.length) return sendError(res, 400, 'DQ_NO_IDS');
      const deleted = [];
      let error = null;
      for (let i = 0; i < ids.length; i += 40) {
        const chunk = ids.slice(i, i + 40);
        try {
          const ev = await deleteSessionsViaPage(acc.name, chunk);
          if (ev.status === 200 && ev.biz === 0) deleted.push(...chunk);
          else { error = `http=${ev.status} biz=${ev.biz}`; break; }
        } catch (e) { error = e.message || 'DQ_DELETE_FAIL'; break; }
        if (i + 40 < ids.length) await new Promise((r) => setTimeout(r, 1500));
      }
      if (deleted.length) {
        const store = sessionStore(acc.name);
        for (const [k, hit] of [...store]) if (deleted.includes(hit.sessionId)) store.delete(k);
        for (const id of deleted) deleteQueue.delete(`${acc.name}/${id}`);
        saveSessions();
      }
      return sendJson(res, 200, { ok: !error, deleted: deleted.length, remaining: ids.length - deleted.length, error });
    }

    if (req.method === 'POST' && url.pathname === '/admin/revive') {
      // Re-probe accounts after re-login (clears dead marks and cooldowns).
      for (const a of accounts) {
        const th = throttles.get(a.name);
        th.dead = false;
        th.authFailStreak = 0;
        th.coolUntil = 0;
      }
      healthCache = { at: 0, value: null };
      return sendJson(res, 200, { ok: true, revived: accounts.map((a) => a.name) });
    }

    if (req.method === 'GET' && url.pathname === '/dashboard') {
      const html = fs.readFileSync(path.join(__dirname, 'dashboard.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    if (url.pathname === '/admin/auth/login' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req, 64 * 1024));
      if (body.password !== AUTH.dashboardPassword) return sendError(res, 401, 'DQ_BAD_PASSWORD');
      const token = newSessionToken();
      AUTH.sessions.push(token);
      AUTH.sessions = AUTH.sessions.slice(-5);
      saveAuth(AUTH);
      res.setHeader('set-cookie', `dq_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`);
      return sendJson(res, 200, { ok: true });
    }

    if (url.pathname === '/admin/auth/logout' && req.method === 'POST') {
      const c = /dq_session=([a-f0-9]+)/.exec(String(req.headers.cookie ?? ''));
      if (c) { AUTH.sessions = AUTH.sessions.filter((t) => t !== c[1]); saveAuth(AUTH); }
      res.setHeader('set-cookie', 'dq_session=; Max-Age=0');
      return sendJson(res, 200, { ok: true });
    }

    if (url.pathname === '/admin/auth/set' && req.method === 'POST') {
      // rotate credentials; requires a valid session cookie or a valid API key
      const c = /dq_session=([a-f0-9]+)/.exec(String(req.headers.cookie ?? ''));
      const authorized = (c && authSession(c[1])) || checkApiKey(req);
      if (!authorized) return sendError(res, 401, 'DQ_UNAUTHORIZED');
      const body = JSON.parse(await readBody(req, 64 * 1024));
      if (body.apiKey) {
        // setting a key REPLACES the list (user-customisable sk-xxxx style);
        // sk-dq-bridge-local is always kept for the CCR passthrough.
        AUTH.keys = [String(body.apiKey), 'sk-dq-bridge-local'];
      }
      if (body.dashboardPassword) AUTH.dashboardPassword = String(body.dashboardPassword);
      saveAuth(AUTH);
      return sendJson(res, 200, { ok: true, keys: AUTH.keys.map((k) => k.slice(0, 10) + '…') });
    }

    // Multi-key management: auth.json keys[] is the source of truth for /v1/*.
    if (url.pathname === '/admin/keys' && req.method === 'GET') {
      return sendJson(res, 200, { keys: AUTH.keys });
    }
    if (url.pathname === '/admin/keys/add' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req, 64 * 1024));
      const key = String(body.key ?? '').trim();
      if (!/^sk-[A-Za-z0-9_-]{4,}$/.test(key)) return sendError(res, 400, 'DQ_BAD_KEY_FORMAT — sk- 开头，字母/数字/-/_');
      if (AUTH.keys.includes(key)) return sendError(res, 400, 'DQ_KEY_EXISTS');
      AUTH.keys.push(key);
      saveAuth(AUTH);
      log(`api key added (${key.slice(0, 10)}…) — total ${AUTH.keys.length}`);
      return sendJson(res, 200, { ok: true, count: AUTH.keys.length });
    }
    if (url.pathname === '/admin/keys/remove' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req, 64 * 1024));
      const key = String(body.key ?? '');
      const i = AUTH.keys.indexOf(key);
      if (i < 0) return sendError(res, 404, 'DQ_KEY_NOT_FOUND');
      if (AUTH.keys.length <= 1) return sendError(res, 400, 'DQ_LAST_KEY — 至少保留一个 Key');
      AUTH.keys.splice(i, 1);
      saveAuth(AUTH);
      log(`api key removed (${key.slice(0, 10)}…) — total ${AUTH.keys.length}`);
      return sendJson(res, 200, { ok: true, count: AUTH.keys.length });
    }


    if (req.method === 'GET' && url.pathname === '/admin/stats') {
      await getHealth().catch(() => null); // refresh per-account displayName via pageStatus
      const today = statDay();
      const total = Object.values(STATS.days).reduce((a, d) => a + d.requests, 0);
      const okAll = Object.values(STATS.days).reduce((a, d) => a + d.ok, 0);
      const hmap = new Map((healthCache.value?.accounts ?? []).map((h) => [h.name, h]));
      const accountsView = accounts.map((a) => {
        const th = throttles.get(a.name);
        const h = hmap.get(a.name) ?? {};
        return {
          name: a.name, displayName: h.displayName ?? a.displayName ?? null, cdpPort: a.cdpPort,
          dead: th.dead, cooling: th.coolUntil > Date.now(),
          coolRemainS: Math.max(0, Math.round((th.coolUntil - Date.now()) / 1000)),
          authFailStreak: th.authFailStreak,
          loggedIn: h.loggedIn ?? false, page: h.page ?? h.error ?? null,
          dayCount: h.dayCount ?? th.dayCount ?? 0, lastDone: h.lastDone ?? th.lastDone ?? null,
        };
      });
      const accStats = accounts.map((a) => {
        const m = sessionStore(a.name);
        return { name: a.name, sessions: m.size };
      });
      return sendJson(res, 200, {
        uptimeS: Math.round((Date.now() - BOOT_TS) / 1000),
        accounts: accountsView, accStats,
        retireQueue: deleteQueue.size,
        today, total, okRate: total ? Math.round((okAll / total) * 100) : null,
        days: Object.fromEntries(Object.entries(STATS.days).sort().slice(-15)),
        recent: STATS.recent,
        queue: { len: queue.length, active, concurrency: CFG.concurrency },
        sessionsMapped: [...sessions.values()].reduce((n, m) => n + m.size, 0),
        cfg: {
          minGapMs: CFG.minGapMs, jitterMs: CFG.jitterMs, maxPerHour: CFG.maxPerHour,
          maxPerDay: CFG.maxPerDay, sessionContGapMs: CFG.sessionContGapMs,
          think: CFG.think, quietHours: CFG.quietHours || 'off',
        },
        keys: AUTH.keys,
      });
    }

    if (req.method === 'GET' && url.pathname === '/admin/logs') {
      const n = Math.min(200, Number(url.searchParams.get('n') ?? 60));
      return sendJson(res, 200, { logs: LOG_RING.slice(-n) });
    }

    if (req.method === 'POST' && url.pathname === '/admin/experimental/complete') {
      // Protocol experiment endpoint: raw completion with explicit session/
      // parent/preempt control. Returns the full event transcript.
      const body = JSON.parse(await readBody(req, 1024 * 1024));
      const id = `exp${crypto.randomBytes(4).toString('hex')}`;
      const events = [];
      reportWaiters.set(id, (ev) => events.push(ev));
      if (!body.sessionId) {
        const name = pickAccount();
        if (!name) return sendError(res, 503, 'DQ_NO_LIVE_ACCOUNT');
        body.sessionId = await newSessionViaPage(name);
        body.account = name;
      }
      const account = body.account ?? pickAccount();
      if (!account || !cdps.has(account)) return sendError(res, 503, 'DQ_NO_LIVE_ACCOUNT');
      await cdps.get(account).cmd({
        op: 'complete',
        id,
        prompt: String(body.prompt ?? ''),
        sessionId: body.sessionId,
        parentId: Number.isInteger(body.parentId) ? body.parentId : null,
        thinking: !!body.thinking,
        search: false,
        preempt: body.preempt === true,
      });
      await new Promise((resolve) => {
        const iv = setInterval(() => {
          const last = events[events.length - 1];
          if (last && (last.type === 'done' || last.type === 'error')) { clearInterval(iv); resolve(); }
        }, 300);
        setTimeout(() => { clearInterval(iv); resolve(); }, 88000);
      });
      reportWaiters.delete(id);
      return sendJson(res, 200, { id, sessionId: body.sessionId, events });
    }

    sendError(res, 404, 'DQ_NOT_FOUND — see README: /v1/chat/completions, /v1/models, /health');
  } catch (e) {
    if (!res.headersSent) sendError(res, 500, String(e.message || e));
    else res.end();
  }
});

// ---------------------------------------------------------------------------
// Auth (auth.json) + persistent stats (stats.json, 15-day retention)
// ---------------------------------------------------------------------------
const AUTH_FILE = path.join(__dirname, 'auth.json');
const STATS_FILE = path.join(__dirname, 'stats.json');
const STATS_DAYS = 15;

function loadAuth() {
  try { return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')); } catch { return null; }
}
function saveAuth(a) { fs.writeFileSync(AUTH_FILE, JSON.stringify(a, null, 2)); }
let AUTH = loadAuth();
if (!AUTH || !AUTH.keys?.length) {
  AUTH = {
    keys: [`sk-dq-${crypto.randomBytes(12).toString('hex')}`, 'sk-dq-bridge-local'],
    dashboardPassword: crypto.randomBytes(6).toString('hex'),
    sessions: [],
  };
  saveAuth(AUTH);
  log(`first run credentials written to auth.json: apiKey=${AUTH.keys[0]} dashboardPassword=${AUTH.dashboardPassword}`);
}

const newSessionToken = () => crypto.randomBytes(16).toString('hex');
function authSession(token) { return typeof token === 'string' && AUTH.sessions.includes(token); }

function checkApiKey(req) {
  const auth = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
  const xkey = String(req.headers['x-api-key'] ?? '');
  return AUTH.keys.includes(auth) || AUTH.keys.includes(xkey);
}

function loadStats() {
  const today = new Date().toDateString();
  let s = { days: {}, recent: [] };
  try { s = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')); } catch { /* first run */ }
  // drop entries older than STATS_DAYS
  const cutoff = Date.now() - STATS_DAYS * 86400_000;
  for (const k of Object.keys(s.days ?? {})) {
    if (new Date(k).getTime() < cutoff) delete s.days[k];
  }
  s.recent = (s.recent ?? []).slice(0, 50);
  s._today = today;
  return s;
}
const STATS = loadStats();
let statsSaveTimer = null;
function writeStatsSync() {
  try {
    const { _today, ...out } = STATS;
    fs.writeFileSync(STATS_FILE, JSON.stringify(out));
  } catch { /* ignore */ }
}
function saveStats() {
  clearTimeout(statsSaveTimer);
  statsSaveTimer = setTimeout(writeStatsSync, 500);
}
function statDay() {
  const key = new Date().toDateString();
  if (!STATS.days[key]) STATS.days[key] = { requests: 0, ok: 0, fail: 0, inChars: 0, outChars: 0 };
  return STATS.days[key];
}
function recordRequest(job) {
  const day = statDay();
  day.requests += 1;
  if (job.error) day.fail += 1; else day.ok += 1;
  day.inChars += job.prompt?.length ?? 0;
  day.outChars += (job.shownText ?? job.text ?? '').length;
  STATS.recent.unshift({
    at: nowHMS(),
    account: job.account ?? '?',
    mode: job.reqType ?? (job.usedDelta ? 'delta' : 'full'),
    in: job.prompt?.length ?? 0,
    out: (job.shownText ?? job.text ?? '').length,
    think: job.reasoning?.length ?? 0,
    tools: job.toolCalls?.length ?? 0,
    ms: job.roundDoneAt && job.startedAt ? job.roundDoneAt - job.startedAt : null,
    ok: !job.error,
    err: job.error ? job.error.slice(0, 80) : null,
  });
  STATS.recent = STATS.recent.slice(0, 50);
  saveStats();
}
const LOG_RING = [];
const _log = log;
log = (...args) => {
  _log(...args);
  LOG_RING.push(`${nowHMS()} ${args.map((a) => String(a)).join(' ')}`);
  if (LOG_RING.length > 200) LOG_RING.shift();
};

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
for (const a of accounts) {
  // Pre-launch every account's Chrome so first request doesn't race the boot.
  fetch(`http://127.0.0.1:${a.cdpPort}/json/version`)
    .then((r) => { if (!r.ok) throw 0; log(`account ${a.name}: chrome already up (port ${a.cdpPort})`); })
    .catch(() => launchChrome(a));
}

loadSessions();
loadFileCache();

const BOOT_TS = Date.now();
server.listen(CFG.port, '127.0.0.1', () => {
  log(`DeepSeek Browser Bridge on http://127.0.0.1:${CFG.port}/v1`);
  log(`accounts: ${accounts.map((a) => `${a.name}@${a.cdpPort}`).join(', ')} | concurrency=${CFG.concurrency} queue=${CFG.queueMax} gap=${CFG.minGapMs}+0..${CFG.jitterMs}ms hour=${CFG.maxPerHour}/acc day=${CFG.maxPerDay || 'unlimited'}/acc think=${CFG.think} quiet='${CFG.quietHours || 'off'}'`);
  log(`session retirement: ${CFG.sessionDeleteTtlMs > 0 ? `delete web sessions inactive >= ${Math.round(CFG.sessionDeleteTtlMs / 86400_000)}d (activity-based)` : 'off'} | sweep every ${Math.round(CFG.sessionSweepMs / 60000)}min (fail-safe: drop mapping only after confirmed web delete)`);
  log(`profile dirs under ${LOCALAPPDATA}${CFG.show ? ' (windows ON-SCREEN for login)' : ' (silent, off-screen)'}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => {
  writeSessionsSync(); writeStatsSync(); // flush debounced state before exit
  process.exit(0);
});
