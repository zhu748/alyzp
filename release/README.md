# zcode-proxy 使用说明

> **v0.0.0.2 — 修复 exe 模式下 Playwright solver 崩溃 (kind-of / stealth 插件 require 失败)**
>
> v0.0.0.1 的 Playwright solver 在源码模式 (`bun run src/index.ts`) 下能跑通,但编译成 Windows exe (`bun build --compile`) 后完全崩溃。本版本彻底重写 solver,确保 exe 模式也能正常 solve 验证码。
>
> **本次改动**
>
> - **根因: `playwright-extra` + `puppeteer-extra-plugin-stealth` 在 `bun build --compile` 下必崩**
>   - `puppeteer-extra-plugin-stealth` 运行时 `require('kind-of')` 等 CJS 子模块,exe 模式没有 node_modules,报 `Cannot find package 'kind-of'`
>   - `playwright-extra` 用 `require.resolve` 动态查找 playwright,同样失败,报 `Playwright is missing. :-)`
>   - Fallback 到 JSDOM 后,JSDOM 在 exe 模式下也崩 (`idlUtils.implForWrapper(window2._document)._location` null)
>   - 结果: exe 用户每次 solve 都走 JSDOM → F001 → 503 失败
>
> - **重写 `captcha-playwright.ts`: 纯 `playwright` + 构建期提取 stealth 补丁**
>   - 去掉 `playwright-extra` + `puppeteer-extra-plugin-stealth` 运行时依赖
>   - 新增 `scripts/generate-stealth-evasions.ts`: 构建期从 stealth 插件提取 14 个 evasion 的 JS 代码,打包成 `src/proxy/stealth-evasions.js.txt`(跟 `AliyunCaptcha.js.txt` 同样的 text import 模式)
>   - 运行时用 `context.addInitScript(STEALTH_EVASIONS)` 注入,零 `require()` 调用,exe 模式完全兼容
>   - 新增 CDP `Network.setUserAgentOverride`: 设置 `navigator.userAgentData`(Sec-CH-UA client hints),这是 `addInitScript` 无法 patch 的平台级属性
>   - 新增手动 `navigator.platform` + `navigator.userAgentData` 补丁:确保 platform="Win32" 与 UA 一致(不匹配是强机器人信号)
>
> - **修复 3 个生成脚本 bug**:
>   1. `eval(value as string)` — TypeScript 语法在浏览器里无效,改为 `eval(entry[1])`
>   2. 每个 evasion 声明 `const _utilsFns` 在同一作用域冲突 — 给每个 evasion 包 IIFE `(function(){...})()`
>   3. `chrome.runtime` evasion 默认跳过非 HTTPS 页面 — 设 `runOnInsecureOrigins: true`(about:blank 不是 HTTPS)
>
> - **修复 `captcha.ts` isLaunchFailure 判断逻辑**:
>   - 旧版用正则匹配特定关键词 (`playwright|chromium|Executable`),漏了 `Cannot find package 'kind-of'`
>   - 新版反转逻辑:只有 `SDK fail` (Aliyun 拒绝) 才重试 Playwright,其他错误一律切 JSDOM fallback
>   - 效果:环境问题不再浪费一次 solve 周期 (~20s)
>
> - **`package.json` 依赖变更**:
>   - 删除 `playwright-extra` + `puppeteer-extra-plugin-stealth`(运行时不需要)
>   - 新增 `chromium-bidi` (playwright 的构建期依赖,`--external chromium-bidi` 排除出 bundle)
>   - `build` 脚本加 `--external chromium-bidi --target=bun-windows-x64`(workflow 同步更新)
>
> - **`start.bat` / `start.sh` 新增选项 `i`**:
>   - 一键安装/更新 Chromium binary (`bunx playwright install chromium` 或 `npx playwright install chromium`)
>   - 首次使用 start-plan 模式前必须跑一次
>   - 自动检测 bun / npx,都没有时给出安装链接
>
> - **实测结果**: 3 次连跑全过,平均 2.4 秒,verifyParam 280 字符。684 单测全过。Windows exe 编译成功 (PE32+, 107MB)。
>
> **升级建议**: 所有 v0.0.0.1 用户立即升级。v0.0.0.1 的 exe 包完全无法 solve 验证码。

---

> **v0.0.0.1 — Playwright 验证码 solver 根治阿里云风控 + 修复 ReadableStream is locked bug**
>
> 本次发版**彻底解决** start-plan 模式下验证码无法通过的问题。之前版本用 JSDOM 跑阿里云验证码 SDK,2024 年底阿里云风控升级后,JSDOM 环境被识别为机器人,每次 solve 都返回 `verifyCode F001`,导致所有 `/v1/messages` 请求 503 失败。
>
> **本次改动**
>
> - **新增 Playwright solver** (`src/proxy/captcha-playwright.ts`):
>   - 用 `playwright-extra` + `puppeteer-extra-plugin-stealth` 跑真实 headless Chromium,通过 CDP 控制真实浏览器内核。
>   - 单例 browser 复用,每次 solve 新建 BrowserContext 隔离指纹(避免阿里云关联多次尝试)。
>   - 5 分钟 idle 自动关闭 browser,节省内存(对 Render Free tier 重要)。
>   - 实测首次 solve 2.4 秒成功(JSDOM 路径 20-40 秒且必失败),verifyParam 280 字符,连续 3 次稳定通过。
> - **修复 `ReadableStream is locked` unhandledRejection** (`src/proxy/handler.ts:884-919`):
>   - start-plan 收到 403 captcha challenge 后调 `handleCaptchaChallenge` 返回 `errorResponse(503, ...)`,然后用 `await upstreamResp.text()` 读 body 判断错误类型,接着 `return upstreamResp`。
>   - 但 `errorResponse()` 构造的 Response 内部是单次读取流,被 `.text()` 消费后 Response 进入 locked 状态,返回给 Bun.serve 时抛 `TypeError: ReadableStream is locked`,导致 unhandledRejection + 客户端连接被切断。
>   - 修复:用 `upstreamResp.clone()` 先复制再读 clone,返回原始 Response。
> - **改造 `src/proxy/captcha.ts` 调度逻辑**:
>   - 默认走 Playwright(`ZCODE_CAPTCHA_SOLVER=auto`,Playwright 启动失败自动回退 JSDOM)。
>   - `ZCODE_CAPTCHA_SOLVER=playwright` 强制 Playwright,不回退(适合生产环境,失败立即暴露)。
>   - `ZCODE_CAPTCHA_SOLVER=jsdom` 强制 JSDOM(仅调试用)。
>   - 错误分类:区分「Playwright 启动失败」(切 JSDOM) vs「SDK fail F001」(重试,可能换 context 就过)。
> - **Dockerfile 加 Chromium 系统依赖**:`libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 libatspi2.0-0 libxshmfence1 fonts-noto-color-emoji fonts-noto-cjk`。deps stage 显式 `bunx playwright install chromium` 下载二进制。
> - **`package.json` 新增依赖**:`playwright` / `playwright-extra` / `puppeteer-extra-plugin-stealth`。新增 `postinstall` 脚本自动 `playwright install chromium`。
> - **新增 `scripts/test-captcha.ts`**:独立验证 solver 的 smoke test,一行命令 `bun run scripts/test-captcha.ts` 即可确认 Playwright + Chromium 装好且能过阿里云风控。
> - **`config.example.yaml` 新增 captcha solver 配置文档**:说明三种模式(auto/playwright/jsdom)的差异 + 所有相关环境变量。
> - **影响**:
>   - **所有 start-plan 用户**:验证码不再失败,F001 错误消失。
>   - **coding-plan 用户**:无影响(本来就跳过 captcha)。
>   - **Render Free tier 用户**:内存可能紧张(Chromium 单例 ~150MB + Bun ~50MB),建议升 Starter ($7/mo, 512MB)。
>   - **Docker 部署**:首次构建镜像会下载 Chromium 二进制(~150MB),构建时间增加 1-2 分钟,运行时磁盘多占 ~200MB。
>
> **升级建议**:所有在 start-plan 模式遇到 `verifyCode F001` / `captcha verify failed` / `ReadableStream is locked` 错误的用户立即升级。coding-plan 用户可选升级(无影响)。

---

> **v0.2.1.7 — SSE heartbeat 保活:解决 Cloudflare 524 超时 + 修复压缩流 bug + admin API 增强**
>
> 解决 Cloudflare 524 超时问题:当代理部署在 CF 后面时,GLM-5.2 thinking 模式经常需要 60-180 秒才吐第一个 SSE event,超过 CF 的 100 秒 Proxy Read Timeout,CF 直接返回 524 切断连接。本版本通过在等待上游首字节期间定期 flush SSE 标准注释行(`: keepalive\n\n`)保活,完全解决此问题。
>
> **本次改动**
>
> - **新增 SSE heartbeat 保活机制** (`src/proxy/handler.ts` 的 `createSseHeartbeatTransform`):
>   - 在等待上游首个 chunk 期间,每 15 秒(可配置)往客户端 flush 一行 SSE 标准注释 `: keepalive\n\n`。注释行是 SSE 协议规范的一部分,所有合规客户端(Anthropic SDK / OpenAI SDK / Cherry Studio / Claude Code / Codex / curl)都静默忽略。TCP 层有真实字节流过,CF 重置 100 秒计时器。
>   - 上游首个真实 chunk 一到,heartbeat 立即停止,**之后整个流期间零开销**。
>   - 客户端断开时自动清理定时器,无泄漏。
>   - 在三条 SSE 转发路径上插入(translateMode openai-responses / openai / 非 translateMode passthrough),位置在 stats transform 之后(更靠近客户端)。
> - **修复压缩流 bug**:`passthrough` 模式下 fetch 用 `decompress: false`,upstreamResp.body 是原始压缩字节流(gzip/br/deflate)。如果在此压缩流中间插入明文 `: keepalive\n\n`,客户端解压会报 `Z_DATA_ERROR`。修复方式:passthrough 分支检查 `content-encoding` 头,有压缩时自动禁用 heartbeat。translateMode 两个分支不受影响(Bun 自动解压 + 翻译器输出明文 + translatedSseResponse 不设 content-encoding)。
> - **新增配置项 `server.sseHeartbeatMs`**:
>   - 默认 15000ms(15 秒),设为 0 禁用。
>   - YAML 配置:`server.sseHeartbeatMs: 15000`
>   - 环境变量:`ZCODE_PROXY_SSE_HEARTBEAT_MS=15000`
>   - 推荐范围 10s-30s。低于 5s 浪费带宽,高于 60s 在 CF 后面失去意义。
> - **修复 admin API 的 server 字段处理**:
>   - `configToYaml` 之前只序列化 `server.port` + `server.host`,丢弃 `upstreamTimeoutMs` / `trustProxy` / `sseHeartbeatMs`。通过 dashboard 保存配置后这些字段会从 YAML 消失,重启后恢复默认。现已完整序列化所有 server 字段。
>   - PUT `/admin/api/config` 之前对 `server` 字段做浅合并,部分更新(如只发 `sseHeartbeatMs`)会丢失 `port` / `host` 等其他字段。现已改为 deep-merge。
>   - PUT 热更新逻辑之前完全忽略 `server` 字段,`sseHeartbeatMs` 改完需要重启才生效。现已支持热更新(`upstreamTimeoutMs` / `trustProxy` / `sseHeartbeatMs` 立即生效,`port` / `host` 仍需重启)。
> - **新增 10 个测试**:`src/proxy/handler-heartbeat.test.ts`(6 个,覆盖静默期 flush / 首 chunk 停止 / intervalMs=0 透传 / 注释行格式 / 定时器清理 / 错误处理)+ `src/config/loader.test.ts`(4 个,覆盖默认值 / YAML 覆盖 / env 覆盖 / 0 禁用)。全部 684 个测试通过,TypeScript 零错误。
> - **影响**:
>   - Cloudflare / 反向代理后部署的所有用户:524 超时问题消失。
>   - 所有 SSE 客户端兼容:无需改动,自动忽略注释行。
>   - 流量开销:每分钟静默期约 78 字节,可忽略。
>   - TTFB 之后零开销:heartbeat 已停止。
>   - passthrough + 压缩流:heartbeat 自动禁用(罕见边缘场景,不影响功能)。
>   - non-stream 请求(`stream: false`):不受 heartbeat 保护(客户端期望 JSON 不是 SSE,无法插入注释行)。如果遇到 non-stream 的 CF 524,建议客户端改用 `stream: true`。
>
> **升级建议**:所有在 Cloudflare 或其他反向代理(有 Proxy Read Timeout)后部署的用户立即升级到 v0.2.1.7。直连部署(无反向代理)的用户可选升级(heartbeat 无害但非必需)。

---

> **v0.2.1.6 — 扩展 WAF 拦截检测 + 默认重试加入 429**
>
> 修复两个生产反馈问题:(1) Render 部署时遇到一种伪装成 nginx 标准错误页的 405 拦截,旧版 WAF 检测无法识别,导致代理池不轮换、错误页直接透传给客户端;(2) GLM 上游对超并发返回 429 `{"code":3010,"msg":"model admission concurrency limit exceeded"}`,旧版默认只重试 529,429 直接报错给用户。
>
> **本次改动**
>
> - **新增 4 类 WAF 指纹** (`src/proxy/handler.ts` 的 `checkWafBlock`):
>   - **指纹 3**:阿里云 WAF 标准拦截页的更稳特征(`data-spm` + `block_message` / `block_traceid_tips`)。即使 `errors.aliyun.com` 域名或图片 URL 变化也能识别。
>   - **指纹 4**:nginx 不存在的版本号(`nginx/1.31+`)。nginx 实际不存在 1.31 mainline(2025 年 mainline 是 1.27.x),这种"未来版本号"几乎肯定是 WAF/网关伪装。
>   - **指纹 5**:nginx 默认 405 错误页模板(`<title>405 Not Allowed</title>` + `<hr><center>nginx`)。即使 server 头丢失也能识别。
>   - **指纹 6**(兜底):JSON API 上游(anthropic/openai)返回短 HTML 405。这个项目所有上游都是 JSON API,任何 HTML 405 都是异常。
> - **`checkWafBlock` 导出**:从 `async function` 改为 `export async function`,便于外部测试脚本调用。
> - **新增验证脚本** `scripts/verify-waf-detect.ts`:用 Render 日志和 Cherry Studio 报错的两份真实 405 body + 两个负样本(正常 JSON 405 / SSE 200)跑检测,确认新指纹能命中且不误伤。
> - **默认重试码加入 429** (`src/config/loader.ts` 的 `DEFAULTS.RETRY_STATUSES`):`[529]` → `[529, 429]`。GLM 上游的超并发 429 在短暂退避后重试通常能成功,无脑报错给用户体验差。503 不加入默认(语义模糊,无脑重试反而加剧),需要可通过 `ZCODE_RETRY_STATUSES=529,429,503` 显式开启。
> - **`config.example.yaml` 同步**:种子配置的 `retryableStatuses` 也加上 429,保证新部署开箱即用。
> - **`render.yaml` 同步**:Render Blueprint 的 `ZCODE_RETRY_STATUSES` 从 `"529,429,503"` 改为 `"529,429"`,与默认值保持一致(避免 Render 部署无脑重试 503)。
> - **测试**:`src/config/loader.test.ts` 默认值断言同步更新。676 个单元测试通过,TypeScript 零错误。
> - **影响**:
>   - Render / Docker / 云厂商部署用户:遇到 nginx 伪装 405 拦截时,代理池会自动轮换到下一个代理(前提是池里有多代理),不再透传错误页给客户端。
>   - 所有用户:GLM 上游超并发 429 自动重试,无需手动配置。
>   - 已有 `config.yaml` 用户:如果文件里已硬编码 `retryableStatuses: [529]`,需要手动改成 `[529, 429]` 或删掉该行让它走默认。
>   - Render Blueprint 部署用户:env 变量 `ZCODE_RETRY_STATUSES` 优先级高于默认值,本次改动通过 render.yaml 同步生效。
>
> **升级建议**:Render / Docker / 云厂商部署用户,以及遇到 GLM 超并发报错的所有用户,立即升级到 v0.2.1.6。本地 Windows exe + 住宅 IP 直连用户可选升级(WAF 拦截主要发生在云 IP)。

---

> **v0.2.1.5 — 修复 SOCKS4/SOCKS5 代理无法使用的问题**
>
> 之前版本中，所有 SOCKS 协议代理（`socks4://`、`socks4a://`、`socks5://`、`socks5h://`）在 dashboard 测试和实际请求转发时都会报错 `UnsupportedProxyProtocol fetching "https://api.z.ai/"`，导致 SOCKS 代理完全不可用。本版本通过引入本地 HTTP-CONNECT→SOCKS 桥彻底修复了这个问题。
>
> **本次改动**
>
> - **根因**：Bun 原生 `fetch(url, { proxy })` 只支持 HTTP/HTTPS 代理，遇到 SOCKS scheme 直接抛 `UnsupportedProxyProtocol`。原代码在 4 处调用点（dashboard 单代理测试、代理池批量测试、配额查询、上游 LLM 转发）都直接把 SOCKS URL 透传给 fetch，所以全部失败。
> - **新增 `src/proxy/socks-bridge.ts`**：在 `127.0.0.1` 的 OS 随机端口启动一个迷你 HTTP CONNECT 代理，接受 fetch 的 CONNECT 请求，对目标做 SOCKS4/4a/5/5h 握手（含 user/pass 认证），然后纯字节透传。按 SOCKS URL 引用计数缓存复用，60s 空闲后自动关闭。完全在进程本地，不可达外部网络。
> - **新增 `src/proxy/proxied-fetch.ts`**：`proxiedFetch` / `wrapFetchWithSocksBridge` / `makeProxiedFetcher` 三个包装器，按 scheme 路由：HTTP/HTTPS 走 Bun 原生，SOCKS 走桥。已注入所有 4 处调用点，HTTP 代理路径完全未变（零回归）。
> - **Bug 修复（tunneling 阶段）**：原 `failConnection` 在 tunneling 阶段被调用时会向已建立 TLS 的 socket 写入 502 HTTP 响应字节，污染客户端的 TLS 流。改为仅在 pre-tunnel 阶段（read-connect / socks-handshake）才回 502，tunneling 阶段直接 `cleanupConn` 静默关闭。
> - **`cleanupConn` 幂等化**：多个 close/error 回调可能对同一连接触发多次，原实现会重复 `end()` 同一 socket。加了幂等检查。
> - **调试日志**：可通过环境变量 `ZCODE_PROXY_SOCKS_DEBUG=1` 启用 per-connection 调试日志（bridge 创建/释放、CONNECT 目标、tunnel 建立等），生产默认关闭。
> - **测试覆盖**：新增 28 个测试（21 个单元测试覆盖路由逻辑 + 7 个端到端测试用真实本地 SOCKS5/SOCKS4a 服务器打到 `www.example.com`，包含 user/pass 认证、错误密码、bridge 复用、tunneling 阶段不污染 TLS 等场景）。全部 677 个测试通过，TypeScript 零错误。
> - **影响**：所有用户（特别是使用 SOCKS5 代理的国内用户）现在可以正常配置和使用 SOCKS 代理，包括单账号代理、代理池、配额查询、上游转发全部链路。已配置 HTTP/HTTPS 代理的用户完全不受影响。
>
> **升级建议**：所有使用 SOCKS 代理的用户立即升级到 v0.2.1.5。使用 HTTP 代理或直连的用户可选升级。

---

> **v0.2.1.4 — 完整对齐 zcode cache_control 指纹（基于 6 请求实测样本）**
>
> 基于 zcode 桌面客户端 6 个连续请求的完整流程抓包，实现了 cc 指纹的 1:1 对齐。v0.2.1.3 的"保守跳过"策略被替换为精确的三规则模型，cache 命中率恢复到 v0.2.0.8 水平甚至更好。
>
> **本次改动**
>
> - **三条 zcode 实测规则**（基于 2026-06-30 抓包的 6 个连续请求）：
>   - **RULE 1**（req#1/#2）：text-only user 消息 → cc 挂最后一个 text block
>   - **RULE 2**（req#3/#4/#6）：单 tool_result user 消息 → cc 直接挂在 tool_result block 本身（zcode 桌面客户端就是这么做的，之前 v0.2.0.9 起的"strip cc from tool_result"是基于错误假设）
>   - **RULE 3**（req#5）：多 tool_result user 消息（并行工具调用续传）→ 完全剥掉所有 cc（zcode 也是这么做的）
> - **`sanitizeContentBlocks`**：去掉了 v0.2.0.9 引入的"strip cc from tool_result"逻辑。这个逻辑基于一个错误假设（"real ZCode client never puts cc on tool_result"），实测正好打脸——zcode 在单 tool_result 场景下就是直接挂 cc 在 tool_result 上的。
> - **`applyAnthropicCacheControl`**：完全重写为三规则模型，基于 tool_result 数量分支决策。不再追加 `text:" "` 占位块（v0.2.0.9-v0.2.1.2 的错误行为）。
> - **验证**：6 个 zcode 参考请求全部 1:1 对齐（cc 位置、block 数量完全一致）；Claude Code 失败请求已修复（单 tool_result 现在保留 cc 在自身，匹配 RULE 2）；646 个单元测试通过，TypeScript 零错误。
> - **影响**：相比 v0.2.1.3，单工具调用续传场景重新命中 prompt cache（之前是被丢掉的）。多工具调用续传场景首次实现 zcode 对齐（之前没有规则处理）。
>
> **升级建议**：所有用户立即升级到 v0.2.1.4。这是首个 cc 指纹完全对齐 zcode 桌面客户端的版本。

---

> **v0.2.1.3 — 修复 Claude Code 多轮工具调用时 [1213] 网关错误**
>
> 修复 v0.2.0.9 引入的 cache_control 指纹对齐回归 bug。当 Claude Code 进行多轮工具调用时（最后一轮 user 消息是 tool-call 续传，只含 `tool_result` blocks），代理会追加一个 `text:" "` + cc 块到该消息尾部，触发 zcode 网关 `[1213][未正常接收到prompt参数。]` 错误。
>
> **本次改动**
>
> - **根因**：v0.2.0.9 commit `51f2ce7` 误读了 zcode 参考样本。`msg[122].content[3]` 的 cc 锚点确实在 `text_len=1` 的块上，但那条消息只有 4 个 text block，没有 `tool_result`。开发者漏看了这个前提，于是在 Claude Code 的 tool-call 续传消息尾部追加 text+cc —— 这种结构 zcode 网关不接受。
> - **修复**：`applyAnthropicCacheControl` 改为——当最后一条 user 消息含任何 `tool_result` block 时，完全跳过 cc 注入，不再追加 text block。代价是这一轮丢掉 prompt cache 优化，但请求能成功；下一轮用户发文本消息时 cc 自然恢复。
> - **测试**：原断言 "追加 text block" 的测试改为断言 "跳过 cc"，并新增 "tool_result + text 共存时也跳过" 的测试用例。645 个单元测试全部通过，TypeScript 类型检查零错误。
> - **影响范围**：仅影响 `start-plan` 与 `coding-plan` 模式下 Claude Code 客户端的多轮工具调用场景。其他客户端（Codex / Cherry Studio）如果不在最后一条 user 消息里塞 tool_result 则不受影响。
>
> **升级建议**：所有在 v0.2.0.9 ~ v0.2.1.2 之间遇到 `[1213]` 或 "Claude Code 用着用着突然报错" 的用户立即升级到 v0.2.1.3。

---

> **v0.2.1.2 — 全面优化：并发竞态修复 + 性能提升 + 死代码清理**
>
> 本版本对核心代理转发链路进行了两轮深度优化，修复了多个并发竞态与资源泄漏，显著降低了 WAF 重试与凭证切换路径的事件循环阻塞，并清理了 255 行无生产引用的 deprecated 死代码。所有 644 个单元测试通过，TypeScript 类型检查零错误。
>
> **本次改动**
>
> **1. 严重并发竞态修复（P0）**
>
> - **代理池 sticky 状态竞态**：`pickProxy` / `markProxyFailed` 引入 `stateMutex` 串行化 `currentWorkingProxy` 与 `roundRobinCursor` 的读-改-写。此前两个并发请求会同时观察到 sticky 为 null，各自推进游标并拿到不同代理，粘性策略失效。
> - **重试循环无限增长**：`extraAttemptsFromSwitches` 每次凭证切换自增但无上限。新增硬上限 `MAX_TOTAL_ATTEMPTS = min(maxRetries×4+10, 20)`，防止并发 dashboard 导入新账号时循环超预期运行（每个 attempt 还要等 40s captcha 超时）。
> - **Captcha 配置不可用导致 10+ 分钟超时**：区分网络错误（hard fail，立即返回 503 中断重试）vs 配置返回但 disabled（soft fail，跳过 captcha 让上游决定）。此前每个凭证都要走 120s captcha 超时才返回错误。
>
> **2. 性能与流畅度优化（P1）**
>
> - **`markProxyFailed` 防抖刷盘**：从每次调用全量读盘+写盘改为内存更新 + 5 秒合并刷盘。WAF 轮换中 6-9 次磁盘写合并为 1 次，消除 30-450ms 事件循环阻塞。
> - **代理池并行刷新**：`refreshFromSources` 从串行 `await importFromUrl` 改为 `Promise.all` 并行 fetch 所有 URL 源。5 个源的最坏刷新时间从 150s 降到 ~30s。
> - **代理失败 cooldown**：`pickProxy` 跳过 60 秒内刚失败的代理（消费之前是死代码的 `failures` 字段，新增 `lastFailedAt` 时间戳）。此前刚失败的代理会立即被 round-robin 重新选中导致重复失败。
> - **单请求内 triedPoolProxies TTL**：从 `Set` 改为 `Map<url, triedAt>` + 60s TTL。此前第一次 attempt 试过的代理在所有后续 retry 中永久排除，即使已恢复也无法回退。
> - **retry 中 transform+stringify 缓存**：凭证切换后仅当 `userId|plan|thinkingLevel` 实际变化才重新转换。coding-plan 间切换的 transform 输出完全相同，每次节省 8-30ms。
> - **SSE 统计解析早停**：`observeStreamParseSse` 加 `includes()` 标记检查，跳过非关键 event 的 `JSON.parse`。长流（1000+ events）节省 100ms+ CPU。
> - **WAF 检测流式 peek**：`checkWafBlock` 从 `await resp.text()` 全量读取改为流式 peek + 32KB 上限 + 命中签名早停，防大 HTML 响应 OOM。
> - **日志批量 fan-out**：`appendLog` 从同步遍历所有 SSE waiter 改为 `queueMicrotask` 批量推送。50 个 dashboard tab × 100 logs/sec 从 5000 次同步 enqueue 降到 1 次 microtask。
> - **stats seenIds LRU**：从全清+重建（丢 4900 个 id）改为增量 evict（每次删 1000 条，limit 提到 50000），消除长跑服务 stats 虚高。
> - **SSE 批量重组 O(N²)→O(N)**：`sse-to-batch.ts` 用 cursor 指针替代每事件 `buffer.slice()`。
> - **sse-error-detector 竞态**：`reconstructStream` 加 `streamClosed` 状态 + `safeClose/safeError/safeEnqueue` 包装，防 client abort 与 async read loop 竞态导致 uncaught exception。
>
> **3. 配置与内存安全（P2/P3）**
>
> - **admin 配置 deep-clone**：配置 PUT 路径对 `responsesThinking` / `routingRules` / `modelMappings` / `corsAllowList` / `models` 加 defensive 深拷贝，防止 `newConfig` 与 `opts.config` 共享引用导致 in-place mutation 污染 live config。
> - **responses-store LRU + TTL**：从 FIFO eviction 改为 LRU（`lastAccessAt`）+ 24h TTL，自动清理过期会话，内存占用有界。
> - **captcha JSDOM 资源清理增强**：`vc.removeAllListeners` + `delete w.document/navigator` 断引用环，减少长跑服务内存缓慢增长。
>
> **4. 死代码清理**
>
> - 删除 `src/translator/anthropic-to-openai.ts`（140 行 @deprecated，无生产引用）
> - 删除 `sse-translator.ts` 中的 `openaiSseToAnthropicSse` + `formatAnthropicSSE` + `mapFinishReason`（115 行，有已知 Anthropic SSE spec 违规 bug，无生产引用）
> - 同步删除对应 8 个 deprecated 测试
>
> **5. 工程化改进**
>
> - 新增 `src/utils/constants.ts`：集中管理 LOG/RETRY/PROXY_POOL/CAPTCHA/ADMIN/WAF/SSE 常量组
> - 新增 `src/utils/errors.ts`：ErrorType 错误码枚举（40+ 错误类型）
>
> **不影响兼容性**：本次改动未触碰 ZCode 请求格式转换逻辑（`body-transformer.ts` 的 `alignZCodeRequestFormat` 等），captcha 核心求解逻辑（JSDOM 配置、polyfill、SDK 调用）也完全未变，仅增强了错误分类与资源清理。

> **v0.2.1.1 — 全局代理池 + WAF 拦截自动轮询重试 + 粘性代理 + 代理检测**
>
> 新增全局共享出站代理池，支持手动导入、txt 文件上传、URL 一键导入与定时自动刷新。当请求遇到 405/阿里云 WAF 拦截时，自动轮询切换到池中其他代理重试。粘性代理机制让可用代理持续复用，直到失败才切换。
>
> **本次改动**
>
> **1. 全局代理池模块（`src/proxy/proxy-pool.ts`）**
>
> 新增持久化代理池（`~/.zcode-proxy/proxy-pool.json`），支持 6 种协议：`http`、`https`、`socks4`、`socks4a`、`socks5`、`socks5h`。优先级：单账号代理设置 > 代理池 > 直连。
>
> 三种导入方式：
> - 手动粘贴文本（每行一个代理，支持注释行 `#`）
> - 上传 txt 文件
> - URL 一键导入（如 `https://cdn.jsdelivr.net/gh/proxyscrape/free-proxy-list@main/proxies/all/data.txt`）
>
> 自动定时刷新（默认 5 分钟，可配 0 = 禁用）。手动刷新返回新增/删除/总数统计。刷新失败时保留该来源已有代理（不会因网络抖动清空可用代理）。
>
> **2. 粘性代理（Sticky Proxy）**
>
> 代理池采用粘性策略：一旦某个代理请求成功，它会被标记为"当前使用代理"，后续所有请求继续复用它——直到它失败（405/WAF/网络错误）才轮询到下一个。这避免了每个请求都换代理导致的连接浪费，同时保证故障时自动切换。
>
> 管理面板「代理池」页面顶部会显示当前粘性代理，列表中对应行标记"使用中"徽章。
>
> **3. WAF 拦截自动轮询重试**
>
> 当上游返回 405/403/200+HTML 且检测到阿里云 WAF 拦截特征时，自动切换到池中其他代理重试（最多 `maxRotations` 次，默认 3）。每次轮询的代理会被标记失败次数。轮询在初始请求和 retry 循环中都生效。
>
> **4. 代理检测功能**
>
> - **单个检测**：代理列表每行有"检测"按钮，对目标提供商域名做 HEAD 请求验证代理连通性，显示延迟或错误
> - **全部检测（后台运行）**：一键检测池中所有代理，支持配置分批大小（每批并发数，默认 5）。检测任务在**服务器后台运行**，关闭浏览器页面也不影响——重新打开页面会自动恢复进度显示。检测进度实时显示，完成后汇总成功/失败数
> - **失败自动删除**：勾选"失败自动删除"后，全部检测完成的失败代理会自动从池中删除，只保留可用代理
>
> **5. 代理使用日志**
>
> 每个请求在日志中显示当前使用的代理（标记 `(sticky)` 表示复用粘性代理）：
> ```
> 001 >>> POST /v1/messages (anthropic)
> 001 proxy: http://1.2.3.4:8080 (sticky)
> 001 proxy sticky: http://1.2.3.4:8080 (will reuse for future requests)
> ```
> WAF 轮询时显示切换过程：
> ```
> 001 WAF rotation 1/3: switching to proxy socks5://5.6.7.8:1080
> 001 WAF rotation 1 succeeded — request now proceeds with proxy socks5://5.6.7.8:1080
> ```
>
> **6. 管理面板新增「代理池」栏目**
>
> 侧边栏新增「代理池」页面，包含：
> - 配置卡片（启用开关、刷新间隔、WAF 轮询开关与次数、来源 URL 列表）
> - 导入卡片（URL 导入、文本粘贴、txt 文件上传、追加/替换模式）
> - 代理列表表格（URL、来源、检测状态、失败次数、检测/删除按钮）
> - 当前粘性代理指示器
> - 「全部检测」按钮（分批并发）+ 「刷新来源」+ 「清空全部」
>
> **7. Bug 修复**
>
> - 修复 `refreshFromSources` 在某个 URL 来源拉取失败时会清空该来源已有代理的 bug（现在保留已有代理，只跳过本次拉取）
> - WAF 轮询循环现在正确读取 `maxRotations` 配置（之前硬编码为 5）
>
> **8. socks4/socks4a 协议支持**
>
> 单账号代理设置和代理池都新增 `socks4://` 和 `socks4a://` 协议支持（Bun 原生 fetch 已支持）。单账号代理弹窗新增 SOCKS4 和 SOCKS4a 选项。
>
> **9. Admin API 新增 8 个端点**
>
> `GET /admin/api/proxy-pool`、`PUT /admin/api/proxy-pool/config`、`POST /admin/api/proxy-pool/import-text`、`POST /admin/api/proxy-pool/import-url`、`POST /admin/api/proxy-pool/refresh`、`DELETE /admin/api/proxy-pool/proxy`、`POST /admin/api/proxy-pool/clear`、`POST /admin/api/proxy-pool/test-one`

---

> **v0.2.1.0 — 流式翻译路径 token 计数修复（cache_read_input_tokens + reasoning_tokens 透传）**
>
> 修复 v0.2.0.6 引入的 token 计数 bug：当客户端使用 OpenAI Chat Completions 或 Responses API 协议接入代理、且 `stream:true` 时，dashboard 严重低估输入 token（少约 35 倍），且不显示 thinking 量标记 `(th:M)`。Anthropic 直通路径不受影响，计数一直正确。
>
> **本次改动**
>
> **1. Bug #1：流式翻译路径丢失 `cache_read_input_tokens`（核心修复）**
>
> 当上游 GLM 启用 prompt cache（`cache_read_input_tokens > 0`）时，dashboard 显示 `in: 1152` 而不是 `in: 41152 (c:40000)`，少约 35 倍。
>
> 根因：`createStatsTransform` 接在翻译器**之后**，stats 解析器只能看到翻译器吐出来的内容。但两个流式翻译器（`sse-translator.ts` 和 `anthropic-to-responses.ts`）的 `message_start` 分支只读 `input_tokens`，没读 `cache_read_input_tokens`；最终 usage chunk 也没有这个字段。v0.2.0.6 修 cache_read 时只补了直通路径，漏了翻译路径。
>
> 修复：两个翻译器的 `TranslationState` / `StreamState` 加 `cacheReadInputTokens` 字段；`message_start` 读、`message_delta` 覆盖（message_delta 是权威源）；最终 usage chunk / `response.completed` payload 透传 `cache_read_input_tokens`。OpenAI 客户端会忽略未知 usage 字段，安全。
>
> **2. Bug #2：流式翻译路径丢弃 `thinking_delta` 事件**
>
> 上游开 thinking 时，GLM 流式发 `thinking_delta` 事件。两个翻译器的 `content_block_delta` 分支只处理 `text_delta` 和 `input_json_delta`，对 `thinking_delta` 直接 fall-through 丢弃。结果 dashboard 永远不显示 `(th:M)` 标记。
>
> 修复：两个翻译器加 `thinkingTokens` 计数器；`content_block_delta` 加 `thinking_delta` 分支累加计数；最终 usage 以 `reasoning_tokens` 字段输出（Chat Completions 流式 chunk）或 `output_tokens_details.reasoning_tokens`（Responses API）。注意：**不向前端客户端输出 thinking 内容**——OpenAI/Responses 协议没有标准的 reasoning 流式格式，硬塞会破坏 strict 客户端。只透传计数给 stats observer 用。
>
> **3. Bug #3：`reasoning_tokens` 硬编码为 0**
>
> `anthropic-to-responses.ts` 的 `buildResponseSnapshot` 和 `translateResponseAnthropicToResponses` 写死 `output_tokens_details: { reasoning_tokens: 0 }`，即使上游开了 thinking 也报 0。修复为使用真实 thinking 计数；batch 路径同步从 `resp.usage.reasoning_tokens`（GLM 扩展字段）读取。
>
> **4. 上游权威值优先**
>
> 如果 GLM 在 `message_delta.usage` 里返回了权威 `reasoning_tokens` 计数，优先采用它而不是我们的 chunk 计数（chunk 计数是近似值，一个 thinking_delta 事件算 1）。GLM 不总是返回这个字段，但返回时它就是真实值。
>
> **5. Stats observer 增强**
>
> `observeStreamParseSse`（`src/proxy/handler.ts`）新增三处 `reasoning_tokens` 提取点：
> - `response.completed.response.usage.output_tokens_details.reasoning_tokens`（Responses API 流式）
> - `message_delta.usage.reasoning_tokens`（Anthropic 流式，GLM 扩展）
> - Chat Completions chunk 的扩展 usage 字段（`j.choices && j.usage`，无 `type` 字段时匹配）
>
> **6. 测试覆盖**
>
> 新增 9 个回归测试（604/604 全过，TypeScript 零错误）：
> - `sse-translator.test.ts` +3：cache_read_input_tokens 透传、thinking_delta 计数、上游权威值优先
> - `anthropic-to-responses.test.ts` +6：batch + 流式路径的 cache/reasoning 透传
>
> 端到端验证：同一条上游 SSE（`input=1152, cache=40000, output=529, thinking=2 chunks`）经过 Anthropic 直通 / Chat Completions 翻译 / Responses API 翻译三条路径后，stats observer 提取的计数完全一致：`in: 41152 (c:40000) out: 529 (th:2)`。
>
> **影响范围**：
> - **Claude Code（Anthropic 直通）用户**：无变化，计数一直正确。
> - **Codex CLI / OpenAI SDK（Responses API / Chat Completions 流式）用户**：dashboard 现在显示真实 input 总量 + cache 命中量 + thinking 量，之前严重低估。
> - **配置兼容**：无需修改任何配置，开箱即得正确计数。
>
> ---

> **v0.2.0.9 — 严格请求头白名单 + cache_control 指纹对齐**
>
> 基于 2026-06-28 对 app.asar Mf() (offset 886853) + SDK 字面量 (offset 1085109) + yU (offset 887429) 的最新解包,全面对齐真实 ZCode 客户端的请求头指纹。修复了多个之前未发现的指纹泄漏问题。
>
> **本次改动**
>
> **1. 请求头改为严格白名单(核心改动)**
>
> 之前用"黑名单过滤 + 透传"策略,任何未识别的客户端 header 会透传到 z.ai。现在改为**纯白名单**:完全不读客户端 headers,只按 zcode 真实客户端的固定 14 个 header 构造 upstream 请求。任何陌生 header(包括未来 SDK 新增的指纹头)都不会泄漏到上游。
>
> **2. wire 顺序完全对齐**
>
> 按真实 ZCode 客户端的网络发送顺序:
> ```
> content-type → x-api-key/auth → anthropic-version →
> user-agent → http-referer → x-title → x-zcode-app-version →
> x-platform → [x-release-channel] → x-client-language →
> x-client-timezone → x-os-category → [x-os-version] → x-request-id
> ```
>
> **3. 修复 5 处指纹问题**
>
> - **移除 `accept: text/event-stream`** —— 真实 zcode 客户端在 /v1/messages 上**根本不发 accept 头**,之前错误地发了反而是指纹
> - **不显式设 `accept-encoding`** —— 让 fetch 运行时自动加 `gzip, deflate, br`(之前硬编码 `gzip` 是错的)
> - **新增 `X-Release-Channel`** —— 真实客户端条件发(空值不发),现在通过 `identity.releaseChannel` 配置,默认 "stable"
> - **修复 `X-Os-Version`** —— 从 `os.release()`(内核版本号)改为 `os.version()`(OS 产品名,如 "Windows 11 Home China")
> - **修复身份头内部顺序** —— UA→Referer→Title→AppVer(之前是 UA→AppVer→Referer→Title)
>
> **4. cache_control 指纹对齐**
>
> 对比真实 zcode 抓包(msg[122])发现 2 处 cc 位置不对齐,已修复:
>
> - **剥离 `tool_result` 块上的 cc** —— Claude Code 经常在 tool_result 上放 cc,真实 zcode 客户端从不在 tool_result 上放
> - **cc 只加在最后一条 user 消息的 text 块上** —— 之前会 fallback 到 assistant 消息(指纹错位);现在若最后一条 user 消息只有 tool_result,会追加一个空 text 块作为 cc 锚点(模拟真实 zcode msg[122] 的 cc 锚点模式,text_len=1)
>
> **5. Claude Code 工具调用与 harness 完整保留**
>
> 验证:CC 发出的 13 个工具的 name/description/input_schema 字面一致透传(总字符数 53369 → 53369,0 丢失);14 条 messages 的所有非 thinking 块完整保留(总字符数 110902 → 110905,差异仅 +3 是剥离 thinking 后的空 text 占位符);CC 的 6681 字符 harness 指令块字面一致保留。
>
> **6. 测试覆盖**
>
> 595 个测试通过(+13 个新增),覆盖:完整 wire 顺序(coding-plan / start-plan+JWT / OpenAI 三种 format)、CC/Stainless 11 个指纹头剥离、前缀剥离(x-stainless-* / x-claude-*)、23 个乱七八糟 header 零泄漏、captcha 注入路径仍工作、X-Release-Channel 条件发(空/undefined/whitespace)、X-Os-Version 用 os.version() 不是 os.release()、身份块内部顺序。
>
> **7. 控制面板刷新卡顿优化(重推补丁)**
>
> 修复"运行久了刷新控制面板卡一会才能点击"的性能问题。根因:SSE 日志流在刷新时把服务端 ring buffer(最多 2000 条)一次性回放给浏览器,客户端 `appendLog()` 每收到一条就调一次 `renderLogs()`,而 `renderLogs()` 会 filter 全部 logLines + 用 innerHTML 重建整个日志框 DOM。结果 2000 × O(2000) ≈ 4,000,000 次 DOM 操作,浏览器主线程被冻结数秒。服务端运行越久,ring buffer 越满,卡顿越明显。
>
> 三处修复:
>
> - **客户端 debounce renderLogs** —— 新增 `scheduleLogRender()`,用 `requestAnimationFrame` 合并同一帧内的多次 `appendLog` 调用。SSE 日志爆发从 2000 次 render 降为 1 次,稳态日志(几秒一条)仍立即渲染(rAF < 16ms)
> - **服务端 SSE 首连只回放最近 200 条** —— 之前会 dump 全部 2000 条 ring buffer,现在只回放最近 200 条(`INITIAL_REPLAY_LIMIT`),网络流量降到 1/10。更老的历史仍可通过 `/admin/api/logs` 批量接口(带 search/filter/分页)查询
> - **renderLogs 限制 DOM 渲染条数** —— 新增 `MAX_RENDERED_LOGS=500` 上限,超出的旧日志只保留在内存供 search/filter,不写进 DOM。每次重建 DOM 的成本稳定在 16ms 内,带"已隐藏更早的 N 条匹配日志"提示
>
> 测试:595 个测试全部通过,类型检查零错误。改动完全向后兼容 —— `/admin/api/logs` 批量接口仍返回完整 2000 条供搜索。
>
> **不影响现有用户**:默认配置无需修改即可获得更严格的指纹对齐。如需自定义 release channel,在 config.yaml 的 identity 节添加 `releaseChannel: stable`。
>
> ---

> **v0.2.0.8 — 全面优化 + 请求头调试功能**
>
> 本次发版对代理进行了全面的代码优化（安全/性能/健壮性/可维护性），并新增了"请求头调试"功能，方便排查请求转换是否有缺陷。
>
> **本次改动**
>
> **1. 新增"请求头调试"功能（核心新功能）**
>
> 开启后，每个请求会写入**两个 JSON 文件**到 `./header-debug/` 目录：
> - `{时间戳}_{reqId}_inbound.json` —— 代理**收到的原始客户端请求**（完整的请求头 + 请求体）
> - `{时间戳}_{reqId}_upstream.json` —— 代理**翻译后发给 z.ai 的请求**（完整的请求头 + 翻译后的请求体）
>
> **重试不记录**——每个请求只产生一对文件，方便对比"客户端发了什么" vs "代理发了什么"，验证转换流程有没有缺陷。可以用 `diff *_inbound.json *_upstream.json` 直接对比。
>
> 三种开启方式：
> - 环境变量：`ZCODE_PROXY_HEADER_DEBUG=1`
> - YAML 配置：`logging.headerDebug: true`
> - 管理面板"日志"页的"请求头调试"开关（热更新，无需重启）
>
> 敏感头（authorization / x-api-key / cookie）自动 mask 为 `first-8...last-4`，短值完全 mask。用完用 `rm -rf header-debug/` 清理。
>
> **2. 安全加固**
>
> - `/admin/api/verify` 现在也走 loopback gate（之前被豁免，会向非 loopback 暴露"代理未设认证"信息）
> - `proxyApiKey` 强制最小 8 字符（阻止 trivial key 如 "x"、"test"）
> - `setAccountProxy` 加 SSRF 校验，阻止把上游流量路由到云元数据端点（169.254.169.254 等）
> - `timingSafeEqual` 改用 `node:crypto` 审计过的实现，替代手写版
> - Dockerfile 改为多阶段构建 + `oven/bun:1.2-slim` + tini + **非 root 用户**（uid 1001）
>
> **3. 性能优化**
>
> - **长流式响应内存减半**：`body.tee()` + 并行 reader 改为 `TransformStream`，字节流过即解析，消除长 LLM 流（100K+ tokens）的内存翻倍问题
> - `Bun.gzipSync` → `CompressionStream` 流式压缩，避免 200KB 响应阻塞事件循环 5-20ms
> - `buildIdentityHeaders` 的 `Intl.DateTimeFormat()` + `os.release()` 改为模块级 memoize，每请求省 0.1-0.5ms CPU
> - logWaiters 加 50 连接上限，防止 SSE 客户端 flood
> - 删除账号时同步清理 quotaCache 条目
>
> **4. 健壮性**
>
> - `clearCredential()` 同步版的 `while(Date.now()<end){}` 忙等改为 `Atomics.wait`（真正让出 CPU，保留 sync API 契约）
> - captcha 求解加外层硬超时安全网（`Promise.race`），完全不改变 JSDOM 求解逻辑，仅防止 Promise 永挂导致 JSDOM 实例泄漏
> - OAuth callback server `maxConnections=5`，防止 fd 耗尽
> - `body.cancel()` 的静默 catch 加诊断注释
>
> **5. 部署兼容性**
>
> - 修复 `package.json` 中无效的 `typescript: "^6.0.3"`（TS 最高 5.x）→ `^5.5.0`
> - `@types/bun: "latest"` → `^1.2.0` 固定
> - `render-start.sh` 的 `sha256sum` 改为兼容 macOS（`shasum -a 256`）+ bun fallback
>
> **6. 可维护性**
>
> - 死代码（`openaiSseToAnthropicSse` / `anthropic-to-openai.ts`）加 `@deprecated` 标注
> - `openai-to-anthropic.ts` 的 4 处 `(b as any).text` 改为 type guards
> - 修复 TS 5.9 严格泛型导致的 `CompressionStream`/`Uint8Array` 类型错误
>
> **约束遵守**：加密密钥固定 `520` 未动；captcha JSDOM 求解逻辑完全未改（只加外层安全网）。
>
> ---
>
> **v0.2.0.7 — 重大修复：凭证丢失 bug + 命令行无限重试 + 管理面板刷新卡顿**
>
> 本次发版修复了用户在 Windows 长时间运行后报告的三个关联问题：账号突然全部消失、管理面板切不动账号、命令行客户端一直在重试。同时大幅优化了管理面板刷新卡顿。
>
> **本次改动**
>
> **1. 修复"账号全没"毁灭性 bug（核心修复）**
>
> 之前的 `withStoreLock` 在 `readStore()` 因任何原因返回 null 时（Windows 杀毒软件临时锁文件、IO 错误、跨进程竞争等），会用 `{accounts: []}` 覆盖写入磁盘——**静默蒸发所有账号，无任何错误日志**。retry 循环每次切凭证都会触发这个路径，所以一旦撞上 AV 锁文件，3 次切换就把所有账号清空。
>
> v0.2.0.7 修复：拆分 `withStoreLock` 为两个版本：
> - `withStoreLock`（保留空回退）：仅供 `saveCredential` / `importAccounts` 使用，因为这两个操作的本意就是新建 store
> - `withExistingStoreLock`（无空回退）：供 `switchAccount` / `removeAccount` / `setAccount*` 使用——读不到 store 就**不写盘**
>
> 新函数还区分两种 null 场景：
> - 文件不存在 → 返回 false（账号 id 找不到 → 404 not found）
> - 文件存在但读不到 → 返回 null（transient 故障 → 503，拒绝写入）
>
> 这样即使 AV 把文件锁住，最多是切换失败返回 503，**绝对不会清空账号**。
>
> **2. 修复"命令行还在继续重试"**
>
> 之前所有凭证都失败后，代理返回 529（可重试状态码）给客户端。Claude Code / Codex 等客户端看到 529 就重发请求，代理又跑一遍 retry 循环又返回 529……无限循环。用户报告"命令行还在继续重试"就是这样来的。
>
> v0.2.0.7 修复：当 `totalAvailableCredentials > 1` 且所有凭证都试过时，返回 **503 + `Retry-After: 300`**（5 分钟）。503 是非可重试状态码，配合 Retry-After 头部告诉客户端"5 分钟内别再试了"。单凭证场景仍返回 529（可能是临时上游过载，重试合理）。
>
> **3. 修复"切换失败"**
>
> 这是问题 1 的连带症状：账号被清空后，dashboard 调 `switchAccount(id)` 找不到账号返回 false → 404。现在账号不会再被清空，切换路径恢复正常。同时新增 503 响应路径，让 dashboard 在 store 临时不可读时给出明确提示"凭证库暂时不可读，请稍后再试，您的凭证安全"。
>
> **4. 修复"管理面板运行久了刷新卡顿"**
>
> 多个性能问题叠加导致运行越久越卡：
>
> - **忙等自旋阻塞事件循环 750ms**：`readStoreUncached` 在 Windows AV 锁文件时用 `while (Date.now() < end) { /* spin */ }` 同步忙等，最长 50+100+150+200+250 = 750ms 期间整个 Bun 事件循环冻结，所有 HTTP 请求、SSE 推送、定时器全部停摆。改为 `await new Promise(r => setTimeout(r, ms))` 异步等待，让出事件循环。
>
> - **3 处冗余 `invalidateStoreCache()`**：`GET /admin/api/credentials`、`GET /admin/api/accounts`、`GET /admin/api/accounts/export-single` 每次刷新都强制清缓存 + 全量解密，但 `readStore()` 本来就有 `statSync` mtime 检查能自动检测外部写入。移除这三处冗余调用，每次刷新省 5-20ms。
>
> - **`appendFileSync` 同步写日志**：开启文件日志时，每条 `console.log` 都同步写盘，Windows + AV 干预下单次 5-50ms，50 条/秒就是 250ms-2.5s/秒的事件循环阻塞。改为 500ms 缓冲异步写（内存攒批 + `fs.promises.appendFile`），写入次数从 N 降到 ~1/500ms。
>
> - **SSE waiter 泄漏窗口 10 分钟**：`maxTimeout` 从 10 分钟降到 2 分钟，减少泄漏 waiter 阻塞 `appendLog` 迭代的窗口期 5 倍。
>
> - **前端 13 个串行 await**：`initDashboard` 改为 `Promise.all` 并发（2 批：关键 UI 优先加载，次要内容后台加载），首屏可交互时间减半。
>
> - **2 秒 stats 轮询**：改为 5 秒，减少 60% 后端轮询压力。
>
> - **新增 `visibilitychange` 监听器**：标签页隐藏时停止所有轮询 + 关闭 SSE 连接，可见时恢复。这是"运行久了"卡顿的关键缓解——之前后台标签页会持续轮询 5s + 10s 两个 interval，跟实际代理请求抢 I/O。
>
> **5. AuthManager 新增 `getAvailableCredentialCount()`**
>
> 让 retry 循环能区分"只有 1 个凭证"（返回 529）和"多凭证全失败"（返回 503）两种场景。
>
> **影响谁**
>
> - Windows 长时间运行的用户：再也不用担心账号突然消失，命令行客户端也不会无限重试。
> - 所有用户：管理面板刷新明显变快，尤其运行久了之后。
> - 单凭证用户：行为不变（仍返回 529 重试，因为是临时过载）。
>
> **升级建议**
>
> 强烈建议所有 Windows 用户升级。如果你之前遇到过"账号全没"问题，升级后即使再遇到 AV 锁文件也不会丢账号，最多是切换临时失败。

> **v0.2.0.6 — Token 计数修复：cache token 读取 + Anthropic SSE 协议合规 + thinking 计数显示**
>
> 本次发版聚焦于"日志里 token 计数显示偏小"的诊断与修复。v0.2.0.4 给 system 块和最后一块用户消息加了 `cache_control: ephemeral`（对齐 ZCode 客户端 wire shape）后，prompt cache 开始命中——但日志的 token 计数没跟上这个变化，导致用户看到 `in: 1152 out: 4413` 这种"看起来丢了几万 token"的怪现象。同时 thinking 开启后日志缺少思考 token 显示，TTFB 90 秒但 out 只有 529 让人困惑。
>
> **本次改动**
>
> **1. 读取 cache_read_input_tokens（核心修复）**
>
> GLM 上游命中 prompt cache 时，`message_delta.usage` 被拆成 3 个字段：
> ```json
> "usage": {
>   "input_tokens": 1152,              // 新增输入（小）
>   "cache_read_input_tokens": 40000,  // 从缓存读取（大）
>   "cache_creation_input_tokens": 0,  // 新写入缓存的
>   "output_tokens": 4413
> }
> ```
> 之前的 `observeStream` 只读 `input_tokens`，所以显示 1152 而不是真实总数 41152。
>
> v0.2.0.6 修复：在 `observeStream.parseSse` 提取 `cache_read_input_tokens`，日志新格式：
> ```
> | in: 41152 (c:40000) out: 4413 |   ← 显示总数 + (c:缓存命中数)
> ```
> 让你直观看到 prompt cache 在工作（40000 个 token 走了缓存路径，不重复计费/计费减半）。
>
> **2. 修复 parseSse 漏读 message_start 事件（协议合规性 bug）**
>
> Anthropic SSE 协议规定 `input_tokens` 只在流开头的 `message_start` 事件里出现一次，路径是 `j.message.usage.input_tokens`（嵌套在 message 字段里）。但 `parseSse` 之前只读顶层 `j.usage`，对 `message_start` 事件无效——这意味着标准 Anthropic 上游的 `input_tokens` 永远抓不到。
>
> 同项目的 `sse-to-batch.ts` 实现是正确的（读 `data.message.usage`），但 `parseSse` 是另一份手写实现，漏掉了这一条。
>
> v0.2.0.6 修复：在 `parseSse` 顶部添加 `message_start` 分支，读 `j.message.usage.input_tokens` / `cache_read_input_tokens`。用 `> 0` 守卫，避免 GLM 在 message_start 发 0 占位值覆盖 message_delta 后续提供的真实值。
>
> 修复后行为：
> - 标准 Anthropic 上游（input_tokens 在 message_start）：正确捕获（修复前丢失）
> - GLM（input_tokens=0 在 message_start，真实值在 message_delta）：行为不变
>
> **3. SSE→batch 重组器保留 cache 字段**
>
> 非流式客户端走 SSE→batch 缓冲路径时，重组器（`sse-to-batch.ts`）需要把 cache token 字段也保留到重组后的 `message.usage` 里，否则非流式客户端拿不到 cache 信息。
>
> v0.2.0.6 修复：`handleEvent` 接口扩展 `cache_read_input_tokens` / `cache_creation_input_tokens`，`message_start` 和 `message_delta` 事件转发这些字段，重组 `message.usage` 时保留它们。
>
> **4. debug 日志增强：SSE 预览扩到 8KB**
>
> 之前 debug 日志的 SSE 预览只有 2KB，在第一个 `\n\n` 就停了——永远只能看到 `message_start`（usage 是 0/0 占位）。真实的 usage 在流末尾的 `message_delta` 事件里，但 debug 日志读不到。
>
> v0.2.0.6 修复：
> - SSE 预览上限：2KB → 8KB
> - 停止条件：检测到 `message_delta` 事件（携带真实 usage）
> - 这样开 debug 模式时能看到完整 usage JSON，包括 cache 字段
>
> **5. recordStat / stats 数组扩展 cacheReadTokens 字段**
>
> admin dashboard 的 stats 系统也跟上：`recordStat` 入参新增 `cacheReadTokens?:string`，`stats.requests` 数组类型扩展，reclassify 和 fullEntry 都传递该字段。dashboard 后续可以基于这个字段做更精细的"缓存命中率"统计。
>
> **6. 翻译路径同步修复**
>
> Codex（Responses API）和 OpenAI 格式的请求走翻译路径，它们的 batch 响应也需要正确提取 cache token：
> - `translatedBatchResponse`（OpenAI 翻译）：从 `parsedAnthropic.usage.cache_read_input_tokens` 提取
> - `translatedResponsesBatchResponse`（Responses 翻译）：同上
> - batch passthrough path（Anthropic 直通）：从 `usage.cache_read_input_tokens` 提取
>
> **7. 新增 thinking token 计数显示（解释"TTFB 90 秒但 out 只有 529"）**
>
> v0.2.0.4 把 thinking 格式对齐 ZCode 客户端后，思考真正生效——GLM 在 SSE 流里返回 thinking 块（`content_block_start` type=thinking + 一串 `thinking_delta` 事件），模型在"自言自语"推理，最后才输出正式回答。之前日志只显示 `out: 529`，让人困惑"TTFB 90 秒怎么才输出 529 token"。
>
> 本次修复：`observeStream` 单独追踪 `thinking_delta` 事件计数（`thinkingTokens`），日志新格式：
> ```
> | in: 31529 (c:19584) out: 529 (th:1234) |  4.8 | 109382ms |  TTFB=92103ms
> ```
> - `out: 529` = 正式输出 529 token
> - `(th:1234)` = 思考了 1234 个 chunk（近似计数）
>
> 这样你能直观看到"为什么 TTFB 90s 但 out 只有 529"——**因为 thinking 占了大量时间，模型在思考**，不是 bug。
>
> **8. SSE→batch 重组器支持 thinking_delta**
>
> 之前重组器注释说"thinking_delta 不重组"——但非流式客户端（走 SSE→batch 缓冲）应该也能看到完整 thinking 内容。本次修复：重组器把 `thinking_delta` 拼接成完整的 `block.thinking` 字段，非流式客户端拿到的 message 与流式客户端一致。
>
> **9. debug 日志 SSE timeout：3s → 10s**
>
> 之前 debug 日志的 SSE 预览只有 3 秒 timeout，长 thinking 流（thinking 阶段可能持续 30s+）永远读不到末尾的 `message_delta` usage，显示 `(read timeout after 3s)`。本次修复：SSE 预览 timeout 提升到 10 秒，JSON 错误响应保持 3 秒（小 body 不需要长 timeout）。
>
> **测试**：574/574 pass，TypeScript 零错误。新增 5 个测试用例：
> - cache token 保留 / 无 cache 字段不回归 / message_start 与 message_delta 冲突时 message_delta 获胜 / spec-compliant 流验证 / thinking_delta 不污染 output_tokens 计数
>
> **本质说明**
>
> "日志显示 token 少"不是对齐丢提示词——所有 Claude Code / Codex 原始内容完整透传。原因是 v0.2.0.4 给 system 块加 `cache_control: ephemeral` 后 prompt cache 大幅命中，cache 命中部分在 `cache_read_input_tokens` 字段里没被读到。这次修复让日志显示真实总数 + 缓存命中量 + 思考量，让你直观看到 cache 在工作、thinking 在思考。
>
> 关于 quota 额度消耗比预期少：这是**正常的**——start-plan 的 billing/balance API 返回的是 zcode 自己的"折算单位"，不是 raw token。prompt cache 命中部分在计费时大幅折扣（通常 10% 或 0%），所以 40000 cache token 实际可能只算 4000 个单位。这是 cache 在帮你省钱，不是 bug。
>
> ---

> **v0.2.0.5 — 请求头对齐真实 ZCode 客户端（修正历史误判）**
>
> 本次发版修正了一个**与真实客户端相反**的请求头设计。v0.2.0.4 及之前基于一份错误的逆向笔记，把真实 ZCode 客户端**实际发送**的请求头当成了"WAF 指纹"而主动删除——这反而让请求看起来像"声称自己是 ZCode 却拿不出任何身份证据"，是最可疑的状态。
>
> 本次通过逆向**当前官方 ZCode 桌面客户端的 `app.asar`**（`buildZCodeSourceHeaders` / `withZCodeEndpointHeaders`），逐头对齐到字节级。**改动**
>
> **1. User-Agent 改回 `ZCode/{version}`（之前错误地用了 `ai-sdk/anthropic/3.0.81`）**
>
> 真实客户端的 UA 是 `ZCode/{appVersion}`，不是 Vercel AI SDK 的默认 UA。官方 asar 里**完全没有** `ai-sdk/anthropic/{version}` 的运行时拼接代码——即使底层用 `@ai-sdk/anthropic`，UA 也被 `buildZCodeSourceHeaders` 覆盖成 `ZCode/{版本}`。
>
> **2. 恢复发送 ZCode 身份头（这些才是客户端"自证身份"的关键）**
>
> 真实客户端发送，本项目之前却删掉了的头：`X-ZCode-App-Version`、`X-Title: Z Code@electron`、`HTTP-Referer: https://zcode.z.ai`、`X-Platform`（如 `win32-x64`）、`X-Client-Language`、`X-Client-Timezone`、`X-Os-Category`（windows/macos/linux）、`X-Os-Version`。环境特征头（平台/时区/语言/系统版本）取代理运行时真值，最忠实复现客户端在自己主机上的产出。
>
> **3. 删除自造的 trace 头（真实客户端根本不发）**
>
> 之前凭空添加的 `x-session-id` / `x-query-id` / `x-zcode-trace-id` 在官方 asar 里**零命中**。连同为它们服务的 session-id 缓存逻辑（`getSessionId` / `clientFingerprint`）一并删除。只保留真实客户端确实发送的 `x-request-id`（经 `withRequestIdHeader` 每请求新 UUID）。
>
> **4. app_version 统一到 3.1.8（当前官方客户端版本）**
>
> `DEFAULTS.APP_VERSION` 与 `quota.ts` 的 `DEFAULT_APP_VERSION` 从 3.1.5 提到 3.1.8，让 UA 里的版本号、额度查询的 app_version 都对齐当前官方客户端。`config.example.yaml` 示例配置同步更新（之前示例里硬编码了 3.1.5，会覆盖默认值）。start-plan 首次激活仍属 3.1.x 激活区间，行为不变。
>
> **5. 阻断代理转发头泄漏**
>
> 之前下游客户端（或反向代理）注入的 `X-Forwarded-For` / `X-Real-IP` 等头会**原样透传到上游**，而真实 ZCode 桌面客户端从不发这些头——属于身份泄漏点。本次把 `X-Forwarded-*` / `X-Real-IP` 全部加入剥离列表（仅保留用于诊断的读取逻辑，不再转发）。
>
> 涉及文件：`src/proxy/identity.ts`（重写）、`src/proxy/upstream.ts`（删 trace 头+session 缓存、剥离 XFF）、`src/config/loader.ts`（APP_VERSION→3.1.8、SOURCE_TITLE 默认→`Z Code@electron`）、`src/auth/quota.ts`（DEFAULT_APP_VERSION→3.1.8）、`config.example.yaml`（示例值对齐）+ 对应测试。**569/569 测试通过**。

> **v0.2.0.4 — Claude Code + Codex 双路径 ZCode wire-shape 完全对齐**
>
> 本次发版聚焦于"客户端请求 → ZCode 上游"的请求体结构对齐，让 Claude Code 和 Codex CLI 两条客户端路径产出的 wire bytes 与真实 ZCode 桌面客户端完全一致（顶层字段顺序、thinking 格式、max_tokens、stream、tool_choice、system 块 cache_control 等），降低 WAF 指纹检测风险。
>
> **本次改动**
>
> **1. 移除 `forceStreamAnthropic` 配置项，强制 `stream: true` 对齐 ZCode**
>
> 真实 ZCode 客户端的请求体永远带 `stream: true`。之前这个开关默认关闭，Claude Code / Codex 等客户端发请求时 body 里没有 `stream` 字段，造成 wire-shape 指纹差异。v0.2.0.4 起：
> - `stream: true` 在 `body-transformer.alignZCodeRequestFormat` 内**无条件注入**，不再受配置控制
> - 删除 `forceStreamAnthropic` 配置项（YAML `anthropic.forceStream`、环境变量 `ZCODE_PROXY_FORCE_STREAM_ANTHROPIC`、dashboard 复选框全部移除）
> - 现有配置文件里的 `forceStream: false` 字段会被**静默忽略**，不影响运行
>
> **2. 新增 SSE → batch JSON 响应缓冲（关键修复）**
>
> 强制 `stream: true` 后，上游永远返回 SSE。但 Claude Code / Codex 等客户端有时会发非流式请求（`stream: false` 或不传），期望收到 batch JSON 响应。之前 proxy 直接透传 SSE 给非流式客户端，导致客户端无法解析——这就是用户反馈"开了 forceStream 在 Claude Code 里还是非流式"的根本原因。
>
> v0.2.0.4 修复：在响应路径检测 `isSSE && !meta.stream` 时，proxy 自动缓冲上游 SSE 流并重组为完整 Anthropic Message JSON 返回给客户端。客户端无感知：
> - 流式客户端：SSE 透传（不变）
> - 非流式客户端：proxy 缓冲 SSE → batch JSON（透明转换）
>
> 新增模块 `src/proxy/sse-to-batch.ts`（Anthropic SSE → Message 重组器），覆盖 11 个测试用例（文本块、tool_use 块、混合内容、容忍缺失 content_block_start、分块传输、ping、错误事件、malformed JSON、空流、网络断开兜底等）。
>
> **3. system 块 cache_control 对齐 ZCode 客户端**
>
> 真实 ZCode 客户端在自己的第三块 system 上加 `cache_control: { type: "ephemeral" }` 作为 prompt cache 断点。之前 proxy 只给注入的 2 块官方 ZCode 块加 cc，客户端自己带的 system 块（Codex 的 `instructions`、Claude Code 的 harness 块）没有 cc，造成 wire-shape 差异。
>
> v0.2.0.4 修复：在 `alignZCodeRequestFormat` Step 1b 给 system 数组的**最后一块**补 `cache_control: { type: "ephemeral" }`（幂等——已有 cc 的不覆盖）。现在 Claude Code 和 Codex 两条路径的 system 块结构都完全对齐 ZCode 客户端：
> ```
> [0] ZCode 官方块 +cc
> [1] ZCode 官方块 +cc
> [2] 用户自己的 system +cc   ← 本次修复
> ```
>
> **4. 标注格式转换边界（防止后续误改）**
>
> 在 3 个关键文件加了 `FORMAT CONVERSION BOUNDARY — DO NOT MODIFY WITHOUT REVIEW` 标注框：
> - `src/proxy/body-transformer.ts` — `alignZCodeRequestFormat`（两条客户端路径的最终汇聚点）
> - `src/translator/responses-to-anthropic.ts` — `translateRequestResponsesToAnthropic`（Codex 专属翻译）
> - `src/proxy/handler.ts` — 转换编排点（ASCII 流程图说明三条客户端路径如何汇聚）
>
> 每个标注框包含：当前 VERIFIED ALIGNED 状态（2026-06-27）、验证脚本路径、改动失败模式清单。
>
> **5. 验证脚本（开发参考）**
>
> 新增两个对齐验证脚本（位于 `/home/z/my-project/scripts/`，开发环境用，不打包进 release）：
> - `test_alignment.ts` — Claude Code 请求 → 对比真实 ZCode 客户端
> - `test_responses_alignment.ts` — Codex 请求 → 对比真实 ZCode 客户端
>
> 后续若需修改转换逻辑，必须先跑这两个脚本确认对齐状态未破坏。
>
> **本质说明**
>
> 本次对齐**只动结构、不动内容**——所有 Claude Code / Codex 原始内容（harness 指令、messages、tools、tool 结果）都原样透传。proxy 只做：
> - 注入 2 块 ZCode 官方 system 提示词（冻结在 `zcode_system.json`）
> - 改写 Claude Code 身份串 "You are Claude Code..." → "You are ZCode model working in Claude Code."（**仅 Claude Code**，Codex 不改）
> - 重排顶层字段顺序
> - 强制 stream:true / max_tokens:64000 / thinking 格式 / output_config
> - 剥离客户端专属字段（metadata / context_management / billing-header / Codex 10 个专属字段）
> - 格式归一化（string content → array、document block → text、剥离 thinking block）
>
> 不会塞任何其它提示词或内容到请求里，客户端上下文保持完整。
>
> **测试结果**：570/570 pass，TypeScript 零错误，Claude Code + Codex 两条路径核心结构全部对齐 ZCode 客户端。
>
> ---

> **v0.2.0.3 — 安全加固 + 协议转换 bug 修复**
>
> 本次发版聚焦于安全防护与协议转换正确性，修复了多个高危问题。
>
> **本次改动**
>
> **安全加固**
>
> 1. **修复 XFF 伪造绕过 admin 鉴权**：之前 admin API 通过 `X-Forwarded-For` / `X-Real-IP` 判断 loopback，但这些头任何客户端都可伪造，攻击者发送 `X-Real-IP: 127.0.0.1` 即可获得 admin 权限。现在改用 `Bun.server.requestIP(req)` 读取 TCP 真实远端地址（不可伪造），XFF 仅在 `server.trustProxy: true` 时可信（需在 config.yaml 显式开启，用于反向代理后端场景）。
>
> 2. **修复存储型 XSS**：dashboard 的内联 `onclick` 之前用 `escapeHtml` 转义字符串参数，但 HTML 解析器会把 `&#39;` 还原为 `'`，导致 JS 字符串可被闭合逃逸。新增 `escapeJsString()` 对 JS 字符串上下文做转义（含 `\`、`'`、`"`、`\n`、`\r`、`\u2028`、`\u2029`），所有内联 onclick 参数全部替换。
>
> 3. **修复 OAuth 回调 innerHTML XSS**：`d.provider` / `d.apiKeyMask` / `d.userId` / `d.error` / `d.message` 之前直接拼接到 innerHTML，可能被上游劫持注入。现在全部 `escapeHtml()`。
>
> 4. **新增安全响应头**：dashboard 和 admin API 响应统一加 `Content-Security-Policy` / `X-Frame-Options: DENY` / `X-Content-Type-Options: nosniff` / `Referrer-Policy: same-origin` / `Cache-Control: no-store`。
>
> 5. **admin /verify 失败计数锁定**：同一 IP 连续 10 次失败后 15 分钟内拒绝访问（429），防止暴力枚举 `proxyApiKey`。成功验证后清零。
>
> 6. **admin API 请求体大小限制**：所有 mutation 路由限制请求体 1 MiB，防止恶意 1GB JSON 触发 OOM。
>
> 7. **setAccountProxy URL 校验加固**：之前用松散的正则 `/^(https?|socks5h?):\/\/[^\s]+$/i`，允许单引号等特殊字符（直接导致存储型 XSS）。改用 `new URL()` 严格校验 + 拒绝 host 含 HTML/JS 元字符。
>
> 8. **CORS 默认收紧**：之前无 allowlist 时回显任意 Origin，现在默认回显 `"null"`（拒绝跨站），需要时通过 `ZCODE_PROXY_CORS_ALLOWLIST` 显式配置。
>
> **协议转换**
>
> 9. **修复 `tool_choice: "none"` 语义反转**：OpenAI 的 `"none"`（禁用工具调用）之前被翻译为 Anthropic 的 `{ type: "any" }`（强制调用工具），语义完全相反。现在正确丢弃 `tools` 数组和 `tool_choice`，让模型没有工具可调用。
>
> 10. **修复流式 `tool_use` 完全丢失**：`anthropicSseToOpenaiSse` 之前跳过 `content_block_start`，导致 OpenAI 客户端永远收不到 `tool_calls` 的 id/name/arguments，流式工具调用完全丢失。现在正确发出 OpenAI 格式的 `tool_calls` delta，支持多工具、text+tool 混合块、参数增量。
>
> **代理模块**
>
> 11. **修复 WAF body 消费后未恢复**：`isWafBlockResponse` 之前在非 WAF 路径用 `(resp as any)._wafCheckBody = text` hack 暂存 body，但下游从不读取，导致 200+HTML 响应的 `body.tee()` 抛错。重构为 `checkWafBlock` 返回新的 `Response`（body 重建），并在重试循环中也加入 WAF 检查。
>
> 12. **`upstreamTimeoutMs` 配置实际生效**：之前 `config.server.upstreamTimeoutMs` 被 loader 解析但 handler 用硬编码常量，配置是死的。现在 handler 读取配置值，0 或未设时回退到默认（流式 10min / 批量 5min）。
>
> 13. **`sessionCache` 指纹改用 socket IP**：之前 `clientFingerprint` 无条件读 XFF，攻击者可伪造 XFF 让多用户共享上游 session ID。现在用 `resolveClientIp`（TCP socket），XFF 仅在 `trustProxy: true` 时可用。
>
> **测试**：556 pass / 0 fail（新增 22 个测试覆盖以上修复）。

> **v0.2.0.2 — 日志系统优化（请求追踪 + 验证码耗时拆分 + 错误分类 + 文件持久化）**
>
> 全面优化代理日志系统，从8个维度提升可观测性和诊断效率。
>
> **本次改动**
>
> 1. **请求入口日志（G1）**：每个请求进入 `proxyRequest()` 时立即打印 `#001 >>> POST /v1/messages (anthropic)`，之前第一条日志要到路由阶段才出现，无法关联"请求等了多久才开始处理"。
>
> 2. **reqId 跨模块传播（G2）**：captcha 模块、resolver 模块的日志现在携带请求 ID（如 `#001 [captcha] solve attempt 1/3 failed`），之前只有 `[captcha]` 标签，无法将验证码日志与对应请求关联。
>
> 3. **TTFB 中拆分验证码耗时（G4）**：控制台表格新增 Captcha 列，start-plan 请求显示 `TTFB=35000ms (net 3000ms + captcha 32000ms)`，直接看出 TTFB 是因为验证码慢还是上游慢。
>
> 4. **错误统计按状态码分类（G5）**：新增 `byStatus` 字段（如 `{529: 12, 429: 3, 401: 1}`），之前只知道 `failed: 16`，无法判断是过载还是限流还是鉴权问题。
>
> 5. **凭证成功率统计（G6）**：`byCredential` 新增 `success` 和 `failed` 字段，可计算每个凭证的成功率，之前只有成功计数，失败凭证无法被发现。
>
> 6. **可选文件日志持久化（G3）**：新增 `logging.file` 配置项和环境变量 `ZCODE_PROXY_LOG_FILE`，设为文件路径后每条日志同时写入磁盘（JSON Lines 格式），重启后日志不丢失。
>
> 7. **请求体大小记录（G7）**：解析请求体后打印 `#001 body size: 45.2KB (46296 bytes)`，方便诊断超大请求触发 WAF 或超时的问题。
>
> 8. **环形缓冲区替代 splice（G8）**：日志缓冲区从 array+splice 改为预分配环形缓冲区，避免 splice(0, N) 的 O(N) 数组拷贝开销。
>
> **v0.2.0.1 — 修复 Responses API (Codex) 工具翻译 + 身份改写增强**
>
> 在 v0.2.0 基础上修复 Codex CLI 通过 Responses API 发送请求时的工具翻译问题，并增强 ClaudeCode 身份改写的兼容性。
>
> **本次改动**
>
> 1. **修复 `type: "custom"` 工具转换**：Codex 的 `apply_patch` 工具使用自定义 grammar 格式而非 JSON Schema，之前被直接过滤掉导致 Codex 报错。现在转为标准 function 工具，创建 `{ patch: string }` 的 input_schema，grammar 格式信息追加到 description。
>
> 2. **修复 `function_call.arguments` 非JSON格式**：Codex 的 custom 工具发送 freeform 文本作为 arguments（不是 JSON），之前 JSON.parse 失败后丢弃。现在解析失败时包裹为 `{ patch: "原文" }`，与 custom 工具的 input_schema 匹配。
>
> 3. **转换 `type: "tool_search"` 工具**：Codex 用此工具做延迟工具发现，转为 function 工具保留 schema，让模型知道可以搜索工具。
>
> 4. **修复身份改写正则**：ClaudeCode 新版身份串增加 `, running within the Claude Agent SDK.` 后缀，之前 `.includes()` 匹配失败，改为正则兼容新旧两种格式。
>
> 5. **剥离 `x-anthropic-billing-header` 系统 block** + **剥离 `is_error:false`** + **`document` 块转 text**（v0.2.0 改动一并包含）。

> **v0.2.0 — ClaudeCode→ZCode 请求转换对齐修复（身份改写 + document 块 + is_error 处理）**
>
> 修复了 v0.1.9 中 ClaudeCode 长任务请求转换为 ZCode 格式时的三个关键问题，确保转换后的请求在身份、内容块类型和字段值上与真实 ZCode 客户端一致。
>
> **本次改动**
>
> 1. **修复身份改写失败**：ClaudeCode 新版身份串变更为 `"You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK."`，旧版 `.includes()` 匹配失败导致 "Claude Code" 身份泄漏到网关。改为正则匹配，兼容新旧两种格式，替换为 `"You are ZCode, an interactive coding agent."`。
>
> 2. **替换 system 文本中所有 "Claude Code" 引用**：ClaudeCode 的 harness 指令中多处出现 "Claude Code"（如 "Claude Code is available as a CLI"），现在全部替换为 "ZCode"，消除身份指纹。
>
> 3. **剥离 x-anthropic-billing-header 系统 block**：ClaudeCode 在 system[0] 插入 billing header（`x-anthropic-billing-header: cc_version=...`），ZCode 从不发送此块，现在从 system 数组中移除。
>
> 4. **新增 convertDocumentBlocks()**：ClaudeCode 会发送 `type: "document"` 的内容块（如附件日志文件），ZCode 网关不接受此类型，现在自动转换为 `type: "text"` 块，保留文档文本内容。
>
> 5. **剥离 is_error:false**：ClaudeCode 给每个成功的 tool_result 标记 `is_error: false`，但真实 ZCode 客户端成功时省略该字段（49 个成功 tool_result 中 0 个带 is_error），只在失败时发送 `is_error: true`。现在剥离 `is_error: false`，保留 `is_error: true`。
>
> **当前对齐效果**（用 ClaudeCode 真实长任务请求转换后对比真实 ZCode 抓包）：
>
> | 维度 | v0.2.0 转换后 | 真实 ZCode |
> |---|---|---|
> | 顶层字段顺序 | ✅ model→max_tokens→thinking→output_config→system→messages→tools→tool_choice | ✅ 一致（stream 除外） |
> | thinking 格式 | ✅ {type:"enabled", budget_tokens:32000} | ✅ 一致 |
> | max_tokens | ✅ 64000 | ✅ 一致 |
> | output_config | ✅ {effort:"max"} | ✅ 一致 |
> | tool_choice | ✅ {type:"auto"} | ✅ 一致 |
> | ZCode 官方 2 条 system 块 | ✅ 前置注入 | ✅ 一致 |
> | 身份泄漏 | ✅ 无 "Claude Code" 残留 | ✅ 一致 |
> | billing header | ✅ 已剥离 | ✅ 一致 |
> | document 类型块 | ✅ 转为 text | ✅ 一致 |
> | is_error:false | ✅ 已剥离 | ✅ 一致 |
> | is_error:true | ✅ 保留 | ✅ 一致 |
> | thinking/redacted_thinking | ✅ 已剥离 | ✅ 一致 |
> | cache_control | ✅ 最后 user text block | ✅ 一致 |
> | context_management | ✅ 已删除 | ✅ 一致 |
> | metadata | ✅ 已删除 | ✅ 一致 |

> **v0.1.9 — 正式版：ZCode 请求体对齐成为默认行为（移除测试开关）**
>
> 在 vceshi0.1.5 ~ vceshi0.1.7 经过 3 个测试版本验证后，将「对齐 ZCode 请求格式」从测试开关转正为默认且唯一的行为。同时适配了 OpenAI / Responses 格式：所有客户端请求（无论 Anthropic / OpenAI / Responses）最终都通过 translator 转成 Anthropic 格式后走对齐逻辑，统一对齐到真实 ZCode 客户端的 wire format。514/514 测试通过，TypeScript 编译零错误。
>
> **本次改动**
>
> 1. **删除 `alignZCodeFormat` 配置项**：不再需要手动开启，默认就是对齐模式。Dashboard、YAML、环境变量三种配置方式均移除。原版的非对齐代码路径（`relocateSystemMessages`、`ensureAssistantTextBlock`、`normalizeToolResultContent`、`sanitizeContentBlocks` 的 strip 逻辑等）全部废弃删除。
>
> 2. **OpenAI / Responses 格式自动适配**：发现 OpenAI（`/v1/chat/completions`）和 Responses（`/v1/responses`）格式的请求在 handler.ts 中已经通过 translator 翻译成 Anthropic 格式后才走 `transformRequestBodyObj`，`upstreamFormat` 永远是 `"anthropic"`。所以对齐逻辑天然覆盖所有客户端格式，无需单独适配。
>
> 3. **v0.2.0.4 恢复强制 `stream: true`**：v0.1.9 曾改为可选的 `forceStreamAnthropic` 配置项（默认关闭），但实测发现「对齐 ZCode wire shape」的优先级高于「尊重客户端 stream 偏好」——响应路径已能正确把上游 SSE buffer 成 batch JSON 返还给非流式客户端，所以不会破坏非流式客户端。v0.2.0.4 移除该配置项，`stream: true` 永远在 `alignZCodeRequestFormat` 内部强制注入。
>
> 4. **代码清理**：删除 3 个废弃函数（`relocateSystemMessages`、`ensureAssistantTextBlock`、`normalizeToolResultContent`），body-transformer.ts 从 1081 行精简到 876 行。删除约 1000 行废弃测试代码。
>
> 5. **`metadata.user_id` 注入路径移除**：原 coding-plan 模式下会注入 `metadata.user_id` 用于 OAuth 跟踪，但 alignZCodeRequestFormat 总是删除 metadata（真实 ZCode 从不发送）。两者矛盾，所以 v0.1.9 直接移除 `applyAnthropicUserId` 调用（函数定义保留以备将来需要）。
>
> **当前对齐效果**（用 Claude Code 真实长任务请求做样本模拟，对比真实 ZCode 抓包）：
>
> | 维度 | v0.1.9 | 真实 ZCode |
> |---|---|---|
> | 顶层 9 字段顺序 | ✅ | ✅ |
> | `tool_result.content` 格式 | ✅ string (49/49) | string (49/49) |
> | assistant 无 text 块 | ✅ 18 | 18 |
> | `is_error` 保留 | ✅ 1 | 1 |
> | `cache_control` 块数 | ✅ 1 | 1 |
> | system 块数 (start-plan 幂等) | ✅ 3 | 3 |
> | ZCode 官方 2 条 system 块 | ✅ | ✅ |
> | `tools` 15 个名称+顺序 | ✅ | ✅ |
> | metadata 剥离 | ✅ | ✅ |
> | `thinking` / `output_config` / `max_tokens` | ✅ | ✅ |
>
> **移除的配置项（v0.2.0.4）**：
> - **Anthropic 强制流式输出**（`forceStreamAnthropic` / `anthropic.forceStream` / `ZCODE_PROXY_FORCE_STREAM_ANTHROPIC`）：已移除。`stream: true` 现在无条件注入对齐 ZCode wire shape。
>
> **继承 vceshi0.1.5 ~ vceshi0.1.7 / v0.1.8 的所有改动**（消息体内部指纹对齐、顶层字段顺序对齐、ZCode 官方 system 块注入、身份改写、请求头指纹对齐、WAF 拦截短路检测、[undefined] 字段清理、思考等级面板控制等）
>
> ---

> **vceshi0.1.7 — 测试版本：新增思考等级面板控制（高 / 最高）**
>
> 在 vceshi0.1.6 的基础上，新增「ZCode 思考等级」面板下拉，支持两档思考强度，与真实 ZCode 桌面客户端的「高 / 最高」选项一一对应。同时移除了 v0.1.9 遗留的「ZCode 思考格式注入（默认开启）」固定说明文字（既然已默认开启，没必要在面板占一行）。547/547 测试通过，TypeScript 编译零错误。
>
> **本次新增功能 — thinkingLevel 配置项（默认 max）**
>
> Dashboard「代理规则」面板新增下拉：
> - **最高**（默认）：`max_tokens=64000` / `thinking.budget_tokens=32000` / `output_config.effort=max`
> - **高**：`max_tokens=64000` / `thinking.budget_tokens=16000` / `output_config.effort=high`
>
> 这两档参数完全对齐真实 ZCode 桌面客户端的思考档位选项。
>
> **触发逻辑**（关键设计）：
>
> | 客户端请求 | 代理行为 |
> |---|---|
> | 客户端发送 `thinking.type=enabled` | 按面板档位注入 `budget_tokens` + `output_config.effort`（高或最高） |
> | 客户端不发 `thinking` 字段 | 只注入 `max_tokens=64000`，**不强制开思考**（对应 ZCode「不思考」模式） |
> | 客户端发送 `thinking.type=disabled` | 同上：只注入 `max_tokens=64000`，保留 `thinking.type=disabled` 不变 |
>
> 也就是说：**面板档位只控制思考强度（高 vs 最高），不控制思考开关**。开关由客户端决定——Claude Code / Cherry Studio 等客户端在用户那边开思考，代理才会按面板档位注入对应强度。
>
> **三种配置方式**：
> 1. Dashboard「代理规则」→ 「ZCode 思考等级」下拉 → 选「最高」或「高」→ 保存（热切换，无需重启）
> 2. YAML: `anthropic: thinkingLevel: high` 或 `anthropic: thinkingLevel: max`
> 3. 环境变量: `ZCODE_PROXY_THINKING_LEVEL=high` 或 `ZCODE_PROXY_THINKING_LEVEL=max`
>
> **其他改动**：
> - 移除 dashboard 里 v0.1.9 遗留的「ZCode 思考格式注入（默认开启）」纯文字说明（既然默认就是开的，没必要单独占一行面板；改为下拉控件更实用）
> - `injectZCodeThinkingFormat` 重写：默认情况下 `max_tokens=64000` 强制注入（匹配 ZCode 三种 wire 形态都有 `max_tokens=64000`）；只有当 `thinking.type=enabled` 时才注入 `budget_tokens` + `output_config`
>
> **继承 vceshi0.1.6 / vceshi0.1.5 / v0.1.8 的所有改动**（消息体内部指纹对齐、顶层字段顺序对齐、ZCode 官方 system 块注入、身份改写、请求头指纹对齐、WAF 拦截短路检测、[undefined] 字段清理等）
>
> ---

> **vceshi0.1.6 — 测试版本：消息体内部指纹全面对齐真实 ZCode 客户端（alignZCodeFormat 开关）**
>
> 在 vceshi0.1.5 顶层结构对齐的基础上，继续对齐 messages 内部的细节指纹。用真实 ClaudeCode 长任务请求（123 轮对话 + 49 个 tool_use/tool_result）做样本模拟，对比真实 ZCode 客户端抓包，本次修复后所有 WAF 可观测维度全部对齐。539/539 测试通过，TypeScript 编译零错误。
>
> **本次修复（仅在 alignZCodeFormat 开关开启时生效；默认关闭时行为与 v0.1.5 完全一致）**
>
> 1. **tool_result.content 保留 string 格式**：真实 ZCode 客户端的 `tool_result.content` 全部用 string（49/49），vceshi0.1.5 错误地转成了 array 格式。现在 alignZCodeFormat 模式下跳过 `normalizeToolResultContent`，保持 string 不变。
>
> 2. **assistant 消息不再强插 text 占位块**：真实 ZCode 客户端允许 assistant 消息只有 tool_use 块（样本中 18 条这样的消息），vceshi0.1.5 的 `ensureAssistantTextBlock` 强行插入 `text:" "` 占位块。现在 alignZCodeFormat 模式下跳过此步骤。
>
> 3. **保留 is_error 字段**：真实 ZCode 客户端保留 `tool_result.is_error`（样本 messages[6] 的超时返回有 `is_error: true`），vceshi0.1.5 在 `sanitizeContentBlocks` 里把 `is_error` 全部删了。现在 alignZCodeFormat 模式下保留。
>
> 4. **保留 + 注入 cache_control**：真实 ZCode 客户端在最后一条 user 消息的 text 块加 `cache_control: { type: "ephemeral" }` 作为 prompt cache 断点。vceshi0.1.5 在 start-plan 模式下被 `sanitizeContentBlocks` 全删了。现在 alignZCodeFormat 模式下：
>    - 不剥离客户端自带的 cc
>    - `applyAnthropicCacheControl` 即使在 start-plan 也启用，在最后一条 user 消息的末尾 text 块注入 cc
>    - 既对齐指纹，又保留 prompt cache 优化（命中缓存输入 token 计费降到 1/10，TTFB 显著降低）
>
> 5. **修复 start-plan + alignZCodeFormat 双开时的幂等性 bug**：vceshi0.1.5 在重试/缓存回放场景下，`applyStartPlanSystem` 会重复注入 ZCode 官方块导致 system 从 3 块变成 5 块。现在改为完整比对官方块序列（前 N 块文本逐一匹配），不再重复注入。
>
> **实测对齐效果**（用 Claude Code 真实长任务请求做样本模拟，对比真实 ZCode 抓包）：
>
> | 维度 | vceshi0.1.5 | vceshi0.1.6 | 真实 ZCode |
> |---|---|---|---|
> | 顶层 9 字段顺序 | ✅ | ✅ | ✅ |
> | `tool_result.content` 格式 | ❌ array | ✅ string (49/49) | string (49/49) |
> | assistant 无 text 块 | ❌ 0（被强插） | ✅ 18 | 18 |
> | `is_error` 保留 | ❌ 0（被删） | ✅ 1 | 1 |
> | `cache_control` 块数 (start-plan) | ❌ 0（被剥） | ✅ 1 | 1 |
> | system 块数 (start-plan 幂等) | ❌ 5（重复） | ✅ 3 | 3 |
> | ZCode 官方 2 条 system 块 | ✅ | ✅ | ✅ |
> | `tools` 15 个名称+顺序 | ✅ | ✅ | ✅ |
> | metadata 剥离 | ✅ | ✅ | ✅ |
>
> **三种开启方式（不变）**：
> 1. Dashboard「代理规则」→ 勾选「对齐 ZCode 请求格式（测试开关）」→ 保存（热切换，无需重启）
> 2. YAML: `anthropic: alignZCodeFormat: true`
> 3. 环境变量: `ZCODE_PROXY_ALIGN_ZCODE_FORMAT=1`
>
> **默认关闭时行为与 v0.1.5 完全一致**——所有新行为都在 `if (ctx.alignZCodeFormat)` 闭包内，关闭时走原有逻辑（normalizeToolResultContent 转 array、ensureAssistantTextBlock 强插 text、sanitizeContentBlocks 剥 cc+is_error、applyAnthropicCacheControl start-plan no-op）。
>
> **继承 vceshi0.1.5 / v0.1.8 的所有改动**（顶层字段顺序对齐、ZCode 官方 system 块注入、身份改写、请求头指纹对齐、思考格式默认注入、WAF 拦截短路检测、[undefined] 字段清理等）
>
> ---

> **vceshi0.1.5 — 测试版本：请求体结构对齐真实 ZCode 客户端（alignZCodeFormat 开关）**
>
> 本次测试版本新增「对齐 ZCode 请求格式」开关（默认关闭），开启后请求体结构完全对齐真实 ZCode 桌面客户端抓包。全套 532/532 测试通过，TypeScript 编译零错误。
>
> **新增功能 — alignZCodeFormat 开关（默认关闭）**
>
> 开启后，任何 Anthropic 格式（/v1/messages）请求都会被改写成真实 ZCode 客户端的请求结构：
>
> 1. **顶层字段顺序对齐**：按 ZCode 抓包顺序重排 → `model → max_tokens → thinking → output_config → system → messages → tools → tool_choice → stream`。JSON 对象的 key 顺序会影响实际传输的字节序列，部分 WAF 会检查 key 顺序作为指纹。
>
> 2. **注入 ZCode 官方 system blocks**（2 条，coding-plan 和 start-plan 都注入）：
>    - Block 1: `You are ZCode, an interactive coding agent`（身份声明）
>    - Block 2: harness 说明 + 安全策略（"You are an interactive ZCode agent that helps users with software engineering tasks..."）
>    - 每个 block 带 `cache_control: { type: "ephemeral" }`
>    - 客户端原 system blocks 追加在这两条后面
>    - **start-plan 必须**：网关做内容检查，缺少 ZCode 身份 block 会被拒
>
> 3. **身份改写**：客户端 system/messages 里的 `You are Claude Code, Anthropic's official CLI for Claude.` 自动改写成 `You are ZCode model working in Claude Code.`（保留 Claude Code 的 harness 指令，仅切换身份声明）
>
> 4. **保留 messages 里 role:system**：不再把 `role: "system"` 从 messages 移到顶层 system 字段（真实 ZCode 就保留在 messages 里，之前的 relocateSystemMessages 适配是改错了）
>
> 5. **补全缺失字段**：
>    - 有 tools 但没 tool_choice 时自动补 `tool_choice: { type: "auto" }`
>    - stream !== true 时强制 `stream: true`（Claude Code 默认 false，真实 ZCode 总是 true）
>
> 6. **删除非 ZCode 字段**：
>    - 删除 `metadata`（Claude Code 自带 user_id 跟踪字段，真实 ZCode 客户端从不发送）
>
> **实测对齐效果**（用 Claude Code 真实请求做输入）：
> - 顶层字段顺序 9/9 完全对齐 ✅
> - system blocks: 2 个 ZCode 官方 block + 客户端原 system（身份已改写）✅
> - tool_choice / stream / metadata 全部处理 ✅
> - 身份字符串改写 ✅
>
> **三种开启方式**：
> 1. Dashboard「代理规则」→ 勾选「对齐 ZCode 请求格式（测试开关）」→ 保存（热切换，无需重启）
> 2. YAML: `anthropic: alignZCodeFormat: true`
> 3. 环境变量: `ZCODE_PROXY_ALIGN_ZCODE_FORMAT=1`
>
> **继承 v0.1.8 的所有改动**（请求头指纹对齐、思考格式默认注入、WAF 拦截短路检测、[undefined] 字段清理等）
>

> **v0.1.8 — WAF 指纹对齐：请求头/请求体全面模拟真实 ZCode 客户端**
>
> 本次升级针对阿里云 WAF 拦截问题，根据逆向真实 ZCode Electron 客户端抓包，全面对齐请求指纹。全套 518/518 测试通过，TypeScript 编译零错误。
>
> **核心改动 — 请求头指纹对齐（identity.ts / upstream.ts）**
> - **User-Agent 改为 `ai-sdk/anthropic/3.0.81`**（之前是 `ZCode/3.1.5`，但真实 ZCode 客户端用的是 Vercel AI SDK，发的 UA 是 `ai-sdk/anthropic/{version}`）
> - **删除四个伪装头**：`X-ZCode-App-Version` / `X-Title` / `X-ZCode-Agent` / `HTTP-Referer`（真实 ZCode 客户端**根本不发**这些头，发了反而是指纹）
> - **`x-query-id` 去掉 `query_` 前缀**，发送纯 UUID（之前是 `query_<uuid>`，真实客户端发的是裸 UUID）
> - **`x-session-id` 改为会话内稳定**（之前每次 fetch 都换新 UUID，真实客户端在 Electron app 整个生命周期内只换一次 session ID。代理现在按 client IP + proxy API key 缓存 session ID 30 分钟）
> - **新增 `Accept: text/event-stream`** 头（真实 ZCode 客户端总是发这个 Accept，之前代理缺失）
> - **剥离所有客户端 SDK / 浏览器头**：`origin` / `referer` / `sec-fetch-*` / `sec-ch-ua` 等都从客户端请求剥离，不让它们透传到上游
> - **`anthropic-beta` 过滤**：只保留 `claude-code-*` 前缀的 flag，其余（`prompt-caching-*` / `interleaved-thinking-*` 等）一律剥离
>
> **核心改动 — 请求体清理（handler.ts）**
> - **递归剥离 `"[undefined]"` 字段**：Cherry Studio 等客户端会把 JavaScript `undefined` 序列化成字符串 `"[undefined]"`（变成 `temperature: "[undefined]"` 这种垃圾字段透传到 z.ai），这是强烈的脚本流量指纹，WAF 一抓一个准。代理现在会递归清理请求体里所有值为 `"[undefined]"` 的字段
>
> **核心改动 — WAF 拦截短路检测（handler.ts）**
> - 新增 `isWafBlockResponse()` 检测阿里云 WAF 拦截响应（HTTP 405/403/200 + `content-type: text/html` + body 含 `errors.aliyun.com`）
> - 命中 WAF 拦截时**立即停止所有重试**，返回 503 + `waf_blocked` 错误类型，避免越撞越黑
> - 控制台输出明显的警告日志，提示用户换 IP / 等待 / 降频
>
> **核心改动 — 新增「注入 ZCode 思考格式」开关（默认关闭）**
> - 真实 ZCode 客户端在思考开启时发送固定的请求体：`max_tokens: 64000` + `thinking.budget_tokens: 32000` + `output_config.effort: "max"`
> - 之前代理会**剥离** `budget_tokens` 和 `output_config`（误以为 GLM 不支持），导致请求体和真实客户端不一致
> - 新增 `anthropic.injectThinkingFormat` 配置项（默认关闭），开启后任何 `thinking.type === "enabled"` 的请求都会被强制改写成 ZCode 真实客户端格式
> - 三种开启方式：① Dashboard「代理规则」面板的开关（热切换，无需重启）② YAML `anthropic.injectThinkingFormat: true` ③ 环境变量 `ZCODE_PROXY_INJECT_THINKING_FORMAT=1`
> - 仅当客户端已开启思考时触发，不会强制开启思考；OpenAI 格式请求不受影响
>
> **影响**
> - 代理发出的请求头**逐字节匹配**真实 ZCode 客户端抓包（已用脚本对比验证）
> - Cherry Studio / Claude Code / Codex CLI 任何客户端发来的请求，透传到 z.ai 时都会变成真实 ZCode 客户端的形状
> - 被阿里云 WAF 拦截时不再傻乎乎撞 3 次 retry，立即停止并提示用户
> - 开启思考格式注入后，请求体层面也和真实 ZCode 客户端一致，进一步降低被识别风险
>
> **配置示例**
> ```yaml
> anthropic:
>   forceStream: false
>   injectThinkingFormat: true   # 新增：注入 ZCode 思考格式
> ```
>
> **建议升级路径**
> 1. 升级到 v0.1.8
> 2. **换 IP**（旧 IP 可能已被拉黑，不换 IP 升级也没用）
> 3. 启动代理，在 Dashboard 开启「注入 ZCode 思考格式」
> 4. 用 Cherry Studio / Claude Code 测试，观察代理日志看是否还有 `⚠️ ALIYUN WAF BLOCK DETECTED` 警告
> 5. 如果再被拦，把拦截响应的完整 header（特别是 `via` / `eagleid` / `x-cache`）反馈给开发者定位是哪一层挡的
>

> **v0.1.7 — 紧急修复：Captcha Token 重用导致 3007 验证失败**
>
> 本次修复 v0.1.6 引入的 regression。全套 508/508 测试通过，TypeScript 编译零错误，生产编译成功。
>
> **问题：v0.1.6 的 mutex + double-checked-locking 导致 captcha token 在并发请求间共享**
> - 症状：start-plan 模式下，多个并发请求共享同一个 Aliyun captcha verifyParam token，第二个请求上游返回 `{"code":3007,"msg":"captcha verify failed"}`
> - 根因：v0.1.6 加的 `solveMutex` + double-checked locking 让并发 cache-miss 的请求都拿到**同一个** token（第一个 solve 完，其他 cache hit 复用）。但 Aliyun verifyParam 是**一次性**的，zcode.z.ai 验证一次后即消耗
>
> **修复（captcha.ts）**
> - **完全去掉 token cache**，`getCaptchaToken()` 每次都 solve 新的 token
> - 保留 `solveMutex` 串行 solve 防止 OOM（同时只有一个 JSDOM 实例）
> - config fetch timeout 从 8s → 15s，避免网络慢时误判 config 不可用
> - 静默 jsdom 在 Bun 上的 `vm.runInContext` 错误（这些错误不影响 solve 成功，但会刷屏 dashboard 日志）
>
> **修复（handler.ts）—— 每次 fetch 都 solve 新 token**
> - 关键认知：Aliyun verifyParam 在**任何**上游响应后都被消耗（200 / 529 / 429 / 403 都算），不只是 403 captcha 失败时才消耗
> - 因此**每次** `fetchUpstreamDetected()` 调用前都 solve 一个全新的 token，不复用
> - `handleCaptchaChallenge()` 保留作为 403 的快速重试路径，但 re-solve 的 token 也只用于这一次 fetch
> - 代价：每次 retry 多 20-40s solve 时间（JSDOM 启动开销），但这是 Aliyun captcha 一次性语义的硬性要求
> - 并发请求由 `solveMutex` 串行化，防止 N 个 JSDOM 实例同时存在导致 OOM
>
> **影响**
> - 不同请求各自 solve 独立 token → 3007 错误消除
> - 同一请求的 retry 也各自 solve 独立 token → 529 重试不再触发 3007
> - 并发请求串行 solve（mutex 保护）→ 防止 OOM，代价是并发延迟（N 请求 = N × solve 时间）
> - 对于单用户本地代理场景，并发 start-plan 请求很少，延迟可接受
>
> **v0.1.6 — 全面优化：Captcha 并发保护 + 凭证竞态修复 + Admin API 默认鉴权 + authExport 安全输出**
>
> 本次更新聚焦于「用着用着突然不能用」类问题的根因修复。全套 508/508 测试通过，TypeScript 编译零错误，生产编译（786 模块 → 单文件 exe）成功。
>
> **核心修复 1：Captcha Solver 并发保护（防止 OOM 崩溃）**
> - 症状：start-plan 模式下，多个并发请求同时遇到 token 过期时，每个请求都会启动一个独立的 JSDOM 实例（每个 50-100MB），4 个并发 = 400MB 内存峰值，长时间运行容易 OOM
> - 修复：新增 `solveMutex` 串行化所有 JSDOM solve 调用，同一时刻只允许一个 JSDOM 实例存在
> - 双重检查锁定：第二个调用者拿到锁后会先检查 cache，如果第一个调用者已 solve 完就直接复用，省掉一次 JSDOM 启动
> - `pendingInvalidate` 机制：403 触发 invalidate 时如果 solve 正在进行，solve 完成后丢弃结果，避免旧 token 污染 cache
> - 配置获取超时：8s timeout + AbortController，避免 zcode.z.ai 网络问题导致整个请求挂死
> - JSDOM 资源彻底清理：finally 块清理 interval/timeout/window/document 引用，防止内存泄漏
> - 错误分类：配置不可用不重试（不会突然恢复），只有 solve 失败才重试
>
> **核心修复 2：clearCredential 竞态（防止凭证"复活"）**
> - 症状：用户点击"清除凭证"时，如果同时有 auto-switch 写入在进行，写入会把刚删的 credentials.json 重新创建出来，导致凭证"复活"
> - 修复：新增 `clearCredentialAsync()` 走 `storeWriteMutex`，确保任何 in-flight 写入完成后才执行删除
> - 生产代码（`auth logout` 命令、dashboard 的"清除凭证"按钮）全部改用 async 版本
> - 同步版本保留给测试用，加了 ⚠️ 注释标明不安全
>
> **核心修复 3：跨进程凭证缓存同步（无需重启即可看到新凭证）**
> - 症状：proxy 运行中，用户通过 `start.bat` 跑 `auth login` 添加新凭证，proxy 的 auto-switch 不会用到新凭证（cache 不刷新）
> - 修复：`readStore()` 加 mtime 检测，每次读 cache 前先 stat 文件 mtimeMs，如果变化（说明 CLI 进程改了 credentials.json）就丢弃缓存重新读盘
> - 新增凭证后运行中的 proxy 在下一次 auto-switch 时就能看到，不需要重启
>
> **安全加固 1：Admin API 默认鉴权（防止远程清空凭证）**
> - 症状：当 `proxyApiKey` 未配置时，所有 `/admin/api/*` 路由完全开放，任何能访问端口的人都可以 POST 凭证、DELETE 清空、PUT 改配置
> - 修复：`proxyApiKey` 未配置时，admin API 要求 loopback 来源（127.0.0.1 / ::1 / localhost），非 loopback 返回 401 提示配置 `proxyApiKey`
> - 本地开发不受影响（dashboard / CLI 都走 loopback），远程管理必须显式配置 `proxyApiKey`
>
> **安全加固 2：authExport 安全输出（防止凭证泄漏到 stdout）**
> - 症状：`zcode-proxy auth export` 把 base64 编码的完整凭证（apiKey / secret / jwt / userId）打印到 stdout，会被终端 scrollback / CI 日志 / 录屏 / SSH 录像 / log 聚合捕获
> - 修复：新增 `--output <file>` 选项，写文件 + 强制 0600 权限（owner-only），避免 stdout 暴露
> - 新增 `--quiet` 选项，只输出 base64 无 banner，便于管道（但仍有 scrollback 风险，敏感场景用 `--output`）
> - 默认行为保留（向后兼容），但加了 tip 提示用 `--output`
>
> **逻辑修复：credentialSwitchThreshold 默认值（5 → 2）**
> - 症状：默认 `credentialSwitchThreshold=5` > `maxRetries=3`，导致通用凭证切换在默认配置下永不触发（retry 循环先耗尽）
> - 修复：默认值改为 2，失败 2 次后切换到下一个凭证，并 grant +1 attempt 让新凭证真的有机会被试
>
> **性能优化：logWaiters 泄漏修复**
> - 症状：dashboard SSE 日志连接的 waiter 最长泄漏 1 小时（maxTimeout=3600s），浏览器崩溃/移动网络断开后 appendLog 每次都遍历死 waiter
> - 修复：maxTimeout 从 1h → 10min；新增 30s 心跳（发送 `: heartbeat\n\n` SSE 注释），enqueue 失败立即清理 waiter
>
> **CLI 变化（不影响 start.bat / start.sh）**
> - `auth export` 新增 `--output <file>` 和 `--quiet` 选项（旧脚本不调用 `auth export`，无需重新生成）
> - `auth logout` 内部改为 async（用户视角无变化，调用方式不变）
> - `printHelp` 输出更新，反映新的 `--output` / `--quiet` 选项
>
> **配置变化**
> - `retry.credentialSwitchThreshold` 默认值从 5 改为 2（已同步更新 config.example.yaml）
> - 其他配置项无变化，无需用户手动迁移
>
> **v0.1.5 — 代码质量优化 + Anthropic 强制流式输出 + 代理测试连接 + 上游超时配置**
>
> 本次更新包含大量代码质量改进和新功能。无 CLI 命令变化，无需重新生成 start.bat / start.sh。全套 508/508 测试通过，TypeScript 编译零错误。
>
> **新功能 1：Anthropic 格式强制流式输出**
> - 新增 `anthropic.forceStream` 配置项（YAML）和 `ZCODE_PROXY_FORCE_STREAM_ANTHROPIC=1` 环境变量
> - 开启后，对 Anthropic 格式（/v1/messages）的请求强制设置 `stream: true`，即使客户端发送的是非流式请求
> - 这使得 Claude Code 等默认非流式的客户端也能实时逐 token 输出，而不是等待完整响应
> - 仅影响 Anthropic 直通路径，OpenAI / Responses 格式不受影响
> - Dashboard 日志配置页新增「Anthropic 强制流式输出」开关，支持热切换无需重启
>
> **新功能 2：上游请求超时配置**
> - 新增 `server.upstreamTimeoutMs` 配置项（默认 300000ms = 5 分钟）
> - 可通过 `ZCODE_UPSTREAM_TIMEOUT_MS` 环境变量覆盖
> - 防止挂起的上游连接无限期占用资源
>
> **已有功能确认：账号代理测试连接**
> - Dashboard 已支持代理测试功能（POST /admin/api/accounts/proxy-test）
> - 可在账号设置中输入代理 URL 后点击测试，验证代理是否可达目标上游
> - 支持 http/https/socks5 代理，10 秒超时，返回延迟和状态信息
>
> **代码质量优化（10项）**
> - 修复 `resolvePositiveInt` 语义错误：函数名说"正整数"但实际允许 0，已改为 `> 0`；`maxRetries` 改用 `resolveNonNegativeInt`
> - 移除 `sse-translator.ts` 中重复定义的 `ParsedSSE` 接口，改为从 `utils/sse.ts` 统一导入
> - 修复 `tsconfig.json` 的 `types` 字段：`bun-types` → `@types/bun`，匹配实际安装的 devDependency
> - 重构 `BigmodelOAuthClient`：消除 ~80 行重复的回调服务器代码，复用共享的 `CallbackServer` 类
> - 格式化 `captcha.ts` 中超长单行 polyfill 代码，拆分为可读的多行格式
> - 消除硬编码 VERSION 常量：从 `package.json` 动态读取版本号，单点维护
> - CORS allowlist 依赖注入：移除 `globalThis` hack，改为通过 `ProxyConfig.corsAllowList` 配置字段传递
> - 启用 `noUnusedLocals` / `noUnusedParameters` 严格检查，清理所有未使用的导入/变量
> - 增强 SSE 流 reader 安全释放：`controller.close()` 和 `reader.releaseLock()` 加 try-catch 防止二次操作抛异常
> - 清理多个文件中未使用的导入和变量（api.ts / handler.ts / anthropic-to-openai.ts 等）
>
> **vceshi0.1.4 — 凭证变破损根因修复 + 调试日志 + 导入不自动激活 + 切换后 activeId 同步**
>
> 本次修复用户反馈的 4 个问题。无 CLI 命令变化，无需重新生成 start.bat / start.sh。全套 508/508 测试通过（新增 2 个回归测试）。
>
> **问题 1：凭证突然全部变成破损的（.broken-* 文件堆积）**
> - 症状：用着用着刷新页面，凭证全部没有了，去 `~/.zcode-proxy/` 一看，credentials.json 旁边堆了好多个 `.broken-{timestamp}` 文件
> - 根因 1（杀毒/索引器锁文件误判）：旧代码 `readFileSync` 单次失败就直接 `backupCorruptedStore`，把当时被杀毒软件/Windows Search 短暂锁住的（其实是完好的）文件备份成 `.broken-*`。每次刷新页面遇到一次锁，就多一个 `.broken` 文件
> - 根因 2（空文件误备份）：旧代码遇到 0 字节的 credentials.json（旧版 writeFileSync 崩溃残留）也调 `backupCorruptedStore`，备份一个空文件毫无意义，纯垃圾
> - 根因 3（无清理机制）：`.broken-*` 文件只增不减，永远不删
> - 修复 1：`readStoreUncached` 的 `readFileSync` 加 5 次重试（50ms 退避，应对 EPERM/EBUSY/EACCES）。重试期间锁通常已释放，文件能正常读，不再误判为破损
> - 修复 2：空文件（`raw.trim() === ""`）直接当"无 store"处理，不备份、不设守卫，下次 saveCredential 直接创建新文件
> - 修复 3：`backupCorruptedStore` 新增 `cleanupOldBrokenBackups`，按 mtime 降序只保留最近 5 个 `.broken-*` 文件，更早的自动删除
> - 修复 4：JSON.parse 失败时日志输出文件大小 + 前 100 字符摘要，方便诊断是截断还是真的损坏
>
> **问题 2：看不到上游具体返回了什么（529/空回200都是黑盒）**
> - 症状：遇到 529 或空回 200 时只能看到状态码，看不到上游返回的具体错误 JSON / 空响应体长什么样，难以诊断
> - 修复：新增 `logging.debug` 配置项（环境变量 `ZCODE_PROXY_DEBUG_LOGGING=1`，YAML `logging.debug: true`）。开启后每个请求在上游响应返回时输出：
>   - `[debug] upstream response: status=529 | ct=application/json | retry-after=120 | empty-stream=1 | ratelimit-remaining=0`
>   - `[debug] body preview (156 chars): {"type":"error","error":{"type":"overloaded_error","message":"..."}}`
> - 实现：用 `resp.clone()` 读取副本，不消耗原始响应体，下游 passthrough / 重试逻辑完全不受影响。SSE 流读取前 2KB（含第一个完整事件），JSON 读取到闭合 `}` 为止，3s 超时防止挂起
> - **Dashboard 日志面板增强**：
>   - 日志页新增「调试模式」开关（与设置页同步，热切换无需重启）—— 一键开启/关闭 `logging.debug`
>   - 新增「全部展开」开关 —— 一键展开所有日志行看完整内容
>   - 每条日志行现在**可点击展开/折叠**：长日志（>120 字符）、`[debug]` 行、`[verbose]` 行默认折叠显示摘要（前 120 字符 + …），点击行任意位置展开看完整内容
>   - 展开状态按日志 seq id 记忆 —— 新日志到达触发的重渲染不会丢失你已展开的行
>   - `[debug]` 行带紫色 `DEBUG` 徽章，`[verbose]` 行带蓝色 `VERBOSE` 徽章，方便视觉扫描
>   - 开启调试模式时自动勾选「全部展开」，立刻看到所有上游响应详情
>
> **问题 3：ZCode 导入凭证不应自动激活**
> - 症状：通过 `zcode-proxy auth login --import` 或 dashboard 导入凭证后，新导入的凭证立刻变成激活账号，原来正在用的账号被踢下线
> - 期望：导入只是"添加"账号，不切换激活；用户手动点"激活"才切换
> - 修复 1：CLI `auth login --import` 改用 `saveCredential(cred, { keepActive: true })`，保留原 activeId。OAuth 登录（非 import）仍然自动激活（符合"auth login 是主登录流程"的预期）
> - 修复 2：dashboard `/admin/api/import` 端点同样改用 `keepActive: true`，并移除自动 hot-swap（不再调 `opts.auth.setOAuthCredential`）。响应新增 `activated: false` 字段通知前端
>
> **问题 4：空回自动切换凭证后 activeId 不同步**
> - 症状：遇到空回 200 自动切换到下一个凭证后，请求实际已经用新凭证调用了，但 dashboard 显示的"激活账号"还停在原来那个
> - 根因：`handler.ts` 有两个凭证切换代码块（top-of-loop 和 end-of-loop）。top-of-loop 块切换后会调 `switchAccount(match.id)` 持久化 activeId，但 **end-of-loop 块漏了这步** —— 只切换了内存中的 `cred`，没写磁盘。下次刷新页面读磁盘 activeId 还是旧的
> - 修复：end-of-loop 块补上和 top-of-loop 一致的持久化逻辑：`exportAccounts()` 找到匹配账号 → `switchAccount(match.id)` 写磁盘 → `appendLog` 通知 dashboard。两个切换路径现在行为完全一致
>
> **问题 5：OAuth 模式无凭证时无法启动（鸡生蛋死锁）**
> - 症状：config.yaml 设为 `auth.mode: oauth` 但还没登录过，启动 exe 直接报错退出：「Not logged in for OAuth mode. Run this in a terminal first...」。用户无法打开 dashboard 登录，因为服务器根本没起来；CLI 登录又需要终端（Windows 双击 exe 场景没有终端）
> - 期望：就算没凭证也能进去，打开 dashboard 后再登录
> - 修复：`serve()` 不再在无凭证时 `throw new Error()` 退出。改为打印警告横幅（提示用户打开 dashboard 登录），服务器正常启动。API 请求在凭证添加前返回 503 `credential_unavailable`（`proxyRequest` 已有 try/catch 处理）。用户在 dashboard 点「OAuth 登录」或「从 ZCode 导入」后，新凭证通过 `opts.auth.setOAuthCredential` 热加载到运行中的服务器，无需重启
>
> 升级建议：**所有用户强烈建议升级**。问题 1 的 .broken 堆积 + 凭证丢失是致命问题；问题 4 的 activeId 不同步会导致 dashboard 显示与实际使用不符，排查时误导严重；问题 5 让首次使用 OAuth 模式的用户不再卡在启动报错。

> **vceshi0.1.3 — 凭证存储可靠性 + 进程稳定性双修复**
>
> 本次修复两个用户反馈的高频严重问题：重启后凭证突然全部丢失、Windows exe 用着用着突然退出。无 CLI 命令变化，无需重新生成 start.bat / start.sh。全套 506/506 测试通过（新增 2 个并发写 + 原子写回归测试）。
>
> **问题 1：重启突然凭证全部丢失**
> - 症状：重启 exe 后偶发提示「没有凭证」，回 `~/.zcode-proxy/` 发现 `credentials.json` 被清空或变成 0 字节
> - 根因 1（非原子写）：旧代码用 `writeFileSync` 直接写 credentials.json，该 API 先 truncate 再 write。如果中间被打断（Ctrl+C / Windows kill / 杀毒软件短暂锁文件 / 磁盘满），文件就停在截断状态，下次启动 JSON.parse 失败 → 凭证全没
> - 根因 2（并发写竞争）：proxy 的自动切换凭证路径（handler.ts → switchAccount）和 dashboard 的添加账号路径（admin/api.ts → saveCredential）可能并发执行。两者都 read-modify-write 同一个 store，最后一个写入者覆盖前者，第一个写入者的账号被静默丢掉
> - 修复 1：`writeStore` 改用 `atomicWriteFile`（先写 `.{pid}.tmp-{ts}` 临时文件，再 rename 覆盖）。POSIX rename 是原子的；Windows 上 `safeRename` 已内置 5 次重试应对杀毒/索引器短暂 EPERM。崩溃时临时文件残留（无害），目标文件保持原样
> - 修复 2：新增 `withStoreLock` 互斥锁，包裹所有 mutation 的完整 read-modify-write 序列（`saveCredential` / `switchAccount` / `removeAccount` / `setAccountLabel` / `setAccountPlan` / `setAccountProxy` / `setAccountName` / `setAccountEmail` / `setAccountDisabled` / `importAccounts`）。锁内每次重新 readStore 以避免内存缓存陈旧
> - 修复 3：`clearCredential` 的 `unlinkSync` 加 Windows EPERM/EBUSY/EACCES 重试（5 次，50ms 退避），避免杀毒扫描时「清除凭证」按钮抛未捕获错误
>
> **问题 2：Windows exe 用着用着突然退出**
> - 症状：长时间运行后偶尔无提示退出，没有错误日志，需要手动重启
> - 根因 1（未捕获异步错误）：Bun 默认遇到任何 uncaughtException / unhandledRejection 都会杀进程。SSE observer、captcha 回调、console.log 格式化等任何一处抛错都会让整个 proxy 退出
> - 根因 2（shutdown 挂起）：旧 `Promise.race([server.stop(), timeout]).then(exit)` 没有 catch，如果 `server.stop()` reject（已停止 / Bun 内部错误），`.then` 永不触发，进程挂起直到外部 kill
> - 根因 3（第二次 Ctrl+C 不生效）：注释说「再按一次 Ctrl+C 强制退出」，但旧代码第二次信号只是再次设 `shuttingDown=true`，实际还要等 30s 超时
> - 修复 1：在 `main()` 之前安装 `process.on("uncaughtException")` 和 `process.on("unhandledRejection")`，只 log 不退出。每请求的 try/catch 已经返回 502 给客户端，这两个 handler 是兜底
> - 修复 2：shutdown 改用 `.finally(() => process.exit(0))`，无论 `server.stop()` resolve 还是 reject 都会退出；并在 `server.stop()` 上加 `.catch` 记录错误
> - 修复 3：第二次信号 `process.exit(130)` 立即退出（128 + SIGINT(2)），真正兑现注释承诺
>
> **凭证加密密钥策略确认**
> - 按用户要求：所有密钥都通过 `520` 固定密钥加密解密，**不在凭证目录放任何用于解密的 secret 文件，也不读任何环境变量**
> - 旧版曾支持 `ZCODE_PROXY_CREDENTIAL_SECRET` 环境变量覆盖密钥——这正是「重启凭证全丢」的元凶之一（一次运行设了 env，下次没设，密钥静默轮转，文件解不开）
> - 本次彻底移除该路径：新加密永远用 `SHA-256("520")`，解密 fallback 只保留 `ZCODE_PROXY_LEGACY_SEED` 作为**手动一次性恢复**入口（用户主动设置旧 seed 值来恢复旧版加密的文件，恢复后下次写自动用 520 重新加密）
> - `ZCODE_PROXY_CREDENTIAL_SECRET` 现在完全不被读取，设置它没有任何效果
>
> 升级建议：**所有用户强烈建议升级**。凭证丢失是致命问题，进程异常退出影响日常使用。

> **vceshi0.1.2 — 从 ZCode 导入升级：双源读取 + 自动识别 + OAuth 自动激活额度**
>
> 三项改进，无 CLI 命令变化，无需重新生成 start.bat / start.sh。全套 504/504 测试通过（新增 12 个 zcode-config 用例）。
>
> **改进 1：从 ZCode 导入改为双源读取，导入账号现在带邮箱**
> - 旧版只读 `~/.zcode/v2/config.json`（明文 apiKey），但该文件**没有邮箱/用户 ID**，导入的账号只能用 `zcode(N)-plan` 自动编号
> - ZCode 3.1.x 客户端把更完整的凭证（含邮箱、用户 ID、当前激活的提供商）存在了**加密的** `~/.zcode/v2/credentials.json`
> - 本次：同时读两个文件并合并取更全的信息——config.json 给可直接用的 apiKey，credentials.json 补充邮箱/用户 ID
> - 效果：导入的账号现在命名为 `{邮箱}-{套餐}`（与 OAuth 登录一致），多账号场景下更清晰
>
> **改进 2：导入时自动识别提供商和套餐**
> - 读取 `credentials.json` 的 `active_provider` 字段自动选对提供商；按实际有凭证的组合自动选对套餐
> - Dashboard 导入卡片打开即自动预填，没有凭证的「提供商×套餐」组合会置灰，避免选了报错
> - 仍可手动覆盖
>
> **改进 3：OAuth 登录后自动激活额度，新号「登录即用」**
> - 新号 OAuth 完成后，凭证虽已保存，但 start-plan 仍需查一次额度才激活（vceshi0.1.0 修复的 app_version 闸门）
> - 本次：OAuth 完成、凭证保存成功后，后台自动查一次额度（fire-and-forget，不阻塞登录、失败仅记日志）
> - 效果：新号 OAuth 登录完即可用，无需再手动点「额度」按钮激活
>
> **关键修复（实测发现）**：`zcodejwttoken` 是全局单字段（不分提供商），zai 登录后会让 bigmodel **误报**有 start-plan 凭证。已加归属判断修复，并有回归测试锁定。

> **vceshi0.1.1 — 修复账号导入失败 + 凭证加密损坏两个严重 Bug**
>
> 本次修复两个用户反馈的高频问题：导出账号无法导回、更新后凭证偶尔全部损坏。无 CLI 命令变化，无需重新生成 start.bat / start.sh。全套 492/492 测试通过。
>
> **Bug 1：从文件导入账号时报「缺少 accounts 数组」**
> - 症状：在账号管理页点某行的「导出」按钮导出单个账号 JSON，再点「从文件导入」时被拒绝，报错「文件无效：缺少 accounts 数组」
> - 根因：仪表盘有两种导出按钮生成不同格式，但导入只接受 `{accounts:[...]}` 一种格式；单账号导出格式 `{id,label,credential,...}` 被误拒
> - 修复：`importAccountsFromFile` 现在自动识别四种导出格式（单账号 / 多账号备份 / v2 store 信封 / 账号数组），任一格式均可导入
>
> **Bug 2：更新后偶尔无法解密凭证，导致凭证全部损坏**
> - 症状：更新版本后，偶尔遇到「无法解密凭证」的情况，点击「清除凭证」恢复后所有账号丢失
> - 根因：旧加密方案有 3 层密钥优先级（环境变量 > 密钥文件 > 种子派生），环境变量每次调用都重新计算且不缓存。如果某次运行设置了 `ZCODE_PROXY_CREDENTIAL_SECRET`，文件用 K_env 加密；下次运行没设环境变量则用 K_seed，解密失败，多种子兜底也找不到 K_env（非种子派生），文件被标记为不可解密 → 用户被迫清除 → 数据全丢
> - 修复：彻底简化为**固定密钥** `SHA-256("520")`。无环境变量优先级、无密钥文件、无种子派生——一个常量，到处都一样。无论怎么切环境、切设备，加密密钥始终一致，凭证永不会因密钥漂移而损坏
> - 旧版本加密的文件仍可恢复：`decrypt()` 保留多种子兜底作为一次性迁移路径，恢复后下次保存自动用固定密钥重新加密
>
> 升级建议：**所有用户强烈建议升级**。凭证损坏是致命问题，旧版本随时可能触发。

> **vceshi0.1.0 — 修复 start-plan 额度查询无法激活新账号的致命 Bug**
>
> 新号 OAuth 登录后，用 lealll 额度查询一直显示「无计划（plans 为空）」，必须手动去登录 ZCode 桌面客户端才能激活。
> 本次彻底定位根因并修复。无 CLI 命令变化，无需重新生成 start.bat / start.sh。
>
> **症状**
> - 全新账号 OAuth 登录后，dashboard 点「额度」→ 一直显示空 / no_plan
> - 用户误以为是「凭证没激活」，反复重新 OAuth 或去登录 ZCode 客户端
>
> **根因：app_version 版本号过低，触发不了服务端的 trial 激活闸门**
> - `billing/current` 接口把 `app_version` 当作 start-plan 首次激活的闸门：
>   低版本（如 `2.0.0`）查询不激活，真实客户端版本（`3.1.x`）才授予 trial
> - lealll 的 `quota.ts` 硬编码 `DEFAULT_APP_VERSION = "2.0.0"`，与项目 config 体系（默认 `3.1.1`）脱节
> - 所以每次额度查询都用 `2.0.0`，**永远激活不了新号**
> - 用户「必须登录 ZCode 才激活」的体感真相：ZCode 客户端查额度用真实版本 3.1.x，所以激活；与登录无关
>
> **修复**
> - `quota.ts`：`DEFAULT_APP_VERSION` 从 `2.0.0` → `3.1.5`（真实客户端版本）
> - `admin/api.ts`：调额度查询时注入 `config.identity.appVersion`，复用 config 体系（env/yaml 可覆盖）
> - 激活不可逆，版本号只在首次成功查询时起作用
>
> **实测验证**（同一新号、同一秒、同一 jwt，唯一变量是 app_version）：
> - `app_version=2.0.0` → `{"plans":[]}` 不激活
> - `app_version=3.1.5` → 瞬间激活 ZCode Start Plan（GLM-5.2 3M/daily + GLM-5-Turbo 2M/daily）

> **vceshi0.0.9 — 修复"空回 200 不自动切换账号"严重 Bug**
>
> vceshi0.0.7 / vceshi0.0.8 期间尝试修复过"额度耗尽返回空 200 不切换凭证"的问题，但实测仍不生效。
> 本次彻底定位根因并修复，无 CLI 命令变化，无需重新生成 start.bat / start.sh。全套 492/492 测试通过。
>
> **症状**
> - Claude Code：`API Error: API returned an empty or malformed response (HTTP 200)`
> - Cherry Studio：输出为空，后台日志显示 `| batch | 200 | in:- out:- |`
> - 期望：自动切换到下一个账号重试 → 实际：直接把空 200 透传给客户端
>
> **根因 1：SSE 空流检查条件过严**
> - 旧代码 `sse-error-detector.ts:141` 要求 `!sawAnyCompleteEvent && bufferedChunks.length === 0`（**零字节**才算空流）
> - 但实际网关额度耗尽时往往**返回几个字节**就关闭连接：`\n\n`（空事件块）、`: keepalive\n\n`（注释行）、或部分事件片段
> - 这些场景下 `bufferedChunks.length > 0`，旧检查失败 → 直接 fall through 到 `reconstructStream` → 把"伪 200"透传给客户端 → retry loop 永远不进入 → 凭证切换逻辑根本没机会触发
> - 修复：去掉 `bufferedChunks.length === 0` 条件，只看 `!sawAnyCompleteEvent`
>
> **根因 2：batch（非流式）路径完全没有空响应检测**
> - 旧代码 `sse-error-detector.ts:75` 直接 `if (!ct.includes("text/event-stream")) return resp;` —— 非 SSE 响应一律跳过
> - 用户日志中的 `#063 | batch | 200 | in:- out:-` 就是这条路径：上游返回 200 + 空 JSON body，proxy 原样透传
> - 之前的 detector 对非流式响应**完全无感知**
> - 修复：新增 `detectEmptyJsonAndConvert()`，对 200 + JSON 响应逐项检查：
>   - 空体 / 纯空白 / `{}` / `null` / `[]` / 非对象 → 转 529
>   - 畸形 JSON（被网关中途截断）→ 转 529
>   - 缺 `content` / `choices` / `output` / `usage` 全部字段 → 转 529
>   - 已含 `error` 字段 → 不转（让原有 error passthrough 处理）
>   - 看起来是合法响应（有 `content`+`usage` / `choices` / `output` 等）→ 不转，原样透传
>
> **修复后行为**
> - 所有空 200（SSE 或 JSON）都打上 `x-zcode-empty-stream: 1` 标记并转换为合成 529
> - 复用 `handler.ts` 既有的"3 次重试后切换凭证"逻辑（默认 `emptyStreamSwitchThreshold=3`）
> - 新增 19 个回归测试 + 3 个端到端集成测试，覆盖：SSE 空白流 / batch 空体 / batch `{}` 三种实际场景
>
> 升级建议：**所有用户强烈建议升级**。空 200 是上游额度耗尽最常见的特征，旧版本完全无法应对，会导致客户端报错且账号切换逻辑形同虚设。

---

> **vceshi0.0.8 — 移动端全面适配 + 逻辑 Bug 修复 + 性能优化（重新发布）**
>
> 本次 vceshi0.0.8 重新发布，叠加 vceshi0.0.7 re-release 之后的全部累积改动。无 CLI 命令变化，无需重新生成 start.bat / start.sh。全套 473/473 测试通过。
>
> **1. 移动端（<768px）全面适配**
> - **汉堡菜单 + 抽屉式侧边栏**：原 900px 以下侧边栏塌缩为 60px 图标条，浪费手机屏幕；现在改为 off-canvas 抽屉，所有页头注入汉堡按钮，点击展开 + 半透明遮罩 + ESC 关闭 + 切页自动关闭 + 视口变大自动关闭
> - **表格**：账号表 9 列在手机上保持可读 — 首列（名称）粘性，横向滚动时不丢；移动端取消 sticky-top 表头；scrollbar 变细
> - **按钮组**：`.td-actions` 中 6+ 按钮在移动端换行，避免挤一行；`.action-bar` 按钮全宽折行
> - **账号页搜索 + 筛选**：在移动端垂直堆叠（原来和 card-title 挤一行）
> - **Modal**：所有 modal `max-width:94vw`、`form-row` 强制单列、footer 按钮全宽折行；inline-styled 的 proxyModal / quotaModal 同样覆盖
> - **Toast**：移动端 `left/right` 各留 12px，全宽显示，原 `max-width:480px` 在 360px 屏会溢出
> - **kv-grid**：移动端 label 在上、value 在下，原来 140px label 列在窄屏太挤
> - **stats-grid**：360px 以下进一步塌缩为 1 列
> - **触摸目标**：表单输入框 focus 时字号升到 16px，避免 iOS Safari 自动缩放
> - **mini-stat / hero-card / login-box / log-box**：移动端 padding 与字号统一收紧
> - **Tab 栏**：移动端隐藏图标、缩小 padding、横向滚动
>
> **2. 逻辑 Bug 修复**
> - **`loadSettings` 端口 0 误判**：用 `||` 取端口，配置为 0（OS 随机端口）时被误判为 falsy 覆盖成 8080。改为 `??`（nullish coalescing），同样修复了 `cfgHost`
> - **`statsIntervalId` 启动时机错误**：原代码在脚本加载时即启动 10s 轮询，未登录前 timer 永远空转浪费电量（移动端后台 tab 尤甚）。抽出 `startStatsInterval()`，改为登录成功后 `initDashboard()` 内调用
> - **切换页面不重置滚动**：新页面继承旧页面的滚动位置（如从长账号列表切到概览会停在底部，看似空白）。nav click handler 内 `main.scrollTop=0`
>
> **3. 排版优化**
> - Hero card 小屏改垂直堆叠 + 缩小图标
> - Hint banner、empty-state 在移动端 padding 收紧
> - OAuth URL 显示框在移动端按钮换行
>
> **4. 历史遗留修复（已并入本版本）**
> - **`appendLog` 死循环（vceshi0.0.7 引入的回归）**：原 `while (logWaiters.length > 0) { shift().resolve() }` 因 waiter 的 resolve 同步 re-push 自己导致 while 永真，事件循环被永久阻塞。已改为 `for (const w of logWaiters) w.resolve(entry)`，每个 SSE 连接持有长期 waiter，连接关闭时由 `cancel()` 移除。新增回归测试覆盖。
>
> 升级建议：所有 vceshi0.0.7 用户建议升级。如果主要在移动端使用管理面板，强烈推荐升级。

---

> **vceshi0.0.7（re-release）— 追加管理面板 UI 排版系统优化**
>
> 本次 re-release 在原 vceshi0.0.7 逻辑修复基础上，追加 UI/排版层的系统优化。无 CLI 命令变化，无需重新生成 start.bat / start.sh。
> 全套 473/473 测试通过。
>
> **1. 严重 CSS Bug 修复（功能性）**
> - **`.login-error` 上边距失效**：`margin-top:-var(--s-2)` 是无效 CSS 语法（`-var()` 不合法，浏览器静默忽略），登录错误提示与输入框贴在一起。改为 `calc(var(--s-2) * -1)`。
> - **`.action-bar` 上下边距失效**：`margin:var(--s-4) -var(--s-5) -var(--s-5)` 同样的 BUG，导致设置页底部 sticky action bar 上下挤在一起。改为 `calc()` 形式并修正横向负值与 `.main-content` padding 对齐。
> - **`#quotaModal` 残留 `backdrop-filter:blur(2px)`**：上一轮只改了 `.modal-overlay` 和 `#proxyModal`，遗漏了 quotaModal，点击"额度"按钮首次打开时仍有 GPU 开销抖动。移除。
>
> **2. 移动端布局 Bug 修复**
> - **8 个页面 header 移动端溢出**：所有页面 header 都用同一个内联 `style="margin:-24px -32px 24px"`，硬编码了桌面端的 32px padding。在 ≤900px 屏幕上 `.main-content` padding 缩到 20px，但负 margin 仍是 -32px → header 两边各突出 12px，看起来像被剪了一截。抽出 `.page > .main-header` CSS 类，并在 900px / 600px 两个媒体查询里分别覆盖正确的负 margin。
> - **设置页 sticky action bar 同样的硬编码问题**：抽出 `.action-bar` 类并加响应式规则。
>
> **3. 内联 style 去重（约 30+ 处）**
> - 4 个账号统计 mini-stat 卡片：抽出 `.mini-stat` / `.mini-stat-label` / `.mini-stat-value` 类
> - 3 个账号页过滤器控件（搜索框 + 2 个下拉）：抽出 `.filter-input` / `.filter-select` 类，附带统一下拉箭头图标
> - 5+ 处重复的 `<p style="font-size:12px;color:var(--text-2);...">` 段落：抽出 `.text-help-sm` 工具类
>
> **4. UX 内容优化**
> - 移除账号管理页副标题里冗余的"刷新"文字链接（header 右上角已有图标+文字按钮）
> - "已存储账号"卡片下方的密集说明段落改为 `.hint` 信息横幅，视觉层级更清晰
> - "备份与恢复"卡片里手写的假提示框（`<p>` + 内联 `border-left`）改为真正的 `.hint` 横幅，统一所有提示信息的视觉语言
>
> ---

> **vceshi0.0.7 — 管理面板逻辑 Bug 全面修复 + 性能优化**
>
> 对管理面板进行了系统性审计，修复 5 个严重 Bug + 7 个高优先级 Bug + 6 个中优先级优化。
> 新增 12 个回归测试，全套 472/472 通过。本版本无 CLI 命令变化，无需重新生成 start.bat / start.sh。
>
> **1. 严重 Bug 修复（Critical）**
> - **凭证详情弹窗 XSS / 显示按钮失效**：`toggleSecret` 内联 `onclick` 把 `escapeHtml` 转义后的 `'`（`&#39;`）放回 JS 字符串，HTML 解码后破坏 JS 语法。含 `'` 的 API Key/JWT 无法显示，且可被恶意凭证注入 JS。改为 `data-secret` 属性 + 事件委托。
> - **清空凭证未清内存**：`DELETE /admin/api/credentials` 只删磁盘文件，内存 `oauthCred` 仍存活，运行中的请求继续用已删除凭证。新增 `AuthManager.clearOAuthCredential()`，清空时同步热清除内存。
> - **OAuth 过期状态未处理**：后端 `oauth/poll` 在流程过期时返回 `{status:"expired"}`，前端 `pollOAuth` 不处理这个状态，导致用户授权超时后界面空转 4 分钟无提示。
> - **OAuth 旧轮询循环未取消**：用户重新点击"开始登录"启动新流程时，旧 `pollOAuth` 循环仍后台运行，两个循环同时更新 UI 造成状态闪烁。新增 `oauthPollCancelled` 标志，新流程启动时通知旧循环退出。
> - **日志 SSE 虚假推送**：`waiter.resolve` 是 noop，实际靠 500ms 永久轮询投递。10 个 Dashboard 标签页 = 每秒 4 万次字符串比较。改为真正推送 + 2s 安全网轮询。
>
> **2. 高优先级 Bug 修复（High）**
> - **setInterval 内存泄漏**：`loadOverview` 与 `setInterval(loadStats,10000)` 未保存 handle，退出登录后定时器继续触发，闭包无法 GC。新增 `uptimeIntervalId` / `statsIntervalId`，`doLogout` 中清理。
> - **`submitCallback` 不刷新账号列表**：粘贴回调 URL 完成授权后，新账号不出现在多账号管理表格，需手动刷新页面。补加 `loadAccountsList()`。
> - **`renameAccount` / `changePlan` 不刷新账号列表**：内联编辑成功后列表不更新；失败时下拉框停留在用户选择值，不回退到持久化值。成功/失败均刷新列表。
> - **`/admin/api/endpoints` 缺 URL 校验**：直接 `Object.assign`，缺 `https://` 等错误格式被静默接受，所有后续请求 404。新增 URL 协议校验 + 拒绝未知字段。
> - **`/admin/api/oauth/init` 缺 provider 校验**：未校验 `as "zai" | "bigmodel"` 强制转换，未知 provider 深入到 OAuth 客户端构造函数才崩。新增 400 校验。
> - **`loadStats` 页面可见性检测错误**：用 `style.display !== 'none'` 判断页面是否可见，但页面切换是通过 `.active` 类实现的，判断永远为 true，导致非账号页时也疯狂 `filterAccounts()`。改为 `classList.contains('active')`。
> - **重复 stats 轮询**：`loadUptimeFromServer` (1s) 与 `loadStats` (10s) 同时 fetch 同一端点。uptime 间隔改为 2s 并复用响应中的 `byCredential` 缓存，减少冗余请求。
>
> **3. 中优先级优化（Medium）**
> - **`recordStat` trim 后重试重复计数**：`stats.requests` 满 200 trim 到 100，被裁掉的 id 重试到达时被误判为新请求，total +1。新增 `seenIds` 生命周期 Set（上限 5000），即使被裁也能识别。
> - **`byCredential` 重试成功漏补加**：失败 → 成功的状态翻转时，`byCredential` 计数未补加，凭证使用次数少计。更新路径检测 `!wasSuccess && isSuccess` 时补加。
> - **`stats.models` Map 无上限**：客户端发各种自定义模型名（经 mappings 映射），Map 无限增长。上限 100 个，超出聚合到 `_other`。
> - **`appendLog` 截断依赖脆弱子串**：`message.includes("[verbose]")` 判断 verbose 日志，但任何偶然包含该子串的日志都会绕过截断。改为 `level === "debug" || message.includes("[verbose]")`。
> - **`/admin/api/accounts/quota` 缺速率限制**：上游计费查询非免费，疯狂点击会耗尽 JWT 或触发 IP 限流。新增 15s 缓存，命中返回 `cached: true`。
> - **错误响应格式不一致**：前端 `addApiKey` / `importKey` / `renameAccount` 等只读 `d.error`，丢失真实错误信息。统一 `d.error?.message || d.error || '默认'` 兜底。
>
> **4. 测试覆盖**
> - 新增 12 个回归测试覆盖上述修复（post-trim dedup、models cap、byCredential re-classification、oauth/init validation、endpoints URL validation、clearCredentials 热清除、quota id 校验等）。
> - 全套 472/472 通过，TypeScript 零错误。

> **vceshi0.0.6 — 输入 token 计数 + 详细日志模式 + 凭证禁用/启用 + 使用次数**
>
> 用户反馈 4 项需求全部实现：统计页只看到输出 token、日志不够详细、凭证无法禁用、看不到凭证使用次数。
>
> **1. 统计页新增「输入 Tokens」列**
> - 之前：只记录输出 token（completion_tokens / output_tokens），输入 token 完全没记录。
> - 现在：`recordStat` + `printRow` + `observeStream` 全链路增加 `inputTokens` 字段。从上游响应的 `usage.input_tokens` / `usage.prompt_tokens` / `usage.input_tokens`（Responses API）/ `message_delta.usage.input_tokens`（Anthropic SSE）解析。
> - dashboard「近期请求」表头从 `Tokens` 拆为 `输入` + `输出` 两列；「模型使用情况」表头从 `总 Tokens` 拆为 `输入 Tokens` + `输出 Tokens`。
> - 控制台日志格式也改为 `in:N out:M`。
>
> **2. 详细日志模式（简略/详细开关）**
> - 之前：正常请求完全不记录请求头和转换后 body（只在 4xx 时记录摘要）。
> - 现在：dashboard「日志配置」标签页新增「详细日志模式」开关。开启后每个请求在日志里输出：
>   - `[verbose] upstream headers: {完整请求头 JSON，auth token 已脱敏}`
>   - `[verbose] transformed body: {经项目转换后发送给 zai/bigmodel 的完整 body，截断到 2000 字符}`
> - verbose 日志行放宽到 3000 字符上限（普通日志仍 500 字符），避免 body 被截断。
> - 配置：YAML `logging.verbose: true`，环境变量 `ZCODE_PROXY_VERBOSE_LOGGING=1`，dashboard 可热切换。
> - 排查 3001 / 参数错误时建议开启。
>
> **3. 凭证禁用/启用按钮**
> - 之前：凭证只能删除，不能临时停用。
> - 现在：`Credential` 接口新增 `disabled?: boolean` 字段。dashboard 账号表每行新增「禁用/启用」按钮（橙色/绿色）。
> - 禁用后：
>   - `switchToNextCredential` 跳过此凭证（不会被自动切换选中）
>   - `switchAccount` 拒绝激活此凭证（服务端强制，dashboard 也隐藏「激活」按钮）
>   - 状态列显示「已禁用」红色徽章
>   - 名称/套餐输入框半透明显示
> - 禁用当前激活的凭证时会弹确认框（仍处理进行中请求，但不会被自动切换选中）。
> - 新端点：`PUT /admin/api/accounts/disabled` body `{id, disabled: boolean}`。
>
> **4. 凭证使用次数显示**
> - 之前：凭证没有使用统计。
> - 现在：`stats` 对象新增 `byCredential` 内存映射，key = `maskApiKey(apiKey)`，value = `{count, inputTokens, outputTokens, lastUsed}`。
> - 只统计成功请求（2xx）—— 失败请求不消耗凭证配额。
> - dashboard 账号表新增「使用」列，显示该凭证的成功请求次数，hover 显示输入/输出 token 明细。
> - 每 10 秒随 `loadStats` 自动刷新（无需手动刷新账号列表）。
> - 内存统计，重启清零（与现有 stats 一致）。
>
> 全套 460 测试通过（vceshi0.0.5 是 452），TypeScript 类型检查零错误。
>
> ---

> **vceshi0.0.5 — 全面 bug 修复（dashboard 模态框/CRITICAL 凭据切换/配置深合并/校验补全）**
>
> 对 dashboard、admin API、handler、store 进行全面审查后修复 22 个 bug，包括 4 个 CRITICAL、6 个 P1、12 个 P2。所有修复都有回归测试覆盖（452 测试通过，TypeScript 零错误）。
>
> **CRITICAL 修复：**
>
> **C1. dashboard 账号详情/编辑模态框无法显示（CSS 完全缺失）**
> - 现象：点「查看」「编辑」按钮看起来什么都没发生（实际 HTML 被追加到页面底部，需滚动才能看到）
> - 根因：`openAccountDetail` / `openEditModal` 用 `class="modal-overlay"` 等类名，但 CSS 里完全没定义这些类
> - 修复：在 `:root` 后添加完整 `.modal-overlay` / `.modal` / `.modal-header` / `.modal-body` / `.modal-footer` / `.modal-close` CSS（带 fadeIn 动画、遮罩、居中、暗色背景）
>
> **C2. empty-stream 凭据切换 off-by-one（默认配置永不触发）**
> - 现象：用户配置 `maxRetries=3, emptyStreamSwitchThreshold=3`，初始响应非空 529 时，切换永远不会触发（计数器在最后一次 retry 末尾才到 3，但 break 先触发）
> - 修复：在 retry loop 末尾、break 之前加切换检查。达到阈值且有备用凭据时，授予 1 个 extra attempt 并 `continue`，让新凭据真正被尝试
>
> **C3. 凭据切换后不同步 plan（跨 plan 切换必失败）**
> - 现象：从 coding-plan 凭据切到 start-plan 凭据时，请求仍发到 coding-plan endpoint 但带 start-plan JWT → 上游 401/403
> - 修复：引入 `currentPlan` 变量，切换后调用 `effectivePlanForCred(newCred)` 更新；所有 `config.plan` 引用（buildUpstreamReq / refreshCaptchaHeaders / 401/403 检测 / transformRequestBodyObj）改为读 `currentPlan`
>
> **C4. PUT /config 浅合并 retry 对象（部分更新导致 TypeError 崩溃）**
> - 现象：客户端发 `{"retry":{"maxRetries":5}}` 会让 `retryableStatuses` 等字段丢失，handler.ts 抛 `TypeError: Cannot read property 'includes' of undefined`
> - 修复：对 `retry` / `identity` / `logging` / `providers` 都做深合并（之前只 `auth` 做了）
>
> **P1 修复：**
>
> - **statTotal ID 重复**：账号页「账号总数」卡片 10 秒后被统计页「总请求数」覆盖。改账号页 ID 为 `statAccountsTotal`
> - **btn-warning CSS 未定义**：「导出 Render 凭证」按钮无警告色。加 `.btn-warning` 别名
> - **clearCredentials 不检查 r.ok**：服务端返回 4xx 时仍显示「凭证已清空」成功提示。改为检查 `r.ok`
> - **loadDebugDumps upstreamError.slice 空值崩溃**：`upstreamError` 为 undefined 时 `.slice()` 抛 TypeError，整个 dumps 列表渲染失败。加 `||''` 保护
> - **/admin/api/endpoints 不持久化**：修改 endpoints 重启即丢失。加 `persistConfig` 调用
> - **POST /admin/api/credentials 缺热替换+校验**：手动添加 API Key 在 oauth 模式下不立即生效；空 apiKey / 未知 provider 写入脏数据。加字段校验 + invalidateStoreCache + setOAuthCredential 热替换
> - **POST /admin/api/import 缺热替换**：从 ZCode 导入在 oauth 模式下不立即生效。加热替换 + name 自动命名为 `zcode(N)-plan`
> - **bigmodel 手动 callback 缺 state 校验**：CSRF 防御不一致（zai 有 bigmodel 无）。补齐 `state !== flow.state` 校验
> - **/admin/api/oauth/poll 不检查过期**：过期 flow 永远返回 "pending"，dashboard 永远转圈。加过期检查返回 `"expired"` 状态；失败时返回 `error` 字段
>
> **P2 修复：**
>
> - 未定义 CSS 变量 `--bg-1/--bg-2/--text-1/--text-0/--warning/--warning-bg` 全部添加别名映射
> - Escape 键现在能关闭账号详情/编辑模态框（之前只关 proxy/quota 模态框）
> - `loadUptimeFromServer` 登出后停止请求（之前每秒发 401）
> - `openAccountDetail` 的 API Key 行在 `cred.apiKey` 为空时不再显示 `[object Object]`
> - `validateConfigForSave` 增加 `emptyStreamSwitchThreshold`（>=0）和 `backoffFactor`（>0）校验
> - `PUT /admin/api/accounts/edit` 增加 name/email 类型校验（防非字符串值崩溃 setAccountName 的 .trim()）
> - `GET /admin/api/accounts/export-single` 加 `invalidateStoreCache`（外部新增账号立即可见）
> - `undecryptableFilePresent` 守卫在解密成功 / 文件不存在时自动清除（之前用户用 LEGACY_SEED 恢复后能读不能写，被锁死）
>
> 全套 452 测试通过（vceshi0.0.4 是 445），TypeScript 类型检查零错误。
>
> ---

> **vceshi0.0.4 — 空回阈值可配置 + 凭证名称/邮箱 + 单账号导出（测试版）**
>
> 用户反馈：3 次空回切换凭证的阈值应该可配置；凭证 JSON 格式应该有 name + email；账号管理 UI 应该可以查看/编辑/导出单账号。本版全部实现。
>
> **1. 空回切换阈值可在面板配置**
> - 之前：硬编码 3 次，用户无法调整。
> - 现在：dashboard「重试配置」标签页新增「空回切换阈值」输入框（默认 3，设为 0 禁用回退到普通凭证切换阈值）。YAML 配置 `retry.emptyStreamSwitchThreshold`，环境变量 `ZCODE_RETRY_EMPTY_STREAM_SWITCH_THRESHOLD`。
>
> **2. 凭证 JSON 格式增加 name + email 字段**
> - OAuth 登录：自动从回调响应的 `data.user.email` 提取邮箱，名称自动命名为 `邮箱-套餐`（如 `alice@x.com-start-plan`）。
> - ZCode 导入：邮箱为空，名称自动命名为 `zcode(N)-套餐`（N = 当前已导入的 zcode 账号数 + 1，如 `zcode(1)-coding-plan`）。
> - 手动添加 API Key：name 和 email 都为空，dashboard 显示自动生成的标签作 fallback。
> - dashboard「账号管理」表头从「标签」改为「名称」，按凭证创建时间正序排（最旧的排最前），无 name 时回退到自动 label。
>
> **3. 账号管理每行新增 查看/编辑/导出 按钮**
> - **查看**：模态框显示完整凭证信息（含 API Key/Secret/JWT 的「显示/隐藏」切换）。
> - **编辑**：模态框可改 name + email（保存即生效，热替换内存凭证）。
> - **导出**：浏览器下载该账号的完整 JSON 凭证文件，文件名 = 名称或标签，含完整 apiKey/secret/jwt/email/name — 可用于备份或迁移到其他机器。
>
> **4. 新增环境变量**
> - `ZCODE_RETRY_EMPTY_STREAM_SWITCH_THRESHOLD` — 空回切换阈值，默认 3
>
> 全套 445 测试通过（vceshi0.0.3 是 430），TypeScript 类型检查零错误。
>
> ---

> **vceshi0.0.3 — 凭证加密根因修复 + 空回重试 + Dashboard 优化（测试版）**
>
> 一次性修复 vceshi0.0.2 暴露的 6 个用户痛点 + UI 优化。所有改动都有回归测试覆盖（430 测试通过，TypeScript 类型检查零错误）。
>
> **0. 加密解密根因修复（最关键 — 解决"版本更新后凭证丢失"的根本原因）**
>
> - **现象**：用户报告「同一个 zip 解压两次能用，但新版本 release 解压后凭证全没」。只能提前导出账号再更新。
> - **根因深挖**（不是简单的"加密失败"）：
>   - 旧版密钥派生用 `SHA-256(${homedir()}-${process.platform}-${process.arch})`
>   - 旧 release 用 Bun 1.1 编译 → `os.homedir()` 在 Windows 直接读 `USERPROFILE` 环境变量
>   - 新 release（GitHub Actions）用 Bun 1.3.14 编译 → `os.homedir()` 改用 Win32 API `SHGetKnownFolderPath`，返回值可能在大小写、路径规范化、域用户后缀（`Alice` vs `Alice.Company`）等方面不同
>   - git 历史可证：`4ca5f0e` "fix(docker): upgrade bun base image to 1.2" + `ffe3075` "add GitHub Actions build" — Bun 1.1 → 1.2 → 1.3 的升级链改变了 `homedir()` 行为
>   - 结果：旧 `credentials.json` 用 X 加密，新二进制算出 Y，解密失败 → 旧版"备份+返回 null"逻辑让 `saveCredential` 静默覆盖原文件 → 凭证全没
> - **修复（三层防御）**：
>   1. **持久化 key file**（`~/.zcode-proxy/.secret-key`）：首次运行时把派生出的 key 写入文件，之后所有运行都直接读文件，**不再依赖 `homedir()`/`platform`/`arch`** — 这些变量再怎么变都不影响。Bun 升级、Windows 用户名改、跨位数编译全部免疫。
>   2. **多 seed fallback**：解密失败时自动尝试所有合理的旧 seed 组合：
>      - `${homedir()}-${plat}-${arch}` / `${homedir()}-${plat}` / `${homedir()}-${arch}` / `${homedir()}`
>      - `${USERPROFILE}-*` / `${HOMEDRIVE}${HOMEPATH}-*` / `${HOME}-*`（旧 Bun 直接用这些 env var）
>      - 每种 seed 都试 SHA-256 派生 + XOR-fold 派生（覆盖 zcode-api-ref 旧格式）
>      - 每种 key 都试 Node crypto 格式（IV[16]）+ WebCrypto 格式（IV[12]）
>      - 任意一个组合成功 → 解密成功 + 把命中的 key 写入 key file，下次免 fallback
>   3. **手动恢复通道**：`ZCODE_PROXY_LEGACY_SEED` 环境变量让用户显式提供旧 seed 字符串（例如 `set ZCODE_PROXY_LEGACY_SEED=C:\Users\OldName-win32-x64`），多 seed fallback 会尝试它
> - **效果**：用户更新到 vceshi0.0.3 后：
>   - 首次启动 → 多 seed fallback 自动找到旧 key → 解密成功 → key 持久化到 key file
>   - 之后所有运行 → 直接读 key file → 再也不依赖 homedir/platform/arch → 任何版本更新都不再丢凭证
> - **极端情况兜底**：如果所有 fallback 都失败（如 credentials.json 从完全不同的机器拷过来），上一版的"拒绝覆盖"守卫仍生效——不会静默销毁原文件，用户可手动恢复或显式 `auth logout` 重来
>
> **1. 版本更新后凭证丢失（严重数据丢失 bug）**
> - **现象**：下载新 release 解压后启动 exe，提示「没有凭证」无法进入；回到 `~/.zcode-proxy/` 发现 `credentials.json` 被清空。
> - **根因**：上面 #0 详解。
> - **修复**：
>   - 上面 #0 的三层防御从源头解决
>   - 额外兜底：`src/auth/store.ts` 新增 `undecryptableFilePresent` 守卫标志。一旦读到无法解密的 `credentials.json`，`writeStore()` 会**抛错拒绝覆盖**，强制 `saveCredential` 把错误冒泡给调用方。原文件保持不变，`.broken-{timestamp}` 备份也保留。
>   - 用户必须显式执行 `zcode-proxy auth logout`（或 dashboard 的「清空凭证」按钮）才会清除守卫，之后才能保存新凭证——避免任何意外的数据销毁。
>   - `clearCredential()` 同时清除守卫标志 + 删除 key file，确保登出后能正常重新登录。
>
> **2. Dashboard 刷新看不到外部新增凭证**
> - **现象**：通过 `start.bat` 获取新凭证后，刷新 dashboard 看不到，必须重启程序。
> - **根因**：`store.ts` 的 `cachedStore` 是进程内缓存，`writeStore` 才失效。外部进程（start.bat 调起的 `zcode-proxy auth login`）写入磁盘后，长期运行的代理进程的缓存仍是旧快照。
> - **修复**：导出 `invalidateStoreCache()`，在 `/admin/api/accounts` 和 `/admin/api/credentials` 的 GET handler 中调用——dashboard 每次刷新都强制重新读盘+解密，外部进程的新增凭证立即可见。
>
> **3. 200 空回被识别为有效输出（额度耗尽时的核心 bug）**
> - **现象**：某账号额度耗尽时上游返回 HTTP 200 + `text/event-stream` 但 body 为空（无任何 SSE 事件）。代理透传给客户端，Claude Code / Codex CLI 报「empty or malformed response (HTTP 200)」，但 dashboard 统计显示成功。
> - **修复**：`src/proxy/sse-error-detector.ts` 增加 empty-stream 检测——如果 200 SSE 流读到结束都没出现任何完整 SSE 事件（`\n\n` 分隔的块），合成一个 529 `overloaded_error` 响应，并打上 `x-zcode-empty-stream: 1` 标记头。
>
> **4. 空回 3 次后自动切换凭证**
> - **现象**：用户期望「200 空回 → 重试 3 次 → 仍空回就切换下一个凭证」，但旧逻辑只在 5 次普通失败后才切换，对空回这种「凭证已死」的强信号反应太慢。
> - **修复**：`src/proxy/handler.ts` 新增 `consecutiveEmptyStreams` 计数器（与现有 `consecutiveCredFailures` 独立）。检测到 `x-zcode-empty-stream: 1` 标记就累加；达到 3 次立即调用 `auth.switchToNextCredential()`，**不等** `credentialSwitchThreshold=5`。切换时额外授予 1 次 retry 配额（`extraAttemptsFromSwitches`），确保新凭证至少有 1 次尝试机会。切换后计数器重置，新凭证走完整的 3 次空回阈值才会再次切换。
> - 日志清晰显示每次空回与切换：「`retry 2 got empty-stream 529 (3/3 before forced switch)`」「`credential switched after 3 consecutive empty-stream responses`」。
>
> **5. OAuth 新凭证默认启用，覆盖原选择**
> - **现象**：dashboard 走 OAuth 登录新账号后，新账号立即变成 active，原激活账号被静默替换——用户没点「激活」却发生切换。
> - **根因**：`saveCredential` 总是把新账号设为 active（`store.activeId = account.id`），无论调用方是否期望保持原选择。
> - **修复**：`saveCredential` 增加可选参数 `opts.keepActive`。当 `keepActive: true` 且已存在 active 账号时，新账号**仅追加**到列表，不动 `activeId`。`src/admin/api.ts` 中 4 处 OAuth 完成点（bigmodel 自动回调、zai 自动轮询、zai 手动 callback、bigmodel 手动 callback）全部传入 `{ keepActive: true }`。只有「首次登录」（store 为空）才会自动激活。用户必须显式点 dashboard 的「激活」按钮才会切换。
>
> **6. bigmodel 手动 callback 缺热替换（一致性 bug）**
> - **现象**：bigmodel 手动 callback 路径在 OAuth 完成后没有调用 `opts.auth.setOAuthCredential()`，与其他 3 处 OAuth 完成点不一致——用户在远程环境用手动 callback 登录后，运行中的代理仍用旧凭证，直到重启才生效。
> - **修复**：补齐热替换调用，与其他 3 处对齐。同时所有 OAuth 完成点统一行为：**只在首次登录（store 为空）时热替换**，否则保留当前激活——与 `keepActive` 语义一致。
>
> **7. UI 优化：账号管理排版重构**
> - 新增 4 卡片统计栏：账号总数 / Bigmodel / Z.AI / Start Plan 数量一目了然。
> - 表头增加搜索框 + 提供商/套餐过滤器：实时过滤，无网络请求。
> - 右上角「刷新」按钮：强制重新读盘，外部新增凭证立即可见（与 Bug #2 修复配合）。
> - 标题栏副标题增加可点击「刷新」链接。
> - 账号数量徽标动态显示（如「3 个」）。
> - 空状态分两种：完全无账号 vs 过滤无匹配，引导更清晰。
> - 「添加 API Key」表单帮助文案明确说明：手动添加会自动激活，OAuth 不会——与 Bug #5 行为一致。
>
> 全套 430 测试通过（vceshi0.0.2 是 422），TypeScript 类型检查零错误。
>
> ---

> **vceshi0.0.2 — 凭证额度查询功能（测试版）**
>
> 新增「额度查询」：dashboard 账号表格每个账号的「操作」列新增「额度」按钮，点击后实时查询上游真实额度并弹窗展示。
>
> **功能内容**：
> - start-plan 账号：查询 zcode.z.ai 的套餐（`billing/current`）+ 余额（`billing/balance`），显示套餐名、到期时间、每个模型（如 GLM-5.2 / GLM-5-Turbo）的剩余 token 与每日重置时间
> - coding-plan 账号：查询提供商（api.z.ai / open.bigmodel.cn）的额度上限（`/api/monitor/usage/quota/limit`），显示套餐等级与各项额度明细
> - 额度接口逆向自 ZCode 客户端，每个模型额度独立展示（不混算成单一百分比，避免「某模型已用完但整体显示 40%」的误导）
> - 支持为配了出口代理的账号查询（复用该账号的 proxy 配置）
> - 新增 10 个单元测试，全套 422 测试通过，TypeScript 类型检查零错误
>
> 全套 422 测试通过，TypeScript 类型检查零错误。
>
> ---

> **vceshi0.0.1 — OAuth 凭证切换失效修复（测试版）**
>
> 修复 dashboard 通过 OAuth 登录的账号在切换后立即失效的问题。原现象：OAuth 账号切换后 Claude Code 报 `API returned an empty or malformed response (HTTP 200)`，但从 ZCode 桌面版导入的账号切换后正常工作。
>
> **根因（两个 bug 叠加）**：
> 1. **OAuth 登录完成后未热替换内存凭证**：`/admin/api/oauth/*` 三处完成点（bigmodel 自动回调、zai 自动轮询、zai 手动回调 URL）都只调用 `saveCredential(cred)` 写入磁盘，**没有**调用 `opts.auth.setOAuthCredential(cred)` 热替换 `AuthManager` 内存中的凭证。结果：OAuth 登录后 dashboard 显示新账号为 active，但请求路径仍使用旧凭证（通常是之前 zcode 导入的）。只有用户显式点击「激活」切换时，`/admin/api/accounts/active` 的 handler 才会真正热替换 —— 此时 OAuth 凭证第一次被真正使用，立刻暴露 bug #2。
> 2. **start-plan 模式下注入了 `metadata.user_id`**：`src/proxy/body-transformer.ts` 的 `applyAnthropicUserId` 没有像 `applyAnthropicCacheControl` 那样为 start-plan 做特判。OAuth 登录的凭证带 `userId` 字段（zcode 导入的不带），所以只有 OAuth 账号会触发 `metadata.user_id` 注入。ZCode start-plan 网关收到该字段后返回 `200 + content-type: text/event-stream` 但 body 为空，被 `sse-error-detector.ts` 当作合法空流透传给客户端，Claude Code 报 "empty or malformed response"。
>
> **修复内容**：
> 1. `src/admin/api.ts` 三处 OAuth 完成点均补充 `opts.auth.setOAuthCredential(activeCred)` 热替换，与 `importAccounts` 路径行为对齐
> 2. `src/proxy/body-transformer.ts:150-158` 增加 `&& !ctx.startPlan` 守卫，start-plan 模式下不注入 `metadata.user_id`（与同文件 `applyAnthropicCacheControl` 的 start-plan 特判对称）
> 3. 新增 2 个回归测试用例（start-plan 不注入 / coding-plan 仍注入），更新 1 个原有断言
>
> **影响范围**：
> - **所有 OAuth 登录用户**：切换账号后立即生效，无需重启
> - **start-plan + OAuth 用户**：不再出现 "HTTP 200 empty response" 错误
> - **coding-plan 用户**：行为不变（仍注入 `metadata.user_id`）
> - **zcode 导入用户**：行为不变（本来就没有 `userId`，本来就不注入）
>
> 全套 409 测试通过，TypeScript 类型检查零错误。
>
> ---

> **v2.1.4.1test6 — 代理配置 UI 升级：模态框 + 测试连接**
>
> 重做 v2.1.4.1test5 引入的代理配置入口：移除账号表格里的内联输入框（输入 URL 字符串体验差、容易输错），改为操作列的「代理」按钮 + 弹出式模态框，支持代理类型选择、主机/端口/账号/密码分字段填写、一键测试连通性。
>
> **v2.1.4.1test6 关键改进**：
> 1. **Dashboard UI 重做**：
>    - 移除账号表格的「代理」列，恢复 colspan 到 7
>    - 操作列新增「代理」按钮（btn-ghost 风格，与「激活」「删除」并列）
>    - 已配置代理的账号在 API Key 列显示「代理」徽标（hover 显示完整 URL）
>    - 点击「代理」按钮打开模态框，预填该账号当前代理设置
> 2. **代理模态框**：
>    - 代理类型下拉：无代理 / HTTP / HTTPS / SOCKS5 / SOCKS5h（远端 DNS）
>    - 主机（必填）、端口、用户名、密码分字段输入，免去手拼 URL
>    - 用户名密码 URL 编码自动处理（含 `@`、`:`、`/` 等特殊字符）
>    - 选「无代理」时所有字段禁用 + 清空，方便一键恢复直连
>    - 「测试连接」按钮：调用后端 proxy-test 端点，实时显示结果（成功显示 HTTP 状态码 + 延迟，失败显示错误信息）
>    - Esc 键关闭模态框，点击遮罩关闭，× 按钮关闭
> 3. **新增 `POST /admin/api/accounts/proxy-test` 端点**：
>    - 接收 `{ proxy, provider? }`，用 Bun 原生 `fetch(url, { proxy })` 对上游 base URL 发 HEAD 请求
>    - 10s 超时，超时清晰提示「Connection timed out after 10s」
>    - 任何 HTTP 响应（200/404/403 等）都视为代理可达；只有网络层错误（拒绝连接、DNS 失败、代理鉴权失败等）才返回 `ok: false`
>    - 返回 `{ ok, status?, latencyMs, target, error? }`，永远 HTTP 200 让前端能渲染错误信息
>    - `provider` 字段决定测试目标：zai→`https://api.z.ai`，bigmodel→`https://open.bigmodel.cn`
> 4. **`AdminOptions` 新增 `fetchImpl` 字段**：让测试代码可注入 mock fetch，避免真实网络调用
> 5. **Add API Key 表单**：移除「出口代理」输入字段，改为提示「添加后可在账号列表中点击「代理」按钮配置」，统一代理配置入口
> 6. **新增 8 个回归测试**（共 407 测试通过）：
>    - proxy-test API 8 个：参数校验 / scheme 校验 / 成功 / bigmodel 切换 / 4xx 视为成功 / 网络错误 / 超时
> 7. **JS 工具函数**：`buildProxyUrlFromModal()` / `parseProxyUrl()` 实现字段 ↔ URL 双向转换；用户密码用 `encodeURIComponent` 处理
>
> **影响范围**：
> - **所有使用代理功能的用户**：从拼字符串改为分字段填写，体验大幅改善
> - **添加新 API Key 流程**：先添加 Key，再点「代理」按钮配置出口，两步分离更清晰
> - **后端兼容性**：v2.1.4.1test5 的 `PUT /admin/api/accounts/proxy` 端点完全不变，存储格式不变，凭证字段不变
>
> ---

> **v2.1.4.1test5 — 账号级出口代理（per-account HTTP proxy）**
>
> 新增**账号级出口代理**功能：在 dashboard 账号管理页面，可以为每个账号单独配置 HTTP / HTTPS / SOCKS5 出口代理，让不同账号走不同的网络出口（例如让 A 账号走日本节点、B 账号直连、C 账号走 SOCKS5）。代理在请求时动态读取，多账号 retry 切换凭证时新账号的代理会自动生效。
>
> **v2.1.4.1test5 关键改进**：
> 1. **`Credential` 接口新增 `proxy?: string` 字段**：可选字段，留空 = 直连；设置 = 所有上游请求走该代理
> 2. **`fetchUpstreamDetected` 动态注入代理**：在每次上游 fetch 时读取 `cred.proxy`，通过 Bun 原生 `fetch(url, { proxy })` 选项路由请求。**关键设计**：每次调用都重新读取 `cred.proxy`，所以 retry 时凭证自动切换（key-AAA → key-BBB）会立即应用新账号的代理设置，不会缓存旧代理
> 3. **`setAccountProxy(id, proxy)` 存储函数**：持久化代理设置到加密的 `credentials.json`；空字符串清除代理，回到直连
> 4. **`PUT /admin/api/accounts/proxy` 新 API 端点**：dashboard 编辑代理的后端，支持 scheme 校验（`http(s)://` / `socks5(h)://`），更新激活账号时自动热替换内存凭证（无需重启）
> 5. **`POST /admin/api/credentials` 接受 `proxy` 字段**：手动添加 API Key 时可直接指定代理
> 6. **Dashboard UI 增强**：
>    - 账号表格新增「代理」列，每行带独立输入框，失焦即保存
>    - 添加 API Key 表单新增「出口代理」可选输入
>    - 客户端轻量 scheme 校验 + 失败时回滚输入框
>    - 表格 `colspan` 同步从 7 调整为 8
> 7. **代理设置随凭证导出**：`exportAccounts` / `exportStore` / Render 凭证导出都会带上 `proxy` 字段，云端部署时各账号的代理配置完整保留
> 8. **新增 18 个回归测试**（共 399 测试通过）：
>    - `setAccountProxy` 存储层 5 个：持久化 / 清除 / 未知 ID / 字段保留 / listAccounts 暴露
>    - `accounts/proxy` API 9 个：参数校验 / scheme 校验 / 404 / 设置 / 清除 / 热替换 / socks5 / trim
>    - 代理路由 handler 4 个：proxy 传递 / 不传 / socks5 / decompress 共存
>
> **影响范围**：
> - **多账号 + 多网络出口用户**：可以为不同账号配置不同代理，灵活组合（如某账号被风控时切到代理出口）
> - **单账号用户**：留空代理字段，行为与 v2.1.4.1test4 完全一致
> - **retry 凭证切换**：从有代理的账号切到无代理账号会自动停止使用代理，反之亦然
>
> ---

> **v2.1.4.1test4 — Docker 部署修复（bun 1.2 lockfile 兼容）**
>
> 修复 v2.1.4.1test3 在 Render / Docker 部署时的构建失败问题：`bun.lock` 使用 Bun 1.2+ 引入的新 JSON 格式（`lockfileVersion: 1`），而 Dockerfile 的 base image 仍是 `oven/bun:1.1-debian`，Bun 1.1.45 无法解析该格式，导致 `bun install --frozen-lockfile` 在容器构建阶段报 `InvalidLockfileVersion` 错误。
>
> **v2.1.4.1test4 关键修复**：
> 1. **Dockerfile base image 升级**：`oven/bun:1.1-debian` → `oven/bun:1.2-debian`，匹配 `bun.lock` 的新 JSON lockfile 格式
> 2. **同步更新 Dockerfile 注释**：说明必须使用 Bun ≥ 1.2 的原因（lockfile 格式兼容性）
> 3. **零源代码变更**：本次发版仅修复部署链路，业务逻辑与 v2.1.4.1test3 完全一致
>
> **影响范围**：
> - **Render / Docker / Fly.io / Cloud Run 用户**：解决 `bun install` 构建失败问题，部署可正常完成
> - **本地直接运行（bun run）用户**：无影响
>
> ---

> **v2.1.4.1test3 — 多账号 Render 凭证导出修复**
>
> 修复 v2.1.4.1test2 引入的 Render 凭证导出 bug：多账号场景下，dashboard "导出 Render 凭证" 只导出当前激活的一个账号，导致用户在 Render 上只能用到一个账号，丢失了多账号轮转能力。
>
> **v2.1.4.1test3 关键修复**：
> 1. **`/admin/api/accounts/render-export` 多账号修复**：原实现调用 `loadCredential()` 只取激活凭证；新版改用新增的 `exportStore()` 获取完整 v2 store（含所有账号 + activeId 指针）
> 2. **智能格式自适应**：单账号时仍输出 bare credential base64（向后兼容旧 `render-start.sh`）；多账号时输出完整的 v2 store envelope（`{version:2, activeId, accounts:[...]}`）
> 3. **`render-start.sh` 自动识别两种格式**：解码 `ZCODE_OAUTH_CREDENTIAL` 后，检测顶层是否含 `version:2 + accounts` 数组——是则直接落盘为 `credentials.json`，否则按原逻辑包装为单账号 store
> 4. **Dashboard UI 增强**：导出弹窗标题新增「单账号 / 多账号 · N 个」徽标；安全提示在多账号模式下明确警告 blob 包含所有账号的明文凭证
> 5. **新增 `exportStore()` 工具函数**：返回 v2 store 的深拷贝（含 activeId），供后端导出接口使用
> 6. **新增 3 个回归测试**：覆盖 0 账号（404）/ 1 账号（bare credential）/ 2 账号（v2 envelope）三种场景，确保两个 API key 都出现在 base64 blob 中
> 7. **测试覆盖**：全套 381 测试通过（v2.1.4.1test2 是 378），TypeScript 类型检查零错误
>
> **影响范围**：
> - **单账号用户**：无感知，行为与 v2.1.4.1test2 完全一致
> - **多账号用户**：现在能完整部署所有账号到 Render，dashboard 切换功能在云端可用
>
> ---

> **v2.1.4.1test2 — Render 云部署支持 + dashboard 一键导出环境变量**
>
> 新增 Render / Fly.io / K8s 等云平台一键部署能力，dashboard 增加导出环境变量格式的凭证。
>
> **v2.1.4.1test2 关键改进**：
> 1. **Render Blueprint 一键部署**：新增 `render.yaml` Blueprint 配置文件，连接 GitHub 仓库即可一键部署到 Render，无需手动配置 Docker
> 2. **Dockerfile 支持**：基于 `oven/bun:1.1-debian` 镜像，内置 `/healthz` 健康检查，适配 Render / Fly.io / Cloud Run / K8s 等所有支持 Docker 的云平台
> 3. **render-start.sh 智能启动脚本**：自动映射 Render 的 `$PORT` → `ZCODE_PROXY_PORT`；自动探测 `/data` 可写性，不可写时降级到 `/tmp/zcode-proxy`；自动从 `config.example.yaml` 种子化 `config.yaml`
> 4. **`/healthz` 健康检查端点**：新增 K8s 约定的 `/healthz` 路径（同时保留 `/health` 和 `/`），且 `/healthz`、`/health`、`/` 三个端点免 `proxyApiKey` 认证，确保 Render 探针无需 Authorization 头即可通过
> 5. **`ZCODE_AUTH_MODE` 环境变量**：支持通过环境变量覆盖 `auth.mode` 配置，Render 用户无需编辑 yaml 即可在 apikey 和 oauth 模式间切换
> 6. **`ZCODE_OAUTH_CREDENTIAL` 环境变量**：OAuth 模式下，支持通过 base64 编码的 JSON 凭证注入。本地用 `zcode-proxy auth export` 导出后粘贴到 Render 环境变量，无需在云端重复 OAuth 流程
> 7. **`auth export` CLI 子命令**：本地登录后执行 `zcode-proxy auth export`，输出可直接填入 `ZCODE_OAUTH_CREDENTIAL` 的 base64 blob
> 8. **dashboard "导出 Render 凭证" 按钮**：在 dashboard 账号管理页面新增按钮，点击后弹窗展示 `ZCODE_AUTH_MODE` 和 `ZCODE_OAUTH_CREDENTIAL` 两个环境变量值，附带一键复制按钮和详细操作说明
> 9. **`/admin/api/accounts/render-export` 接口**：dashboard 后端接口，返回当前激活凭证的 base64 编码 + 环境变量格式 + 操作指引
> 10. **凭证存储路径可配置**：`ZCODE_PROXY_STORE_DIR` 环境变量支持自定义凭证存储目录，适配 Render 只读文件系统（默认 `~/.zcode-proxy`，Render 上自动降级到 `/data/.zcode-proxy` 或 `/tmp/zcode-proxy/.zcode-proxy`）
> 11. **`writeStore` 优雅降级**：只读文件系统下写入失败不再崩溃，仅警告日志，保留内存中的副本让当前请求继续完成
> 12. **`.dockerignore` 优化**：排除 node_modules / 二进制文件 / 本地 config.yaml / 测试配置，加速 Docker 构建
> 13. **README 完整部署文档**：新增 Render 部署章节，含 Blueprint / 手动两种方式、两种认证模式（apikey / oauth）详细说明、完整环境变量参考表、客户端接入示例（OpenAI SDK / Anthropic SDK / Codex CLI / curl）、常见问题排查
> 14. **测试覆盖**：全套 378 测试通过，TypeScript 类型检查零错误
>
> **Render 部署两种模式**：
> - **Mode A (apikey)**：设置 `ZCODE_API_KEY` 即可，最简单
> - **Mode B (oauth)**：本地 `zcode-proxy auth login` → `zcode-proxy auth export` → 把 base64 blob 填入 `ZCODE_OAUTH_CREDENTIAL`
>
> **必填环境变量**：仅 `ZCODE_PROXY_API_KEY`（客户端访问代理的密钥）。上游认证二选一。
>
> ---

> **v2.1.4.1test1 — Responses 思考管理 + GLM 模型目录接口**
>
> 修复 Codex CLI 在 `/v1/responses` 接口下思考参数丢失的问题，并新增管理面板配置入口。
>
> **v2.1.4.1test1 关键改进**：
> 1. **Responses 思考管理**：Codex CLI 经常把 `reasoning` 字段传成 `null`（即使本地配置开了 reasoning），导致思考参数丢光。新增管理面板「代理规则 → Responses 思考管理」卡片，可勾选需要强制开启思考的模型，无论客户端发什么都会注入 `thinking:{type:"enabled"}`
> 2. **GLM 模型目录接口**：新增 `GET /admin/api/glm-models` 接口，返回完整 GLM 模型目录（含 reasoning 标记、上下文窗口、最大输出 tokens），供前端快速选择
> 3. **模型映射快速选择**：模型映射的「GLM 模型」字段 datalist 改用完整 GLM 目录（之前只用白名单），输入时能看到全部 9 个 GLM 模型作为下拉建议
> 4. **配置持久化**：`responsesThinking` 配置持久化到 `config.yaml`，支持 canonical `{models:[]}` 和简写数组两种形式
> 5. **匹配规则**：按映射后的最终 GLM 模型 id 匹配（大小写不敏感），确保模型映射 + 思考强制开启协同工作
> 6. **测试覆盖**：新增 11 个单元测试（5 个 loader + 6 个 translator），全套 378 测试通过，TypeScript 类型检查零错误
>
> **配置示例**：
> ```yaml
> responsesThinking:
>   models:
>     - glm-5.2
>     - glm-4.6
> ```
>
> ---

> **v2.1.4.1test0 — 凭证自动切换测试版**
>
> 新增凭证自动切换功能：当同一凭证连续失败达到设定阈值时，自动切换到另一个已存储的凭证继续重试。
>
> **v2.1.4.1test0 关键改进**：
> 1. **凭证自动切换**：同一凭证连续失败 N 次（含首次请求）后自动切换到另一个已存储的凭证，逐个尝试所有可用凭证（A→B→C），已试过的凭证不会重复使用
> 2. **可配置阈值**：在 dashboard「重试配置」标签页新增「凭证切换阈值」输入框，默认 5，设为 0 禁用
> 3. **多凭证支持**：支持 3+ 凭证逐个切换，每个凭证获得公平的重试机会
> 4. **持久化切换**：切换后自动持久化到凭证存储，dashboard 实时反映当前激活的凭证
> 5. **环境变量支持**：`ZCODE_RETRY_CREDENTIAL_SWITCH_THRESHOLD` 可覆盖 YAML 配置
>
> ---

> **v2.1.4.1 — 修复版（Windows 保存失败 + 启动提示）**
>
> 修复 v2.1.4 在 Windows 上 dashboard 保存配置失败的问题。
>
> **v2.1.4.1 关键修复**：
> 1. **Windows 保存失败修复**：`atomicWriteFile` 的 `rename` 在 Windows 上会被杀毒软件/Windows Search 索引器短暂锁文件导致 EPERM，新版加了 5 次重试 + 退避
> 2. **启动提示加强**：当 host 为 `0.0.0.0` 时，启动日志明确提示用 `http://127.0.0.1:<port>/admin` 访问 dashboard（之前用户误以为可以直接打开 `http://0.0.0.0:8080/admin`）
> 3. **config.example.yaml 加注释**：明确说明 `0.0.0.0` 是绑定地址不是访问地址
>
> ---
>
> **v2.1.4 — 全面优化版（安全加固 + 性能优化 + 资源控制）**
>
> 在 v2.1.3.5 基础上进行了一次完整的代码审查与系统性优化，覆盖 30 项发现，分 P0/P1/P2/P3 四级落地。
>
> **v2.1.4 关键改进**（按优先级）：
>
> ### P0 关键（安全/正确性）
> 1. **Admin token 时序攻击修复**：admin 控制台 token 比较改用 timingSafeEqual（之前用 `===`）
> 2. **凭证存储明文后门加固**：必须设置 `ZCODE_PROXY_ALLOW_PLAINTEXT_STORE=1` 才能加载明文 credentials.json
> 3. **上游 fetch 超时**：stream 10 分钟、batch 5 分钟，挂起的上游连接不再无限占用 worker
> 4. **SSE 流背压控制**：所有翻译流在 enqueue 前检查 `controller.desiredSize`，慢客户端不再导致 OOM
> 5. **console.log 猴补丁修复**：保留 Error stack，处理循环引用（之前 `JSON.stringify(Error)` 返回 `"{}"`）
>
> ### P1 高优先级（可靠性）
> 6. **网络错误默认可重试**：之前合成 502 但默认 retryableStatuses 不含 502，重试静默失效
> 7. **Retry-After HTTP-date 格式**：RFC 7231 完整支持（之前只解析 delta-seconds）
> 8. **配置原子写入 + 互斥锁**：所有 dashboard 保存改用 temp-file + rename，并发 PUT 串行化
> 9. **凭证 store 内存缓存**：9+ admin 端点不再每次磁盘读 + AES-GCM 解密
> 10. **OAuth callback server 泄漏修复**：try/finally 保证 oauth.close() 总执行
> 11. **responses-store 大小上限**：每条 256KB 上限，防止 Codex 长对话 OOM
> 12. **死代码删除**：移除 `routes-auth.ts` + `cli/login.ts`（220 LOC）
> 13. **recordStat O(n) → Map**：去重查找 O(1)
> 14. **SSE 错误日志**：malformed JSON 不再静默吞掉
>
> ### P2 中优先级（性能/架构）
> 15. **SSE 解析器去重**：3 处副本合并到 `src/utils/sse.ts`
> 16. **4xx 时不再二次构造 Request**：`lastSentBeta` 缓存实际发送的 header
> 17. **structuredClone 优化**：模块加载时一次性 freeze 而非每请求克隆
> 18. **logging.level 真正生效**：之前配置了但不被读取
> 19. **Admin log stream O(n²) → O(n)**：直接遍历 buffer 替代 find(seq)
> 20. **CORS allowlist 支持**：新增 `ZCODE_PROXY_CORS_ALLOWLIST` 环境变量
> 21. **applyStartPlanSystem 短路优化**：body 已正确时跳过 stringify
> 22. **globMatch 改用 Uint8Array**：减少分配
> 23. **defaultModel 与 models 一致性校验**
>
> ### P3 改进（DX）
> 24. **README 更新**：auto-create config.yaml 说明、`--plan=` flag、Admin Dashboard 章节、Security Notes
> 25. **tsconfig 加严**：noImplicitReturns / noFallthroughCasesInSwitch / forceConsistentCasingInFileNames
> 26. **genId 升级到 128-bit**：8 字节 → 16 字节
> 27. **集成测试隔离**：port 0（消除端口竞争）+ 临时 HOME（不污染用户凭证目录）+ 绝对路径 config
>
> 全套 **348 测试通过**（v2.1.3.5 是 329+1 失败 → v2.1.4 是 348+0 失败），TypeScript 类型检查零错误。
>
> ### 新增环境变量
> - `ZCODE_PROXY_ALLOW_PLAINTEXT_STORE=1` — 允许加载明文凭证文件（仅 debug/test）
> - `ZCODE_PROXY_CORS_ALLOWLIST=https://a.com,https://b.com` — CORS origin 白名单

---

## 客户端适配性

| 客户端 | 接入路径 | 状态 | 备注 |
|--------|---------|------|------|
| **Claude Code** (Anthropic CLI) | `/v1/messages` (Anthropic 原生格式) | ✅ 完全适配 | 多轮对话 + 27 工具 + thinking 已验证 |
| **Codex CLI** (OpenAI Responses) | `/v1/responses` (翻译到 Anthropic) | ✅ 完全适配 | 工具调用 + 链式续聊已验证 |
| **OpenAI 兼容客户端** | `/v1/chat/completions` (翻译到 Anthropic) | ✅ 兼容 | 早期版本已支持，未做改动 |
| **Anthropic SDK 直连** | `/v1/messages` (透传) | ✅ 兼容 | coding-plan/start-plan 均可 |

### Claude Code 接入

在 `~/.claude/settings.json` 中配置：

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "你的proxyApiKey（config.yaml中配置的）",
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8080",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "glm-4.7",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "glm-5.2",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "glm-5.2",
    "API_TIMEOUT_MS": "3000000",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  }
}
```

> 如果 `config.yaml` 中没有设置 `proxyApiKey`，则 `ANTHROPIC_AUTH_TOKEN` 可以填任意值。

### Codex CLI 接入

```bash
export OPENAI_API_KEY="your-proxy-secret"
export OPENAI_BASE_URL="http://localhost:8080/v1"
codex --model glm-5.2
```

---

## ⚠️ 维护者必读 — body-transformer 逻辑说明

**这个文件是经过 ~10 次 3001 报错迭代调试出来的，每个 transform 都是为了解决 ZCode start-plan 网关的特定拒绝场景。不要盲目简化、合并、重排序！**

完整逻辑说明在 `src/proxy/body-transformer.ts` 文件顶部的注释里（约 90 行），这里是要点摘要：

### 每个 transform 存在的原因

| Transform | 解决的问题 | 移除会怎样 |
|-----------|-----------|-----------|
| `transformUnsupportedAnthropicFields` | Claude Code 发 `thinking:{type:"adaptive"}`、`context_management`、`output_config`，GLM 不接受 | 3001 |
| `relocateSystemMessages` | Claude Code 把 system 放 `messages[].role:"system"`，Anthropic 要求放顶层 `system` | 3001 |
| `stripThinkingBlocksFromMessages` | GLM 返回 thinking_delta，Claude Code 回传时含 `thinking`/`redacted_thinking` 内容块，GLM 不接受 | 第二轮起 3001 |
| `ensureAssistantTextBlock` | thinking 剥离后 assistant 只剩 tool_use 块，网关要求 assistant 必须有 text 块 | 多轮后 3001 |
| `normalizeAllMessageContent` | string content 必须转 array；空 string 必须转非空占位 `" "` | 3001（Codex CLI 路径关键） |
| `normalizeToolResultContent` | tool_result.content 同上，string → array，空 → 非空 | 3001 |
| `sanitizeContentBlocks` | 剥离 cache_control（start-plan 全剥）+ is_error（两种模式都剥） | 3001 |
| `applyAnthropicCacheControl` | start-plan 模式下 no-op（不添加 cc）；coding-plan 给 text 块加 cc | start-plan 添加 cc 会 3001 |

### Transform 执行顺序（不能乱）

```
1. transformUnsupportedAnthropicFields    # 顶层字段清理
2. relocateSystemMessages                  # system 消息迁移
3. stripThinkingBlocksFromMessages         # 剥离 thinking 块
4. ensureAssistantTextBlock                # 补非空 text 块
5. normalizeAllMessageContent              # string content → array
6. normalizeToolResultContent              # tool_result content → array
7. sanitizeContentBlocks                   # 剥 cache_control + is_error
8. applyAnthropicCacheControl              # coding-plan 才加 cc
```

### 3001 排查指南

如果 3001 复现，按以下顺序检查代理控制台日志：

1. **`transformed request summary:`** — 查看每条消息的块类型
   - 任何 `+cc` 在非 text 块上 → `sanitizeContentBlocks` 回归
   - 任何 `tool_result/str` → `normalizeToolResultContent` 回归
   - 任何 `/+err` → `is_error` 剥离回归
   - 任何 `[N]user/str` → `normalizeAllMessageContent` 回归

2. **`anthropic-beta sent:`** — 应该只有 `claude-code-*` flag
   - 有其它 flag → `collectPassthroughHeaders` 回归

3. **`full transformed body dumped to: zcode-proxy-debug-XXX.json`** — 完整请求体
   - 把这个文件发回开发者精确分析

### ⚠️ 不要做的事

- ❌ **不要** 在 start-plan 模式添加 cache_control — 网关会 3001
- ❌ **不要** 把空 text 块改回 `text:""` — 网关会 3001
- ❌ **不要** 保留 `is_error` 字段 — 网关会 3001
- ❌ **不要** 让 string content 透传 — 网关会 3001
- ❌ **不要** 重排 transform 顺序 — `sanitizeContentBlocks` 必须在 `applyAnthropicCacheControl` 之前
- ❌ **不要** 在 `anthropic-beta` header 保留非 `claude-code-*` flag — header/body 不一致会 3001

---

## 快速启动

### Windows
1. 双击 `start.bat` 打开管理菜单
2. 首次使用：选择 **2**（OAuth 登录智谱）或 **4**（从 ZCode 导入密钥）
3. 登录成功后：选择 **1** 启动代理服务

### Linux / macOS
1. 运行 `chmod +x start.sh && ./start.sh` 打开管理菜单
2. 首次使用：选择 **2**（OAuth 登录智谱）或 **4**（从 ZCode 导入密钥）
3. 登录成功后：选择 **1** 启动代理服务

---

## 命令行用法

`zcode-proxy.exe` 本身就是一个完整的命令行工具，所有功能都可以直接通过命令行使用：

```
zcode-proxy serve [config.yaml]          启动代理服务（默认命令）
zcode-proxy auth login bigmodel          OAuth 登录智谱（自动打开浏览器）
zcode-proxy auth login zai               OAuth 登录 Z.AI（自动打开浏览器）
zcode-proxy auth login bigmodel --import 从 ZCode 桌面版导入智谱密钥
zcode-proxy auth login zai --import      从 ZCode 桌面版导入 Z.AI 密钥
zcode-proxy auth status                  查看当前登录状态
zcode-proxy auth logout                  退出登录，清除凭证
zcode-proxy version                      查看版本号
zcode-proxy help                         显示帮助
```

---

## 两种使用方式

### 方式一：apikey 模式（简单，推荐新手）

在 `config.yaml` 中直接填入 API Key：

```yaml
auth:
  mode: apikey
  apiKey: "你的API_Key"        # 智谱: 直接填 API Key；Z.AI: 填 apiKey.secretKey
```

获取 API Key 的方式：
- **智谱**：登录 https://open.bigmodel.cn → API Keys 页面创建
- **Z.AI**：登录 https://z.ai → 个人中心 → API Keys 页面创建

### 方式二：OAuth 模式（自动获取密钥）

```yaml
auth:
  mode: oauth
```

然后运行登录命令：

```bash
# 方式 A：浏览器 OAuth 登录（自动打开浏览器授权）
zcode-proxy.exe auth login bigmodel

# 方式 B：从已安装的 ZCode 桌面版直接导入密钥（免浏览器）
zcode-proxy.exe auth login bigmodel --import
```

OAuth 凭证加密存储在 `~/.zcode-proxy/credentials.json`。

#### 多账号管理

支持同时存储多套凭证，运行时通过 dashboard 切换：

1. 启动代理后访问 `http://localhost:8080/admin` 进入面板
2. 进入 **Accounts** 页面，可看到所有已存储的账号
3. 用 **Add API Key** 添加新账号，或用 **OAuth Login** 走 OAuth 流程
4. 点击 **Activate** 切换激活账号（运行时热替换，无需重启）

> 凭证存储格式为 v2 多账号格式；旧版本（v1 单账号）的 `credentials.json` 在首次加载时会自动迁移，无需手动操作。

#### OAuth 手动回调（远程/无头环境）

当浏览器自动跳转失效时，可在 dashboard 的 OAuth 页面手动粘贴回调 URL 完成授权：

1. 点击 **Start OAuth Login**，复制 Authorize URL 在浏览器中打开
2. 完成授权后，浏览器会跳转到形如 `https://zcode.z.ai/api/v1/oauth/cli/callback/zai?code=...&state=...` 的 URL
3. 复制该完整 URL，粘贴到 **Manual Callback URL** 输入框，点击 **Submit Callback URL**

---

## start-plan 套餐

如果使用 start-plan（通过 zcode.z.ai 网关），需要额外获取 JWT：

```yaml
plan: start-plan
```

```bash
# start-plan 的 JWT 会随 OAuth 登录一起获取
zcode-proxy.exe auth login bigmodel

# 或者从 ZCode 桌面版导入（同时导入 API Key + JWT）
zcode-proxy.exe auth login bigmodel --import
```

> `--import` 会读取 ZCode 桌面版的配置文件 `~/.zcode/v2/config.json`，
> 自动提取 coding-plan 的 API Key 和 start-plan 的 JWT。
> 前提是你已经在 ZCode 桌面版中登录过。

---

## config.yaml 配置说明

### 最小配置（智谱直连）

```yaml
auth:
  mode: apikey
  apiKey: "你的智谱API_Key"

provider: bigmodel
plan: coding-plan
```

### 完整配置

```yaml
server:
  port: 8080                    # 代理监听端口
  host: "0.0.0.0"

auth:
  mode: apikey                  # apikey 或 oauth
  apiKey: "YOUR_API_KEY"        # apikey 模式必填
  proxyApiKey: "your-secret"    # 客户端访问代理的密钥（可选）

provider: bigmodel              # bigmodel 或 zai
plan: coding-plan               # coding-plan 或 start-plan

providers:
  bigmodel:
    anthropicBase: "https://open.bigmodel.cn/api/anthropic"
    openaiBase: "https://open.bigmodel.cn/api/coding/paas/v4"
  zai:
    anthropicBase: "https://api.z.ai/api/anthropic"
    openaiBase: "https://api.z.ai/api/coding/paas/v4"

defaultModel: glm-5.2
models:
  - glm-4.5-air
  - glm-4.6
  - glm-4.6v
  - glm-4.7
  - glm-5
  - glm-5-turbo
  - glm-5v-turbo
  - glm-5.1
  - glm-5.2

identity:
  appVersion: "3.1.1"
  sourceTitle: "cli"
  refererOrigin: "https://zcode.z.ai"

logging:
  level: info

retry:
  maxRetries: 3                # Maximum retry attempts for 529/overloaded errors
  initialDelayMs: 1000         # Initial delay before first retry (ms)
  maxDelayMs: 8000             # Maximum delay cap (ms)
  backoffFactor: 2             # Exponential backoff multiplier
  retryableStatuses:           # HTTP status codes that trigger retry
    - 529
```

---

## 支持的模型

| 模型 | 上下文 | 最大输出 | 推理模式 |
|------|--------|---------|---------|
| glm-4.5-air | 200K | 128K | ✅ |
| glm-4.6 | 200K | 128K | ✅ |
| glm-4.6v | 200K | 128K | — |
| glm-4.7 | 200K | 128K | ✅ |
| glm-5 | 200K | 128K | ✅ |
| glm-5-turbo | 200K | 128K | ✅ |
| glm-5v-turbo | 200K | 128K | — |
| glm-5.1 | 200K | 128K | ✅ |
| glm-5.2 | **1M** | 128K | ✅ |

---

## 版本演进历史（精简）

**v2.1.3.5** — 全面优化版：13 项改进覆盖安全/内存/UX/代码质量，测试 295→348

正式版 v2.1.3.4 整合了以下 beta 版本的修复：

- **v2.1.3.11beta0** — Responses API 空 string content → 非空占位（Codex CLI 关键修复）
- **v2.1.3.10beta0** — 非空 text 占位符 + 全消息 content 标准化 + 4xx 完整 body dump
- **v2.1.3.9beta0** — start-plan 剥离所有 cache_control + tool_result content 标准化 + is_error 剥离
- **v2.1.3.8beta0** — 过滤 anthropic-beta header（只保留 claude-code-* flag）
- **v2.1.3.7beta0** — assistant 消息必须有 text 块
- **v2.1.3.6beta0** — tool_use 块上的 cache_control 剥离
- **v2.1.3.5beta0** — tool_result 块上的 cache_control 剥离
- **v2.1.3.4beta0** — 增加 3001 诊断日志
- **v2.1.3.3beta0** — 剥离 messages[].content 里的 thinking 块
- **v2.1.3.3** — Dashboard 模型映射 + thinking 无条件注入
- **v2.1.3.2** — thinking 字段重新启用（按模型能力）
- **v2.1.3.1** — Codex CLI 实战修复（连续同角色消息合并 + 非 GLM 模型 fallback）
- **v2.1.3.0** — OpenAI Responses API 适配（Codex CLI 兼容）
- **v2.1.3** — 流式重试三连修复（SSE 错误检测 + Request body 复用 + captcha token 过期）
- **v2.1.2** — Dashboard UI 全面重构
- **v0.1.x** — 多账号管理 / OAuth 回调 / 跨项目凭证互通 / 导入密钥 plan 自动识别
