# Obsidian Context Bridge

把坚果云中的 Markdown 笔记通过远程 MCP 接给 ChatGPT、Codex 等客户端，并用结构化 Activity 共享项目进展，让不同 Agent 在新会话中接续工作。电脑上的 Obsidian 和手机继续使用原有同步方式，不需要为了云端读写而让个人电脑常开。

本次 V2 增量公开 Activity + Skills（服务协议版本 `0.5.0`）。Auto Board Manager、Unified Memory、Memory Manager 和 Context Bootstrap 不包含在本次交付中。

这是个人项目的可复用源码，不是多用户托管服务。目前针对坚果云 WebDAV 实现，不能只换 URL 就当作通用 WebDAV 服务。

## 已有能力

| 工具 | 功能 |
| --- | --- |
| `list_context` | 实时浏览目录和 Markdown 文件，支持分页 |
| `search_context` | 默认搜索正文；支持字面关键词、RE2 正则、大小写、目录、glob、前后文和游标分页；`mode=filename` 搜索实时文件名 |
| `read_context` | 实时读取正文，支持行范围或字符分页，返回路径、行号、ETag 和引用标识 |
| `context_index_status` | 查询索引数量、更新时间及增量扫描进度 |
| `append_diet_record` | 单独授权后，仅向根目录已有的 `饮食记录.md` 追加带日期记录 |
| `get_activity_context` | vault 模式下，从活动数据库读取近期活动、稳定项目 ID、各任务最新明确记录及同步状态 |
| `append_activity` | vault 模式下，单独授权后记录活动，持久排队并同步到 `Agent共享/`；生成最近动态和项目视图 |

笔记原文保存在坚果云；Cloudflare D1 保存可重建的正文搜索副本，KV 保存 OAuth 状态。搜索索引由定时任务和已授权请求触发增量刷新。重要引用应使用 `read_context` 回读最新原文。引用形如 `【示例/笔记.md:L3-L5】`，不是自动生成的网页脚注。

饮食追加使用记录 ID、ETag / If-Match 并读回验证。Activity 使用不可变事件 ID、D1 持久队列及条件创建，视图使用条件更新；`vault_synced=true` 才表示该事件已回读验证。写回不支持任意路径或删除文件；生成视图会更新，原事件通过新增 correction 更正。两类写入依赖 WebDAV 正确执行条件请求。

## 跨 Agent 接续示例

1. Codex 完成一项实际工作，用 `append_activity` 保存项目、任务、结果、依据与下一步。
2. ChatGPT 新会话用 `get_activity_context(project="demo-project")` 读取最新记录，必要时回读原 Markdown。
3. ChatGPT 将讨论建议按 `assistant_proposal / planned` 记录，不能把它写成用户决定或已完成工作。

这是流程示例；本仓库的自动测试使用完全虚构的数据。Activity 不是完整聊天历史，也不会自动采集未调用工具的会话。安装规则见 [Skills](skills/README.md)，完整示例见 [双 Agent 验收](docs/demo.md)。

## 最短部署

见 [DEPLOY.md](DEPLOY.md)。需要 Node.js 24+、自己的 Cloudflare 账号、坚果云 WebDAV 应用密码，以及支持自定义远程 MCP 的客户端。

```sh
npm ci
npm run check
npm test
```

36 项测试使用虚构数据和模拟网络，不读取个人笔记、不连接生产服务。其中集成测试从空 OAuth 存储开始，验证注册、PKCE、MCP 读取、饮食与活动写入权限隔离和幂等。另覆盖活动重试、更正、分页、并发与增量迁移。它们在 Node 模拟环境运行，不代替真实浏览器、Workers runtime 或客户端连接验收；模拟环境不会启用 Workers 专属 CIMD。`node:sqlite` 的实验性提示不代表测试失败。

## 数据范围与限制

- 只访问配置的 `WEBDAV_ROOT` 内的非隐藏 Markdown；排除隐藏配置、回收站和附件。
- 正文索引单文件上限 500 KiB；实时读取单文件上限 16 MiB，每次最多返回 30,000 个 UTF-16 字符单位。
- 搜索按行匹配；RE2 不支持所有 PCRE2 语法，也不支持跨行正则。
- 索引更新受扫描批次、网络与 WebDAV 限流影响，并非实时。单目录列表可能被上游截断，工具会提示。
- D1 保存完整的已索引笔记正文。被读取的材料会经过 Cloudflare 和 MCP 客户端；请自行决定开放哪个目录。
- OAuth 分别控制读取、饮食追加和活动写入；旧授权不会自动增加活动写权限。管理员密钥原文只在授权时提交，Worker Secret 保存其 SHA-256 哈希。
- 活动数据库是已提交事件的持久来源，不是可丢弃的搜索缓存；应备份 D1。Markdown 原事件和生成视图不能替代数据库恢复流程。
- 这是单所有者共享笔记入口，不会自动整理聊天、合并 Agent 内置记忆或管理工作账号的数据边界。

## 文件说明

- `src/`：OAuth、WebDAV、搜索、增量索引、受限追加和 Activity 子系统。
- `test/`：虚构测试夹具与测试。
- `schema.sql`：空表结构，不包含笔记数据。
- `migrations/0001_shared_activity.sql`：从基础版升级的增量迁移，不重建索引。
- `skills/`：通用 ChatGPT / Codex 读写规则与安装说明，无个人看板规则。
- `examples/`：虚构活动 JSON 和示例 Vault，静态样例不是数据库导入。
- `docs/`：[架构](docs/architecture.md)、[字段与语义](docs/activity-schema.md)、[安全边界](docs/security.md)及[验收步骤](docs/demo.md)。
- `wrangler.example.jsonc`：无真实账号和资源 ID 的配置模板。
- `scripts/create-owner-key.mjs`：本机生成管理员密钥和对应哈希。
- `scripts/init-index.mjs`：初始化空索引的根目录，无需上传本地笔记。

此源码包不包含原部署配置、个人笔记、搜索数据库、凭证、日志或排障记录。尚未在一个全新的第三方账号中完成端到端部署验证；发布前应按部署指南走通自己的测试笔记。

许可证：[MIT](LICENSE)。

## V3 personal memory

V3 adds independent `capture_memory` / `recall_memory` alongside the existing Activity system. See [V3 contract, audit, deployment and acceptance](docs/v3-memory.md). Existing Activity grants do not authorize personal memory writes. This repository change does not deploy or collect historic chats.
