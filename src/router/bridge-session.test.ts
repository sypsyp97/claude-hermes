import { expect, test } from "bun:test";
import { telegramSessionTarget, discordSessionTarget } from "./bridge-session";
import { defaultPolicy, deliveryPolicy } from "../policy/channel";

test("Telegram topic identity includes its chat and DMs never use the workspace session", () => {
  const input = { workspace: "/test", chatId: -1, userId: 42, topicId: 7, isDm: false };
  expect(telegramSessionTarget(input).key).toBe("thread:telegram:-1:7");
  expect(telegramSessionTarget({ ...input, chatId: -2 }).key).not.toBe(telegramSessionTarget(input).key);
  expect(telegramSessionTarget({ ...input, topicId: undefined, isDm: true }).key).toBe("user:telegram:42");
});

test("Discord isolates channel users, preserves existing thread keys and honors explicit sharing", () => {
  const input = { workspace: "/test", channelId: "c", guildId: "g", userId: "a", isThread: false };
  const policy = defaultPolicy({ source: "discord" });
  expect(discordSessionTarget(input, policy).key).toBe("channel-user:discord:g:c:a");
  expect(discordSessionTarget({ ...input, userId: "b" }, policy).key).not.toBe(
    discordSessionTarget(input, policy).key
  );
  expect(
    discordSessionTarget({ ...input, isThread: true }, { ...policy, sessionScope: "per-thread" }).key
  ).toBe("thread:discord:c");
  expect(discordSessionTarget(input, deliveryPolicy()).key).toBe("shared:discord:g:c");
});
