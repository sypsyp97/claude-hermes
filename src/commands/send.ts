import { initConfig, loadSettings } from "../config";
import { runUserMessage } from "../runner";
import { getSession } from "../sessions";
import { sendMessage as sendTelegramMessage } from "./telegram";
import { sendMessageToUser as sendDiscordMessage } from "./discord";

/**
 * Parse a `--to user_id` flag out of argv. Returns the ID string (without the
 * flag) or null if absent. Multiple `--to` values are not allowed — one
 * invocation, one recipient.
 */
function parseToFlag(args: string[]): { to: string | null; rest: string[] } {
  const rest: string[] = [];
  let to: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--to") {
      if (to !== null) {
        console.error("send: --to may only be given once");
        process.exit(1);
      }
      to = args[++i] ?? "";
      if (!to || to.startsWith("--")) {
        console.error("send: --to requires a user id");
        process.exit(1);
      }
      continue;
    }
    rest.push(args[i]);
  }
  return { to, rest };
}

export async function send(args: string[]) {
  const { to, rest } = parseToFlag(args);
  const telegramFlag = rest.includes("--telegram");
  const discordFlag = rest.includes("--discord");
  const message = rest
    .filter((a) => a !== "--telegram" && a !== "--discord")
    .join(" ");

  if (!message) {
    console.error(
      "Usage: claude-hermes send <message> [--telegram|--discord --to <user_id>]",
    );
    process.exit(1);
  }

  if (telegramFlag && discordFlag) {
    console.error(
      "send: pick one of --telegram or --discord, not both (use two invocations if you need both channels)",
    );
    process.exit(1);
  }

  const wantsChannel = telegramFlag || discordFlag;
  if (to && !wantsChannel) {
    console.error("send: --to requires --telegram or --discord");
    process.exit(1);
  }
  if (wantsChannel && !to) {
    console.error(
      "send: --to <user_id> is required when forwarding to a channel. "
        + "Broadcast-to-all was removed — targeting every allowed user with "
        + "one command is too dangerous.",
    );
    process.exit(1);
  }

  await initConfig();
  const settings = await loadSettings();

  // Validate delivery target + allowlist BEFORE burning a Claude turn. A bad
  // --to or missing token used to consume a Claude invocation (and mutate
  // session state) only to fail the send afterwards.
  if (wantsChannel) {
    if (telegramFlag) {
      if (!settings.telegram.token) {
        console.error("Telegram token is not configured in settings.");
        process.exit(1);
      }
      if (!/^[1-9]\d*$/.test(to!) || !Number.isSafeInteger(Number(to)) || !settings.telegram.allowedUserIds.includes(Number(to))) {
        console.error(
          `send: --to ${to} is not in telegram.allowedUserIds; add them to settings first.`,
        );
        process.exit(1);
      }
    }
    if (discordFlag) {
      if (!settings.discord.token) {
        console.error("Discord token is not configured in settings.");
        process.exit(1);
      }
      if (!settings.discord.allowedUserIds.includes(to!)) {
        console.error(
          `send: --to ${to} is not in discord.allowedUserIds; add them to settings first.`,
        );
        process.exit(1);
      }
    }
  }

  const session = await getSession();
  if (!session) {
    console.error("No active session. Start the daemon first.");
    process.exit(1);
  }

  const result = await runUserMessage("send", message);
  console.log(result.stdout);

  if (!wantsChannel) {
    if (result.exitCode !== 0) process.exit(result.exitCode);
    return;
  }

  const text = result.exitCode === 0
    ? result.stdout || "(empty)"
    : `error (exit ${result.exitCode}): ${result.stderr || "Unknown"}`;

  if (telegramFlag) {
    await sendTelegramMessage(settings.telegram.token, Number(to), text);
    console.log(`Sent to Telegram user ${to}.`);
  }

  if (discordFlag) {
    await sendDiscordMessage(settings.discord.token, to!, text);
    console.log(`Sent to Discord user ${to}.`);
  }

  if (result.exitCode !== 0) process.exit(result.exitCode);
}
