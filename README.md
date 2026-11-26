# Subagent Model Seat（子会话模型切换）

在子智能体会话的输入框里，像普通对话一样选择该会话使用的模型——包括原版的「模型 / 档位」两级面板，以及**按厂商或模型搜索**。DSH 原版对所有「已寻址（addressed）子智能体会话」隐藏了这个入口，Host 侧的 `session.selectModel` 也会用 `session/agent-busy: ... is owned by subagent routing` 直接拒绝。本插件把入口和写入通道都补回来，并在 **DSH 设置里新增一个独立页**，按工作区列出所有对话，可一键或逐个设置每个对话委派出去的子智能体模型。

- 名称：`@local/subagent-model-seat`
- 版本：`1.4.2`
- 形态：Host 半 + Web Client 半（Host 只新增一条本地路由，无新 Remote、无插件私有持久化状态）
- 生效范围：全部子会话（可续聊 / 一次性 / 未知模式）+ 普通会话，历史冷会话也能改

## 本次新增（v1.4.2）

**发版自动化**：仓库里加了 `.github/workflows/release.yml`。推一个 `v*` 标签，GitHub Actions 就会自动校验「标签版本 == package.json 版本」、语法检查两半代码、`npm pack` 打包、算 SHA256、建 Release 并把 `subagent-model-seat.tgz` 与 `SHA256SUMS.txt` 挂上去——不用再在网页上手动上传二进制。

```
git tag -a v1.4.2 -m "Subagent Model Seat 1.4.2"
git push origin v1.4.2
```

资产文件名不带版本号（`releases/latest/download/subagent-model-seat.tgz` 只解析 `latest`，文件名是字面量），所以老链接不会随版本更新失效。

## 本次新增（v1.4.1）

**卸载还原保证**：禁用或卸载插件后，界面精确还原到没装插件的原版状态——主对话框依然是原来的模型按钮（视觉与行为 1:1 复刻官方 `ModelSelect`），子智能体对话框的模型按钮消失（原版本来就没有）。这条由 DSH 的 fiber 生命周期保证，并用 `tests/cleanup.cjs` 做了自动化验证：

| 关注点 | 保证机制 | 源码依据 |
| --- | --- | --- |
| 两个注入槽（composer seat + 设置页）随卸载消失 | `slots.register`/`slots.inject` 内部用 `ctx.effect` 登记，fiber 停止时自动从 slot ledger 移除 | `cordis/src/fiber.ts:408-448`、`dsh-client-ui-renderer/src/client/registry.ts:741-747,209-270` |
| Host 路由随卸载注销 | 路由 `register` 的 disposer 由 `ctx.effect` 返回，fiber 停止时执行 | `dsh-host-webserver/src/index.ts:439-452`、本插件 `index.js:212-286` |
| 浏览器端代码与样式被清理 | `__DSH_BOOT__` 按 enabled 重算；client-hmr 推新 graph，浏览器 `entries.sync` 调 `loader.remove` + `prune()` 清 factories/loadCache/styles；刷新页面则冷启动更彻底 | `dsh-client-modules/src/index.ts:1043-1069`、`dsh-client-hmr/src/client/index.ts:50-56`、`dsh-client-modules/src/client/system.ts:450-488` |
| 不写浏览器持久状态 | 插件不使用 `localStorage`/`sessionStorage`/`indexedDB`/cookie，不往 `document.body` 挂私有节点（菜单用 `createPortal` 挂 body 但由 React 随卸载回收） | `tests/cleanup.cjs` 断言 |
| 会话模型记录保留 | `model/selection` 是 append-only 会话数据（与原版切模型写入的是同一种事件），插件卸载不回滚；要改回去再切一次模型即可 | `dsh-session/src/index.ts:1-7,972-992`、`dsh-agent/src/model-selection.ts:112-115` |

> 关于主对话框：DSH 的 `conversation.input.model` 是单槽（single），单槽没有条件退让机制（只有 chain 槽有 `select` 路由）。因此本插件以高 priority 全量接管该槽，但 `inject` 里对普通会话仍返回官方同构 props，并走官方 `session.selectModel` RPC（`client.js:1583-1605`），视觉与交互与官方 `ModelSelect` 一致。卸载后本插件组件随 fiber 移除，官方 seat 立即恢复。

## 本次新增（v1.4.0）

v1.4.0 专修设置页的三处实测缺陷（v1.3.0 交互投诉）：

1. **模型选择可搜索了**：设置页不再用原生 `<select>`（上百个模型时下拉溢出屏幕、无法输入）。改为与 composer 弹窗同源的浮层——带搜索框、按厂商分组、厂商标题吸顶、可搜厂商名与模型名。
2. **冷对话也能配置了**：模型目录改读全局 `remote.session.modelCatalog()`，不再依赖 `directoryFor(sessionId)`。后者要求会话有 scope 与 binding（只有当前打开/保留的会话才有），未打开的对话会直接抛错、列表为空。
3. **页面收紧**：两栏改 `220px / 1fr`，工具条压成一行，详情块减少留白与重复文案，树与详情各自限制高度。

同时补上：详情区与每个子会话行显示**当前模型**；写入失败按错误码给出可读原因；写入后本地立即回显（冷写入不会马上回灌投影）。

### v1.3.0 基线能力

- 弹窗搜索同时匹配模型名 / id 与厂商名 / id，命中厂商保留整组。
- DSH 设置新增独立分区「子智能体模型」：按工作区列出对话，可一键统一或逐个配置。
- 升级前已把 v1.2.0 完整备份到 `../backups/subagent-model-seat-v1.2.0-20261125-155527/`。

## 为什么需要 Host 半

原版 Client 侧用 `available = sessions.subagentAddress(sessionId) === undefined` 把子会话的 seat 关掉；即使绕过这个门禁，Host 的 `session.selectModel` 仍然会走到 `ApiSessionAgentController.resolveAgent`：

```
hasApiSessionSubagentOwner(session)  // session.header.origin === 'subagent'
→ apiSessionSubagentOwnershipError()  // session/agent-busy: "... is owned by subagent routing"
```

这是设计上的硬闸门，对 one-shot / continuable / unknown 一视同仁，配置改不了。

但写入本身没有闸门：`AgentModel.select()` 只是往会话日志追加一条 `model/selection` 事件，而 `AgentRegistry.get(id)` 根本不看 `session.header.origin`。所以插件的 Host 半复刻原版命令在解析出 Agent 之后的那两步——先用 `ctx.llm.resolveCallConfig()` 校验路由，再落事件——别的一概不做。

而历史子会话通常**根本没有活 Agent**：子智能体轮次一结束 `SubagentManager` 就 `dispose()` 掉 Agent，`resumeObserved()` 又对 `origin === 'subagent'` 直接抛 `ApiSessionSubagentOwnership`，所以「恢复成 live Agent 再改」这条路是封闭的。因此 Host 半有两条写入路径：

1. **有活 Agent**（可续聊子会话正在跑，或刚结束仍留存）→ `agent.model.select(selected)`，与官方命令一字不差，同时驱动内存里的模型投影。
2. **冷日志**（历史子会话、一次性子会话）→ 用 `ctx.sessionPersistence.open(id, 'write')` 读出事件、追加一条 `model/selection`、`flush()`、`close()`。这与内置 `dsh-message-feedback` 给非活会话写事件的做法一致；下一次这个子会话被续聊/恢复时，`AgentModel.current()` 从会话事件折叠出的 `modelSelection.pending ?? lastUsed` 就会带回这次选择。

## 工作原理

1. **抢占 seat**：以 `priority: 1000` 注册单槽 `conversation.input.model`。DSH 的单槽裁决是 `entriesOfSlot(key)[0]`（按 priority 排序），因此本插件取代原版 seat。
2. **忠实搬运原版面板**：不是仿制外观，而是照原版 `ModelSelect` 的同一套结构重写——根面板两个 `.cell`（`模型` / `档位`）各自下钻到独立列表，模型面板保留厂商分组、吸顶标题、超过 4 个模型才出现的搜索框、进行中的转圈，档位面板保留 `provider default` + 各档位并带勾选。Escape / Shift+Tab 先退回根面板再关闭。
3. **目录来源**：共享 `ctx.modelDirectories.directoryFor(sessionId)`，即 Host 模型目录 + 每会话模型选择投影，当前模型始终与会话真实状态一致。不调 `directory.load()`，因为它对子会话必抛。
4. **写入通道分流**：
   - 普通会话 → 原版 RPC `ctx.remote.session.selectModel(...)`（保留 resume 与默认模型持久化语义）；
   - 已寻址子会话 → 插件自己的同源路由 `POST /subagent-model-seat/select`（见下）。
5. **所有寻址子会话都可切换**：不再按 `mode` 只读——冷会话由 Host 写日志，续聊时生效。
6. **本地即时反馈**：冷日志写入不会立刻回灌到本视图折叠的投影，所以接受的选择先在本地显示，等投影一致后自动让位。
7. **子槽重放**：注册时声明并重放 `conversation.input.model.label` 与 `conversation.input.model.options`，agent-team 等其它插件在该槽的贡献不会丢失。

## 厂商搜索

搜索框的过滤规则（`filterGroups`）现在是：

```
needle 命中 `${厂商名} ${厂商 id}`  → 保留该厂商整组模型
否则命中 `${模型名} ${模型 id}`   → 只保留匹配的行
保留原有分组顺序，厂商命中优先于逐行匹配
```

也就是说，输入 `deepseek`、`GJLD`、`tencent` 会整组展开；输入 `GLM`、`hy4` 会定位到具体模型。空查询显示全部。

## 设置页：子智能体模型配置

注册在 `settings.section`（DSH 设置弹窗的独立分区，`id: subagent-model-seat`，`order: 20`），不占用 `settings.plugins.tab` 宿主。数据全部来自 DSH 已有的 client face：

| 用途 | 数据源 |
| --- | --- |
| 工作区树 | `ctx.workspaces.list` → `WorkspaceSnapshot.items[]`（`workspaceId/path/title/sessionIds[]`） |
| 对话信息 | `ctx.sessions.list` → `SessionListState.byId`（`id/title/displayTitle/parentId/origin/...`） |
| 可选模型 | `ctx.remote.session.modelCatalog()`（全局目录，与会话无关） |
| 当前模型 | 会话投影 `projectionValues.modelSelection` 的 `next ?? lastUsed` |
| 写入 | 复用 `POST /subagent-model-seat/select` |

### 为什么不用 `modelDirectories.directoryFor(sessionId)`

`ModelDirectoryResolver.directoryFor()` 要求 `sessions.scope(id)` 与 `sessions.binding(id)` 同时存在，否则抛 `ui-model-selection: session "…" resolved no scope/binding`；而 `binding(id)` 只对当前打开或保留中的会话有值。设置页要列的是**任意对话**，绝大多数是没打开的冷对话，走 `directoryFor` 会直接失败——这正是 v1.3.0「有的不能用」的原因。`remote.session.modelCatalog()` 是 Host 侧 `buildModelCatalog()` 的结果，全局一份，与选中哪个会话无关。

### 可搜索选择器

`ModelField` / `EffortField` 自绘触发器 + 浮层，不复用原生 `<select>`：

| 行为 | 实现 |
| --- | --- |
| 面板不被裁剪 | 面板用 `createPortal` 挂到 `document.body`，`position:fixed` |
| 位置跟随 | `useAnchoredPanel` 取触发按钮 `getBoundingClientRect()`，下方空间不足时改为向上弹 |
| 搜索 | 输入框即时过滤，规则与 composer 弹窗同一套 `modelEntries`（厂商命中保留整组） |
| 分组吸顶 | 厂商标题 `position:sticky; top:0` + 不透明底色 |
| 键盘 | `Esc` 关闭并回焦触发器；输入框内 `Enter` 选首个匹配行 |
| 跟随默认 | 列表首行固定「跟随会话默认」，选它则不下发写入 |

### 写入反馈

`applyTo()` 把响应归一成 `{ok, live, message}`：成功按 `live` 区分「当前会话即时生效」与「已写入日志，下次启动生效」；失败按错误码映射成可读文案（`session/writer-held` / `seat/model-unavailable` / `seat/session-not-found` / `seat/bad-request`），并附原始 code 便于排查。

页面行为：

- 左侧按工作区折叠列出对话，顶部有对话名过滤框；选中会话后右侧展开配置面板。
- **一键统一设置**：选一个模型（+可选档位），应用到该对话本身；因为它委派出去的子智能体默认继承父会话的 `model/selection`，新开的子会话就会用这个模型。
- **逐个配置**：递归 `parentId` 找出该对话下所有后代子会话，对每一个单独选择模型并应用；已经存在的子会话写它自己的 `model/selection`，下次续聊按新模型继续。
- 表单初值跟随选中会话当前路由；每次应用后给出「已应用 / 设置失败」反馈。

### 为什么写 `model/selection` 而不是 `subagent/model-selection-policy`

这两个事件用途不同：

- `model/selection`（`{provider, model, reasoningEffort?}`）是**实际模型**。子 agent 的默认参数由父会话的 delegation options 继承（`parentAgentOptionsForDelegation` → `resolveChildAgentOptions`），给父会话写这条事件，等于改它后续委派的子智能体默认模型。
- `subagent/model-selection-policy` 的 `allowedModels` 只是**允许列表**，用来限制用户能显式选哪些模型；在不显式选择时它根本不参与，单独写它不会改变实际使用的模型。

时序提醒：给父会话写完后，需要该会话在新模型下再跑一轮、产生新的 request header，后续委派的子 agent 才会带上新模型；已经跑完的历史子会话要按上面「逐个配置」写它自己。

## Host 路由

`POST /subagent-model-seat/select`，请求体 `{ sessionId, provider, model, reasoningEffort? }`：

| 情况 | 响应 |
| --- | --- |
| 成功（有活 Agent） | `200 {"ok":true,"selected":{...},"live":true}` |
| 成功（写入冷日志） | `200 {"ok":true,"selected":{...},"live":false}` |
| 方法不是 POST | `405` + `allow: POST` |
| 请求体超 8 KiB | `413 seat/body-too-large` |
| 请求体不合法 | `400 seat/bad-request` |
| 会话既没有活 Agent 也没有存储记录 | `404 seat/session-not-found` |
| 模型路由校验失败 | `409 seat/model-unavailable` |
| 该会话日志已被别的写者持有 | `409 session/writer-held` |
| 写日志失败 | `500 seat/write-failed` |
| 连接信任校验不通过 | `401` / `403`（同 `/api`） |

信任校验用官方同款 `ctx.connection.requestRejection(req)`（与 `dsh-host-open-in-app` 的三个路由完全一致），因此该路由不是无鉴权的裸口子。

## 视觉与交互

界面按 DSH 原版 `ModelSelect.module.css` 的量值复刻：

| 元素 | 规格（与原版一致） |
| --- | --- |
| 触发按钮 | 高 28px，13px/20px，次要文字色，`--dsw-radius-sm` 圆角，hover 用 `--dsw-alias-interactive-bg-hover` |
| 触发按钮内的 effort | 13px，标题色 `--dsw-alias-label-caption`，`flex-shrink:1000`（模型名先省略） |
| 菜单卡片 | `padding:4px`，`min-width:min(240px, 100vw-24px)`，`max-width:min(420px, …)`，`max-height:min(360px, 100dvh-96px)`，`--dsw-elevation-prominent` 阴影 |
| 根面板行 | 高 34px，`padding:0 8px`，13px/20px；左侧标签、右侧值（三级色、右对齐）、最右 12px 箭头 |
| 厂商分组标题 | 11px/16px、500 字重、`letter-spacing:.3px`、大写、三级文字色；**滚动时吸顶跟随** |
| 模型行 / 档位行 | `min-height:34px`，`padding:5px 7px`，13px/18px，`--dsw-radius-md`，hover/键盘高亮同一底色 |
| 选中态 | 不用底色，只在行尾显示 14px 勾选图标；提交中显示转圈 |
| 搜索框 | 目录超过 4 个模型时出现；透明底、无边框、12px（触屏 16px），有查询时右侧出现 24px 圆形清除按钮；**同时搜模型与厂商** |
| 键盘 | 搜索框用 `↓/↑/Enter`；无搜索框时 `↓/↑` 在可见行间循环、`Enter` 提交；`Esc` / `Shift+Tab` 先退回根面板再关闭，焦点还给对应 cell 或触发按钮 |

吸顶实现说明：官方靠 `@deepseek-ai/dsh-client-ui-primitives` 的 `MenuGroup` + `observeStickyMenuGroups`。本插件不需要它——用纯 CSS `position:sticky` 复刻同一效果（滚动容器 block 布局、分组标题 `top:0` + 不透明背景），已截图验证分组交接正常。

菜单定位说明：DSH 的 composer seat 带 `will-change: transform`，会成为 `position:fixed` 后代的包含块，菜单就地绘制会被裁到卡片内。本插件与官方一样用 `require('react-dom').createPortal` 把菜单挂到 `document.body`，再按触发按钮的 `getBoundingClientRect()` 算 `right`/`bottom`（打开期间监听 resize 与捕获阶段 scroll 重算）。`react-dom` 属平台种子模块，无需额外依赖。

样式全部收在 `<style>` 里（不写 `document.body`），类名统一 `sms-`（弹窗）/ `sms-set-`（设置页）前缀；每个主题 token 都带回退值。文案为内置中英双语（按 `navigator.language` 选择），未接入 DSH 的 `ctx.locale` 字典。

## 写了什么代码

整个插件是手写纯文本，无脚手架、无编译、无打包依赖。文件与职责：

| 文件 | 内容 |
| --- | --- |
| `index.js` | Host 半。注入 `webServer/connection/llm/agents/sessions/sessionPersistence`，注册受信任路由 `POST /subagent-model-seat/select`；实现两条写入路径（活 Agent / 冷日志）、请求体限额 8 KiB、错误码分流、会话存在性校验。 |
| `client.js` | Web Client 半，`window.__ModuleLoader__.load` 的 factory。内含：内置中英字典；弹窗 CSS 与设置页 CSS；`ModelSeat`（抢占 `conversation.input.model` 单槽的三级面板组件）；`filterGroups`（厂商 + 模型搜索）；`SettingsSection`（注册到 `settings.section` 的工作区/对话树配置页）；`postSelection`（同源 POST 封装）；`useFace`/`descendantsOf`/`modelOptions` 等辅助函数。 |
| `cordis.patch.yml` | 把 `@local/subagent-model-seat` 作为一个 include 条目插入 profile。 |
| `package.json` | 包名/版本/导出表/`dsh.bundle.patch` 与 `dsh.client`（platform=web、immediately、inject 依赖顺序）。 |
| `locale/*.json` | 插件展示元数据（标题 / 描述 / 详情链接），8 种语言。 |
| `icon.svg` / `docs/preview.svg` / `docs/DETAIL.md` | 插件图标、详情页示意预览（无文字的 SVG）、详情入口。 |
| `README.md` / `发布指南.md` | 本说明与分发安装指南（发布指南在工作区根目录）。 |
| `tests/cleanup.cjs` | 卸载还原契约测试：验证两个 slot 与 Host 路由随 fiber.dispose 全部注销、无浏览器/磁盘持久写入、`model/selection` 无回滚代码。 |
| `.github/workflows/release.yml` | 发版自动化：推 `v*` 标签后校验标签与 `package.json` 版本一致、语法检查、`npm pack`、算 SHA256、建 Release 并挂上 `subagent-model-seat.tgz` 与 `SHA256SUMS.txt`。 |

依赖的 DSH 契约（只读源码确认，未修改宿主）：`dsh-client-ui-model-selection`（目录 / 槽契约）、`dsh-client-ui-conversation`（composer seat 槽）、`dsh-client-ui-renderer`（单槽 priority 裁决）、`dsh-client-ui-settings`（`settings.section` 契约）、`dsh-api-session-controller`（会话投影）、`dsh-api-workspace-controller`（工作区投影）、`dsh-agent`（`AgentModel.select`）、`dsh-session-persistence`（冷日志写入）、`dsh-subagent`（子会话地址与继承链）。

## 验证

- `node --check`（经 Harness 的 Electron Node）：`client.js`、`index.js` 语法通过；`package.json` 与全部 `locale/*.json` 解析通过。
- 双半冒烟（`/tmp/smoke3.cjs`）：Host 活 Agent / 冷日志两条路径、重复选择、会话不存在、模型校验失败、信任拒绝；Client 注入面、`settings.section` 与 `conversation.input.model` 两个槽、各会话模式的可切换判定——全部通过。
- 渲染桩（`/tmp/render2.cjs`、`/tmp/render3.cjs`、`/tmp/render_settings2.cjs`）：触发按钮、展开菜单的两级 cell、设置页工作区树 / 一键块 / 子孙行 / 当前模型行都能无异常渲染（`render_settings2` 会真实点击会话行触发选中态）。
- 过滤测试（`/tmp/testfilter.cjs`）：空 / 厂商 / 模型 / 无匹配四类查询。
- 卸载还原契约（`tests/cleanup.cjs`）：两个 slot 注册在 fiber.dispose 后清零、Host 路由在 effect disposer 后注销、client/host 两半均无持久写入、无 `model/selection` 回滚代码——`CLEANUP CONTRACT PASSED`。
- 视觉：用真实主题 CSS 生成浅色 / 深色预览并截图核对，深色下无白底白字，分组标题吸顶交接正常；设置页浮层在滚动容器内不再被裁剪。
- 发版流程（`.github/workflows/release.yml`）：YAML 结构校验通过；标签与版本号一致性检查、`package.json`/`screenshots.json` 解析、`node --check` 两半代码、`npm pack` 与校验和生成都在流水线里跑，任一失败即不出 Release。

## 已知边界

- 原版 `ModelSelect` 组件没有从它的模块导出（`lib/client.js` 的 exports 只有 `ModelDirectory`、`ModelDirectoryResolver`、`apply`、`inject`），且 App 内不附带任何 TSX 编译器，因此这里是「同一结构 + 同一套 CSS 量值」的手写等价实现，而不是运行时 `require` 原版组件。
- 一次性 / 未知模式的子会话、以及历史冷会话，切换写入的是会话日志而不是内存投影：它会在该子会话**下一次被续聊/恢复**时生效；已经结束的轮次不会追溯改写。
- 设置页「一键统一」改的是父会话的默认委派模型，需要父会话在新模型下再跑一轮才反映到之后新派生的子会话；对已经存在的子会话请用「逐个配置」。
- 文案暂为内置中英双语（按浏览器语言选择），未接入 `ctx.locale` 字典；主题 token 全部带浅色回退。
- 设置页的「当前模型」读的是会话摘要投影，冷会话要等它被打开或再次运行后才有最新值；本页会先用刚写入的结果覆盖显示。

## 安装 / 卸载

### 从 GitHub 安装（推荐）

仓库地址：<https://github.com/macniu/subagent-model-seat>

```
plugin_manager action=install_bundle \
  target=github:macniu/subagent-model-seat
```

想钉住版本就加 `#` 后缀：`github:macniu/subagent-model-seat#v1.4.2`（tag）或 `#<40位commit>`（`git rev-parse HEAD` 的输出）。也可以把 `github:` 换成 `git+https://…` 用于 GitLab/自建 Git。

安装服务支持的形式见 `@deepseek-ai/dsh-plugin-manager/src/install-spec.ts`：registry 包名、**绝对**本地目录、git 地址（含 `#path:` 子目录）、tarball 直链。相对路径会被拒（`a local path must be absolute`）。

升级需先卸后装（同包名重复安装会返回 `already-installed`，`link:` 换成 git 会命中 `package-moved`）：

```
plugin_manager action=remove_bundle  target=@local/subagent-model-seat
plugin_manager action=install_bundle target=github:macniu/subagent-model-seat#v1.4.2
```

### 从 Release 的 tgz 安装（仓库装不了时的备选）

每个 Release 都附带一个预构建的 `subagent-model-seat.tgz`（文件名不带版本号，这样 `releases/latest/download/` 的链接不会随下次发版失效）：

```
# ① 下载
curl -L -o /tmp/subagent-model-seat.tgz \
  https://github.com/macniu/subagent-model-seat/releases/latest/download/subagent-model-seat.tgz

# ② 校验（可选，对照同目录的 SHA256SUMS.txt）
shasum -a 256 /tmp/subagent-model-seat.tgz

# ③ 安装（必须是绝对路径）
plugin_manager action=install_bundle target=/tmp/subagent-model-seat.tgz
```

> ⚠️ 实测差异：`plugin_manager install_bundle` 指向 tgz 时走的是 profile 的 `dsh.bundle.patch` 正规入口，会写 `cordis.patch.yml` 并在页面上生效；而 `dsh plugin --profile <name> add <tgz>` 只改 `package.json` 依赖、**不会**插入 patch 条目，插件不会自动启用。要让插件出现，用前者。

### 从本地目录安装

在本机开发时，直接安装绝对目录即可（profile 会以软链引用源码，改文件即时生效）：

```
plugin_manager action=install_bundle target=/absolute/path/to/subagent-model-seat
```

### 生效与卸载

Client 半在页面加载时注入，**安装或升级后需要整页刷新（或重启 DSH）**才会拉取新的 client bundle；Host 半即时生效。

卸载：从 profile 移除 bundle 即可——Host 路由随插件一起注销，插件自身不保存任何私有持久化数据，卸载后原版行为完整恢复。本地安装是软链到本目录，删除软链不影响源码；要彻底清空再删掉本目录（以及可选的备份目录）即可。

> 唯一留在磁盘上的痕迹，是你在会话里**自己切过模型**这件事：那是一条写进该会话日志的 `model/selection` 事件（和用原版在普通会话里切模型记录的是同一种事件）。它属于会话数据，不属于插件。
