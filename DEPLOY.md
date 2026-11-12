# 最短部署指南

以下命令在项目目录执行。示例使用 `npx` / `npm`；Windows PowerShell 若遇到脚本执行策略限制，使用 `npx.cmd` / `npm.cmd`。不要把密码或生成的管理员密钥发到聊天、截图或提交到仓库。

## 1. 准备依赖和云端存储

安装 Node.js 24+，准备 Cloudflare 账号，以及坚果云「第三方应用管理」中的 WebDAV 应用密码。客户端需要支持自定义远程 MCP 和 OAuth；只有插件目录入口不代表一定能添加自定义服务。

```sh
npm ci
npm run check
npm test
npx wrangler login
npx wrangler kv namespace create OAUTH_KV
npx wrangler d1 create obsidian-context-search
```

保存命令返回的 KV namespace ID 和 D1 database ID。

## 2. 填自己的配置

把 `wrangler.example.jsonc` 复制为 `wrangler.jsonc`（这个文件已被 Git 忽略）。

- 替换 `kv_namespaces[0].id` 和 `d1_databases[0].database_id`。
- 多个 Cloudflare 账号时，增加你自己的 `account_id`。
- `WEBDAV_ROOT` 填相对坚果云 `/dav/` 的实际同步目录，例如 `obsidian`。建议先指向只有测试笔记的专用目录。
- 保持 `ACCESS_MODE=vault`：开放的是配置根目录内的 Markdown，不是账号下全部文件。
- `PUBLIC_ORIGIN` 填你的 Worker 的 HTTPS origin，不带尾斜杠，不加 `/mcp`。

如果还不知道 workers.dev 地址，先保持示例值完成下面的初始化和第一次部署；Wrangler 会输出实际地址。连接客户端前必须改成实际地址并再次部署。这个值参与 OAuth 来源校验，不能保留模板地址。

不要把原作者的账号 ID、Worker 地址或数据库 ID 复制进你的配置。

## 3. 初始化并配置 Secrets

```sh
npx wrangler d1 execute obsidian-context-search --remote --file schema.sql --yes
node scripts/init-index.mjs
node scripts/create-owner-key.mjs
```

确认 `configured_index_root` 与配置中的 `WEBDAV_ROOT` 相同。这一步只设置索引根目录，不上传任何本地笔记，首次内容由云端扫描建立。脚本读取 JSON 格式配置，保留模板的 JSON 语法即可。

本机将显示两项：管理员密钥原文和 `OWNER_KEY_SHA256`。保存原文，授权页只填写原文；下面的 Secret 输入对应哈希。

```sh
npx wrangler secret put WEBDAV_USERNAME
npx wrangler secret put WEBDAV_PASSWORD
npx wrangler secret put OWNER_KEY_SHA256
npm run deploy
```

三个 Secret 分别输入坚果云登录邮箱、专用 WebDAV 应用密码、刚生成的 SHA-256 哈希。若 CLI 询问为尚不存在的 Worker 创建服务，确认创建你配置的服务。

检查部署输出的 HTTPS 地址；如与 `PUBLIC_ORIGIN` 不一致，修改配置并再次运行 `npm run deploy`。打开 `https://你的地址/health` 应返回 `status: ok`；这只验证 Worker 存活，不代表 WebDAV 和 OAuth 已经正常。

## 4. 接入 ChatGPT

在客户端添加自定义 MCP 服务：

- URL：`https://你的地址/mcp`
- Authentication：OAuth

点击连接，在你自己的 Worker 授权页核对客户端、回调地址和请求权限，输入管理员密钥原文。不要填坚果云密码或密钥哈希。界面名称可能随客户端版本不同。

默认必需权限是 `context:read`。如需饮食追加，客户端还需申请 `context:append:diet` 并重新取得授权；支持手填 scope 的客户端可填写 `context:read context:append:diet`。服务端展示了追加工具不等于当前令牌已经拥有追加权限。

## 5. 用一篇笔记验收

在真正同步的目录里创建 `测试.md`，写一句不敏感且容易识别的话，确认坚果云网页能看到它。

1. 请 ChatGPT 列出根目录，再读取 `测试.md`。
2. 在电脑上修改内容，等坚果云同步，再读取一次，确认看到新内容。
3. 等待后台增量索引，查询索引状态，再搜索刚才的关键词。首次扫描可能需要多轮，不是部署后立即有全部搜索结果。
4. 需要测试追加时，先在根目录创建 `饮食记录.md` 并同步，再取得追加权限，明确要求记录一条测试饮食。检查原有内容保留、记录只追加一次，并在另一端确认同步。

确认后若需修改 `WEBDAV_ROOT`，请为新范围创建独立 D1 数据库、更新绑定，并重新执行表结构初始化和 `init-index.mjs`，然后部署。根目录不一致时服务会拒绝使用旧索引，不会自动切换。旧数据库仍可能保存原范围的正文，确认不再需要后应自行删除。

## 常见问题

- **404：** 确认文件已经同步到云端，且根目录、相对路径正确。
- **Forbidden / 授权失效：** 检查 `PUBLIC_ORIGIN`，从客户端重新连接，别复用过期授权 URL；同一浏览器完成授权，保留所需 Cookie。密钥原文与哈希不能混填。
- **只有旧工具：** 在客户端刷新工具列表；新增 scope 还需重新授权。
- **搜索没有最新内容：** 看 `context_index_status`，或先用 `read_context` 实时读取。
- **追加权限不足：** 检查授权中是否包含 `context:append:diet`；不能通过关闭认证绕过。

更换管理员密钥可重新生成并更新 `OWNER_KEY_SHA256`，但不会自动撤销已经签发的 OAuth 令牌。需停止旧访问时，应同时撤销连接或清理该服务专用 OAuth 存储；停用服务后也可撤销坚果云应用密码。
