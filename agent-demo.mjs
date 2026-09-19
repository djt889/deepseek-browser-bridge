/* Real-agent smoke test: a standard OpenAI tool-calling loop talking to the
 * DeepSeek Browser Bridge, with REAL tool execution (web search + page fetch).
 * Usage: node agent-demo.mjs "你的问题"
 */
const BRIDGE = 'http://127.0.0.1:39751/v1/chat/completions';
const MODEL = process.env.DQ_MODEL ?? 'deepseek-v4.1-flash-nothink';

const tools = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web. Returns top results with title, url and snippet.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Search query' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: 'Fetch a web page and return its readable text (first 4000 chars).',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'Full http(s) URL' } },
        required: ['url'],
      },
    },
  },
];

async function webSearch({ query }) {
  const res = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), {
    headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    signal: AbortSignal.timeout(20000),
  });
  const html = await res.text();
  const results = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && results.length < 5) {
    const clean = (s) => s.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
    results.push({ title: clean(m[2]), url: m[1].replace(/&amp;/g, '&'), snippet: clean(m[3]).slice(0, 300) });
  }
  return results.length ? results : '(no results)';
}

async function fetchUrl({ url }) {
  const res = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    signal: AbortSignal.timeout(25000),
  });
  const html = await res.text();
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').trim();
  return text.slice(0, 4000) || '(empty page)';
}

const executors = { web_search: webSearch, fetch_url: fetchUrl };

async function runAgent(task) {
  const messages = [
    { role: 'system', content: 'You are a research assistant. Use the provided tools to search the web when needed, then answer the user concisely in Chinese.' },
    { role: 'user', content: task },
  ];
  for (let round = 1; round <= 6; round++) {
    console.log(`\n== agent round ${round} (${messages.length} messages) ==`);
    const res = await fetch(BRIDGE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, tools, messages }),
      signal: AbortSignal.timeout(300000),
    });
    const data = await res.json();
    if (data.error) throw new Error('bridge error: ' + data.error.message);
    const msg = data.choices[0].message;
    if (data.choices[0].finish_reason === 'tool_calls' && msg.tool_calls?.length) {
      messages.push(msg);
      for (const call of msg.tool_calls) {
        const name = call.function.name;
        let args = {};
        try { args = JSON.parse(call.function.arguments || '{}'); } catch { /* keep {} */ }
        console.log(`  tool: ${name}(${JSON.stringify(args)})`);
        let result;
        try {
          result = await executors[name](args);
          const shown = JSON.stringify(result);
          console.log(`  -> ${shown.length > 160 ? shown.slice(0, 160) + '…' : shown}`);
        } catch (e) {
          result = { error: String(e.cause?.code || e.message) };
          console.log(`  -> ERROR ${result.error}`);
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      }
      continue;
    }
    console.log('\n== final answer ==\n' + msg.content);
    return;
  }
  console.log('max rounds reached');
}

runAgent(process.argv[2] ?? '搜索一下 DeepSeek 最新发布的模型叫什么名字，用一句话中文告诉我。').catch((e) => {
  console.error('AGENT FAILED:', e.message);
  process.exit(1);
});
