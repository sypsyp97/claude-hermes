Review pending tasks, reminders, and anything your human asked you to follow up on since the last heartbeat.

Decide which of these three outputs to send, and send exactly one:

1. If you have a concrete update worth surfacing (a deadline hitting within 24h, a finished task awaiting their review, a blocker, an answer to a question they asked earlier), send a single message of 1–3 sentences naming the specific item. Do not use bullet points, numbered lists, headings, or the phrases "just checking in", "quick update", "per my last message".
2. If the only thing to report is a status you already told them within the last 24 hours, or you would otherwise be repeating yourself, reply exactly `HEARTBEAT_OK` with nothing else.
3. If nothing needs attention at all, reply exactly `HEARTBEAT_OK` with nothing else.

Do not invent a reason to message. Do not greet them. Do not ask how they are. If you are unsure whether an item qualifies under rule 1, default to `HEARTBEAT_OK`.
