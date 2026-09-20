# DeepSeek Browser Bridge

把 DeepSeek 网页版桥接为**本地 OpenAI / Anthropic 兼容接口**，给本地 agent 和任意 OpenAI SDK 客户端使用。**所有 DeepSeek 请求都由真实 Chrome 页面内发出**（多账号 = 每号一个真实 Chrome 实例）——TLS 指纹、HttpOnly Cookie、数美设备 SDK 信号全部为真，配合内置节流与账号池轮换，把封号风险压到逆向方案的最低档。

零第三方依赖，单文件 `node server.mjs` 即可运行（Node ≥ 22）。

![架构图](docs/architecture.png)

> 🖱️ [交互式架构图](docs/architecture.html)（可缩放 / 主题切换 / 路径追踪）

协议移植自 [zhu1090093659/deepseek-pp](https://github.com/zhu1090093659/deepseek-pp)（Apache-2.0，2026-09 已归档）。

## 这是什么

本地起一个网关（默认 `http://127.0.0.1:39751`），你的 agent / 客户端把请求发给它，桥在后台驱动一个（或多个）**真实 Chrome** 打开 DeepSeek 网页版，把请求翻译成网页私有协议由页面自身发出，再把流式响应翻译回标准 API 格式。对客户端来说，它就是一个普通的 OpenAI 兼容服务。

**功能一览**：

- **三协议出站**：`/v1/chat/completions`（OpenAI）、`/v1/messages`（Anthropic Messages，含 thinking / tool_use / tool_result 翻译与完整流式事件）、`/v1/responses`（OpenAI Responses，含 function_call 翻译）。共用同一条完成流水线
- **流式 / 非流式**：标准 OpenAI SSE（`delta.content` / `delta.reasoning_content` / `delta.tool_calls` 单层格式）
- **function calling**：标准 OpenAI tools 入参出参；联网类工具推荐客户端自执行（`agent-demo.mjs` 是完整参考实现）
- **图片 / 文件输入**（三协议全支持）：自动走网页上传接口 + 审计轮询 + 内容哈希缓存（同文件零重传），含图自动切 vision 模式
- **会话复用**：前缀哈希命中 → 只发增量消息，杜绝每轮新建网页会话；agent compact / 历史改写自动降级全量模式
- **账号池**：多号各自独立 Chrome 实例 + profile + 调试端口，空闲最久优先轮换，单号失败自动摘除换号
- **保号节流**：间隔 + 随机抖动 + 每小时/每日限额 + 静默时段，全部按单账号独立计算
- **管理面板**：Dashboard（号池健康 / 实时日志 / 15 天统计 / 会话清扫 / 多 API Key 管理）
- **韧性**：账号自动复活、悬空会话映射自愈、网页会话 10 天未活跃自动回收（fail-safe：确认删除成功才丢映射）、客户端断开自动优雅停止

## 为什么风险低

| 检测面 | 纯 HTTP 反代 | 本桥 |
|---|---|---|
| TLS/JA3/JA4、HTTP/2 指纹 | Rust/Node 网络栈，一眼假 | Chrome 真实网络栈 |
| HttpOnly Cookie | 手动提取易断 | 浏览器自动携带/轮换 |
| 数美设备 SDK（device_id/行为信标） | 静态快照，信标缺失 | 页面内活跃运行 |
| 会话模式 | 每轮新建 session | 前缀复用，只发增量 |
| 请求节奏 | 机器匀速 | 间隔 + 随机抖动 + 上限闸门 |
| IP | 常部署在云上 | 本机住宅 IP |

浏览器用 **headed 静默窗口**（屏幕外定位），不用 headless——UA、窗口特征、行为信号与日常 Chrome 完全一致，这是防封的关键取舍。

剩余暴露面只有"频率与内容模式"，由节流器压制。**不是零风险**：逆向私有协议违反 DeepSeek ToS，请用专用小号。

## 劣势与代价（用之前先读这节）

优势的另一面，与官方 DeepSeek API 对比：

| 劣势 | 说明 |
|---|---|
| **延迟与吞吐低于官方 API** | 请求过一层真实浏览器（CDP 往返 + 页面 fetch），首 token 延迟更高；节流闸门（间隔/每小时/每日限额）是刻意求慢——这是保号的代价，别指望它跑高并发生产负载 |
| **官方风控无法技术绕过** | 短时间高频会触发软限流，恢复可达数小时且期间只能干等；继续猛打会升级到强制下线。只能靠节流预防，没有事后补救手段 |
| **工具调用遵循性弱** | 网页版模型对注入的 function calling 指令遵循不如官方 API，复杂多工具场景偶发不调用或格式错（客户端拿到的是干净文本，重试或把任务写明确即可） |
| **每号一个常驻 Chrome** | 每个账号一个真实 Chrome 实例，各占数百 MB 内存常驻；不用 headless 是防封的必要取舍，资源紧张的环境不合适 |
| **Windows + 桌面会话** | 只在 Windows + Chrome 实测；headed 静默窗口依赖桌面会话，无显示器的纯服务器部署需自行改造（本项目拒绝 headless，这是设计立场不是疏漏） |
| **登录态需人工维护** | 登录过期或被强制下线后，需要人工重新登录一次（桥会自动检测并在面板提示，不会用坏号硬打） |

## 快速开始

要求：Windows + Node ≥ 22 + Chrome（自动探测），DeepSeek 账号一个或几个（建议 2~4 个自己注册的号，不要批量）。

```cmd
:: 1. 在 server.mjs 同目录建 accounts.json（每号一项，端口不冲突即可；可从 accounts.example.json 复制）
::    [{"name":"acc1","cdpPort":9222}]
::    profileDir 可省略（默认 %LOCALAPPDATA%\dq-bridge-profile-<name>）

:: 2. 启动桥（自动为每个账号拉起静默 Chrome；首次启动自动生成 auth.json，含随机 API Key）
node server.mjs

:: 3. 首次登录：窗口放屏幕上启动，登录一次后永久保存在该号 profile
node server.mjs --show          :: 所有 Chrome 窗口显示在屏幕（登录完 Ctrl+C 重启即可）
:: 或单号手工模式：start-chrome.cmd show

:: 4. 验证
curl http://127.0.0.1:39751/health
```

`/health` 逐账号返回 `loggedIn`/`dead`/`dayCount`。Chrome 未启动时桥自动拉起；端口被占用则复用现有实例。首次启动的 API Key 与面板密码打印在 `bridge.log`，也可直接看 `auth.json`。

可选：`install-guard.cmd` 注册计划任务，每 5 分钟检测桥存活并自动拉起。

## 调用示例

```bash
# 非流式
curl http://127.0.0.1:39751/v1/chat/completions \
  -H "authorization: Bearer sk-你的key" -H "content-type: application/json" \
  -d '{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":"你好"}]}'

# 流式（OpenAI SSE；思考内容在 delta.reasoning_content）
curl -N http://127.0.0.1:39751/v1/chat/completions \
  -H "authorization: Bearer sk-你的key" -H "content-type: application/json" \
  -d '{"model":"deepseek-v4.1-flash","stream":true,"messages":[{"role":"user","content":"介绍下自己"}]}'
```

Python（OpenAI SDK）：

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:39751/v1", api_key="sk-你的key")
r = client.chat.completions.create(
    model="deepseek-v4.1-flash",
    messages=[{"role": "user", "content": "你好"}],
)
print(r.choices[0].message.content)
```

Anthropic SDK / Responses API 客户端同理：把 `base_url` 指到 `http://127.0.0.1:39751`，路径分别为 `/v1/messages` 与 `/v1/responses`。

## 模型名开关

| 模型名 | 思考 | 联网搜索 |
|---|---|---|
| `deepseek-v4.1-flash` | 跟随全局默认（默认开） | 关 |
| `deepseek-v4.1-flash-nothink` | 强制关 | 关 |
| `deepseek-v4.1-flash-search` | 跟随全局默认 | **开** |

模型名按子串解析（`think`/`nothink`/`search`），可组合如 `deepseek-v4.1-flash-nothink-search`。

**联网建议**：agent 的联网需求优先走 agent 自带工具（`web_search`/`web_fetch`）——抓取发生在 agent 进程内，DeepSeek 只看到一条普通长 prompt，联网行为完全不可见；`-search` 模型名留给偶尔需要模型自搜的场景，不要每轮都用（100% 搜索占比是显眼机器特征）。

## 账号池

- **调度**：请求分给「空闲最久」的存活账号；增量会话（前缀命中）固定回原账号（会话归属）。
- **限额**：间隔/每小时/每日限额按**单账号**独立计算，N 个号 = N 倍吞吐，且每号频率不变（号池保号的原理：分摊而非提速）。
- **健康**：连续 `DQ_AUTH_FAIL_LIMIT`（默认 2）次 auth 失败 → 该号标记 `dead` 摘除；PoW 失败/HTTP 429 → 冷却 5 分钟。
- **复活**：**自动**——账号被摘除后，健康检查发现该号页面重新登录即自动恢复（`DQ_AUTO_REVIVE=0` 关闭）；手动 `POST /admin/revive` 仍可用。
- **加号**：accounts.json 加一项 → 重启桥 → 新 Chrome 自动拉起 → `--show` 登录一次即参与轮换。

## Dashboard（内置管理面板）

浏览器打开 **http://127.0.0.1:39751/dashboard**（密码见 `auth.json` 的 `dashboardPassword`，首次启动也打印在日志）。

- **概览**：运行状态条（存活账号/今日请求/成功率/队列）、号池卡片（登录态/冷却倒计时/今日用量）、告警条
- **请求**：最近 50 条请求明细；**统计**：15 天按日聚合，跨重启保留
- **日志**：实时全屏日志；**会话**：网页会话映射查看 + 清扫
- **API Keys**：多 Key 增删（`/v1/*` 的 key 来源即 `auth.json` 的 `keys[]`）

## 鉴权（auth.json）

- `/v1/*` 强制 API Key（`Authorization: Bearer <key>` 或 `x-api-key`）；`/admin/*` 需 Dashboard 登录态（`/admin/stats|logs` 也接受 Key）
- `auth.json` 首次启动自动生成：`keys`（随机主 Key + `sk-dq-bridge-local` 固定备用 Key）与随机 `dashboardPassword`；面板内可增删 Key、改密码

## 节流参数（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `DQ_CONCURRENCY` | 4 | 并发槽（不同会话间并行；同一会话永远串行）。>6 的画像已是明显机器，尖峰临时调高、不要常驻 |
| `DQ_QUEUE_MAX` | 32 | 排队深度，超出返回 429 |
| `DQ_MIN_GAP_MS` | 8000 | 两次 completion 最小间隔（从上一条**完成后**起算） |
| `DQ_JITTER_MS` | 4000 | 间隔随机抖动上限 |
| `DQ_MAX_PER_HOUR` | 90 | 每小时请求上限，超出排队等待 |
| `DQ_MAX_PER_DAY` | 500 | 每日上限，**0 = 不限**，超出返回 429 |
| `DQ_QUIET_HOURS` | 关 | 静默时段，如 `23:00-07:00` |
| `DQ_THINK` | 1 | 思考全局默认（模型名可按请求覆盖） |
| `DQ_PORT` | 39751 | 桥监听端口（仅绑定 127.0.0.1） |
| `DQ_CDP_PORT` | 9222 | 仅单账号模式（无 accounts.json）生效；多账号以 accounts.json 为准 |
| `DQ_AUTH_FAIL_LIMIT` | 2 | 连续 auth 失败多少次后标记账号 dead |
| `DQ_CHROME` | 自动探测 | 指定 chrome.exe 路径 |
| `DQ_SESSION_TTL_MS` | 7200000 | 会话映射存活时间 |
| `DQ_SESSION_MAX` | 50 | 会话映射总量上限（LRU 淘汰，淘汰条目同样受 10 天活跃门槛保护） |
| `DQ_SESSION_DELETE_TTL_MS` | 864000000 | 网页会话回收：**最近一次命中** 10 天不活跃才从 DeepSeek 删除，按活跃度判定（老而活跃的会话绝不删）；0=关闭 |
| `DQ_SESSION_SWEEP_MS` | 600000 | 会话回收清扫周期 |
| `DQ_SESSION_CONT_GAP_MS` | 15000 | 同会话连续 completion 的最小间隔（空流防护），漏网空流自动重试一次 |
| `DQ_IDLE_TIMEOUT_MS` | 180000 | 单请求无输出超时 |
| `DQ_FILE_AUDIT_TIMEOUT_MS` | 45000 | 附件审计轮询超时 |
| `DQ_AUTO_REVIVE` | 1 | 页面重新登录时自动摘除 dead 标记 |

节流参数保持默认即可安心日常使用——**行为模式（频率画像）是唯一变量**，传输与指纹层无法被区分（真实 Chrome）。

## 工具调用

标准 OpenAI function calling：带 `tools` 的请求照常返回 `tool_calls`，`tool` 结果以 `<tool_result>` 回填续答。

- 带 tools 的请求强制 full 模式（每轮新会话 + 全量 transcript）；纯对话不受影响，仍走增量复用。
- 联网等工具由**客户端实现并执行**（`agent-demo.mjs` 是现成参考：DDG 搜索 + fetch_url 的完整循环）。
- **稳定性实测**：移植 DeepSeek++ 的完整配方后（XML 对抗规则 + 搜索 few-shot 示例 + 尾部格式提醒），模型对"该调工具"的遵循显著改善但仍有随机性；客户端拿到的永远是干净回复（没调工具就是纯文本，多试或把任务写明确）。
- 离线解析测试：`node test-tools.mjs`（8 项）。
- **接入 CCR**（claude-code-router）：Providers 加 `{"id":"dq","name":"DQBridge","type":"openai_chat_completions","api_base_url":"http://127.0.0.1:39751/v1",...}`，重启后模型以 `DQBridge/deepseek-v4.1-flash-*` 暴露给任意支持 CCR 的 agent。

## 图片 / 文件输入

三协议全支持（实测）：OpenAI content parts 的 `image_url`/`file`、Anthropic 的 `image`/`document` 块（base64 与 url source）、Responses 的 `input_image`/`input_file`（`file_id` 引用除外）。base64 在桥内即刻剥离——字节走网页上传接口（multipart + PoW）换 `ref_file_ids`，不占模型上下文。

- **审计稳定性**：上传后轮询审计状态（unknown→等，pass→用；reject 且可重试→重传最多 2 次），审计最长等 45s。
- **内容哈希缓存**：同字节文件复用已审计的文件 id（7 天 TTL），多轮对话重复截图零重传。
- 增量轮只引用本轮新增附件（历史图片已活在会话中）。

## 已知限制与实测记录

- **软限流三级升级（重要，实测 2026-09-19）**：短时间高频请求后，DeepSeek 会出现"接受请求但不生成"的软限流（页面流停在消息 id 事件后、桥 180s idle 超时）。实测恢复时间**可达数小时**；且每次挂起的请求在 DeepSeek 侧同样建会话、计入请求量，频繁探针会延长窗口——恢复期间应完全停手。若继续高频重复请求（机器人式模式：大量新会话 + 两字微提示词），风控会三级升级：软限流 → 完全停滞 → **强制下线**（页面自跳 `/sign_in`，token 被清空）。强制下线后重新登录即恢复。节流参数的意义就在避免触发它；测试/探针务必低频、提示词多样化。
- **工具调用依赖提示遵循**：网页版模型对注入指令的遵循弱于官方 API，复杂多工具场景偶发不调用或格式错误（桥会把解析失败的调用以 `_unparsed` 透传，不会崩）。
- **上下文实测**（2026-09-19，暗号探针法）：单条 prompt 实测到 **100 万 token**（prompt_tokens 1,000,233）仍无截断、开头内容可见，上界未探明。
- **客户端断开优雅停止**：断开时桥自动调 stop_stream 打断网页生成，已生成的部分文本进入会话树；客户端按标准 API 语义重发完整历史 + 新指令，模型从断点无缝续写（实测断点精确衔接）。任务断开**立即释放**并发槽（报 `DQ_CLIENT_GONE`）。进行中插队：请求体加 `"dq_preempt": true` 可打断正在生成的会话并接续。
- **会话映射自愈**：映射悬空（网页侧会话被手动删除等）时，第一次增量请求失败会自动删掉悬空映射并回全量模式重放一次，对话无损继续。
- **网页会话自动回收（fail-safe）**：按**活跃度**判定——会话名下所有映射中最近一次命中超过 10 天不活跃才回收，老而活跃的会话绝不删。回收时批量调网页删除接口，**确认删除成功后才丢弃本地映射；失败保留、指数退避重试（30min 起步、上限 24h）**。浏览器不在线时清扫只等待、不拉起 Chrome。
- **同会话空流问题已在桥内解决**：DeepSeek 对同一会话的第二次快速 completion 偶发静默返回空响应（15s 内高发）。桥自动强制 15s 冷却 + 漏网空流自动重试一次，多轮工具循环实测稳定。
- **网页协议适配状态**：`completion` / `regenerate` / `editMessage`（编辑最后一条用户消息重答）/ `stop_stream` / 会话创建均已验证；`continue` 为实验性（未完成回复的续写推荐客户端追加"继续"消息，实测完美）；`resume_stream`（断线恢复）未适配。
- Responses 协议的 `file_id` 引用未实现（需建 `/v1/files` 托管端点）——直接传 base64/url 即可，桥内哈希缓存已等价覆盖其核心收益。
- 上游协议变更（如 PoW 算法升级）会使桥失效——deepseek-pp 已归档，无人跟进修复。

## 排错

| 现象 | 处理 |
|---|---|
| `DQ_CDP_UNREACHABLE` | 桥会自动拉起 Chrome，重试即可；持续失败检查端口/杀毒 |
| `DQ_NO_TOKEN` | 该号页面未登录：`node server.mjs --show` 登录；或登录态过期，刷新页面 |
| `DQ_AUTH_401/403` | token 被服务端拒绝，重新登录 |
| `DQ_ACCOUNT_DEAD` / `DQ_NO_LIVE_ACCOUNT` | 该号连续 auth 失败被摘除：重新登录后自动复活（或 `POST /admin/revive`） |
| `DQ_POW_*` | PoW 挑战失败，桥已自动让该号冷却 5 分钟；频发说明风控收紧，降频观察 |
| `DQ_IDLE_TIMEOUT` | 思考模式长回复超时，调大 `DQ_IDLE_TIMEOUT_MS` |
| `DQ_TAB_NAVIGATED` | 请求进行中页面被导航，重试即可 |
| `DQ_FILE_AUDIT_REJECTED` | 附件被审计拒绝且重试仍拒：换文件或缩小体积 |

## 文件说明

| 文件 | 说明 |
|---|---|
| `server.mjs` | 桥主体（单文件，零依赖） |
| `inject.js` | 注入 DeepSeek 页面的桥接脚本（PoW / 私有协议 / SSE 解析） |
| `dashboard.html` | 内置管理面板（单文件） |
| `wasm/sha3_wasm_bg.wasm` | DeepSeek 官方网页的 PoW WASM（原样取自其前端，本地求解挑战） |
| `accounts.example.json` | 多账号配置示例（复制为 `accounts.json`） |
| `agent-demo.mjs` | 客户端工具循环参考实现（搜索 + fetch） |
| `test-sse.mjs` / `test-tools.mjs` | 流式 / 工具解析离线测试 |
| `start-chrome.cmd` / `guard-bridge.cmd` / `install-guard.cmd` | 手工起 Chrome / 存活守护 / 注册守护计划任务 |

运行时自动生成（已 gitignore，含个人数据，勿提交）：`auth.json`、`accounts.json`、`sessions.json`、`files.json`、`stats.json`、`bridge.log`。

## 免责

本项目仅用于个人学习研究。使用即表示你理解并接受：违反 DeepSeek 服务条款、账号可能被限制或封禁、上游协议变更导致失效等风险。请控制频率，对你的账号负责。

## License

[MIT](LICENSE)
