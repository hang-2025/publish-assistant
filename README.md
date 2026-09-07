# 易造发布助手

面向易造团队的 Chrome 扩展与本地配套服务。它用于扫描本地文章发布包、预览正文及图片 ALT/图注、生成发布前检查和人工验收材料。

## 当前阶段

当前代码为**只读 / 模拟验收版（阶段 2J）**：

- 不上传真实文章；
- 不调用真实账号保存草稿或公开发布；
- 不修改真实 Excel；
- 不移动、删除或归档真实文章包；
- 不启动、停止或修改旧桌面自动发布助手；
- 不使用真实 Chrome 登录资料。

官网和百家号的模拟流程会停在“等待用户最终提交”；知乎、搜狐只提供草稿流程模拟和验收模板；头条、网易、小红书仍是待适配状态。

## 目录

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
