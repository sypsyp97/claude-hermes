---
description: Show recent heartbeat logs
---

Show recent heartbeat daemon logs. Use `$ARGUMENTS` to filter or limit results.

1. **List log files**: List files in `.claude/hermes/logs/` sorted by modification time (newest first).

2. **Filter**: If `$ARGUMENTS` contains a job name (e.g. "heartbeat", "example"), only show logs matching that name. If it contains a number, show that many recent logs. Default to showing the 5 most recent logs.

3. **Display**: For each log file, read and display its contents with a clear header showing the filename and timestamp.

If `.claude/hermes/logs/` doesn't exist or is empty, tell the user there are no logs yet.
