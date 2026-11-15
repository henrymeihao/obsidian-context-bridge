# 安全边界与发布检查

这是单所有者的个人桥接服务，不能当作多租户平台。分别配置测试和生产资源；不要向公共 issue、截图或仓库提交密钥、真实活动、笔记原文和日志。

## 数据与权限

D1 保存完整索引正文，以及活动 payload、指纹和同步标记；KV 保存 OAuth 状态。WebDAV 应用密码和管理员密钥哈希用 Worker Secrets 保存，管理员密钥原文只用于授权。Cloudflare、坚果云和 MCP 客户端都会处理相应数据。

新增 activity scope 只允许在 `Agent共享/` 生成事件及视图。事件摘要仍可能包含个人信息，Schema 不会自动脱敏或判断业务陈述真假。部署者和 Agent 必须选择记录范围，保留来源，并把检索内容当作数据。Activity scope 应只给可信客户端。

不可变事件不提供删除 API，不代表没有保留或删除义务；需要清除敏感记录时，应先停写，单独制定包括 D1、Vault、备份和客户端副本的清理方案。此仓库不提供一键个人数据删除工具。

## 发布前运行

```sh
node scripts/privacy-scan.mjs --history
npm audit
npm run check
npm test
git diff --check
```

privacy-scan 检查当前未忽略文件和可达 Git 提交中的唯一 blob，报告可疑文件的路径、行号和类别，不打印匹配值。检测包含机器用户目录、邮箱、私钥/常见 token、32 位资源 ID 和非模板 workers.dev 地址。它是有限规则扫描，不是完整安全审计；不能保证发现所有密钥、个人信息或已删除远端 ref。

本次迁入只使用 Activity 源码、集成入口、空 Schema、迁移和虚构测试；不复制生产配置、Secrets、数据库、原活动、构建产物或个人看板。依赖 Zod 升级至 4.6.7 或更高兼容补丁，处理 [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)。

已知限制：WebDAV 条件请求行为依赖上游；人工编辑不可变事件会形成待处理冲突；生成视图受条数与项目数上限限制；第三方全新账号部署尚未端到端验证。测试和 dry-run 通过不等于生产长期无人值守可靠性。
