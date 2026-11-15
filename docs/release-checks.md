# V2 增量公开核对记录

核对日期：2026-11-15。基础提交：`a6e0241`。V2 指公开能力迭代，MCP 服务版本为 `0.5.0`。

## 迁入前实际差异

| 范围 | 与公开 main 的差异 | 本次处理 |
| --- | --- | --- |
| src/activity.ts | 新增 Activity Schema、D1 存储、WebDAV 镜像、查询和视图 | 迁入 |
| src/index.ts | 接入工具、活动 scope、授权提示与 cron | 迁入；公开版要求部署者授权例行记录；非 vault 模式不运行活动 cron |
| src/sync.ts | 只有一处私人环境注释 | 未迁入 |
| src/append.ts、read.ts、search.ts | 内容相同 | 保持 |
| schema.sql | 新增活动表及两个索引 | 迁入空结构 |
| migrations/0001_shared_activity.sql | 新增可重复执行的增量迁移 | 迁入 |
| test/activity.test.ts、activity-fixture.ts | 新增虚构夹具与 7 项活动测试 | 迁入；补充迁移测试及 OAuth/MCP 活动测试 |
| package.json / lock | 本地生产目录有差异 | 未整体复制；在公开版上单独升级 Zod |
| 部署配置、Secrets、数据、日志和个人看板 | 不属于迁入范围 | 不复制 |

## 本轮验证

- `npm run check`：通过。
- `npm test`：36 项通过。OAuth 集成包含活动 scope 与饮食 scope 双向隔离、只读令牌跨会话读取、重复请求及非法证据状态拒绝。
- 新增迁移测试：已有笔记和 index_meta 保留；迁移重复执行；新安装和升级后的活动表/索引一致。
- `npm audit`：Zod 升级后 0 项已知漏洞。
- `node scripts/privacy-scan.mjs --history`：当前文件及基础版可达历史 blob，有限规则扫描 0 命中；不是完整审计。
- 本地额外将发布文件与实际生产配置中的 4 项 Secret / 资源 / origin 值比较：0 命中；未输出或提交实际值。
- 两个 SKILL.md：技能验证器以 UTF-8 模式运行通过。
- `wrangler deploy --config wrangler.example.jsonc --dry-run`：打包通过，不部署云端资源。
- 独立虚构配置及存储下，本地 Workers D1 执行完整 Schema、再执行增量迁移均通过；查询保留 notes、index_meta、shared_activity。
- 实际本地 Workers runtime：`/health` 返回版本 0.5.0；OAuth metadata 列出三项 scope；未授权 `/mcp` 返回 401。

## 仍未验证

没有在全新第三方 Cloudflare / 坚果云账号完成真实部署，也没有以第三方账号完成双客户端端到端验收。Node 的合成网络测试、本地 runtime 检查和 dry-run 各有边界，不能合并描述成此项通过。

Auto Board Manager、Unified Memory、Memory Manager、Context Bootstrap 未纳入本 PR。MIT 许可证由仓库所有者选择。CI 运行结果以 PR 实际检查为准；本记录不预先宣称远端 CI 通过。
