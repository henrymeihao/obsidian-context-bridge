# V3 Phase 4A：行为分流与跨语言召回

本轮仅修改本地代码、Skill 安装源和测试。不执行生产部署、数据库迁移、历史导入、真实个人 Memory 写入或公开推送。没有新增依赖、数据库表、向量服务或索引重建。

## 根因与证据边界

已只读审计两份实际安装的 Skill：Codex 本机文件，以及 ChatGPT 网页 Skill 编辑器中的正文、description 和 agents/openai.yaml。审计快照保存在本机忽略目录 work/phase4a/，不提交个人定制规则。

两端都有个人记忆规则，但缺少一条先于 Activity 规则执行的明确分流。尤其本机保留的旧规则将“用户决定、有意义讨论结论”广泛导向 Activity；原 MCP 全局 instructions 和 append_activity 描述也没有限制为项目事实。上轮真实新会话确实加载 Skill 后写了 Activity，未调用 capture_memory。这支持“路由竞争”判断，不能证明它是所有客户端未触发的唯一原因。

ChatGPT 的 description、UI 简介已经包含个人记忆，allow_implicit_invocation=true，products 包含 chatgpt/codex；没有发现禁用隐式调用的配置。网页编辑器复制出的正文带前导空行，本轮合并候选会规范化 YAML 文件开头，但无法仅凭编辑器导出确认宿主加载器是否因此拒绝过文件。

另一个必要前提是新会话能够取得实际个人记忆授权。Skill 安装或 OAuth scope 不能替代授权；缺少授权时不应绕写 Activity。客户端审批也可以阻止调用。本轮 CLI 初次探测即遇到工具审批拒绝；随后仅为隔离 fixture 的具名工具设置审批配置，没有修改真实客户端/生产权限。

中文召回失败可定位到 SQL 候选生成：旧 queryTerms 只扩展六组概念，中文“第三阶段客户端联通性测试记忆”与英文 summary/topic 没有共享词项，lexical > 0 将目标排除。重排没有机会挽救它；这不是索引扫描过期或队列停滞。

## 最小修改

两份仓库 Skill 新增相同的 Route before recording，description 从能力介绍改为明确的主动行为入口：

| 内容 | 工具/行为 |
|---|---|
| 项目进展、交付、实现决策、任务状态 | append_activity |
| 明确个人决定、稳定偏好、真实经历、持续目标 | capture_memory，对应类型 |
| AI/职业/人生探索形成新的可复用结论 | capture_memory(type=exploration)，保留归属和证据 |
| 混合内容 | 仅将两个不同且各自合格的事实分别写入 |
| 问题、未形成结论、重复观点 | 不写入 |

个人偏好即使出现在项目聊天里仍是个人偏好。已授权普通非敏感结论不再等待用户说“记住”；先召回同一主题，再选择新建、跳过或 supersedes 修订。敏感内容、第三方隐私和推断的限制不变。MCP 全局指令和 Activity 工具描述同步限定项目范围，避免再次诱导错误分流。没有修改 scope guard。

后端增加 recall-query.ts，并继续使用现有 D1 数据：

- NFKC、大小写、标识符连接符、数字/中文阶段序号规范化。
- 有限通用双语概念扩展，覆盖职业、旅行、AI、偏好、项目、连通性等，不给特定 memory_id 或测试记录附加别名。
- 原始词项、扩展词和中文二元组分别加权；topic/路径/项目任务名优先，摘要高于上下文。Memory、Activity 和 Markdown 的候选统一重排、去重，沿用各类 201 条候选上限和截断提示。
- 英文单词在 SQL 候选阶段检查边界，避免 AI 被 chair/airplane 或 test 被 testosterone 命中并挤满候选。
- 每个扩展概念只计一次。只命中“测试”等弱概念，不能让具体问题召回无关事实；不同明确阶段的候选不混淆。
- 时间有效性、修订链、冲突、来源行号、过期处理和新鲜度协议保留。

Skill 在词法查询不足时最多先尝试一次忠实的另一语言改写，保留实体、数字、否定和时间，按 ID 合并并回读 source.path。source_refs 可能是不可解引用的会话引用，不能当作文件路径或已读原文。改写不生成新事实，也不算原始中文查询直接命中。

## 隔离行为验收

运行 scripts/evaluate-memory-behavior.mjs。真实 Codex CLI 模型读取各份 Skill，由模型自行选择工具；自然输入不包含 capture_memory、recall_memory 或“记住”。MCP 使用真实 captureMemory/recallMemory/appendActivity 实现，连接独立 SQLite 和只在内存中工作的 WebDAV fixture。模拟人物和授权都明确标为 fixture；不加载生产 MCP 配置或 WebDAV 凭据。

这些是两份 Skill 文本在同一 Codex CLI 运行时的行为测试，不是两个实际产品运行时验收。ChatGPT 网页和 Codex Desktop 更新安装后的自然触发仍需另验。

| 独立场景 | Codex Skill 实际轨迹 | ChatGPT Skill 实际轨迹 | 检查结果 |
|---|---|---|---|
| 新的明确个人决定 | read_skill → recall → capture | read_skill → recall×2 → capture | 每端新增1 Memory，decision/user_statement/confirmed，vault_synced=true；无 Activity |
| 探索尚无结论 | 无写入调用 | 无写入调用 | Memory/Activity均0，不强迫记录 |
| 重复已有偏好 | read_skill → recall | read_skill → recall | 预置1条，仍1条，没有 capture 或 Activity |
| 项目交付 | read_skill → get_activity×2 → append | read_skill → get_activity → append | Memory为0，Activity为1；使用用户报告证据，不冒称亲自执行测试 |
| 新的探索结论（补充正例） | read_skill → recall×2 → capture | read_skill → recall×2 → capture | exploration/user_statement/confirmed；无 Activity |

核心四组8项及探索正例2项均通过。原始 Agent JSONL、工具参数/回执和最终行数在 work/phase4a/behavior/{client}/{case}/；behavior-summary.json 汇总结果。脚本保存重跑前的 previous/ 轨迹，不能用最后回答代替调用日志。

另有释义召回挑战：中文初查未命中，两份 Skill 都选择英文改写并命中英文 Memory。首轮出现将 opaque source_ref 当路径读取的错误，原始失败轨迹保留；已据此补来源边界规则并复测，两个最新实验均通过：read_skill → recall（中文无匹配）→ recall（英文命中）→ read_context（实际 Markdown 来源），没有写入或无效路径请求。不并入后端直接召回指标。合计12项真实模型隔离实验通过，公开的合成工具轨迹摘要见 [v3-phase4a-traces.json](v3-phase4a-traces.json)。

## 召回质量

scripts/evaluate-recall.ts 在同一虚构数据集上调用 b2d239d 和当前版本的实际召回实现。18个定向问题含中文、英文和混合表达，覆盖职业、旅行、AI、生活及项目，另加2条未扩词调优的释义挑战。

| 口径 | b2d239d | 当前本地版 |
|---|---:|---:|
| 定向18题 Recall@5 | 14/18 | 18/18 |
| 含2条释义挑战，共20题 Recall@5 | 14/20（70%） | 18/20（90%） |
| 前五候选中不在标注来源集合的条数 | 9 | 0 |
| 两条释义挑战直接命中 | 0/2 | 0/2 |

“错误候选”是候选条数，不是错误问题数。该小型策划语料不是用户真实历史的代表性评测，不能外推生产准确率。没有为了指标修改生产记录或为目标记录添加中文标签。来源行号、阶段排错、NFKC、短英文词及220条干扰候选另有自动回归；新的 SQL 还在隔离 workerd + D1 中实跑验证。

## Embedding / Vectorize 评估

词表不能解决任意跨语言语义等价。上述两条释义挑战表明纯后端仍有边界；客户端忠实改写能作为低成本回退，但依赖模型实际调用。当前先交付已复现故障的可验证修复，不创建 Vectorize，也不声称一般语义检索已经解决。

若后续用真实来源标注的盲测仍反复出现词法遗漏，可单独批准多语言 Embedding 原型，与当前词法方案做融合对照。需要测量中文/英文语义命中、误召回、否定与时间过滤、延迟、文本外发范围及增量更新/删除；不需要知识图谱。

成本示例：假设1000个768维向量、每月10000次查询，对应0.768百万存储维度和8.448百万查询维度。这低于当前 Vectorize 免费额度的5百万存储维度、30百万月查询维度；这是该假设的用量，未核查账户剩余额度，也不包含 Worker 或 Embedding 推理费用。实际分块数和模型维度尚未选择，不能把它当作总账单报价。[Cloudflare 官方计费说明](https://developers.cloudflare.com/vectorize/platform/pricing/)

## 更新与后续门槛

本轮没有改动已安装的生产 ChatGPT Skill 或本机个人规则文件。work/phase4a/candidates/ 提供根据实际已安装正文生成的合并候选，保留原正文和个人看板规则，新增路由段并更新 description；两份候选和两份仓库 Skill 均通过格式校验。ChatGPT 的图标、products、allow_implicit_invocation=true 等已有配置继续保留，无须为更新正文卸载或重建连接。

要让修复生效，需要：

1. 备份后合并更新两端 Skill；确保真实个人记忆授权能出现在新会话中，不从安装状态推断授权。
2. 经用户另行确认部署 Worker，取得新检索代码和一致的 MCP 路由元数据；刷新现有连接工具元数据，再开启新会话。没有数据库迁移，无需清空 notes 或改写原笔记。
3. 分别测试两端实际产品中的隐式 Skill 加载、自然 capture/recall、权限审批、去重和来源。客户端配置允许隐式选择不等于保证每次触发；Skill 也没有可靠会话结束钩子，不能读取客户端未提供的聊天。[官方 Skill 机制](https://learn.chatgpt.com/docs/build-skills)
4. 发布时观察 D1 查询延迟/读取量和候选截断；有限词表回退仍不够时，再进行 Embedding 对照实验。

复现：npm run check；npm test；npx tsx scripts/evaluate-recall.ts。真实模型测试是显式 opt-in，可能消耗模型额度：node scripts/evaluate-memory-behavior.mjs codex decision（client也可为chatgpt；场景为decision/exploration/duplicate/project/insight/paraphrase）。它仅为 fixture 工具配置审批，不改变生产权限；临时模型认证副本在完成后删除，原认证文件不变。

本轮 npm run check 通过，npm test 66/66 通过，包括 workerd/D1 查询集成、OAuth、Activity、Memory 和索引安全回归；四份 Skill 格式检查通过。生产部署、真实个人新结论和两个实际客户端的修复后行为均不在这些通过项之中。
