# 易造发布助手 · 本地只读原型服务（阶段 1A ~ 2J）

仅限原型验证：只提供目录配置、只读扫描、发布包读取、官网/百家号模拟任务、Excel 登记匹配只读预览、平台能力矩阵、真实动作闸门、发布前总预演和验收材料生成。**没有**真实发布、上传、Excel 写入登记、文件移动/删除命令，不会修改任何文章文件或真实 Excel。

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
| `checkRealActionGate` | 查询真实动作闸门；当前真实上传/公开发布/Excel 写入/归档移动均返回不允许 |
| `preflightPackage` | 发布前总预演：汇总发送快照、Excel 匹配、归档目标和真实动作闸门；只读不执行 |
| `generateRealExecutionChecklist` | 生成真实执行验收单和单篇小样本验收模板；只读返回 Markdown，不创建任务、不写文件、不上传、不发布、不登记、不归档 |
| `getShareableConfigTemplate` / `importShareableConfigTemplate` | 导出/导入不含个人路径、令牌和扩展 ID 的团队规则 |
| `previewArchiveGate` | 只读计算多平台共享包归档门槛，不移动文件 |
| `confirmPublishedSimulated` | 只更新任务的模拟人工发布确认状态 |
| `confirmExcelRegisteredSimulated` | 只更新任务的模拟登记确认状态，不写 Excel |
| `confirmArchivedSimulated` | 只更新任务的模拟归档确认状态，不移动、复制或删除文件 |

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
- `checkRealActionGate` 当前始终返回 `allowed=false`，用于防止模拟版本误触发真实上传、发布、写表或归档；
- 所有文件访问经过 `resolveInside`：`fs.realpath` 解析 Windows junction/符号链接后复核仍位于授权根目录内；扫描不深入符号链接目录；
- 请求体按 UTF-8 实际字节限制为 1MB。

## 测试

```cmd
npm test
```

1A~2J 测试全部使用系统临时目录夹具，覆盖：中文路径与空格、缺图、乱序、同名文件、重复图片（内容指纹）、空 ALT、已有图注与 ALT 冲突、junction 越界、`..` 越界、Host/Origin/令牌/扩展 ID 绑定/白名单/UTF-8 请求大小校验、服务重启后旧包 ID 失效、跨进程互斥锁、Excel 只读匹配预览、平台能力矩阵、真实动作闸门、发布前总预演、官网/百家号/知乎小样本验收模板和错误包平台绑定拒绝。

## 本阶段未实现（已知风险）

- 未接入官网/百家号真实执行器（跨进程互斥已有 `lib/mutex.mjs` 设计与测试，但未启动任何浏览器）；
- 未实现 Excel 写入登记与真实归档（旧 `archive.mjs` 的破坏性操作未复制启用）；
- 未做图片分块传输（当前 getPackage 整包返回，大图场景待后续阶段）；
- 当前采用“首次持令牌配对时绑定扩展 ID”；正式分发时仍需确定固定扩展 ID、令牌轮换和解除配对的安装流程。
- 验收材料不是执行授权；官网/百家号真实流程仍必须停在用户最终提交之前，知乎/搜狐真实草稿也尚未验收。
