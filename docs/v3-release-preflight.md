# V3 Release Blocker 复验（2026-11-21）

结论：旧 generation 误删索引的阻断已消除，候选可在 owner 另行确认后进入生产 rollout。本轮仅本地代码、测试及文档，未运行生产迁移、部署或 push。基线 `dfc2b9b`，在当前分支已有 `5499521` 上继续收紧，未扩展个人记忆功能。

## 安全策略

全局 Sweep 禁用，采用“完整 Mark → 持久化待核实清单 → 每条独立 GET 404 → 精确条件删除”。目录列表缺失、单个目录 404、超大文件都不是删除笔记的证据。任何不能确认的条目保留。

- 新扫描必须由当前代码从根开始，持久化 `scanVersion=2`、根目录遍历完成证据、generation、队列、待处理文件、延迟项与核实阶段。只有旧 `pruneSafe` 标记也不授予本版清理资格。
- 旧/过期/异常时间 generation 排空后重新排根扫描，保留内容与已完成更新，不推进 `lastFullScanAt`。
- 根或子目录错误、404、截断、文件变化/跳过项阻止本轮生成清理候选；暂时错误保留并退避，后续干净扫描再核实。
- 核实队列持久化并受请求预算约束；403/503 等错误重试而不删除；GET 200 保留；GET 404 才执行带 path 和 generation 条件的 DELETE RETURNING。每个实际删除记录固定原因 `verified_note_404`、路径和时间。
- 正常分轮、重启后继续已持久化的工作；核实阶段的根遍历证据失效时重新根扫描，不尝试清理。完成后重复执行不重复删除。
- 原始 WebDAV Markdown 不删除、不改写；不清空 notes；Memory、Activity、OAuth、写回接口和迁移均未改变。

## 自动验证

`npm run check` 和 `npm test` 通过（61 项）。覆盖：旧 generation 的 33 个失效目录与仍存在的未标记笔记、文件型 SQLite 关闭/重开模拟扫描中途重启、正常完整根扫描、根 403/404/503、子目录 503/404、目录列表截断、文件在分页读取中变化、核实失败与重试、超大文件保留、无根证据的核实队列拒绝，以及重复扫描/清理幂等。

隔离 workerd + D1 + KV + OAuth + 模拟 WebDAV 演练 13 项通过：旧 scopes 隔离、新工具、幂等、版本修订、旧 Activity/read/diet 接口、404 队列恢复、WebDAV 故障写回重试、手改视图保护、使用预检下载旧 Worker 的回退/再次升级、扫描中途 Worker 重建后的持久状态恢复，以及真实 workerd D1 绑定中的逐路径 GET 404 清理。不是 ChatGPT/Codex 真实客户端 E2E 或 Skill 自动触发验收。

```sh
npm run check
npm test
npx wrangler deploy --dry-run --config wrangler.example.jsonc --outdir work/preflight-current-bundle
node scripts/rehearse-release.mjs --rollback-bundle <私有备份中的旧Worker-index.js>
npx tsx scripts/verify-index-backup.ts --backup-sqlite <私有备份中的production-d1-restored.sqlite> --report-dir <私有验证目录> --baseline dfc2b9b
```

测试脚本拒绝向外部服务发送请求，WebDAV 只用内存模拟；完整历史备份仅在 owner 私有目录复制、读取与验证，不进入仓库。隔离演练需先打包当前候选；脚本生成的 cron 包装器仅用于本地测试，不能作为生产部署入口。

## 生产备份副本差异

输入为预检中已验证恢复的 V2 SQLite：638 notes、68 Activity、7 index_meta。原备份 SHA-256 在验证前后相同。所有目录和文件响应均是从快照构造的离线模型，不代表已查验现在的生产 WebDAV。

| 阶段 | notes | 286 条旧 generation 未标记记录 | 删除依据 |
|---|---:|---|---|
| 输入备份 | 638 | 原始集合 | 无 |
| 原始 dfc2b9b 处理完旧目录 | 352 | 全部误删 | 未标记，无独立存在性验证 |
| 修复候选处理完旧目录 | 638 | 全部保留 | 无删除 |
| 新根遍历与独立核实完成 | 637 | 仅模型中的 1 条已删除文件被清理 | 该路径独立 GET 404 |

离线模型另故意漏列一条实际存在的笔记，其 GET 200 后索引保留。637 条存续索引正文与模型源内容逐条相同；68 条 Activity 的全行指纹不变。首轮新遍历与核实在 14 次调用内完成，中途关闭/重新打开隔离数据库；冷却期内重复调用及随后强制启动的另一轮完整扫描均无额外删除或正文变化。两轮各 14 次调用，共 255 次模拟请求。私人验证目录的 `private-deletion-details.json` 保存修复前每条误删路径及原因、修复后每条精确删除路径/原因/时间；公开文档不复制私人路径或笔记正文。

## 风险、部署门槛与生产指标

新增成本为未标记候选的独立 GET；受每轮请求预算和逐项退避约束。保守保留可能使失效/超大/不可访问条目暂留索引；这是明确选择，不能将其当成当前事实，必要时实时 read_context。超过 24 小时的长扫描会重扫并继续保留旧索引。目录错误/截断时 `complete` 可以表示本轮终止，但不能单看它认定全库新鲜。

原 Preflight 的 D1/schema、scope、幂等与回退结论保留；恢复副本不是上线时刻备份。批准上线后必须先重新导出生产 D1、记录 Time Travel bookmark、当前 Worker 版本/配置与内容指纹，验证导出恢复（已有原始 SQL NUL 的情况需使用经过验证的可恢复副本），保留 Secrets 和原 D1/KV binding，再执行 0002 与部署候选。

部署后分开验收：

1. 旧接口可用、Activity 数量与内容未丢失、新 MCP 工具和独立 scope 正确。
2. 旧目录队列持续下降，随后出现新 generation 和根遍历证据；旧队列结束时不能减少未标记集合。
3. 新扫描及核实队列持续推进；目录错误/截断、`skipped`、重试均必须被检查。只有干净扫描与核实结束才推进 `lastFullScanAt`。
4. 每条索引删除都有本轮 `deletions` 中的独立 GET 404 原因；发现无法解释的数量骤降时停止放行并核查。这里仅删索引，不能出现原 Markdown 删除/改写请求。
5. 用已授权测试内容比对 read_context、search_context/recall_memory 的路径、行号和逐条 indexedAt。没有内容变化时 MAX(indexed_at) 不一定前进。

代码回退仍使用预检记录的旧 Worker 版本，保留新增表、D1、KV 与记忆 Markdown；不以清库/drop 表作为回退。Worker 回退不会恢复数据。生产扫描恢复、真实双客户端闭环及 Recall@5 仍待后续阶段验证，本轮不声称已完成。
