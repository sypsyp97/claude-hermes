import { backupSession } from "../sessions";

export async function clear() {
  // Do not stop the daemon here: when clear runs inside the daemon's own
  // Claude CLI child, a SIGTERM would kill the process awaiting the reply.
  // backupSession() clears the Claude context and invalidates in-flight writes,
  // retaining durable history for the daemon's next fresh Claude session.
  const backup = await backupSession();

  if (backup) {
    console.log(`Session backed up → ${backup}`);
  } else {
    console.log("No active session to back up.");
  }

  console.log("No daemon will be stopped; a running daemon (if any) will create a fresh session on its next turn.");
  process.exit(0);
}
