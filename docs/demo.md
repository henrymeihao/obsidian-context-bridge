# 双 Agent 最小验收

使用专门的测试 Vault、D1、KV、Worker，不连接个人生产库。完成 DEPLOY 后再运行。`examples/vault/` 中共享目录仅供阅读，不要预置到测试写入目标；服务会自行创建 `Agent共享/`。

1. 把 `examples/vault/测试.md` 放入测试根目录并同步到坚果云。客户端 A、B 连接同一个测试 MCP，读取这篇笔记。
2. 明确授权例行活动写回，两个客户端安装 Skills。A 申请活动 scope；先让 B 仅申请读取 scope。
3. 以 `examples/activity.json` 为格式准备虚构事件：生成新的唯一 ID，把 occurred_at 换成实际当前时间，保留虚构标记。让 A 调用 append_activity，保存完整请求和响应。
4. 检查 `vault_synced=true`；如 pending，只能说队列已接受，先排查同步。通过 WebDAV / Obsidian 和 read_context 核对原事件。
5. B 用 get_activity_context(project="demo-project") 读取，核对 summary、evidence、status、path；B 尝试写入应被拒绝，读权限不等于写权限。
6. A 用完全相同 ID 和 payload 重试，确认不重复；同 ID 改 summary 应拒绝。
7. B 重新取得 activity scope，以新 ID 写一条 `assistant_proposal / planned` 建议。A 新会话读取，应看见建议，但 tasks 仍保留之前的明确进展，不能把建议当部署完成。
8. 测试结束保留必要的虚构验收证据；不要将真实令牌、密钥或个人事件放入 issue。测试资源的清理由部署者自行决定。

## 本地可自动验证的部分

`npm test` 使用内存 SQLite 和合成 WebDAV，包含从空 KV 的 OAuth/PKCE→MCP 写入→另一只读令牌读取，以及权限隔离、幂等、断网重试、更正和迁移保留旧索引。它不要求任何云端凭据。

`wrangler deploy --dry-run` 验证 Workers 打包；本地 D1 可单独执行 Schema 和迁移验证。以上都不能代替本页的真实云端双客户端验收。全新第三方账号端到端仍未验证。
