# Stage 3 知乎 HTML 保真草稿本地验收（Windows v3）

> 本验收包只允许保存一篇知乎测试草稿。公开发布、Excel 写入、文件移动/删除、真实归档和其他平台均保持禁用。

## 三步验收

1. 解压 ZIP，先双击 `VERIFY-SHA256.cmd`，通过后双击 `START-HERE.cmd`。启动器会检查 Node.js、端口 8788 并等待本地服务就绪；首次启动时只把服务窗口显示的配对令牌粘贴到 Extension Workbench。
2. 在 `chrome://extensions` 开启开发者模式，选择“加载已解压的扩展程序”并直接加载 `extension-dist`。用户本人在当前 Chrome 会话登录一个专用知乎测试账号；在 Workbench 只选择一篇明确的非敏感测试文章，运行 `Preflight Acceptance Check`。版本、配对、Origin、登录、单篇选择、snapshot、Canonical HTML/Caption 策略和安全闸门必须全部通过。
3. 勾选当次确认后只点击一次“一键发布（知乎仅保存草稿）”。不得调用或点击公开发布。流程固定为：读取 `02-后台一键复制正文.html` → Canonical Article 解析 → 原位置上传图片 → `Caption = HTML img.alt` → 保存草稿 → 平台回读 → Fidelity Report。只有必需项通过才会成为 `draft_saved`，随后可从任务中心打开草稿并导出非敏感证据 JSON。

## Fidelity Report 规则

- 必需 PASS：标题、正文文字及主块顺序、strong/emphasis 语义、图片数量、图片顺序、图片相对正文锚点、每张图 Caption 等于源 HTML `img.alt`、受信任草稿 URL、`draftOnly`、平台回读。
- 可显式 DEGRADED：平台规范化后的 H1-H3、列表、引用、链接和表格语义；表格只承诺单元格语义，不承诺像素级样式。
- Caption 当前验收策略上限为 200 个 Unicode 字符；超限会在 Preflight 阻止，不会静默截断。
- 当前 capability 不承诺知乎提供独立的无障碍 ALT 字段（`imageAlt=false`）；HTML `img.alt` 仍会写入请求，但本轮唯一强制且可回读的映射是可见 Caption。
- 任一必需项 FAIL 时，即使知乎已返回草稿 ID，也不得标记 Stage 3 verified 或 `draft_saved`，不得自动重试。

## 失败规则

- 任一关键项失败都不得视为 `draft_saved`，不得自动重试生成第二份草稿；应先人工查看知乎草稿箱。
- `START-HERE.cmd` 返回错误码 10/11 表示 Node.js 缺失或版本过低，12 表示端口占用，13/14 表示服务启动失败或健康检查超时；启动器不会接管已有服务。
- 若出现失败或结果未知，先在知乎草稿箱人工核对，再把不含账号、文章正文和凭据的失败步骤反馈到 Draft PR #4。
- 本包只是待验收构建，不代表真实账号验收已经完成。真实验收完成前，知乎 capability 必须保持 `verified=false`、`saveDraft=false`，PR #4 必须保持 Draft，Issue #3 必须保持 Open。

`public publish remains disabled`
