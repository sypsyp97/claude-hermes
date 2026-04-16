---
description: Show Telegram bot status and manage global session
---

Show the Telegram bot integration status. Check the following:

1. **Configuration**: Read `.claude/hermes/settings.json` and check if `telegram.token` is set (show masked token: first 5 chars + "..."). Show `allowedUserIds`.

2. **Global Session**: Read `.claude/hermes/session.json` and show:
   - Session UUID (first 8 chars)
   - Created at
   - Last used at
   - Note: This session is shared across heartbeat, cron jobs, and Telegram messages.

3. **If $ARGUMENTS contains "clear"**: Delete `.claude/hermes/session.json` to reset the global session. Confirm to the user. The next run from any source (heartbeat, cron, or Telegram) will create a fresh session.

4. **Running**: Check if the daemon is running by reading `.claude/hermes/daemon.pid`. The Telegram bot runs in-process with the daemon when a token is configured.

Format the output clearly for the user.
