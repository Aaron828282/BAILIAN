# 百炼中转工作台 - 项目长期记忆

## 项目基线

- 项目：Node.js 24 + SQLite 的百炼 Key 池中转服务，生产域名为 `https://polarix.art`。
- 运行入口：`npm.cmd start`；本地验证：`npm.cmd test` 与 `npm.cmd run check`。
- 部署：GitHub `main` 推送后由 Hostinger 自动部署。生产变更必须等待部署完成并用公开接口复核。
- 数据：生产 SQLite 与环境变量由 Hostinger 持久化，严禁将中转 Key、阿里 Key、管理员密码、Vault Key 或完整结果签名 URL 写入本文件。
- 回滚：优先 `git revert <commit>`，推送后等待 Hostinger 自动部署；不得覆盖生产数据库。

### 2026-09-11 - 任务状态查询改为按请求 ID 免鉴权

- 状态：已完成并经本地与生产验证。
- 范围：`src/app.cjs`、`test/billing.test.cjs`、`docs/接口说明.md`；`GET /v1/tasks/{request_id}`。
- 目标：Dify 按 Relay 请求 ID 轮询任务状态时不再要求中转 Key；其他 `/v1/*` 接口继续鉴权。
- 根因背景：Dify 查询节点使用的 Secret 无法通过生产 Key 校验而返回 401，但提交任务已经成功。用户明确授权将只读任务查询改为免鉴权。
- 实施修改：把严格格式匹配的任务查询路由放到 `/v1/*` 统一鉴权之前；只允许 GET 和 `[a-zA-Z0-9_-]+` 任务 ID；未知任务仍返回 404。提交、模型目录、余额、用量和管理接口未开放。公开查询响应移除内部上游 Key ID、中转 Key ID/标签及计费字段。
- 验证结果：`npm.cmd test` 为 45/45 通过；`npm.cmd run check` 检查 21 个脚本通过；GitHub 提交 `680d46f` 已由 Hostinger 部署。生产环境对一条既有成功任务执行无 Header GET，返回 HTTP 200、`status=succeeded` 与视频结果；Dify 单节点随后返回 SUCCESS。未提交新视频、未产生新费用。
- 安全影响：请求 ID 现在等同于只读结果访问凭证。不得公开、写入公开日志或使用可预测 ID；视频结果 URL 仍可能带时效签名。
- 回滚位置：`git revert 680d46f` 后推送；回滚后 Dify 查询必须恢复使用创建任务所属的同一枚有效中转 Key。
- 剩余风险：Hostinger 运行时日志目前只显示进程启动/错误，不记录每次 HTTP 请求；公开查询缺少速率限制。若后续对外开放给不可信调用方，应增加查询限流、结果过期或单独的查询令牌。
