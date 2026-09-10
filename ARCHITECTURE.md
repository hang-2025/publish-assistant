# Publish Assistant Architecture

## 1. 系统组成

```text
Chrome Extension
        ↓  POST /api/command + Bearer Token
Local API (routes/local-api.mjs)
        ↓
Domain / Services
        ↓
Platform Adapters
        ↓
Local Files / read-only Excel / Future Database
```

- Chrome Extension 的易造工作台位于 `packages/extension/src/workbench`。它负责呈现文章、平台能力和任务状态，不直接读取任意磁盘路径。
- Windows 启动器位于 `yizao-sync-service/tools/launcher.mjs`，双击入口为 `yizao-sync-service/启动易造发布助手.cmd`。它只负责启动既有本地服务，并使用服务已持久化的受信任扩展 Origin 打开工作台；不会把 Bearer Token 放入 URL，也不会改变配对、Origin 或真实动作闸门。
- Local API 仅绑定 `127.0.0.1`，负责 Host、Origin、Token、请求大小、命令白名单和严格 payload 校验。
- `yizao-sync-service/services/application.mjs` 是兼容应用层，保留原有命令，并为知乎、搜狐号、头条号分别提供 5 条受保护草稿握手命令。
- `domain` 定义统一 Article、Task 和状态词汇；旧接口通过转换层渐进接入，不要求一次性迁移。
- `platforms` 是服务端 Platform Adapter Registry。知乎、搜狐号、头条号 Adapter 承接受保护的任务/闸门协调；其他 Adapter 仍只描述能力并承接模拟入口。
- `repositories` 隔离 Article、Task 和 Excel 存储。当前 Article 为内存投影，Task 继续使用 JSON，Excel 只读。

原 WechatSync 的平台网络适配器仍位于 `packages/core/src/adapters/platforms`。知乎、搜狐号与头条号 Adapter 均通过 `saveDraft()` 上传、保存并回读单篇草稿，`publish()` 明确拒绝公开发布。头条号的网络调用在当前编辑器页面主世界中执行，以保留官方页面自身的请求安全处理；不会读取、复制或保存 Cookie/Profile。`packages/core/src/article/canonical.ts` 在平台 Adapter 之前把发布包 HTML 解析为可复用 Canonical Article 块模型，并负责语义渲染、`Caption = HTML img.alt` 策略与平台回读 Fidelity Report；其他网络 Adapter 不等于 Workbench 已启用真实能力。

## 2. Article 生命周期

```text
发现 discovered
  → 校验 validated
  → 准备 ready
  → 执行 processing
  → 草稿 draft_saved
  → 人工确认 waiting_user_confirmation
  → 发布 published
  → 登记 registered
  → 归档 archived
```

旁路状态为 `failed`。发布、草稿、Excel、归档状态彼此独立，不能用一个“成功”字段代替。

`domain/article.mjs` 提供：

- `createArticle()`：建立统一 Article。
- `articleFromScanResult()`：把现有 scan 结果投影为 Article。
- `articleFromPackageDetail()`：用现有 getPackage 详情补全 Article。

当前 HTTP 响应保持兼容，Article Repository 是内部投影，不向调用方强制新增字段。

## 3. 平台 Adapter 设计

统一接口位于 `platforms/platform-adapter.mjs`：

```text
id / name / aliases / workflow / capabilities
checkLogin / prepare / validatePackage / createTask
saveDraft / publish / getStatus
```

当前平台分组：

- `platforms/official`：用户界面统一显示为“官方网站”平台；内部保留 eyzao.com、eyzao.cn、yzfanglei.com 三个站点 Adapter，分别执行包↔站点绑定、栏目映射与站点锁校验，当前仍为发布流程模拟。
- `platforms/baijiahao`：百家号发布流程模拟。
- `platforms/zhihu`、`platforms/sohu`、`platforms/toutiao`：受保护单篇草稿协调，各平台未完成人工验收前 `verified/saveDraft` 仍为 false。
- `platforms/netease`：扩展本地草稿流程模拟的能力声明，不包含平台网络实现。
- 小红书：`unsupported`，不得伪造草稿或发布成功。

新增平台时应依次修改：

1. 在 `platforms/<platform>/index.mjs` 实现 Adapter。
2. 在 `platforms/registry.mjs` 注册并声明 capabilities。
3. 在 `lib/capabilities.mjs` 增加证据、风险和真实动作策略。
4. 如需命令，在 `services/application.mjs` 增加严格 schema 的 Handler，并登记到白名单。
5. Workbench 只消费 `workflow/capabilities`，不新增大量平台名分支。
6. 为包与平台绑定、幂等、重启恢复、失败停止和安全闸门增加测试。

## 4. Task 状态机

Canonical 状态位于 `domain/status.mjs`：

```text
pending → validating → ready → running
        → uploading → filling → saving_draft
        → draft_saved → waiting_confirmation → published
```

旁路状态：`failed`、`cancelled`。`domain/task.mjs` 只将旧模拟任务投影到统一结构，不改变现有 JSON 格式和用户可见中文状态。

## 5. Repository 边界

- `article-repository.mjs`：当前使用内存，可替换为 SQLite。
- `task-repository.mjs`：包装现有 TaskStore，不改变 JSON 数据。
- `excel-repository.mjs`：只允许读取；`write()` 明确拒绝。

未来数据库实现应替换 Repository，而不是把 SQL、文件路径或 Excel 访问散落到平台 Adapter 和 UI。

## 6. 安全边界

当前构建只有三个分别限定的真实动作例外：

- 独立的真实上传命令仍禁止；仅知乎、搜狐号或头条号 `saveDraft` 内部所需图片上传随各自当次授权执行。
- 当前仍然禁止最终公开发布。
- 当前仍然禁止 Excel 写入。
- 当前仍然禁止文件移动、删除和真实归档。
- `checkRealActionGate` 默认拒绝；只在 `zhihu/sohu/toutiao + saveDraft + 对应独立阶段 + 当次确认 + 快照复核` 同时成立时允许。
- 知乎、搜狐号、头条号 Platform Adapter 的 `publish()` 拒绝；其他平台的 `saveDraft()`、`publish()` 继续拒绝。
- 不能绕过 Host、Origin、Token、扩展 ID 绑定、packageId、realpath、站点绑定、请求大小和命令白名单验证。
- `archive-sim.mjs` 的复制算法只在临时测试夹具中验证，没有暴露为 HTTP Command。

## 7. 后续路线

当前下一步是使用 Windows v3.4 验收包，分别以专用知乎、搜狐号、头条号测试账号和一篇非敏感 HTML 小样本完成人工验收。各平台必须独立验收；草稿 ID、标题或非空正文本身都不是完成证据，必需保真项还必须全部 PASS。在此之前不得把 capability 标为已验证。

再下一阶段：人工确认后的发布登记。将正式 URL、人工确认来源和状态证据纳入任务记录。

最后：Excel 写入、归档、安装包产品化。Excel 和归档必须分别经过备份、幂等、崩溃恢复及小样本验收后才可开放。
