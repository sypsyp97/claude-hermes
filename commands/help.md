---
description: Show heartbeat plugin help
---

Display this help information to the user:

**Claude Hermes** — daemon mode plus one-shot prompt/trigger runs.

**Commands:**
- `/claude-hermes:start` — Initialize config and start the daemon
- `/claude-hermes:stop` — Stop the running daemon
- `/claude-hermes:clear` — Back up the current session and restart fresh
- `/claude-hermes:status` — Show daemon status, countdowns, and config
- `/claude-hermes:config` — View or modify heartbeat settings (interval, prompt, telegram)
- `/claude-hermes:jobs` — Create, list, edit, or delete cron jobs
- `/claude-hermes:logs` — Show recent execution logs (accepts count or job name filter)
- `/claude-hermes:telegram` — Show Telegram bot status and sessions (use `clear` to reset sessions)
- `/claude-hermes:help` — Show this help message

**Start command options (CLI):**
- `bun run src/index.ts start` — normal daemon mode
- `bun run src/index.ts start --prompt "text"` — one-shot prompt, no daemon loop
- `bun run src/index.ts start --trigger` — start daemon and run startup trigger once
- `bun run src/index.ts start --prompt "text" --trigger` — start daemon and run startup trigger with custom prompt
- Add `--telegram` with `--trigger` to forward startup trigger output to configured Telegram users
- Add `--discord` with `--trigger` to forward startup trigger output to configured Discord users

**Send command options (CLI):**
- `bun run src/index.ts send "text"` — send to active daemon session
- `bun run src/index.ts send "text" --telegram` — send and forward output to Telegram
- If daemon is already running, use `send`; `start` will abort.

**How it works:**
- The daemon runs in the background checking your schedule every 60 seconds
- A **heartbeat** prompt runs at a fixed interval (default: every 15 minutes)
- **Jobs** are markdown files in `.claude/hermes/jobs/` with cron schedules (timezone-aware, evaluated in configured `timezone`)
- The statusline shows a live countdown to the next run

**Configuration:**
- `.claude/hermes/settings.json` — Main config (model, heartbeat, telegram, discord, security)
- `.claude/hermes/jobs/*.md` — Cron jobs with schedule frontmatter and a prompt body

**Job file format:**
```markdown
---
schedule: "0 9 * * *"
---
Your prompt here. Claude will run this at the scheduled time.
```

Schedule uses standard cron syntax: `minute hour day-of-month month day-of-week`

**Note:** Bun is required to run the daemon. It will be auto-installed on first `/claude-hermes:start` if missing.

**Telegram:**
- Configure in `.claude/hermes/settings.json` under `telegram`
- Daemon mode can run Telegram polling in-process when token is configured
- Startup trigger `start --trigger --telegram` and daemon `send --telegram` can forward responses
