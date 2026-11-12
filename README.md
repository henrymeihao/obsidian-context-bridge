# Obsidian Context Bridge

把坚果云中的 Markdown 笔记通过远程 MCP 接给 ChatGPT。电脑上的 Obsidian / Codex 和手机继续使用原有同步方式，不需要为了云端读取而让个人电脑常开。

这是个人项目的可复用源码，不是多用户托管服务。目前针对坚果云 WebDAV 实现，不能只换 URL 就当作通用 WebDAV 服务。

## 已有能力

| 工具 | 功能 |
| --- | --- |
| `list_context` | 实时浏览目录和 Markdown 文件，支持分页 |
| `search_context` | 默认搜索正文；支持字面关键词、RE2 正则、大小写、目录、glob、前后文和游标分页；`mode=filename` 搜索实时文件名 |
| `read_context` | 实时读取正文，支持行范围或字符分页，返回路径、行号、ETag 和引用标识 |
| `context_index_status` | 查询索引数量、更新时间及增量扫描进度 |
| `append_diet_record` | 单独授权后，仅向根目录已有的 `饮食记录.md` 追加带日期记录 |

笔记原文保存在坚果云；Cloudflare D1 保存可重建的正文搜索副本，KV 保存 OAuth 状态。搜索索引由定时任务和已授权请求触发增量刷新。重要引用应使用 `read_context` 回读最新原文。引用形如 `【示例/笔记.md:L3-L5】`，不是自动生成的网页脚注。

写回不支持任意路径、改写旧记录或删除文件。它使用记录 ID 防止重复追加，用 ETag / If-Match 检查并发修改，并读回验证；仍依赖 WebDAV 服务正确执行条件请求。

## 最短部署

见 [DEPLOY.md](DEPLOY.md)。需要 Node.js 24+、自己的 Cloudflare 账号、坚果云 WebDAV 应用密码，以及支持自定义远程 MCP 的客户端。

```sh
npm ci
npm run check
npm test
```

28 项测试使用虚构数据和模拟网络，不读取你的笔记、不连接生产服务。其中集成测试从空的 OAuth 存储开始，验证注册、PKCE 授权、MCP 读取、追加权限隔离及重复请求不重复写入。它在 Node 模拟环境运行，不代替真实浏览器、Workers runtime 或 ChatGPT 的连接验收；模拟环境不会启用 Workers 专属的 CIMD 能力。`node:sqlite` 的实验性提示不代表测试失败。

## 数据范围与限制

- 只访问配置的 `WEBDAV_ROOT` 内的非隐藏 Markdown；排除隐藏配置、回收站和附件。
- 正文索引单文件上限 500 KiB；实时读取单文件上限 16 MiB，每次最多返回 30,000 个 UTF-16 字符单位。
- 搜索按行匹配；RE2 不支持所有 PCRE2 语法，也不支持跨行正则。
- 索引更新受扫描批次、网络与 WebDAV 限流影响，并非实时。单目录列表可能被上游截断，工具会提示。
- D1 保存完整的已索引笔记正文。被读取的材料会经过 Cloudflare 和 MCP 客户端；请自行决定开放哪个目录。
- OAuth 区分读取与饮食追加权限；管理员密钥原文只在授权时提交，Worker Secret 保存其 SHA-256 哈希。
- 这是单所有者共享笔记入口，不会自动整理聊天、合并 Agent 内置记忆或管理工作账号的数据边界。

## 文件说明

- `src/`：OAuth、WebDAV、搜索、增量索引和受限追加。
- `test/`：虚构测试夹具与测试。
- `schema.sql`：空表结构，不包含笔记数据。
- `wrangler.example.jsonc`：无真实账号和资源 ID 的配置模板。
- `scripts/create-owner-key.mjs`：本机生成管理员密钥和对应哈希。
- `scripts/init-index.mjs`：初始化空索引的根目录，无需上传本地笔记。

此源码包不包含原部署配置、个人笔记、搜索数据库、凭证、日志或排障记录。尚未在一个全新的第三方账号中完成端到端部署验证；发布前应按部署指南走通自己的测试笔记。
