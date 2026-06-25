# zcode-proxy 使用说明

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
