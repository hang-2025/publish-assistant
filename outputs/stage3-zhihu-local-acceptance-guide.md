# Stage 3 知乎单篇草稿本地验收

> 本验收包只允许保存一篇知乎测试草稿。公开发布、Excel 写入、文件移动/删除、真实归档和其他平台均保持禁用。

## 三步验收

1. 解压外层 ZIP，双击 `start-local-service.cmd`。首次启动时只把控制台配对令牌粘贴到 Extension Workbench；不要复制、导出或提交 Cookie、Profile、密码、验证码、`local-service/data` 或日志。
2. 在 `chrome://extensions` 开启开发者模式，解压 `extension-dist.zip` 后选择“加载已解压的扩展程序”。用户本人在当前 Chrome 会话登录一个专用知乎测试账号；在 Workbench 只选择一篇明确的非敏感测试文章，运行 Preflight，核对标题、正文、图片数量、ALT/caption 问题和 snapshot。任何阻塞都必须停止。
3. 勾选当次确认后只点击一次“保存一篇知乎草稿”。不得调用或点击公开发布。完成后核对标题、正文、图片数量/顺序/位置/清晰度、知乎实际支持的 ALT/caption、受信任的 `https://zhuanlan.zhihu.com/.../<id>/edit` 草稿地址、`draftOnly=true`、`readBackVerified=true`、Workbench 可打开草稿，以及重复点击被幂等保护阻止。

## 失败规则

- 任一关键项失败都不得视为 `draft_saved`，不得自动重试生成第二份草稿。
- 若出现失败或结果未知，先在知乎草稿箱人工核对，再把不含账号、文章正文和凭据的失败步骤反馈到 Draft PR #4。
- 真实验收完成前，知乎 capability 必须保持 `verified=false`、`saveDraft=false`，PR #4 必须保持 Draft。

`public publish remains disabled`
