import { handleMessageCreate, handleDispatch, stopGateway } from "../../src/commands/discord";
import { reloadSettings } from "../../src/config";
import { getSharedDb, resetSharedDbCache } from "../../src/state/shared-db";
import { upsertPolicy } from "../../src/state/repos/policies";
await reloadSettings();
const db = await getSharedDb();
upsertPolicy(
  db,
  { source: "discord", guild: "g", channel: "parent" },
  { mode: "listen", sessionScope: "per-user" }
);
let release!: () => void;
let started!: () => void;
const gate = new Promise<void>((r) => (release = r));
const ready = new Promise<void>((r) => (started = r));

globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
  if (init?.method === "GET") {
    if (String(url).endsWith("/channels/thread")) {
      started();
      await gate;
      return Response.json({ id: "thread", name: "foo", type: 11, parent_id: "parent" });
    }
    return Response.json({ name: "work", type: 0 });
  }
  return Response.json({ id: "sent" });
}) as typeof fetch;
handleDispatch("fake", "THREAD_CREATE", {
  id: "thread",
  parent_id: "parent",
  name: "foo",
  type: 11,
  guild_id: "g",
});
const user = { id: "a", username: "Alice", discriminator: "0" };
const base = { guild_id: "g", author: user, attachments: [], mentions: [], type: 0 };
let fireDone = false;
let replyDone = false;
const fire = handleMessageCreate("fake", {
  ...base,
  id: "fire",
  channel_id: "parent",
  content: "fire foo",
}).then(() => {
  fireDone = true;
});
await ready;
const reply = handleMessageCreate("fake", {
  ...base,
  id: "reply",
  channel_id: "thread",
  content: "hello there",
}).then(() => {
  replyDone = true;
});
await Bun.sleep(25);
release();
await Promise.race([Promise.all([fire, reply]), Bun.sleep(2000)]);
if (!fireDone || !replyDone)
  console.error("Thread deletion and a concurrent shared-user turn did not finish");
const session = db.query("SELECT key FROM sessions").get();
stopGateway();
await resetSharedDbCache();
process.exit(fireDone && replyDone && session ? 0 : 1);
