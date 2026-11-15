# Activity 字段与语义

权威校验实现为 `src/activity.ts` 的 `activitySchema`。未知顶层字段被拒绝。示例见 `examples/activity.json`。

| 字段 | 约束 |
| --- | --- |
| event_id | 必填；8–100 个英文、数字、`_` 或 `-`；每个 Vault 内唯一 |
| project / task_id | 必填；2–80 位小写英文、数字、`_`、`-`，首位英文或数字；复用稳定 ID |
| project_name / task_name | 必填；单行，分别最多 100 / 150 字符 |
| agent / session_ref | 必填；单行，最多 60 / 1000 字符；没有真实 URL 时用来源说明 |
| occurred_at | 必填；含时区的 ISO 时间，规范化为 UTC；超过当前时间 5 分钟拒绝 |
| kind | discussion / decision / progress / result / blocker / correction / observation |
| evidence | user_statement / observed_action / assistant_proposal / inference |
| status | discussed / planned / in_progress / completed / blocked |
| summary | 必填；单行，最多 1000 字符 |
| sources | 必填；1–12 条真实依据，每条单行最多 1000 字符 |
| details | 可选；最多 8000 字符，可多行，默认空串 |
| next_step | 可选；单行最多 1000 字符 |
| artifacts | 可选；0–12 条，每条单行最多 1000 字符 |
| supersedes | correction 必填，格式同 event_id；其他 kind 禁止使用 |

`user_statement` 是用户明确表达，`observed_action` 是实际操作，`assistant_proposal` 是未必被接受的建议，`inference` 是暂定推测。后两者只允许 discussed 或 planned；不能用它们取代已发生的任务状态。

更正需要新 ID，指向同项目同任务的旧事件，依据只能是明确表达或实际操作。旧事件保留，查询会隐藏被 supersedes 的旧记录。它不是删除接口。

同 ID 同规范化 payload 重试幂等，同 ID 改内容拒绝。建议保留第一次完整请求以原样重试；不要重排 sources、修改时间或新增字段后复用 ID。

## 读取与分页

`get_activity_context` 参数：days 默认 7，范围 1–90；limit 默认 30，范围 1–100；可用 project 过滤。date 为北京时间的 `YYYY-MM-DD`，覆盖 days，不是滚动 24 小时。

将 next_cursor 原样作为 cursor，保留其他参数，直到 null。分页按 occurred_at、event_id 降序；不是数据库事务快照，新写入或更正可能影响后续页。长期采集器应重复扫描时间窗口并按事件 ID 去重，不能假定分页覆盖所有并发写入。

activities 受窗口与分页限制；projects 是全库最多 100 个项目的概览；指定项目时 tasks 返回最多 100 个任务的最新明确记录，**不受 days/date 窗口限制**。这些是已提交证据，不是对 GitHub、部署平台或整个项目完成情况的实时验证。

返回还包括 pending_vault_sync、last_sync_error、源 path 和覆盖说明。缺记录只能说明未找到已提交活动。vault_synced 为历史回读标记，不会持续监视人工修改。
