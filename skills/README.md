# 安装跨 Agent 规则

先按 [DEPLOY](../DEPLOY.md)连接同一桥接服务，分别给需要写入的客户端授权 `context:read context:write:activity`。安装 Skill 不会创建连接或取得 OAuth 权限。

部署者先明确授权：

> 允许记录有意义的讨论结论、项目进展、产出、阻碍和更正到本服务的 Agent共享/，供其他 Agent 接续；不要记录凭据、完整聊天或无关私人资料。

没有这项授权时，Skill 只能读取或准备待提交记录。服务端仍始终检查 OAuth scope。

## Codex

将 `codex/sync-shared-context/` 复制到自己的 Codex skills 目录（例如用户目录下 `.codex/skills/`），保留 `SKILL.md`。若已有同名技能，先合并已有规则，避免覆盖自己的定制。重启或刷新会话，让技能发现机制重新加载。

可在相关工作区 AGENTS.md 添加以下入口，使读写时机更明确：

> 持续项目开始或恢复时使用 sync-shared-context 技能读取共享近况和对应项目；有阶段性产出、阻碍或更正时，最终回复前实际调用 append_activity。仅在已明确授权的 Agent共享/ 记录，区分用户表态、实际执行、Agent 建议和推测。工具不可用时说明未同步。

这份入口不包含个人路径、看板规则或任意命令执行权限。

## ChatGPT

`chatgpt/sync-shared-context/SKILL.md` 提供同一套协议规则。使用客户端支持的 Skill 导入机制时，导入包含该 SKILL.md 的文件夹或 ZIP；若客户端没有 Skill 导入功能，可将正文加入相关项目指令。具体界面和支持范围取决于客户端，不承诺所有账号都提供相同入口。

连接器工具可能带前缀；按 `get_activity_context` / `append_activity` 后缀识别即可。

## 验收

在两个新会话分别读取同一个虚构项目，再由一个会话写、另一个读并写回。确认活动来源、状态和原文一致，写入返回 `vault_synced=true`。若工具缺失或 scope 不足，刷新现有服务并重新授权；不要通过重置密钥、直接改文件或 SQL 绕过。

这两个客户端版本保持相同的协议规则；没有包含 Auto Board Manager 的私有工作流。
