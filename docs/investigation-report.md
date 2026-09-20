# 调查报告：并发架构 / 工具调用 / 架构图

调查日期：2026-09-20
调查对象：`E:\AI\ZCode\outputs\deepseek-browser-bridge`
状态：**仅调查，未改任何代码**

---

## 一、关于「本地 agent 调用子代理」这个场景

这是最应该讲清楚的场景，因为它是真并行需求最强的用例。

### 1.1 你的场景实际发生了什么

当本地 agent（pi / Claude Code 等）一次开 N 个子代理时：

| 环节 | 行为 |
|------|------|
| 子代理发起 | pi 在同一条消息里发 N 个 `Agent` 调用，每个子代理**独立**发一个 `/v1/chat/completions` |
| 到达 Bridge | N 个请求同时进入队列，`pump()` 按 `concurrency=6` 放行最多 6 个 |
| **卡在这里** | 这 6 个 job 全部去抢**同一个账号的同一个节流器**，而节流器要求「距上次完成 ≥ 8~12 秒」 |
| 实际结果 | 6 个 job 在节流器前排成一条链，**一次只过一个** |

用你实测的 6 子代理数据看得很清楚（Bridge 日志）：

```
22:43:15  complete sess=a32475e6
22:43:24  complete sess=46e89b2c      ← 隔 9 秒
22:43:25  complete sess=a56b52f0      ← 隔 1 秒
22:43:25  complete sess=c477e3d2
22:43:36  complete sess=a16e6b46      ← 隔 11 秒
```

**结论：6 个子代理实际是「排队 + 每 8~12 秒放行一个」，不是并行。** 总耗时 ≈ 子代理数 × 8~12 秒。

### 1.2 为什么会这样（根因一行）

`server.mjs:578-584`：

```js
const since = now - this.lastDone;
if (this.lastDone && since < dynamicInterval) {
  const waitTime = dynamicInterval - since;
  await sleep(waitTime, signal);
  continue;          // ← 睡醒后回循环顶部再检查，只有满足间隔才放行
}
```

`this.lastDone` 是**账号级唯一标量**，只在请求**完成后**更新（`done()`，`:593`）。

所以语义是：**「上一个请求彻底完成后，再等 8~12 秒，才允许下一个」** —— 这是设计上的全局串行闸门。

关键点：`concurrency=6` 控制的是「同时在**排队**的 job 数」，不是「同时在**跑**的 job 数」。槽位被「在节流器里 sleep」的 job 占着。

### 1.3 为什么这是刻意的

README 里写得很明确（`:50`、`:174`）：

> 节流闸门是刻意求慢——这是保号的代价，别指望它跑高并发生产负载
>
> 短时间高频会触发软限流，恢复可达数小时……继续猛打会升级到强制下线

代码里也有对应的风控反馈闭环：软限流检测（`:1194`，60 秒无首 token 判定）、`429` 触发 5 分钟冷却（`:620`）、连续认证失败直接标记 `dead`（`:616`）。

**所以这不是 bug，是风控设计。** 单账号下它主动禁止了真并行。

### 1.4 你这个场景的三种解法

**方案 A：多账号（唯一安全路径）**

每账号一个 Chrome + Profile + 独立节流器，`pickAccount()` 会把 job 分到不同节流器。

| 账号数 | 子代理真并行度 | 说明 |
|--------|---------------|------|
| 1（当前） | **1** | 无论 concurrency 设多少 |
| 3 | 3 | 每个号内仍串行 |
| 6 | 6 | 匹配 concurrency=6 |

对你的场景：**如果 agent 常开 6 个子代理，配 6 个号就能真正 6 路并行**，且每个号内的请求间隔仍是 8~12 秒（保号不受影响）。代价是 6 个 Chrome 常驻，每个数百 MB 内存。

**方案 B：单账号放开闸门（不推荐）**

`DQ_MIN_GAP_MS=0` 即可让同一页面真并发。但同一个号在同一 IP 上并发发请求，是最强的机器行为信号，实测很可能几小时内把号打进软限流甚至强制下线。

**方案 C：单账号多标签页（半吊子）**

同账号开多个标签页。但节流器仍是账号级，**仍然串行**，等于没解决问题；反而多页面同号是比单页面高频更强的信号，风险更高。

### 1.5 我的建议

**推荐 A 的变体：多账号 + 每个号的间隔可配。**

- 子代理场景天然适合多账号：子代理之间互相独立，不需要共享会话，正好可以分散到不同号
- 保留每号 8~12 秒间隔（保号），但**账号数 = 并行度**，这是唯一「既并行又安全」的组合
- 可选：给一个 `DQ_MIN_GAP_MS` 环境变量让你按号的健康状况手动提速（比如养得久的号调到 4 秒）

**你只需要提供 2~6 个小号并分别登录一次**，配置写好（`accounts.json` 加几条），代码侧我改 `pickAccount()` 的分配策略（现在是最久未活动优先，对子代理场景是对的，但需要确保同一批子代理能分散到不同号）。

---

## 二、工具调用：实现方式与稳定性评估

### 2.1 实现方式（完整链路）

```
客户端传 tools
  ↓ server.mjs:1955 取出 tools 数组
  ↓ server.mjs:1957 提取工具名 toolNames
  ↓ buildToolSection() :789   生成「### Tool <name> + 描述 + 调用示例 + JSON Schema」
  ↓ TOOL_RULES :765           对抗规则（必须合法 JSON、别用 <invoke> 包装、标签名精确匹配）
  ↓ toolReminder() :829       中文尾部格式提醒（利用 recency bias，放在 prompt 末尾）
  ↓ joinTranscript() :834     把工具说明放进 [System instructions]，历史 tool_calls 回写成 <name>{json}</name>
  ↓
模型输出文本（含 <tool_name>...</tool_name> 标签）
  ↓ createToolStreamFilter() :890   流式扫描器，逐字符找 '<'
  ↓ parseToolArgs() :865            解析标签体 → 参数对象
  ↓ server.mjs:1223                 映射为标准 tool_calls 格式
  ↓ emitDelta() :1602               按协议分发（OpenAI SSE / Anthropic tool_use / Responses function_call）
```

**关键设计点：**

- **XML 标签协议**：不是原生 function calling，而是让模型按提示词输出 `<tool_name>{json}</tool_name>`，Bridge 再解析回标准 `tool_calls`。这是网页版没有原生 function calling 的必然选择。
- **流式过滤**：`createToolStreamFilter` 在流式过程中就吞掉工具标签，客户端只看到干净的正文；`scan()` 会在标签未闭合时缓冲（hold），避免把半截标签发出去。
- **参数解析双格式**：`parseToolArgs` 同时支持 `<name>{"q":"x"}</name>`（JSON 体）和 `<name><path>p</path><content>c</content></name>`（嵌套参数标签）。
- **服务端不执行工具**：所有 tool_calls 原样返回给客户端（`:1229` 注释明确「Built-in tools were removed by design」）。
- **带 tools 强制 full 模式**：`:1987`，工具请求不走会话增量，每次重发完整 transcript。

### 2.2 稳定性评估

**✅ 可靠的场景：**

- 单工具、单参数、参数是合法 JSON
- 流式模式下的正常工具调用
- 一次响应内多个工具调用（`<a>..</a>mid<b>..</b>` 能正确解析出两个）
- 多轮工具循环（靠 `<tool_result>` 回写 + 客户端重发历史）

**⚠️ 有一个确定的 Bug（P0，会重复执行工具）：**

**非流式模式下 tool_calls 被解析两次。**

`server.mjs:1204` 对每个 chunk 无条件 push 进 filter：

```js
} else if (ev.type === 'chunk') {
  job.text += ev.text;
  const shown = job.toolFilter ? job.toolFilter.push(ev.text) : ev.text;   // ← 没判断 job.stream
```

然后 `:1217-1219` 非流式 `done` 时又把整段文本 push 一次：

```js
if (!job.stream) {
  job.shownText = job.toolFilter.push(job.text) + job.toolFilter.flush();  // ← 第二次 push 同一批内容
}
```

**后果**：任何「非流式 + tools」请求都会拿到**重复的 tool_calls**，客户端会**把同一个工具执行两次**（写两次文件、搜索两次、下两次单）。

**⚠️ 另一个确定的 Bug（P0，会丢调用或产生幻觉参数）：**

**参数值里含 `</` 或嵌套同名标签时，标签体被错误截断。**

`:913` 用 `pending.indexOf('</' + name + '>')` 找闭合标签，不考虑字符串转义：

- `<write>{"c":"</div>"}</write>` → 在 `</div>` 处提前截断，body 变成 `{"c":"a`，**调用丢失 + 正文错乱 + JSON 解析失败**
- `<x><x>inner</x></x>` → 内层闭合被误认成外层，body 变成 `<x>inner`，解析出**幻觉参数**

**真实触发场景**：写 HTML / 代码 / 模板的工具（`write_file`、`edit`），参数里带 `</script>`、`</div>`、`</body>` 极其常见 —— 这个 bug 在实际使用中会频繁触发。

**⚠️ 中风险问题：**

1. **正常文本被长时间扣住**：`isToolNamePrefix`（`:898`）判断过宽，`n.startsWith('')` 恒为真。用户正文里写 `<search>` 这种字面量，会被当成「可能是工具标签开头」而缓冲，直到流结束才吐出来 → 表现为卡壳。
2. **工具名拼错静默失败**：模型输出 `<getWeather>` 但列表里是 `get_weather`，`nameSet.has()` 不匹配 → 当作纯文本原样透传。**既不调用也不报错**，用户只看到一堆乱码文本。
3. **`_unparsed` 兜底对客户端不可用**：JSON 解析失败时返回 `{_unparsed: "..."}`，但 `finish_reason` 仍是 `tool_calls`。客户端按 schema 取字段会拿到 `undefined`，**看似成功实则空转**。
4. **解析格式覆盖有限**：markdown 代码块包裹的 JSON（` ```json ... ``` `）、带尾逗号/单引号的轻微畸形 JSON、纯自然语言参数，都会落入 `_unparsed`。

**测试覆盖不足**：`test-tools.mjs` 只有 8 项，且全是 happy-path，**上述任何一个缺陷都没有覆盖**。

### 2.3 影响评估（对你的实际使用）

| 场景 | 是否受影响 | 后果 |
|------|-----------|------|
| pi agent 流式调用工具 | 部分 | 参数含 `</` 时丢调用（写 HTML/代码时高频） |
| 非流式调用（`stream:false`） | **是** | 工具被执行两次 |
| 工具名拼错 | 是 | 静默失败，无提示 |
| 写含 `</script>` 的文件 | **是** | 高频丢调用 |

---

## 三、架构图重画方案

### 3.1 现有图的问题

现有 `docs/architecture.png` 是**组件级 overview**：8 个粗粒度盒子，把所有细节都压进了「server.mjs 流水线」一个节点里。

**不够详细的原因**：协议适配、任务队列、并发控制、账号节流、CDP 管理、会话映射、文件缓存、工具解析 —— 全部被压缩成一个盒子的小字 tag。

### 3.2 重画方案（按你的选择）

**图 1：详细架构图（architecture 类型）**

拆开 `server.mjs` 大盒子，按层展开：

| 层 | 展开内容 |
|----|---------|
| 入口与协议适配 | HTTP 服务 `:39751`、`/v1/*` + `/admin/*` 路由、三协议转换（`anthropicToInternal` / `responsesToInternal` / OpenAI 原生）、鉴权（auth.json 多 Key） |
| 调度与排队 | 任务队列 `pump()`、`runJob`、并发槽（concurrency=6）、账号轮换 `runWithRotation`、`pickAccount` 健康选号 |
| 保号节流 | `AccountThrottle`（8~12s 间隔 + 抖动）、每小时 90 次上限、软限流检测与冷却 |
| CDP 管理 | `Cdp` 类、9222 端口、`findChrome` / `launchChrome`（屏幕外静默）、页面 RPC（`newSessionViaPage` / `stopStreamViaPage` 等）、报告通道 `onReport` / `awaitReport` |
| 页面注入 | `inject.js`、PoW WASM 本地求解、私有协议 + SSE 解析、页面自身 fetch（真实 TLS / HttpOnly Cookie） |
| 会话与文件 | 会话映射（前缀哈希复用、只发增量）、`withSessionLock`、10 天回收、文件内容哈希缓存 |
| 工具解析 | `TOOL_RULES` → `buildToolSection` → `parseToolArgs` → `createToolStreamFilter` |

**图 2：请求时序图（sequence 类型）**

一次完整请求的生命周期：

```
Agent → 鉴权 → 协议适配 → 入队 → 选号 → 节流闸门 → 会话查找
     → CDP evaluate → inject.js → 页面 fetch(真实 TLS) → DeepSeek 网页版
     → SSE 流回传 → 工具解析过滤 → 协议适配 → 返回 Agent
```

这张图能直观展示**「排队串行」发生在哪一步**（节流闸门），对你理解第 1 节的问题很有帮助。

**图 3：工具调用解析流程图（dataflow 类型）**

```
模型文本流 → 逐字符扫描 '<' → 识别标签名 → 查工具名白名单
          ├─ 命中 → 缓冲到 '闭合标签' → parseToolArgs
          │         ├─ JSON 体 → JSON.parse
          │         └─ 嵌套标签 → 正则解析
          │       → 标准 tool_calls
          └─ 未命中 → 当纯文本透传
```

这张图能标出**两个 bug 的位置**（闭合标签扫描、重复 push）。

### 3.3 工具与流程

用已装好的 archify skill：

```bash
node C:\Users\Administrator\.zcode\skills\archify\bin\archify.mjs doctor
node .../archify.mjs validate <type> docs/xxx.arch.json --quality showcase --json
node .../archify.mjs deliver  <type> docs/xxx.arch.json docs/xxx.html --quality showcase --json
node .../archify.mjs visual-check docs/xxx.html --json
```

产物是自包含单 HTML（内联 SVG，支持暗/亮主题、缩放、搜索），可导出 PNG。

---

## 四、待你决策

1. **真并行**：是否走多账号方案？如果走，你能提供几个小号？
2. **工具调用 bug**：本报告已列出 2 个 P0 + 4 个中风险，是否修复？
3. **架构图**：确认出 3 张（架构 / 时序 / 工具调用）？

以上均未改动任何代码，等你确认后再动手。
