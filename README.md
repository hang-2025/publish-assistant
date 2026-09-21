# 易造发布助手

面向易造团队的 Chrome 扩展与本地配套服务。它用于扫描本地文章发布包、预览正文及图片 ALT/图注、生成发布前检查和人工验收材料。

## 当前阶段

当前代码包含 **知乎、搜狐号、头条号、网易号、小红书、CSDN、豆瓣与抖音文章的受保护单篇草稿闭环（实现完成，完整真实账号验收待执行）**：

- 只有知乎、搜狐号、头条号、网易号、小红书、CSDN、豆瓣或抖音 `saveDraft` 在用户当次明确确认、不可变快照复核和当前 Chrome 登录检查通过后可执行；
- 发布包 `02-后台一键复制正文.html` 是受保护草稿的 canonical source；复用 Canonical Article 块模型保持正文顺序与图片锚点，并按 `HTML img.alt` 生成可见 Caption；若 ALT 以“图片N：/图N：”开头，会先去掉该打包编号，只显示实际说明；
- 保存后必须回读并生成 Fidelity Report，标题/正文主块/图片数量、顺序、锚点与 Caption 等必需项全部通过后才可进入 `draft_saved`；抖音文章通过官方“一键导入”上传由当前快照临时生成、内嵌图片的 DOCX，不直接覆盖网页富文本 DOM；
- 知乎、搜狐号、头条号、网易号、小红书、CSDN、豆瓣、抖音 `publish()` 与所有平台公开发布始终拒绝；
- 不修改真实 Excel；
- “未归档文章”和“已归档文章”使用两个独立页面，不在同一列表混排；
- 文章卡片右上角提供独立的小圆圈归档入口；仅在用户当次确认后，将单个文章包从“未归档”移动到配置中的独立“已归档”目录，不混入“已发布”目录；
- 归档不写 Excel、不触发平台发布、不覆盖同名目标；已归档页面只读展示；
- 不启动、停止或修改旧桌面自动发布助手；
- 不复制、保存或接管 Chrome Cookie/Profile；仅使用扩展所在 Chrome 的当前会话。

官网和百家号的模拟流程会停在“等待用户最终提交”；八个主流平台具有受保护的单篇保存草稿与回读流程，未完成各自完整真实账号人工验收前 capability 仍标记 `verified=false`、`saveDraft=false`。各平台图片下方只显示去除“图片N：/图N：”打包编号后的 ALT 说明。小红书使用“写长文”草稿，正文最多 10000 字；豆瓣使用新版 topic 编辑器的私密草稿库，不调用公开发布接口。

## 目录

- `ARCHITECTURE.md`：领域模型、平台 Adapter、Repository、任务状态和安全边界。
- `yizao-sync-service`：仅绑定 `127.0.0.1:8788` 的本地服务，负责受控扫描、预览、任务模拟与只读验收材料。
- `wechatsync-source/Wechatsync-2`：Chrome 扩展源码。原始 GPL 许可证位于该目录的 `LICENSE`。
- `outputs/统一发布助手-PRD-v0.1-待确认.md`：产品需求草案。
- `outputs/易造发布助手-阶段2J验收材料交付记录-2026-09-07.md`：当前阶段交付与测试记录。

## 本地运行

Windows 日常使用可直接双击：

```text
yizao-sync-service/启动易造发布助手.cmd
```

启动器会检查并启动 `127.0.0.1:8788` 本地服务，然后读取已经绑定的扩展 Origin，直接打开对应的工作台。Bearer Token、Origin 绑定与所有真实动作安全闸门仍然保留；首次安装仍需配对一次，之后只要不移除已配对的扩展，就不需要重复粘贴令牌或填写配置。

如果尚未完成首次配对，启动器只会打开 Chrome 扩展管理页，并在本地窗口中显示配对令牌；令牌不会放入 URL、命令行参数或 Git。

服务：

```powershell
cd yizao-sync-service
npm test
npm start
```

扩展：

```powershell
cd wechatsync-source/Wechatsync-2/packages/extension
npm run typecheck
npm run build
```

Chrome 打开 `chrome://extensions`，开启开发者模式后加载：

```text
wechatsync-source/Wechatsync-2/packages/extension/dist
```

## 同事首次安装或升级

以下流程不会删除或覆盖 `yizao-sync-service/data/`、令牌、个人目录配置、任务记录、文章或 Excel。不要使用 `git reset --hard`，也不要复制别人的 `data/` 或 Chrome Profile。

```powershell
cd <publish-assistant 项目目录>
git status --short
git fetch origin
git switch codex/fix-guarded-draft-workflow
git pull --ff-only origin codex/fix-guarded-draft-workflow

cd wechatsync-source\Wechatsync-2
corepack pnpm install --frozen-lockfile
cd packages\extension
npm test
npm run typecheck
npm run build

cd ..\..\..\..\yizao-sync-service
npm test
```

升级完成后必须同时更新两端：

1. 关闭仍在运行的旧 `node server.mjs` 本地服务，再双击 `yizao-sync-service/启动易造发布助手.cmd`；
2. 在 `chrome://extensions` 对“文章同步助手”点击“重新加载”；
3. 关闭所有旧工作台标签页，从扩展图标重新打开工作台；
4. 顶部 `Service / Protocol / Extension / Build` 全部通过，并显示 `stage8-douyin-article-entry-v3.12` 后再测试草稿；
5. 每台电脑分别登录自己的平台账号并完成首次服务配对，禁止共享令牌、扩展 Origin 或 Chrome 登录目录。

如果 `git status --short` 显示同事修改过源码，应先提交到自己的分支或备份，然后再升级；不要用强制覆盖解决冲突。启动器现在会严格校验服务构建，旧服务占用 8788 时会明确报出实际构建和所需构建，不再让新扩展静默连接旧服务。

## 协作安全规则

禁止提交：真实文章、Excel、配对令牌、服务 `data/`、日志、浏览器登录资料、账号文件、`node_modules`、构建缓存和旧助手文件。根目录 `.gitignore` 使用白名单策略防止误提交。

真实执行功能必须在独立阶段得到明确授权并通过小样本人工验收，不能因本仓库代码存在而自动开启。
