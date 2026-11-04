

## 本轮执行安排

以下批次使用审查时的原始编号，避免与下方重新编号的清单混淆；每批完成验证后独立提交。

| 批次 | 原始编号 | 修复范围 | 状态 |
| --- | --- | --- | --- |
| 1 | 1、13、14、8、11 | ImageGen 错误分类、Context Tier 刷新与保存协调、账户安全提示、下载地址回退、有界持久化冲突重试 | 已完成；`pnpm run check` 通过 |
| 2 | 7、12 | Context Tier 事件流容错及缓冲上限、settings namespace 一致性 | 待开始 |
| 3 | 3、5、6、15 | Zstd 能力恢复、凭据来源语义、异步 RPC 清理、键盘与读屏可访问性 | 待开始 |

原第 2、4、9、16 项忽略；原第 10 项及性能、结构、测试基础设施和其余文档建议不纳入本轮三个提交。

### 第一批结果

- ImageGen 取消保留 `ABORTED`；明确 HTTP 失败保留状态与安全数字业务码，包括诊断正文超时、401 刷新失败。无法确认结果的生成仍禁止自动重新生成。
- 图片下载仅在收到响应前连接失败时尝试其它已验证的公网地址；取消及收到 HTTP 响应后停止地址回退，保持 TLS、DNS 钉定及 SSRF 防护。
- 自动 Context Tier 重验证不再禁用可用控件，保存期间的通知在写入结束后重读；旧读写不能覆盖新状态。
- 账户失败仅显示本地化提示，不保存或渲染任意诊断原文。
- 目录持久化冲突最多重试三次，按 50/100/200ms 退避；耗尽保留元数据，等待外部重试，切换绑定后不再写旧设置。
- 新增离线回归测试，构建、两套类型检查、全部测试及打包 dry-run 均通过。

## 一、需要修的问题（按严重度）

本轮忽略原第 2 项（中国区 machineID）、第 4 项（watcher 配置异常）、第 9 项（`lease!` 非空断言）和第 16 项（轮询 catch 缺 `active` 守卫）；以下剩余问题已重新编号。

**1.〔中〕ImageGen 被取消时被伪装成"结果未知"** — [image-tools.ts:378](src/qoder/transport/image-tools.ts#L378)
兜底 `catch` 把生成阶段的**所有**异常（含 `ABORTED`、超时）统一重写成 `PROVIDER_ERROR`「Qoder ImageGen did not confirm an outcome」，并丢掉原始 `httpStatus`/`upstreamCode`（只进日志）。后果：用户点取消 → 界面提示"生成结果未知，请勿自动重试"，与事实相反；额度不足这类 4xx 也变成"未知"。
修法：`catch` 里先判 `signal?.aborted` 抛 `ABORTED`，其余用 `{ cause }` 保留状态码；只有"请求已发出但无回执"才用"结果未知"。

**2.〔中〕Zstd 被拒后是进程级永久禁用，没有恢复路径** — [request-compression.ts:173](src/qoder/transport/request-compression.ts#L173)、[190](src/qoder/transport/request-compression.ts#L190)、判据在 [122](src/qoder/transport/request-compression.ts#L122)
`disabledEndpoints` 是模块级 `Set`，只 `add` 从不清理，也没 TTL/重探；`probe()` 对 400/403/415 都做启发式判定。一次边缘/WAF 偶发就被永久拉黑到进程重启，用户在设置里重新开关 `requestCompression` 也不会重置。
修法：加 TTL（如 30 分钟）或"成功 N 次后重探一次"，并把当前禁用端点暴露到日志/设置页状态，避免静默降级。

**3.〔中〕环境层提供的 PAT 在 UI 上被当成托管凭据** — [settings-operations.ts:54](src/client/settings-operations.ts#L54)
`success({ configured, source: result.value.method, writable })` 把授权**方式**（`pat|browser|none`）塞进了 `source` 字段，而 `source` 的语义是凭据来源（[credential.ts:11](src/dsh/credential.ts#L11) 正是靠它拒绝环境层凭据）。于是 [QoderAccountCard.tsx:106](src/client/QoderAccountCard.tsx#L106) 与 [QoderBrowserLogin.tsx:52](src/client/QoderBrowserLogin.tsx#L52) 的 `isEnvironmentCredentialSource(...)` 永远为假：env 提供了 `QODER_PAT` 的用户会看到"已配置托管 PAT、可修改/删除"，但传输层其实**拒绝使用**它。
顺带：同一处 [settings-operations.ts:35](src/client/settings-operations.ts#L35) 在"没有 PAT"时返回 `failure(..., undefined)`，而 `failure` 必然走 `diagnoseOperation` → [operation-result.ts:35](src/client/operation-result.ts#L35) 的 `console.error`，未配置属于正常态，不该记 error（测试日志里那 5 段 `[Qoder settings operation]` 就是它）。

**4.〔中低〕路由注销被 fire-and-forget，热重载可能撞"路由已存在"** — [rpc.ts:58](src/dsh/rpc.ts#L58)
返回的 disposer 用 `void dispose()`，既不 catch 也不等待完成；而同函数回滚分支 [rpc.ts:54](src/dsh/rpc.ts#L54) 是 `try { void Promise.resolve(dispose()).catch(() => {}) } catch`。`ctx.effect` 认为已释放，Loader 立刻重注册同一批 path 时可能失败。
修法：返回 `() => Promise<void>`，`await Promise.all(...)`，与回滚分支一致。

**5.〔低〕Context Tier 事件流：一行坏数据整条重连，缓冲无上限** — [session-tier-events.ts:40](src/client/session-tier-events.ts#L40)
每行直接 `JSON.parse`，异常冒到外层 `catch` → 断流重连并丢弃 `buffered` 余下内容；`buffered` 也没有 cap（仓库其它缓冲都有上限）。修法：单行解析 try/catch 跳过坏行；缓冲加 64 KiB 上限。

**6.〔低〕图片下载只用第一个 DNS 地址** — [image-tools.ts:190](src/qoder/transport/image-tools.ts#L190)
`addresses[0]` 单地址钉死；多 A/AAAA 的主机若首个不可达（典型 IPv6 优先但网络只有 v4）整次下载失败，而 IPv6 已用 `/^[23]/` 白名单过滤，说明作者本意是多地址。修法：对已验证为公网地址的候选逐个尝试，保持 `agent:false` 与同一 `lookup`。

**7.〔低〕`chat.ts:102` 造了一个永不 abort 的 signal** — [chat.ts:102](src/qoder/transport/chat.ts#L102)
`options.signal ?? new AbortController().signal` 只为满足签名；真走到 `??` 分支时，队列等待期间不可取消。返回值还被忽略（靠闭包副作用），可读性差。

**8.〔低〕冲突重试无上限无退避** — [catalog-lifecycle.ts:173-191](src/dsh/catalog-lifecycle.ts#L173)
`SettingsConflictError` 时 `dirty = true` 立即进入下一轮写；两个客户端并发保存会长时间乒乓（每轮有 `await`，不是纯 CPU 自旋，但没有上限）。修法：限 3 次 + 指数退避，耗尽走 `onPersistenceError`。

**9.〔低〕settings namespace 宿主派生、客户端硬编码** — [settings.ts:17](src/dsh/settings.ts#L17) 用 `owner.fiber.entry?.options.id ?? 'provider-qoder'`，而 [plugin.ts:39](src/dsh/plugin.ts#L39)、[client/index.ts:83](src/client/index.ts#L83) 是字面量。
用户以别的 id 在自有 profile 引入插件时，模型目录会写一个 namespace、读另一个，界面只剩 `modelsUnavailable`。修法：namespace 经 RPC/slot inject 下发。

**10.〔低〕上下文压力变化会禁用选择控件，可能吞掉点击** — [QoderContextSelect.tsx:89](src/client/QoderContextSelect.tsx#L89) + [:113](src/client/QoderContextSelect.tsx#L113)
`historicalWindow`/`lastUsed` 一变就 `state.refresh()`，无条件 `publish({ loading: true })`，而按钮与菜单项都是 `disabled={pending}`（[:125](src/client/QoderContextSelect.tsx#L125)、[:155](src/client/QoderContextSelect.tsx#L155)）——菜单开着时被加载态禁用，点击无反应也无提示。修法：拆一个不置 `loading`、不抢 generation 的 `revalidate()`，菜单展开期间跳过自动刷新。

**11.〔低〕诊断原文进 UI** — [QoderAccountCard.tsx:188](src/client/QoderAccountCard.tsx#L188)：`(${accountState.error})` 直接渲染宿主/上游报文，与本模块 [operation-result.ts:64](src/client/operation-result.ts#L64) 的"诊断不进 UI"策略冲突。

**12.〔低〕a11y** — `role="alert"` 容器里嵌按钮（[QoderContextSelect.tsx:144](src/client/QoderContextSelect.tsx#L144)）；`role="menu"` 只有 Escape，没有方向键/首项聚焦（[:146](src/client/QoderContextSelect.tsx#L146)）；`role="status"` 里放每秒刷新的倒计时（[QoderBrowserLogin.tsx:197](src/client/QoderBrowserLogin.tsx#L197)），读屏会秒级播报。

---

## 二、性能优化（低风险、见效快）

1. **模型目录每次调用全量重建** — [adapter.ts:180](src/dsh/adapter.ts#L180) → [catalog-lifecycle.ts:65](src/dsh/catalog-lifecycle.ts#L65)：每次 `models()` 都 `modelsFor()`（校验 + 逐个克隆）+ `mergeQoderDiscoveryMetadata`（建 Map、逐 key delete/assign）+ 再克隆。而 `models()` 在 `listModels/resolveModel/prepareCall/setSessionTier/readSessionTier/stream` 里都会被调。建议按 `(configured 引用, discovered generation)` 记忆化。
2. **`listModels()` 会等 discovery** — [adapter.ts:175](src/dsh/adapter.ts#L175) `await this.catalog.refresh()`，metadata 超时 15s。打开模型选择器时若正有 discovery 在飞，UI 最长等 15s。建议热路径只读缓存，刷新放后台。
3. **每个请求一次同步文件 I/O + 系统调用** — [cosy.ts:113](src/qoder/transport/wire/cosy.ts#L113)（`creds.machineID` 为空时 `existsSync`+`readFileSync`，必要时还 `writeFileSync`）与 [cosy.ts:116](src/qoder/transport/wire/cosy.ts#L116) 的 `hostname()`（无条件调用，却只对 model 请求使用）。两者都是进程级常量，应在构造时算一次；`hostname()` 移进 `isModelRequest` 分支。
4. **每个请求 new 一个 `QoderSearchClient`** — [default-transport.ts:154](src/qoder/transport/default-transport.ts#L154)，而 `usage`/`imageUploader` 都是构造时创建一次，不一致。
5. **队列状态固定 1s 轮询** — [queue-status.ts:65](src/client/queue-status.ts#L65)：空队列也每秒一次 RPC，建议空时降到 5–10s。

---

## 三、重复与结构（维护成本）

1. **`chat.ts` 与 `model-server.ts` 是两套镜像的请求生命周期**：header 超时、idle 超时、abort 传播、401 刷新重试、phase 日志、`finally` 清理各写一遍（[chat.ts:113](src/qoder/transport/chat.ts#L113) 起 / [model-server.ts:93](src/qoder/transport/model-server.ts#L93) 起），约 300 行近重复。抽一个 `runModelRequest({ dispatch, parse, onUnauthorized })` 骨架，同时消灭"两个协议的超时/取消语义逐渐分叉"的风险。
2. **超时常量散落 8 处**：15s（metadata/auth）、3s（org tags）、30s（search）、180s（image gen）、600s（image download）、60s（response header）、5min（stream idle）、1s（compression probe），只有部分进 `Config`。
3. **`plugin.ts` 的 `apply` 253 行承担 8 件事**（queue、transport runtime、auth、catalog、adapter、image tools、search、settings/RPC），且 `authorization`/`catalog`/`registration` 被提前声明的闭包引用（[plugin.ts:71](src/dsh/plugin.ts#L71)、[106](src/dsh/plugin.ts#L106)）——当前靠调用顺序成立，改起来容易踩坑。建议拆成几个返回 disposer 的 `bind*`。
4. **`search-provider.ts:75-88` 猴补 `webCtx.web.search`** — 为"透明路由"替换宿主服务方法再还原 descriptor，已处理"别人后接管"，但仍是跨插件共享对象上的可变补丁；短期可留，建议同时向上游提正式路由钩子。
5. **`serialize.ts:45-48` 把 system 同时放进 `system` 和 `messages`** —— 看着像 bug，实际由 `tests/cli-compatibility.test.ts:65`、`tests/translate.test.ts:98` 锁定（对齐 qodercli）。**建议补一行注释**说明是刻意双写，否则每个 reviewer 都会来问一次。

---

## 四、测试与 CI

- **打包内容没有测试守卫**：641 个测试无一读 `files`、无一跑 `pnpm pack`；`files` 写漏只在 `pnpm run check` 的 `pack --dry-run` 暴露，`verify` 全绿。建议把 tarball 清单断言进 CI。
- **3 类可能抖动的写法**：真实墙钟 deadline（`tests/model-refresh.test.ts:14`）、固定轮数事件循环排水（`catalog-lifecycle.test.ts:21`、`package.test.ts:313`、`helpers/browser-login.ts:94`）、`--test-isolation=none` 单进程共享全局（一个 fetch mock 泄漏就会掩盖真实网络调用）。
- **无测试的两个文件**：`src/invariant.ts`（只做了 `access()` 存在性检查）、`src/client/QoderQueueStatus.tsx`（只随 bundle 执行，未断言渲染）；`QoderAccountCard` 无任何用例（过期请求丢弃、revision 触发的重读、额度分支都未覆盖）。
- 未发现真实网络调用或真实 sleep，符合"不消耗 Qoder 配额"。

---

## 五、文档

- [rpc.ts:5](src/dsh/rpc.ts#L5) 写着 "See ADR-0008"，但 `docs/adr/` 里**没有 0005/0007/0008**，属悬空引用。
- 两个架构性改动（`modelTransport: 'http'|'legacy'` 的 Bearer 模型服务器通道、zstd 请求压缩）没有 ADR，而仓库惯例是架构决策入 ADR。建议补 ADR 并加 `docs/adr/README.md` 索引。
- `dsh.client.inject` 列的是三个 type-only 包，真正运行时依赖 `ui-primitives` 没列（宿主会从 bundle 的 `external` 边自动解析，所以只是元数据不准，不影响加载）。

---

## 六、核实过、确认**不是**问题（省你时间）

- `serialize.ts` 的 system 双写（测试锁定，CLI 对齐）。
- 之前的 `CONTEXT.md` 失效引用：仓库已统一到 `GLOSSARY.md`，`AGENTS.md`/`docs/agents/domain.md` 都是对的。
- `credentialLeases` 是 `WeakMap`，不泄漏。
- 区域切换不会闪现旧身份：卡片按 `key={region}` 重挂载。
- `/api` 上跑 NDJSON 流式可行（http-bridge 逐块遍历 `response.body`，断开时 abort `request.signal`）。
- `session/event`、`agent/request` 签名与 harness 一致；`agent/request` 每 step 触发但 `leases.start` 按 turn 去重。
- 客户端产物无 node 内建泄漏，只 require `react` + `ui-primitives`。

**本轮动手顺序**：以上方三个批次为准。后续章节保留原始审查建议供参考，已核实的适用范围与修正以本轮实现及验证结果为准。
