# 易造发布助手 · 本地服务（受保护单篇草稿）

保留阶段 1A~2J 的只读/模拟能力，并提供受保护的知乎、搜狐号、头条号、网易号单篇保存草稿协调。发布包 HTML 先经扩展的 Canonical Article 层解析，平台回读后只有必需的 Fidelity Report 检查全部 PASS，服务才接受 `draft_saved`。公开发布、独立真实上传、Excel 写入、文件移动/删除与真实归档仍没有命令；服务不会保存 Chrome Cookie/Profile，也不会修改文章或 Excel。

## 运行步骤

需要 Node.js ≥ 18.17（无第三方依赖）。

```cmd
cd <项目目录>\yizao-sync-service
node server.mjs
```

- 默认监听 `http://127.0.0.1:8788`（仅回环地址，可用 `--port` 或环境变量 `YIZ_PORT` 修改）。
- 首次启动会生成配对令牌，打印在控制台并写入 `data/token`。
- 查看已有令牌：`node server.mjs --print-token`。
- 测试与数据目录隔离：`YIZ_DATA_DIR` 环境变量可重定向配置/令牌目录（测试脚本使用临时目录）。

## 配对方式（令牌不进网络、不进 URL、不进日志）

1. 启动服务，从控制台复制令牌；
2. 打开插件工作台 → 「服务配对」→ 粘贴令牌保存（保存在扩展 chrome.storage.local）；
3. 之后所有命令由扩展携带 `Authorization: Bearer <token>` 头访问 `/api/command`。

首次成功认证时，服务会把该 Chrome 扩展 Origin 记为唯一可信扩展；后续其他扩展即使拿到令牌也会被拒绝。令牌不在任何匿名接口发放；`/api/health` 只返回版本信息。

## 命令白名单（POST /api/command）

| 命令 | 说明 |
|---|---|
| `getConfig` | 读取目录配置状态 |
| `setConfig` | 设置未发布/已发布/归档目标授权目录和登记表 `.xlsx` 路径（只写本服务自身 `data/config.json`，不创建目录，拒绝互相嵌套） |
| `scan` | 只读扫描授权目录，返回文章卡片与问题摘要 |
| `getPackage` | 按受控包 ID 读取发布包详情（SEO、正文 HTML、图片 dataUrl、ALT、校验报告） |
| `prepareOfficialTask` | 官网/百家号只生成发送快照与执行预览，不创建任务、不启动执行器 |
| `simulateOfficialTask` | 官网/百家号仅本地模拟状态机，终态停在“等待用户最终提交（模拟）” |
| `getTasks` / `getTask` / `removeTask` | 查看/读取/清理纯模拟任务记录 |
| `previewExcelRegistration` | 按已配置 Excel 路径做登记匹配只读预览；只读工作簿，不写单元格、不登记、不归档 |
| `getCapabilities` | 返回平台能力矩阵：可模拟、草稿模拟、待适配、风险与验收状态 |
| `checkRealActionGate` | 查询真实动作闸门；默认拒绝，仅内部满足对应独立阶段、当次确认与快照复核的 `zhihu/sohu/toutiao/netease/xiaohongshu.saveDraft` 可放行 |
| `preflightPackage` | 发布前总预演：汇总发送快照、Excel 匹配、归档目标和真实动作闸门；只读不执行 |
| `generateRealExecutionChecklist` | 生成真实执行验收单和单篇小样本验收模板；只读返回 Markdown，不创建任务、不写文件、不上传、不发布、不登记、不归档 |
| `getShareableConfigTemplate` / `importShareableConfigTemplate` | 导出/导入不含个人路径、令牌和扩展 ID 的团队规则 |
| `previewArchiveGate` | 只读计算多平台共享包归档门槛，不移动文件 |
| `confirmPublishedSimulated` | 只更新任务的模拟人工发布确认状态 |
| `confirmExcelRegisteredSimulated` | 只更新任务的模拟登记确认状态，不写 Excel |
| `confirmArchivedSimulated` | 只更新任务的模拟归档确认状态，不移动、复制或删除文件 |
| `prepareZhihuDraft` | 校验知乎包、生成不可变快照并幂等创建任务；需要当次用户确认 |
| `beginZhihuDraft` | 重新读取源包核对快照后，仅授权该任务的 `zhihu.saveDraft` |
| `advanceZhihuDraft` | 按状态机记录上传、填写、保存进度，拒绝跳级 |
| `completeZhihuDraft` | 只在扩展报告保存成功且平台回读已验证后记录 `draft_saved` |
| `failZhihuDraft` | 持久记录失败；重启后不会自动重发 |
| `prepare/begin/advance/complete/failSohuDraft` | 搜狐号受保护草稿的同等五步握手；独立快照、确认、回读和失败记录 |
| `prepare/begin/advance/complete/failToutiaoDraft` | 头条号受保护草稿的同等五步握手；独立快照、确认、回读和失败记录 |
| `prepare/begin/advance/complete/failNeteaseDraft` | 网易号受保护草稿的同等五步握手；要求官方风控令牌、独立快照、确认、回读和失败记录 |
| `prepare/begin/advance/complete/failXiaohongshuDraft` | 小红书受保护图文草稿的同等五步握手；要求独立快照、当次确认及创作中心 IndexedDB 标题/正文/图片数量回读 |

任何其他命令（包括 publish/archive 等）都会被白名单拒绝。

## 架构分层

- `server.mjs`：最小进程入口；
- `routes/`：HTTP 安全边界与白名单命令分发；
- `services/`：兼容应用层和 Article 转换服务；
- `domain/`：统一 Article、Task 和生命周期状态；
- `platforms/`：模拟/未支持 Platform Adapter Registry；
- `repositories/`：内存 Article、JSON Task、只读 Excel 抽象；
- `lib/`：既有扫描、快照、任务、Excel、锁和路径安全能力。

完整说明见仓库根目录 `ARCHITECTURE.md`。

## 安全边界

- Host 必须为 `127.0.0.1:PORT` / `localhost:PORT`；Origin 必须为首次配对绑定的 `chrome-extension://<扩展ID>`（网页及其他扩展 Origin 一律 403）；
- 令牌校验使用时间安全比较；
- `getPackage` 只接受 `scan` 签发的包 ID（服务内存态，重启失效需重新扫描），不接受路径；
- `previewExcelRegistration` / `preflightPackage` 同样只接受受控包 ID，并且只读取 `setConfig` 已保存的 `.xlsx` 文件；不接受任意 Excel 路径参数；
- `checkRealActionGate` 默认返回 `allowed=false`；仅服务内部复核过的 `zhihu/sohu/toutiao/netease/xiaohongshu.saveDraft` 当次授权可例外放行；
- 所有文件访问经过 `resolveInside`：`fs.realpath` 解析 Windows junction/符号链接后复核仍位于授权根目录内；扫描不深入符号链接目录；
- 请求体按 UTF-8 实际字节限制为 1MB。

## 测试

```cmd
npm test
```

测试全部使用临时夹具或模拟 HTTP 响应，除既有覆盖外还验证：受保护平台未登录、公开发布拒绝、重复任务、快照变化、图片/保存/回读失败、HTML Caption/保真失败不得进入 `draft_saved`、非法状态转换和重启不自动重试。自动测试不会访问真实平台账号。

## 本阶段未实现（已知风险）

- 未接入官网/百家号真实执行器（跨进程互斥已有 `lib/mutex.mjs` 设计与测试，但未启动任何浏览器）；
- 未实现 Excel 写入登记与真实归档（旧 `archive.mjs` 的破坏性操作未复制启用）；
- 未做图片分块传输（当前 getPackage 整包返回，大图场景待后续阶段）；
- 当前采用“首次持令牌配对时绑定扩展 ID”；正式分发时仍需确定固定扩展 ID、令牌轮换和解除配对的安装流程。
- 知乎、搜狐号、头条号、网易号真实草稿实现均尚未用各自专用测试账号完成人工验收，所以能力表仍保持 `verified=false`、`saveDraft=false`；平台页面或接口变化仍可能导致实际验收失败。
