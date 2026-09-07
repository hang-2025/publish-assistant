# Publish Assistant Development Rules

1. 阅读 `README.md`、`ARCHITECTURE.md` 后再修改核心代码。

2. 不允许通过删除测试解决失败。

3. 不允许未经明确任务开启：
   - 真实公开发布
   - 真实上传
   - Excel 写入
   - 文件移动
   - 删除
   - 真实归档

4. 不允许绕过：
   - Origin 检查
   - Token 检查
   - 路径安全检查
   - `checkRealActionGate`

5. 平台功能优先使用 Platform Adapter 实现。

6. 不在业务代码中大量新增 `if platform === xxx`。

7. 新平台必须声明 capabilities。

8. 修改后必须执行现有测试。

9. 不提交：
   - token
   - data
   - 用户文章
   - Excel
   - Chrome 登录数据
   - node_modules
   - 构建缓存

10. 真实发布功能必须独立任务开发和验收。
