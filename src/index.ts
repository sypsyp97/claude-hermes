import { start } from "./commands/start";
import { stop, stopAll } from "./commands/stop";
import { clear } from "./commands/clear";
import { status } from "./commands/status";
import { telegram } from "./commands/telegram";
import { discord } from "./commands/discord";
import { send } from "./commands/send";
import { preflight } from "./commands/preflight";
import { newCmd } from "./commands/new";

const args = process.argv.slice(2);
const command = args[0];

const KNOWN_FLAGS = new Set(["--stop-all", "--stop", "--clear"]);
const KNOWN_SUBCOMMANDS = new Set([
  "start",
  "status",
  "telegram",
  "discord",
  "send",
  "preflight",
  "new",
]);

if (command === undefined) {
  await start();
} else if (command === "--stop-all") {
  await stopAll();
} else if (command === "--stop") {
  await stop();
} else if (command === "--clear") {
  await clear();
} else if (command === "start") {
  await start(args.slice(1));
} else if (command === "status") {
  await status(args.slice(1));
} else if (command === "telegram") {
  await telegram();
} else if (command === "discord") {
  await discord();
} else if (command === "send") {
  await send(args.slice(1));
} else if (command === "preflight") {
  preflight(args.slice(1));
} else if (command === "new") {
  await newCmd(args.slice(1));
} else if (KNOWN_FLAGS.has(command) || KNOWN_SUBCOMMANDS.has(command)) {
  // unreachable — above if/else already covers every known token; kept as a
  // safety net so adding a new entry to KNOWN_SUBCOMMANDS without wiring a
  // branch falls through to the real handler list instead of the error arm.
  await start();
} else {
  console.error(`unknown command: ${command}`);
  console.error(
    `known subcommands: ${[...KNOWN_SUBCOMMANDS].join(", ")} (or ${[...KNOWN_FLAGS].join(", ")})`,
  );
  process.exit(2);
}
