# 易造发布助手

面向易造团队的 Chrome 扩展与本地配套服务。它用于扫描本地文章发布包、预览正文及图片 ALT/图注、生成发布前检查和人工验收材料。

## 当前阶段

当前代码包含 **知乎与搜狐号的受保护单篇草稿闭环（实现完成，真实账号验收待执行）**：

- 只有知乎或搜狐号 `saveDraft` 在用户当次明确确认、不可变快照复核和当前 Chrome 登录检查通过后可执行；
- 发布包 `02-后台一键复制正文.html` 是知乎草稿的 canonical source；复用 Canonical Article 块模型保持正文顺序与图片锚点，并按 `HTML img.alt` 生成可见 Caption；
- 保存后必须回读并生成 Fidelity Report，标题/正文主块/图片数量、顺序、锚点与 Caption 等必需项全部通过后才可进入 `draft_saved`；
- 知乎、搜狐号 `publish()` 与所有平台公开发布始终拒绝；
- 不修改真实 Excel；
- 不移动、删除或归档真实文章包；
- 不启动、停止或修改旧桌面自动发布助手；
- 不复制、保存或接管 Chrome Cookie/Profile；仅使用扩展所在 Chrome 的当前会话。

官网和百家号的模拟流程会停在“等待用户最终提交”；知乎和搜狐号具有受保护的单篇保存草稿与回读流程，未完成各自真实账号人工验收前 capability 仍标记 `verified=false`、`saveDraft=false`；网易号仅接入扩展本地草稿流程模拟；头条、小红书仍待适配。

## 目录

- `ARCHITECTURE.md`：领域模型、平台 Adapter、Repository、任务状态和安全边界。
- `yizao-sync-service`：仅绑定 `127.0.0.1:8788` 的本地服务，负责受控扫描、预览、任务模拟与只读验收材料。
- `wechatsync-source/Wechatsync-2`：Chrome 扩展源码。原始 GPL 许可证位于该目录的 `LICENSE`。
- `outputs/统一发布助手-PRD-v0.1-待确认.md`：产品需求草案。
- `outputs/易造发布助手-阶段2J验收材料交付记录-2026-09-07.md`：当前阶段交付与测试记录。

## 本地运行

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

## 协作安全规则

禁止提交：真实文章、Excel、配对令牌、服务 `data/`、日志、浏览器登录资料、账号文件、`node_modules`、构建缓存和旧助手文件。根目录 `.gitignore` 使用白名单策略防止误提交。

真实执行功能必须在独立阶段得到明确授权并通过小样本人工验收，不能因本仓库代码存在而自动开启。
