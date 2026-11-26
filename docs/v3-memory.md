# V3：个人与 Agent 共享的长期记忆

## 情景保真度升级（2026-11-26）

使用现有字段实现分层记忆，不迁移数据库、不修改既有不可变事件：

- L2 `summary`：简短结论或当前探索状态；尚未决定须明确保留。
- L1 `context`：保存相关背景、用户表达的感受与理由、观点变化、当前立场和未决问题，现有上限 4000 字符。没有证据的过程不能补写。
- L0 `source_refs` / `session_ref`：实际来源及必要的已授权短摘录。链接不保证未来可访问，不能将事件摘要冒充原始会话。

`recall_memory` 新增可选 `detail="summary"|"context"`，默认 summary 保持紧凑；context 模式对个人 Memory 返回完整已存 `context`，非空时另有 `context_source` 行号。主 `source` 仍指向摘要，排序、类型过滤和有效性规则不变。Activity/普通笔记保持原有返回粒度。未同步事件的行号只是预期镜像位置，只有 `vault_synced=true` 才能称为已落盘；空上下文不提供 context_source。默认模式仍会用 context 检索，但不回传全文。

```json
{"query":"当时为什么考虑换方向","topics":["career-transition"],"detail":"context","limit":3}
```

召回去重对个人 Memory 使用不可变 ID，保留摘要相同但情景或修订不同的事件；存储层原有内容去重不变。无需部署即可通过旧接口的 `read_context(hit.source.path)` 深入读取已保存事件；旧服务不接受 detail 参数时，Skill 使用此路径降级。旧记录缺失的情景不会自动恢复。

Skill 捕获规则同时覆盖有具体个人矛盾、选项理由、认知转折或可接续未决问题的探索，即便尚未形成最终结论，也可按 `exploration` / `considering` 保存。裸问题、通用头脑风暴、无变化重复不写。既有授权、去重、证据归属、敏感内容边界和不可变修订规则保留。同一结论出现新的重要情景时，应比较完整 context，不能只看摘要就丢弃。

历史回填须逐个读取指定原始来源，保留原发生时间与本次捕获时间的区别，不把旧记录直接当作当前偏好。本次不自动批量导入私人日记或聊天，不把转述内容伪装成已读原始会话。

本节描述代码与 Skill 契约；本地验证、生产部署、真实客户端自动触发分别验收，不能由前者推断后者。真实使用需抽查捕获覆盖、情景完整性、证据可追溯与不确定性保留；记忆条数不是捕获率的分母。

本版是在现有 Activity 系统旁新增的最小版本。Activity 接口和数据保留；没有历史聊天采集器，没有生产部署、生产迁移或真实笔记批量改写。公开测试仅使用虚构数据。记忆形成依赖 Agent 实际调用，不是后台监听所有聊天。

## 索引审计与修复

2026-11-21 经现有 MCP 只读核查：638 条笔记，`newestIndexedAt=2026-11-14T18:09:15.145Z`，`lastFullScanAt=2026-11-14T18:02:19.455Z`，`complete=false`，待扫目录 33 个，待读笔记 0 个。旧版只返回通用 interrupted 错误。对队首目录的一次实时 `list_context` 请求返回 WebDAV 404，确认当前队首已不可访问；不把私人目录名或笔记内容加入仓库。

`src/sync.ts` 原来在目录读取失败时保留相同队首，每轮再次失败；没有逐项退避/旁路。目录重命名或删除会让其他目录长期无法推进。现改为：

- 非根目录 404 结束该工作项，记录 `retiredDirectories`；根目录 404 保留并报错，不能当成空 Vault。
- 其他失败保留工作项，30 秒起指数退避，上限 1 小时。失败项移入 `deferred`，健康工作继续。每次 cron 重试到期项，不丢弃失败项。
- 每个文件/目录页前后持久化检查点；Worker 中断最多重做当前项，不从根开始。保留旧 `sync_state` 格式的兼容性。
- 120 秒租约避免并发扫库，正常结束按租约值释放，崩溃后过期接续。按请求/时间预算分轮。
- 全局 Sweep 已禁用，不再通过 `DELETE ... WHERE seen_generation<>...` 推断文件已删除。只有由当前版本从根开始且完整结束、无错误/截断/跳过项的扫描，才生成未标记笔记的核实队列；候选必须独立 GET 返回 404 才按路径条件删除。目录漏列但 GET 仍存在、权限错误、临时失败、超大文件都保留索引。核实队列及重试持久化，`deletions` 给出本轮实际删除的路径、固定原因及验证时间；不向 WebDAV 发送 DELETE 或改写原 Markdown。
- 发布预检补丁：当前扫描带 `scanVersion=2`、`pruneSafe=true`、`rootComplete` 根遍历证据，且不得超过 24 小时。旧版本状态（包括只有 pruneSafe 的初版补丁）、无效/未来 generation 或过期扫描结束时保留旧索引与已完成更新，排入新的根扫描，`complete=false`、`rescanReason=expired_or_untrusted_generation`，不更新 `lastFullScanAt`。下一轮继续，不在单次调用中循环重启；大型扫描超过 24 小时会保守保留旧条目。目录错误/404 或文件变化会阻止本轮生成核实队列，后续干净扫描再尝试。`complete=true` 仅代表本轮工作结束，有跳过/错误时不推进 `lastFullScanAt`；不能单独据此声称索引完整。
- 安全诊断使用固定码：`webdav_401/403/404/429/5xx`、`timeout`、`source_changed`、`directory_format`、`response_size`、`storage_or_network`。不保存任意异常正文、响应体、URL 或凭据。状态中的路径仅是原有队列元数据。
- 新状态提供 `observedAt`、`checkpointAt`、`lastProgressAt`、逐项 attempts/after/code 和 `root_mismatch`。源 modified 时间逐步规范为 ISO，用于时间检索。

部署后实际验证新鲜度：

1. 保存 `context_index_status` 基线。隔几个 cron 周期再查，检查检查点、最后进展、队列/延迟项变化与错误码，而不只看笔记数量。
2. 队首 404 应退出；健康目录应推进。权限错误应核对 WebDAV 授权；429/超时等待退避；不要删除索引绕过诊断。
3. 经用户同意，在测试 Vault 新建或修改一篇无敏感 Markdown，先 `read_context` 验证云端内容，再 `search_context` 和 `recall_memory` 查询唯一关键词。检查来源路径、行号、`indexed_at`/`indexedAt` 及源 modified 时间。
4. 全轮完成时 `lastFullScanAt` 前进且 `complete=true`。没有内容改变时 `newestIndexedAt` 可以不变；它不是巡检心跳。检查 `skipped`、延迟项与目录截断标志，扫描完成也不代表所有大文件均已索引。

Activity/Memory 读 D1 即时记录，不依赖全文索引。索引停滞不等于 Agent 没有提交记忆；记忆未提交也不能靠索引刷新修复。本次生产仍运行旧版，修复效果须在批准部署后验证。

## 存储、权限和一致性

迁移 `migrations/0002_personal_memory.sql` 仅新增 `personal_memory`、`memory_views` 及索引。`schema.sql` 供全新部署。旧 Activity、notes、KV/OAuth grants 均不重置。

个人记忆事件：`Agent共享/个人记忆/事件/<memory_id>.md`；当前主题视图及时间线：`Agent共享/个人记忆/主题/<topic>.md`。Markdown 可直接阅读或导出。事件按 ID 不可变；D1 保存完整提交、SHA-256 fingerprint、内容去重 key、修订链和持久同步队列。没有 project/task 外键。

`memory_id` 是不可变事件 ID，重试必须复用 ID 和完全相同 payload；`topic` 是跨客户端稳定主题标识。语义完全相同的标准化摘要/上下文/证据/立场、有效期结束及父修订会去重，返回已存在的 canonical ID；重复陈述不同记录日期或有效期起点不会无限追加。经历另把发生时间纳入去重，避免合并不同次经历。不同措辞的语义去重依赖 Skill 先召回比较，不声称服务器能理解所有同义表达。需要更正时间或内容时创建修订，而不是改原事件。

`supersedes` 必须同 Vault、同 topic/type，服务端分配 `revision`，父记录只能有一个直接后继；并发竞争拒绝后提交者，要求重新召回。无链接的不同观点保留并保守标记为冲突，不自动选择“较新者”。不同独立结论可使用更窄主题。有效期为 `[valid_from, valid_until)`；后继生效前召回父版本，后继失效不会让已取代父观点复活。推断/Agent 建议不能取代已记录观点。跨 type 的不同结论另立记录，不自动改写旧事实。

先写 D1 再尝试 WebDAV：目录创建、`If-None-Match: *` 创建不可变事件、回读一致才标记 `vault_synced=true`。失败保留队列，指数退避，cron 每批最多 5 条；失败项不会挡住后续到期项。主题视图带条件写入与回读验证，并与 D1 保存的上次生成原文比较。手改原始事件或视图时保留文本；`event_conflict`/`view_conflict`/`view_conflicts` 报告问题，不静默覆盖。视图冲突也保存在 D1；cron 轮转处理主题，事件可独立读取。恢复时先人工保留编辑内容到独立笔记，再恢复上次生成原文或移开冲突视图，让它重新生成；不能用改 ID 绕过冲突。

写权限：`context:write:memory`，独立于 `context:write:activity` / `context:append:diet`。旧 token 不能写记忆；OAuth 发现、授权页、批准 scope 白名单和 MCP handler 均接入新 scope。已有 `context:read` 的 owner 可召回其授权 Vault 的记忆，与原来读取 Vault 的权限范围一致。

实际内容授权与 OAuth 权限都需要：`authorization_ref` 指向可见的用户授权；普通例行个人记忆授权只覆盖未来协作相关的重要摘要。敏感个人信息和第三方隐私默认排除，需要 `sensitivity` 和额外 `sensitive_authorization_ref` 的具体明确授权；最小化内容。不保存凭据或聊天全文。服务端验证字段/证据规则，无法证明 Agent 填写的授权引用是否真实，也没有自动隐私分类器；客户端必须据真实授权标注，不能把字段本身当成同意。尚未提供删除/遗忘 API，需要删除时停止写入并由 owner 按备份/保留策略处理 D1、Vault 与副本。

## MCP 接口契约

### capture_memory

必填：`memory_id`（8–100 位 ASCII 字母数字下划线/短横线）、`topic`（2–80 位小写 slug）、`type`、`summary`（单行≤1000）、`agent`、`session_ref`、`source_refs`（1–12 项）、`evidence`、`stance`、`occurred_at`、`valid_from`、`authorization_ref`。时间必须 ISO 带时区；occurred_at 不能是未来的经历。

可选：`context`（≤4000，默认空）、`valid_until`、`supersedes`、`sensitivity`（默认 normal）、`sensitive_authorization_ref`。拒绝未知字段和任意写入路径。

`type`：identity / preference / decision / experience / exploration / working_state。

`evidence`：user_statement / observed_action / assistant_proposal / inference。

`stance`：confirmed / considering / proposed / tentative。decision 必须 user_statement + confirmed；experience 必须是实际经历证据 + confirmed；推断只能 tentative，Agent 建议只能 proposed。考虑旅行不能写成真实经历。

虚构职业讨论示例：

```json
{
  "memory_id": "demo_career_20260101_a",
  "topic": "career-transition",
  "type": "exploration",
  "summary": "用户考虑从测试工程转向产品设计，尚未决定。",
  "context": "讨论结论是先通过一个小项目验证兴趣与技能迁移。",
  "agent": "ChatGPT",
  "session_ref": "demo-session-a",
  "source_refs": ["demo-session-a:用户明确表达与讨论结论"],
  "evidence": "user_statement",
  "stance": "considering",
  "occurred_at": "2026-01-01T10:00:00+08:00",
  "valid_from": "2026-01-01T10:00:00+08:00",
  "authorization_ref": "demo-session-a:用户明确授权个人摘要记录"
}
```

响应：canonical `memory_id`、`revision`、`deduplicated`、`status=recorded|pending_vault_sync`、`vault_synced`、`views_updated`、`view_conflict`、`path`、`read_available`。D1 已提交而 Vault 尚未验证时，不得声称写入 Obsidian 成功。重复 ID 不同内容、修订竞争或错误证据等通过 MCP `isError` 返回；scope 不足附 `mcp/www_authenticate`。

### recall_memory

必填 `query`（1–500）；可选 `topics`（≤12）、`types`（≤6）、`from`/`to`（ISO，按发生时间过滤）、`limit`（1–50，默认 10）、`mode=current|timeline`（默认 current）、`detail=summary|context`（默认 summary）、`as_of`（当前有效状态的参考时间，默认现在）。

```json
{"query":"我之前想换职业的讨论","topics":["career-transition"],"limit":5}
```

```json
{"query":"AI 判断","topics":["ai-viewpoint"],"mode":"timeline","from":"2026-01-01T00:00:00+08:00"}
```

```json
{"query":"项目接口部署状态","topics":["demo-project"],"mode":"current"}
```

topics 精确过滤个人 topic、Activity project，或匹配笔记路径/正文；types 仅指个人记忆类型，指定非空 types 会排除 Activity/notes，避免把普通笔记猜成 preference。Activity 当前模式选择每个任务的最新明确状态并保留建议归属；timeline 保留历史。Memory 有效状态与发生时间过滤分开，需查旧记录用 timeline；不是把某日期窗口里的旧决定重新当成今天的有效决定。

来源：Memory 与 Activity 按当前 D1 记录检索；Markdown 使用现有增量全文索引。排除已由结构化来源覆盖的事件和生成视图，避免重复及过时视图混入。其他手工 Markdown 仍可检索。笔记时间过滤使用可解析的 modified，否则 fallback 到 indexed_at；旧索引中的 HTTP 格式 modified 会随正常巡检逐步规范化。笔记时间不代表文章写作日期；as_of 不重建历史 Markdown 快照，不能用今天的正文证明过去某时的观点。

返回 `matches` 含 kind/id/topic/type/summary/score、source.path/startLine/endLine/citation、occurred_at/recorded_at/indexed_at、evidence/stance、vault_synced、conflict，个人记忆另含 revision/source_refs。未同步事件的来源路径可能尚未存在，不能假装已经读到文件。旧 Markdown 是 `source_note/unclassified`，不是确定个人事实。

顶层有 `insufficient_evidence`、`conflicts`、`view_conflicts`、`candidate_truncated`、`freshness` 和覆盖边界。15 分钟未完成全轮或 complete=false 时保守提示 notes_stale（大型 Vault 扫描可能需要更长，逐条时间和实时读回才是具体证据）。没有匹配只表示证据不足。日期范围无效会拒绝，而不是空匹配。

### 检索选择与限制

先做 NFKC/大小写标准化，精确查询、词语/主题匹配、中文 bigram，再使用有限显式中英同义词组扩展（职业转型/转行/career change，旅行/travel，AI/人工智能等）。三来源 SQL 各按词法分数选最多 201 候选，再用全文/标题加权重排、融合去重；不是按时间倒序截取活动。达到候选上限会明示截断。不同措辞的主题命中有自动化用例，未使用 LLM 生成事实或复杂知识图谱。

[Cloudflare 官方 D1 文档](https://developers.cloudflare.com/d1/sql-api/sql-statements/)确认支持 FTS5；[SQLite FTS5](https://www.sqlite.org/fts5.html)描述 unicode61 和 trigram 的边界。Wrangler 本地 D1 的虚构中文实测：unicode61 对连续中文中的子词“职业转型”命中 0；trigram 四字词命中 1、两字词“转型”命中 0；instr bigram 命中 1。复现实验在 `test/retrieval.test.ts`。

本版选择复用原表的 instr/json_each + 应用层 n-gram，不新增全文副本或强制回填。每次可能线性扫描，D1 rows_read/延迟随库增长；候选上限限制返回和重排，不限制 SQL 全扫描成本。虚构回归足以证明目标场景，不能证明任意中文表达的召回率。Embedding/Vectorize 本版未引入；应先收集获得授权的脱敏查询评测、关注 top-k 命中和无关召回，再用相同测试集比较向量方案。词典外改写可能漏召回，改写查询、补主题或用 search_context/read_context 核查；不能编造记忆补缺。

## 本地验证与尚未验证

```sh
npm ci
npm run check
npm test
python -X utf8 /path/to/skill-creator/scripts/quick_validate.py skills/codex/sync-shared-context
python -X utf8 /path/to/skill-creator/scripts/quick_validate.py skills/chatgpt/sync-shared-context
npx wrangler d1 execute SEARCH_DB --local --config wrangler.example.jsonc --persist-to work/v3-validation --file schema.sql
npx wrangler deploy --dry-run --config wrangler.example.jsonc --outdir work/v3-bundle
```

自动测试包含职业探索跨 Agent 身份读写、计划/经历区分、AI 主题与决定的修订/生效时间、不同表达与中英混合查询、Activity 回归、历史笔记相关性、过期/无匹配/冲突、重复 ID/内容去重、WebDAV 故障重试、索引断点/退避/404 和授权边界。OAuth 集成通过虚构 KV、SQLite 与 WebDAV 执行真实协议流，不调用生产数据。迁移重复执行保留 Activity 并与全新 schema 比对。

本次本地结果（2026-11-21）：`npm run check` 通过；`npm test` 52/52 通过；两端 Skill 校验通过；Wrangler 本地 D1 schema/FTS5 探针通过；Worker dry-run 打包通过。Node SQLite experimental warning 和测试环境的 CIMD compatibility 提示不代表生产客户端已经验收。

尚未验证：生产 D1 迁移与运行性能、真实 WebDAV 并发/限流、生产扫描恢复、真实 ChatGPT/Codex 客户端 Skill 自动加载与主动调用、全新双客户端端到端，以及任意语义改写的召回质量。本地模拟通过不等于生产通过。

## Cloudflare 生产升级步骤（需 owner 另行确认后执行）

本轮未执行以下生产命令。

1. 审阅分支与测试。保留已有 Secrets、D1/KV binding、WEBDAV_ROOT 与 cron；不要复制示例替换成新库。备份现有 D1 和 `Agent共享/`，暂停客户端写入以取得一致备份，避免日志或导出进入公开 Git。
2. V2 已有 `shared_activity` 时仅执行下面的 0002。只有尚未迁移到 V2 的部署才先执行 0001。不要在现有库运行清库、重新初始化 root 或导入虚构数据。

```sh
npx wrangler d1 execute SEARCH_DB --remote --config wrangler.jsonc --file migrations/0002_personal_memory.sql
npx wrangler deploy --config wrangler.jsonc
```

3. 核对 `/health` 为 version 0.6.0，cron 仍启用。读 `context_index_status`，观察 checkpoint/retiredDirectories/lastProgressAt/lastFullScanAt，按索引验证步骤确认恢复。不要假设上线即完成全库扫描。
4. 两客户端重新连接并分别申请 `context:read context:write:activity context:write:memory`，检查授权页个人记忆说明；按需另申请 diet scope。保留旧只读/Activity token 做负例验证。安装 [两端 Skill](../skills/README.md) 并在新会话明确个人记录授权。
5. 先测试专用测试 Vault/隔离部署的虚构数据；真实 Vault 的验收写入须明确授权、限定条目，不能批量采集历史聊天。检查 immutable event、主题视图、D1 立即召回与 Vault 验证。

回退：部署此前 Worker 代码，保留新增表和记忆文件，不 drop 表/清空数据/撤销旧 Activity grants。旧版忽略新表；新 memory scope 不能让旧 Activity handler 获得额外权限。若恢复 V3，继续使用原队列和相同 ID。

## 双客户端端到端验收

每一项都记录“工具是否实际调用、返回字段、另一端是否读回”，不要仅检查 Agent 回复的自然语言。新会话不会自动获得未提供的历史聊天。

1. ChatGPT 新会话：明确授权记录测试个人结论，提供虚构人物“考虑转向产品设计，尚未决定”。应先定向 recall，再 capture exploration/considering；检查 vault_synced=true、来源与实际时间。原 ID 原 payload 重试不重复。
2. Codex 全新会话：只问“此前换职业有哪些考虑？”；应主动 recall_memory，以相同 topic 命中 ChatGPT 记录，引用证据并明确尚未决定。无需注入全部旧聊天。再测 career change/职业转型/中英混合表达。
3. “计划去日本”和“实际去过京都”分别提供，第一条不得成为 experience，第二条须有明确经历证据。另起会话召回时区分计划和经历。
4. 多轮 AI 讨论形成同主题新理解，须先召回，再 new ID + supersedes；重复旧观点跳过或去重。默认只看有效新版本；timeline 能看旧观点和生效时间。
5. 明确改变旧决定，创建 decision 修订。用 as_of 查询变更前后，用 timeline+from/to 查变化，不应把 Agent 建议当成用户决定。无确认推断只能 tentative。
6. 恢复虚构工程时同时使用 recall_memory 与 get_activity_context；旧已完成/进行中状态不能盖过后来明确的 blocked。项目进展继续 append_activity。
7. 使用旧只读、diet、Activity token 调 capture_memory，应拒绝且没有新增 Memory/WebDAV 文件。Memory-only token 调 Activity 写入也应拒绝。
8. 在隔离服务模拟 WebDAV 503，检查 D1 可读、vault_synced=false；恢复后由 cron 重试同 ID。手改测试事件/视图，必须保留内容并报告冲突；另一个健康事件仍能同步。
9. 无关问答/随意闲聊/重复结论不写入。敏感信息/第三方隐私无具体授权不保存。没有访问的历史会话不得声称已经采集。无匹配明确证据不足；陈旧索引提示新鲜度并用实时读回核实。
