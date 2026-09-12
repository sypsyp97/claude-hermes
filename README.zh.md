# Claude Hermes

> **Fork 自 [moazbuilds/claudeclaw](https://github.com/moazbuilds/claudeclaw)。** 围绕 SQLite 状态引擎、基于 envelope 的 router、自动晋升的 skills pipeline 和人触发 + verify 把关的自我进化 loop 重构。对外只保留 Telegram 和 Discord 两个入口 — 没有 Web dashboard。

> 🇬🇧 [English README](README.md)

Claude Hermes 把你的 Claude Code 变成一个不睡觉的个人助理：后台 daemon 常驻，按 schedule 执行任务，在 Telegram 和 Discord 上接话，转写语音命令，还会从你的使用中自己学新 skills。

## 为什么是 Hermes（相对它 fork 来的 Claw）

| | Hermes | Claw |
| --- | --- | --- |
| 存储 | `bun:sqlite` + FTS5，单文件 `state.db` | 一堆 JSON 文件 |
| Session | 按 scope 路由（`dm`, `per-channel-user`, `per-thread`, `shared`, `workspace`） | 全局 session + per-thread 覆盖 |
| Skills | candidate → active，带 rollback 窗口（回退时落到 `shadow`） | 只能手动装 |
| 自我进化 | 人触发 + verify 把关：绿了自动 commit，红了 revert | 无 |
| 模型路由 | agentic 路由 + 持久化的会话级模型覆盖 | 各桥接分别选择模型 |
| Web dashboard | 砍掉了 — 只走 Telegram/Discord/CLI | 有 |
| Verify pipeline | typecheck + lint + unit + smoke + integration，五个全绿才算过 | 手动 |

## 安装

最省事的路子 — 从 Claude Code plugin marketplace 装。在任意 Claude Code session 里跑：

```
/plugin marketplace add sypsyp97/claude-hermes
/plugin install claude-hermes@claude-hermes
/claude-hermes:start
```

setup wizard 会一路引导你配 model、heartbeat、Telegram、Discord 和 security；配完 daemon 就在后台跑起来了。需要 Bun 和 **Claude Code 2.1.257+**；升级 Hermes 前先运行 `claude update`。缺少 Bun 时 `start` 会引导安装。对标依据、Claude 新功能适配和验证边界见 [可靠性评审](docs/AGENT_RELIABILITY_REVIEW.md)。

如果这个 workspace 之前跑过上游的 Claw daemon，第一次 `start` 会把 `.claude/claudeclaw/` 一次性迁移到 `.claude/hermes/`，老目录原样留着当保险。

### 从源码开发

```bash
git clone https://github.com/sypsyp97/claude-hermes.git
cd claude-hermes
bun install
bun run verify
```

然后让 Claude Code 指向这个 working tree：

```
/plugin marketplace add /absolute/path/to/claude-hermes
/plugin install claude-hermes@claude-hermes
```

## 功能

### 自动化
- **Heartbeat：** 周期性的 check-in，可以配 interval、quiet hours、改 prompt。heartbeat prompt 可以是 inline string 也可以是文件路径；改了不用重启 daemon。
- **Cron jobs：** 带时区的定时任务，支持周期性和一次性。job 文件每 30s 热加载一次 — 不需要重启 daemon。
- **Scaffolder（`/claude-hermes:new`）：** `new job <name>`、`new skill <name>`、`new prompt <name>` 会用合理的 frontmatter 默认值生成模板文件，不用手搓 YAML。也能当 CLI 用：`bun run src/index.ts new job my-job --schedule "0 9 * * *"`。
- **自我进化（`bun run scripts/evolve.ts`）：** 可选的本地工具。你丢一段任务描述（CLI 参数、stdin 或 Discord/Telegram 消息），它让本地 Claude 去实现，全套 verify 跑完，绿了 commit、红了 `git restore`。小步走、verify 把关、全程写 journal。完全人触发，没有 cron — verify 就是安全网。

### 定时任务通知目标
job frontmatter 支持 `notifyChannel: "DISCORD_CHANNEL_ID"`、`notifyTelegramChat: "TELEGRAM_CHAT_ID"` 和可选的 `notifyTelegramTopic: 42`，可同时指定两个平台。指定后只向这些目标投递，目标失败或桥接未启用时不会改发其他人。省略这些字段时保留原有默认投递。`notify: false` 关闭任务进度与结果通知，`notify: error` 只发送失败结果。topic 必须同时指定 chat，目标格式错误会在加载时拒绝该 job。

### 通信
- **Telegram：** 支持文字、图片、语音、通用文档（含 JSON、源码和无 MIME 文件），以及引用回复、转发上下文。被引用的图片、文档和音频以文件形式提供。语音识别使用 whisper.cpp 或 OpenAI 兼容 STT endpoint。
- **Discord：** DM、服务器 @mention/reply、slash 命令、语音、多图、通用附件、回复/转发上下文和 reaction。同频道引用快照缺失时，先补取原消息再判断回复触发；系统消息不会调用 Claude。
- **时间感知：** 消息里带时间戳前缀，帮 agent 理解延迟和日常节奏。
- **实时答案预览：** Telegram 和 Discord 在进度消息中展示有长度限制的回答草稿；完成后将其收为状态摘要，完整答案单独发送。`/verbose on` 显示详细工具进度，`/verbose off` 保留简洁预览，设置按会话持久化。

### 附件
两个桥接每个入站文件最多下载 20 MiB。Discord 每条消息最多处理十个文件，当前消息优先于引用附件，并保留原始文件名和来源。下载失败、超出数量的文件会明确写入模型上下文。Telegram 相册仍按多条有序消息处理。压缩包作为文件交给 Claude，Hermes 不自动解压。

生成文件通过 `[send-file:/绝对路径]` 发送。系统提示会告诉 Claude 当前会话的输出目录：`.claude/hermes/outbox/<session-hash>/`。每个输出必须是该目录内的普通文件，最多 10 MiB；拒绝越界符号链接及指向其他目录的 outbox。Discord 的普通消息和 skill slash 命令都支持发送。原有 Telegram skill 若从任意路径发文件，需要先复制到提供的 outbox。平台也可能有额外限制；发送结果不确定时不会自动重发。

### Discord 频道策略
daemon 按频道名自动路由：
- **`listen-*` / `ask-*`** — 自由回应模式，不用 @mention 也会答。
- **`deliver-*`** — 只投递，不交互回复（适合广播）。
- **普通服务器频道** — 默认：per-channel-user 记忆，只在被 @mention 或 reply 时回。
- **DM** — 默认：per-user 记忆，每条都回。
- **手动 override：** SQLite 里 `channel_policies` 的频道配置优先于名称规则。Discord 服务器频道的策略中可加入 `allowedUserIds: ["DISCORD_USER_ID"]`，仅授权这些用户在该频道使用；线程继承父频道，显式覆盖优先。普通消息和 slash 命令共用授权判断；频道授权不会扩展到私聊或其他频道。全局列表为空且没有频道授权时拒绝访问。通过管理消息创建或删除线程需要全局用户授权。

### Discord / Telegram 会话管理
- **独立 thread session：** 每个 Discord thread 拿自己的 Claude CLI session。
- **并行处理：** 不同 thread 里的消息互不阻塞。
- **自动创建：** 一个新 thread 的第一条消息会 bootstrap 一个新 session。
- **生命周期：** 归档保留上下文；删除线程会清除其 SQLite session 和归属记忆。
- **隔离：** 私聊按用户，服务器频道和群聊按频道中的用户，Telegram 话题按群 ID + 话题 ID 路由。
- **控制命令：** `/reset`、`/forget`、`/compact`、`/status`、`/context` 都指向当前会话。重置保留记忆；遗忘会删除该会话的 Hermes 历史、事实和原生 auto-memory。上下文容量优先使用模型报告值，缺失时明确显示未知。会话文件优先从当前工作区定位，移动目录后按精确 session UUID 回查。
- **取消任务：** `/cancel`（别名 `/kill`、`/stop`）立即通知当前会话正在执行或等待进程名额的 Claude 任务停止，其他会话与后续排队消息继续保留。附件准备和已发生的操作不会被撤销。
- **切换模型：** `/model sonnet`、`/model opus`、`/model haiku` 或 `/model <model-id>` 将当前会话的模型覆盖写入 SQLite；`/model` 查看，`/model default` 恢复频道/全局路由。重置会话会保留该设置。
- **频道策略：** 两个桥接都执行 session/memory scope、投递模式、模型和技能限制、自动建线程策略（Telegram 需要论坛群）。自动建线程与后续消息使用一致的策略，显式共享模式保持共享。

细节看 [docs/MULTI_SESSION.md](docs/MULTI_SESSION.md)。

### 可靠性与控制
- **连接恢复：** Discord 心跳与 Resume 使用可取消的连接代次；Telegram 长轮询和重试可中止，并遵守 `retry_after`。
- **结果不确定时：** 发送网络故障和任务超时会明确报错，不自动重放可能已有副作用的操作。
- **Telegram 重启：** 接收记录和轮询 offset 原子写入 SQLite。重启后提示未确认完成的请求，由用户检查部分执行结果后决定是否重发；不保证 exactly-once。
- **执行控制：** 下载附件、查询元数据之前先保留消息顺序。缓冲输出、流式 Claude 和本地语音识别共享最多四个子进程名额；停止桥接会取消请求、子进程和排队中的执行。
- **Agentic 模型路由：** 每个 turn 按关键词/短语分类成 `planning`（→ Opus）或 `implementation`（→ Sonnet）。modes 在 `settings.json` 里可配；关掉就固定用单一模型。
- **模型 fallback：** 使用 Claude 原生 `--fallback-model`，限于同一 provider 凭据下的兼容模型；Hermes 不会在结果不确定时切换 provider 重跑整项任务。
- **Security 级别：** 四档工具访问权限，全都是 headless（不会弹权限 prompt）：
  - `locked` → 只能 `Read`、`Grep`、`Glob`，禁用 MCP 工具。
  - `strict` → 除 `Bash`、`WebSearch`、`WebFetch` 以外全开。
  - `moderate` → 所有工具，以项目作为工作目录。
  - `unrestricted` → 所有工具，不额外传入目录提示。
  这些 CLI 工具规则和目录提示不构成操作系统文件沙箱。
- **Skill 自动晋升：** 在 7 天窗口内跑过 ≥20 次且成功率 ≥85% 的 candidate skill 自动升到 `active`。升上去后如果 rollback 窗口里成功率掉到 70% 以下，就被降回 `shadow`。阈值在 `src/learning/config.ts` 里，可调。
- **Evolve 安全守则：** 自改子 agent 的 system prompt 永远前置一套硬规则 —— 禁 `git stash`、禁切分支、禁 `--no-verify`、禁 force push、禁写 cwd 外的文件。守则内容在 `prompts/EVOLVE_GUARDS.md`，丢失时还有保守的 inline fallback 兜底，永远不会静默失效。
- **抗崩溃的 daemon registry：** `~/.claude/hermes/daemons.json` 用 tmp-write + rename 原子写，SIGKILL 打断写入也不会把 registry 抹掉。
- **父 daemon 保护：** 从 daemon 自己的 Claude 子进程里调 `/stop`、`/stop-all`、`/clear`，永远不会干掉正在跑自己的那个 daemon。
- **Rate-limit 重试：** Discord 加 reaction 的 PUT 走统一的 `discordApi` helper，碰到 429 会按 `Retry-After` 重试，不会像之前那样默默丢弃。

## 记忆

三层，从稳定到易变：

- **Identity** —— `prompts/{SOUL,IDENTITY,USER}.md` + 项目 `CLAUDE.md` + `.claude/hermes/memory/` 下的 workspace override。跨轮字节相同，CLI 的 prompt cache 才会命中。
- **Episodic** —— `state.db` 把每一轮成功调用写进 `messages` 表；FTS5 做搜索，一个轻量的 importance 启发式 + recency / relevance 打分做排序。
- **主动召回** —— 每轮先检索当前会话相关旧消息、归属事实和 Dream 摘要，再补充近期上下文；支持中文子串回退，限制注入长度。
- **明确记忆** —— 成功处理“记住：…”、“remember that …”、“my editor is …”等明确陈述后保存带会话来源的事实。独立笔记互不覆盖，同名事实更新后只召回最新值；提取不额外调用模型。
- **Claude 原生记忆** —— 每个桥接会话使用独立 auto-memory 目录，恢复会话时刷新系统提示。`memoryScope: none` 禁用自动记忆注入，但仍保存成功对话。项目文件和原生 CLI 配置属于共享可信工作区，不构成操作系统隔离。
- **Primitives** —— 四个 opt-in 或者人工 gate 的东西，都已经接进 runtime：
  - `.claude/hermes/memory/blocks/` 下的标签 block 会以 `<block:NAME>…</block>` 的形式打进 system prompt。
  - `.claude/hermes/memory/agent/` 是 agent 自己的 scratchpad，走六操作协议（`view / create / strReplace / insert / del / rename`）。
  - 每晚的 `Dream` pass 压缩老消息、去重 `MEMORY.md`。开关是 `settings.memory.dreamCron`。
  - 学到的 skill 存在 `.claude/hermes/skills/<name>/` 下。`settings.learning.captureCandidateSkills` 打开时，每一轮成功都会自动抓一个 `candidate`（带这轮真实的 tool 调用 trace）；只有你手动把它标成 `active`，它才会被镜像到 `.claude/skills/hermes_<name>/`，spawn 出来的 agent 才看得见。

## Verify pipeline

`bun run verify` 跑五个 stage，任何一个红都算失败：

```
typecheck → lint → unit → smoke → integration
```

自我进化 loop 只在五个全绿的时候 commit；否则 `git restore` 回去，重开一条 journal。开发内循环可以用 `bun run verify --fast`（只跑 typecheck + unit）。

## 开发

```bash
bun run typecheck   # tsc --noEmit
bun run lint        # biome check src tests scripts
bun run fmt         # biome format --write
bun test src        # unit tests
bun test tests/smoke
bun test tests/integration
```

## License

MIT —— 见 [LICENSE](LICENSE)。

## 致谢

最初 fork 自 [moazbuilds/claudeclaw](https://github.com/moazbuilds/claudeclaw)；遗留同名文件（Telegram/Discord bridge、语音转写、cron/heartbeat 骨架）已经针对测试从零重写过。

v1.1.0 将选定的上游功能及开放 PR 提案适配到 Hermes 的会话隔离机制，来源见 [发布说明](docs/releases/v1.1.0.md)。技能安装搜索改用 skills.sh 结构化 API，并加入超时和明确错误处理。

自我进化的节奏（小步走、verify 把关、全程写 journal）借自 [yologdev/yoyo-evolve](https://github.com/yologdev/yoyo-evolve)。

记忆层参考了若干开源 agent-memory 项目：
- **标签 block + 硬字符预算** —— [Letta](https://github.com/letta-ai/letta)（原 MemGPT）。
- **agent scratchpad 六操作协议**（`view / create / strReplace / insert / del / rename`）—— Anthropic [`memory_20250818`](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool) 工具形状。
- **Dream 式离线整理**（digest、dedupe、invalidate）—— [Honcho](https://github.com/plastic-labs/honcho)。
- **`(SKILL.md + description + trajectory)` 结构 + FTS 检索的 skill 库** —— [Voyager](https://github.com/MineDojo/Voyager) 的 skill library 形状。
- **importance · recency · relevance 打分** —— 斯坦福 Generative Agents 论文（[Park 等，2023](https://arxiv.org/abs/2304.03442)）。
- **episodic / semantic 分层 + FTS5 当检索骨架** —— 思路上接近 [Zep](https://github.com/getzep/zep) 和 [mem0](https://github.com/mem0ai/mem0)，但砍掉了图 / 向量存储。

### 主动记忆与新版 Claude

每个 turn 先用 FTS5 检索相关旧消息，再注入近期上下文，检索范围限定在当前会话及有归属的事实。支持中文片段回退、检索数量和摘要长度预算。桥接会话各自使用 Claude 原生自动记忆目录，恢复会话时刷新系统提示。`memoryScope: none` 关闭自动记忆注入，但仍持久化成功的会话记录。项目文件、hooks、MCP 与 skills 仍属于受信任的共享工作区；这不是多租户沙箱。

## 发布新版本

维护者在同步后的 `main` 上执行 `bun run release <version>`。
命令会同步三个版本清单、写入发布说明、运行验证、提交并推送 main。
GitHub Actions 会复用四组验证，确认版本一致后，用 `GITHUB_TOKEN`
自动创建版本标签与 Release，无需个人 token 或本地 `gh` 登录。
重跑会保留已存在的 Release；尚未发布但指向其他提交的同名标签会被拒绝。
`--no-push` 可只在本地准备，`--notes-file=<path>` 可指定发布说明；
也可在 Actions 页面选择 main 手动运行发布流程。
