---
description: Show heartbeat daemon status
---

Show the current status of the heartbeat daemon. Check all of the following:

1. **Daemon process**: Read `.claude/hermes/daemon.pid` and check if the process is alive with `kill -0 <pid>`. Report whether the daemon is running or stopped.

2. **Countdowns**: Read `.claude/hermes/state.json` and show the time remaining until each next run (heartbeat and jobs). Calculate the countdown from the current time.

3. **Configuration**: Read `.claude/hermes/settings.json` and show the current settings (heartbeat interval, prompt, enabled status).

4. **Jobs**: List all `.md` files in `.claude/hermes/jobs/` and show their name and schedule.

Format the output clearly for the user.
