# Workers Paid Staging 验收 — 2026-11-24

**Go：核心 Staging 验收通过，可提交生产发布审批；尚未切换生产。**

- 候选代码：`f6a5fe1acf460f93abc693957c05bf66359efb3d`。
- 实测 Staging 版本：`6e439a57-5b60-423c-8a8f-3dff37125b72`，Worker `ocb-perf-f6a5fe1-1122`。
- 生产仍为 `aaceb93e-e25b-47c8-8b1c-6b05d06d9c02`（原 `b2d239d` 基线），100% 流量；部署和设置前后相同。
- Paid 已在官方控制台核实；Staging 显式 CPU 上限 30,000ms。独立 D1/KV，专用 WebDAV 根 `ocb-staging-f6a5fe1-20261123`，无 Cron。按用户后续明确授权复用现有坚果云账号；没有访问真实 Obsidian 正文。

## 实测结果

固定虚构十题各重复十次，**100/100 完整 MCP Recall 成功，目标全部 Top1，客户端逐次记录无 HTTP/工具错误**。这不是一百道独立问题或私人历史召回验收。

|Cloudflare 平台指标|p50|p95|p99|
|---|---:|---:|---:|
|CPU（ms）|7.819|12.747|254.683|
|墙钟（ms，包含后台工作）|1004.906|1777.280|8800.261|

来源：独立 Recall 窗口的 GraphQL Adaptive Analytics；微秒换算毫秒。该接口汇总为 **98 次 success、0 errors**，与客户端 100 次逐条记录有覆盖差异，因此不声称拿到了全部一百次逐条平台日志。CPU 含实际后台索引工作；不是客户端墙钟或本机 CPU。未观察到 CPU 超限，Paid 的 30 秒上限解决原 Free 10ms 边界，并不意味着 CPU 都低于 10ms。

- **9 项功能检查通过**：Memory 新增并真实 WebDAV 回读、修订、语义去重、同 ID 内容冲突拒绝、独立会话 current/timeline 读取；Activity 写入、幂等及视图同步；OAuth PKCE 和独立 Memory scope。
- **4 项恢复检查通过**：此前失败的 Memory 原 ID/原 payload 重试后同步成功；失败 Activity 恢复且视图更新；越界路径拒绝；D1 完整性正常。
- **云端索引通过**：等规模已建索引的稳定遍历约 **40.46 秒、两次调用完成**，检查点跨调用续跑；独立 GET404 后仅清理一个虚构失效索引，原 765 条基础索引保留。没有做全量冷启动正文下载。
- 最终隔离库为 **783 notes / 5 Memory / 82 Activity**；新增 notes 来自生成的测试事件与视图。`PRAGMA quick_check=ok`，原数据保留、测试记录增量写入。
- 同一计量窗口 D1 报告读 **3,583,028** 行、写 **1,094** 行；KV 读 **90** 次。含后台索引，属于平台 Adaptive 统计。

## 已知边界与费用

765 篇虚构笔记约 3.73MB；网页批量上传成功，WebDAV 数量一致，5 篇核心笔记已回读。**用户明确要求停止进一步校验，全量远端内容指纹校验已跳过，不列为通过项。** 归档填充笔记分两目录，避免坚果云单目录 750 项限制；语料数量和正文规模不变。所有写入路径均预先限定在专用根内。

Workers Paid 最低 **$5/月**，超额另计。若账号含额未被其他应用使用，将本次组合投影到每日 1,000 次 Recall，CPU、D1 和 KV 仍在含额内。完整月账单仍取决于实际写入、扫描、日志及其他应用，不能保证固定 $5。坚果云免费账号 WebDAV 为每 30 分钟最多 600 次；本轮未扩大为冷扫描或压力测试。

## 生产备份、发布与回滚

已完成生产只读备份：D1 导出及本机离线恢复、Time Travel bookmark、当前 Worker bundle/设置/Cron、OAuth KV 安全备份；均存于仅所有者和 SYSTEM 可访问的本机目录，**不入库**。KV 是非原子快照；正常发布和回滚保留当前 KV，不以备份覆盖活跃授权。D1 原始导出含 NUL 文本，保留原件，并将对应字面量无损转成 UTF-8 hex TEXT 后完成离线恢复；未修改远程数据。

1. **等待用户单独确认生产切换**；获准前重新核对生产版本、绑定及备份时间，必要时刷新备份。
2. 从已验收候选的干净工作树，使用准备好的生产配置部署；保留原生产 D1/KV/Secrets/Cron。无 schema 迁移，不安装或覆盖客户端 Skill，不合并 Cloud Run 实验代码。
3. 上线检查 OAuth、Recall、Memory/Activity 及 CPU/错误；异常立即回滚 Worker 到 `aaceb93e-e25b-47c8-8b1c-6b05d06d9c02`，保留 D1/KV 和新增历史，不做数据降级或快照覆盖。

Staging 测试结束后已关闭公开入口和 previews，保留资源与本机证据。没有生产发布或生产数据库写入。

参考：[Workers 费用](https://developers.cloudflare.com/workers/platform/pricing/)、[D1 费用](https://developers.cloudflare.com/d1/platform/pricing/)、[KV 费用](https://developers.cloudflare.com/kv/platform/pricing/)、[坚果云 WebDAV 限制](https://help.jianguoyun.com/?p=2064)。
