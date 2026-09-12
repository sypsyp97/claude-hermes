import { cancelConversation, isCancelCommand, preferenceCommand, conversationPreference } from "../runtime/conversation-controls";
import { artifactDirectory, extractSendFileDirectives, prepareArtifact } from "../runtime/artifacts";
import { quotedContext } from "../runtime/message-context";
import { formatContextUsage } from "../runtime/context-usage";
import { enqueueBridge, prepareBridgeTransfer } from "../runtime/bridge-queue";
import { withBridgeSignal, bridgeSignal } from "../runtime/bridge-context";
import { downloadBytes } from "../runtime/http";
import { ensureProjectClaudeMd, run, runUserMessage, compactCurrentSession, resetCurrentSession, forgetCurrentSession } from "../runner";
import { getSettings, loadSettings } from "../config";
import { pollUpdates } from "../adapters/telegram/polling";
import { telegramCheckpoint } from "../adapters/telegram/checkpoint";
import { resolveTelegramPolicy } from "../adapters/telegram/channel-policy";
import { getSharedDb } from "../state/shared-db";
import { isSkillAllowed } from "../policy/channel";
import { telegramSessionTarget } from "../router/bridge-session";
import { sessionAccess } from "../runtime/session-target";
import { telegramApi as callApi, TelegramApiError } from "./telegram-api";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { transcribeAudioToText } from "../whisper";
import { resolveSkillPrompt, listSkills } from "../skills";
import { mkdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { telegramInboxDir } from "../paths";
import { findSessionFile } from "../runtime/claude-paths";
import { extractSessionAndResultFromText } from "../runtime/claude-output";
import { createTelegramStatusSink, type TelegramTransport } from "../status/sinks/telegram";

// --- Markdown → Telegram HTML conversion (ported from nanobot) ---

function markdownToTelegramHtml(text: string): string {
  if (!text) return "";

  // 1. Extract and protect code blocks
  const codeBlocks: string[] = [];
  text = text.replace(/```[\w]*\n?([\s\S]*?)```/g, (_m, code) => {
    codeBlocks.push(code);
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  // 2. Extract and protect inline code
  const inlineCodes: string[] = [];
  text = text.replace(/`([^`]+)`/g, (_m, code) => {
    inlineCodes.push(code);
    return `\x00IC${inlineCodes.length - 1}\x00`;
  });

  // 3. Strip markdown headers
  text = text.replace(/^#{1,6}\s+(.+)$/gm, "$1");

  // 4. Strip blockquotes
  text = text.replace(/^>\s*(.*)$/gm, "$1");

  // 5. Escape HTML special characters
  text = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // 6. Links [text](url) — before bold/italic to handle nested cases
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // 7. Bold **text** or __text__
  text = text.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  text = text.replace(/__(.+?)__/g, "<b>$1</b>");

  // 8. Italic _text_ (avoid matching inside words like some_var_name)
  text = text.replace(/(?<![a-zA-Z0-9])_([^_]+)_(?![a-zA-Z0-9])/g, "<i>$1</i>");

  // 9. Strikethrough ~~text~~
  text = text.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // 10. Bullet lists
  text = text.replace(/^[-*]\s+/gm, "• ");

  // 11. Restore inline code with HTML tags
  for (let i = 0; i < inlineCodes.length; i++) {
    const escaped = inlineCodes[i].replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    text = text.replace(`\x00IC${i}\x00`, `<code>${escaped}</code>`);
  }

  // 12. Restore code blocks with HTML tags
  for (let i = 0; i < codeBlocks.length; i++) {
    const escaped = codeBlocks[i].replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    text = text.replace(`\x00CB${i}\x00`, `<pre><code>${escaped}</code></pre>`);
  }

  return text;
}

// --- Telegram Bot API (raw fetch, zero deps) ---

const FILE_API_BASE = "https://api.telegram.org/file/bot";

interface TelegramUser {
  id: number;
  first_name: string;
  username?: string;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  reply_to_message?: Partial<TelegramMessage>;
  quote?: { text?: string };
  forward_origin?: { type: string; sender_user?: TelegramUser; sender_user_name?: string };
  chat: { id: number; type: string; is_forum?: boolean };
  message_thread_id?: number;
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  voice?: TelegramVoice;
  audio?: TelegramAudio;
  entities?: Array<{
    type: "mention" | "bot_command" | string;
    offset: number;
    length: number;
  }>;
  caption_entities?: Array<{
    type: "mention" | "bot_command" | string;
    offset: number;
    length: number;
  }>;
}

interface TelegramPhotoSize {
  file_id: string;
  width: number;
  height: number;
  file_size?: number;
}

interface TelegramDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface TelegramVoice {
  file_id: string;
  mime_type?: string;
  duration?: number;
  file_size?: number;
}

interface TelegramAudio {
  file_id: string;
  mime_type?: string;
  duration?: number;
  file_name?: string;
  file_size?: number;
}

interface TelegramChatMember {
  user: TelegramUser;
  status: "creator" | "administrator" | "member" | "restricted" | "left" | "kicked";
}

interface TelegramMyChatMemberUpdate {
  chat: { id: number; type: string; title?: string };
  from: TelegramUser;
  old_chat_member: TelegramChatMember;
  new_chat_member: TelegramChatMember;
}

interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  edited_channel_post?: TelegramMessage;
  my_chat_member?: TelegramMyChatMemberUpdate;
  callback_query?: TelegramCallbackQuery;
}

interface TelegramMe {
  id: number;
  username?: string;
  can_read_all_group_messages?: boolean;
}

interface TelegramFile {
  file_path?: string;
}

let telegramDebug = false;

function debugLog(message: string): void {
  if (!telegramDebug) return;
  console.log(`[Telegram][debug] ${message}`);
}

function normalizeTelegramText(text: string): string {
  return text.replace(/[\u2010-\u2015\u2212]/g, "-");
}

function getMessageTextAndEntities(message: TelegramMessage): {
  text: string;
  entities: TelegramMessage["entities"];
} {
  if (message.text) {
    return {
      text: normalizeTelegramText(message.text),
      entities: message.entities,
    };
  }

  if (message.caption) {
    return {
      text: normalizeTelegramText(message.caption),
      entities: message.caption_entities,
    };
  }

  return { text: "", entities: [] };
}

function isImageDocument(document?: TelegramDocument): boolean {
  return Boolean(document?.mime_type?.startsWith("image/"));
}

function isAudioDocument(document?: TelegramDocument): boolean {
  return Boolean(document?.mime_type?.startsWith("audio/"));
}

function isDocumentAttachment(document?: TelegramDocument): boolean {
  return Boolean(document?.file_id) && !isImageDocument(document) && !isAudioDocument(document);
}

function pickLargestPhoto(photo: TelegramPhotoSize[]): TelegramPhotoSize {
  return [...photo].sort((a, b) => {
    const sizeA = a.file_size ?? a.width * a.height;
    const sizeB = b.file_size ?? b.width * b.height;
    return sizeB - sizeA;
  })[0];
}

function extensionFromMimeType(mimeType?: string): string {
  switch (mimeType) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    case "image/bmp":
      return ".bmp";
    default:
      return "";
  }
}

function extensionFromAudioMimeType(mimeType?: string): string {
  switch (mimeType) {
    case "audio/mpeg":
      return ".mp3";
    case "audio/mp4":
    case "audio/x-m4a":
      return ".m4a";
    case "audio/ogg":
      return ".ogg";
    case "audio/wav":
    case "audio/x-wav":
      return ".wav";
    case "audio/webm":
      return ".webm";
    default:
      return "";
  }
}

function extractTelegramCommand(text: string): string | null {
  const firstToken = text.trim().split(/\s+/, 1)[0];
  if (!firstToken.startsWith("/")) return null;
  return firstToken.split("@", 1)[0].toLowerCase();
}

export function telegramStatusTransport(token: string): TelegramTransport {
  const signal = bridgeSignal() ?? new AbortController().signal;
  return {
    async sendMessage(chatId, text, threadId) {
      const trimmed = text.slice(0, 4096);
      const body: Record<string, unknown> = { chat_id: chatId, text: trimmed };
      if (threadId !== undefined) body.message_thread_id = threadId;
      const res = await callApi<{ ok: boolean; result: { message_id: number } }>(
        token,
        "sendMessage",
        body,
        {signal},
      );
      return { messageId: res.result.message_id };
    },
    async editMessageText(chatId, messageId, text) {
      const trimmed = text.slice(0, 4096);
      await callApi(token, "editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: trimmed,
      }, {signal});
    },
    async deleteMessage(chatId, messageId) {
      await callApi(token, "deleteMessage", { chat_id: chatId, message_id: messageId }, {signal});
    },
  };
}

async function sendMessage(token: string, chatId: number, text: string, threadId?: number): Promise<void> {
  const normalized = normalizeTelegramText(text).replace(/\[react:[^\]\r\n]+\]/gi, "");
  const MAX_LEN = 4000;
  for (let i = 0; i < normalized.length;) {
    let end = Math.min(i + MAX_LEN, normalized.length);
    if (end < normalized.length && /[\uD800-\uDBFF]/.test(normalized[end - 1])) end--;
    const chunk = normalized.slice(i, end);
    i = end;
    const html = markdownToTelegramHtml(chunk);
    const formatted = normalized.length <= MAX_LEN && html.length <= 4096;
    try {
      await callApi(token, "sendMessage", {
        chat_id: chatId,
        text: formatted ? html : chunk,
        ...(formatted ? { parse_mode: "HTML" } : {}),
        ...(threadId ? { message_thread_id: threadId } : {}),
      });
    } catch (err) {
      if (!(err instanceof TelegramApiError) || err.code !== 400 || !/parse entities|unsupported start tag|entity/i.test(err.description)) throw err;
      // Telegram explicitly rejected formatting; the original was not sent.
      await callApi(token, "sendMessage", {
        chat_id: chatId,
        text: chunk,
        ...(threadId ? { message_thread_id: threadId } : {}),
      });
    }
  }
}

async function sendTyping(token: string, chatId: number, threadId?: number): Promise<void> {
  await callApi(token, "sendChatAction", {
    chat_id: chatId,
    action: "typing",
    ...(threadId ? { message_thread_id: threadId } : {}),
  }).catch(() => {});
}

async function sendDocumentToChat(
  token: string,
  chatId: number,
  filePath: string,
  outbox: string,
  threadId?: number
): Promise<void> {
  const { file, name: fileName } = await prepareArtifact(filePath, outbox);
  const formData = new FormData();
  formData.append("chat_id", String(chatId));
  formData.append("document", file, fileName);
  if (threadId) formData.append("message_thread_id", String(threadId));

  await callApi(token, "sendDocument", formData, { timeoutMs: 60_000 });
}

function extractReactionDirective(text: string): { cleanedText: string; reactionEmoji: string | null } {
  let reactionEmoji: string | null = null;
  const cleanedText = text
    .replace(/\[react:([^\]\r\n]+)\]/gi, (_match, raw) => {
      const candidate = String(raw).trim();
      if (!reactionEmoji && candidate) reactionEmoji = candidate;
      return "";
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { cleanedText, reactionEmoji };
}


async function sendReaction(token: string, chatId: number, messageId: number, emoji: string): Promise<void> {
  await callApi(token, "setMessageReaction", {
    chat_id: chatId,
    message_id: messageId,
    reaction: [{ type: "emoji", emoji }],
  });
}

let botUsername: string | null = null;
let botId: number | null = null;

function groupTriggerReason(message: TelegramMessage): string | null {
  if (botId && message.reply_to_message?.from?.id === botId) return "reply_to_bot";
  const { text, entities } = getMessageTextAndEntities(message);
  if (!text) return null;
  const lowerText = text.toLowerCase();
  if (botUsername && lowerText.includes(`@${botUsername.toLowerCase()}`)) return "text_contains_mention";

  for (const entity of entities ?? []) {
    const value = text.slice(entity.offset, entity.offset + entity.length);
    if (entity.type === "mention" && botUsername && value.toLowerCase() === `@${botUsername.toLowerCase()}`) {
      return "mention_entity_matches_bot";
    }
    if (entity.type === "mention" && !botUsername) return "mention_entity_before_botname_loaded";
    if (entity.type === "bot_command") {
      if (!value.includes("@")) return "bare_bot_command";
      if (!botUsername) return "scoped_command_before_botname_loaded";
      if (botUsername && value.toLowerCase().endsWith(`@${botUsername.toLowerCase()}`)) return "scoped_command_matches_bot";
    }
  }

  return null;
}

async function downloadImageFromMessage(token: string, message: TelegramMessage): Promise<string | null> {
  const photo = message.photo && message.photo.length > 0 ? pickLargestPhoto(message.photo) : null;
  const imageDocument = isImageDocument(message.document) ? message.document : null;
  const fileId = photo?.file_id ?? imageDocument?.file_id;
  if (!fileId) return null;

  const fileMeta = await callApi<{ ok: boolean; result: TelegramFile }>(token, "getFile", { file_id: fileId });
  if (!fileMeta.ok || !fileMeta.result.file_path) return null;

  const remotePath = fileMeta.result.file_path;
  const downloadUrl = `${FILE_API_BASE}${token}/${remotePath}`;
  const bytes = await downloadBytes(downloadUrl);

  const dir = telegramInboxDir();
  await mkdir(dir, { recursive: true });

  const remoteExt = extname(remotePath);
  const docExt = extname(imageDocument?.file_name ?? "");
  const mimeExt = extensionFromMimeType(imageDocument?.mime_type);
  const ext = remoteExt || docExt || mimeExt || ".jpg";
  const filename = `${message.chat.id}-${message.message_id}-${Date.now()}${ext}`;
  const localPath = join(dir, filename);
  await Bun.write(localPath, bytes);
  return localPath;
}

async function downloadVoiceFromMessage(token: string, message: TelegramMessage): Promise<string | null> {
  const audioDocument = isAudioDocument(message.document) ? message.document : null;
  const audioLike = message.voice ?? message.audio ?? audioDocument;
  const fileId = audioLike?.file_id;
  if (!fileId) return null;

  const fileMeta = await callApi<{ ok: boolean; result: TelegramFile }>(token, "getFile", { file_id: fileId });
  if (!fileMeta.ok || !fileMeta.result.file_path) return null;

  const remotePath = fileMeta.result.file_path;
  const downloadUrl = `${FILE_API_BASE}${token}/${remotePath}`;
  debugLog(
    `Voice download: fileId=${fileId} remotePath=${remotePath} mime=${audioLike.mime_type ?? "unknown"} expectedSize=${audioLike.file_size ?? "unknown"}`
  );
  const bytes = await downloadBytes(downloadUrl);

  const dir = telegramInboxDir();
  await mkdir(dir, { recursive: true });

  const remoteExt = extname(remotePath);
  const docExt = extname(message.document?.file_name ?? "");
  const audioExt = extname(message.audio?.file_name ?? "");
  const mimeExt = extensionFromAudioMimeType(audioLike.mime_type);
  const ext = remoteExt || docExt || audioExt || mimeExt || ".ogg";
  const filename = `${message.chat.id}-${message.message_id}-${Date.now()}${ext}`;
  const localPath = join(dir, filename);
  await Bun.write(localPath, bytes);
  const header = Array.from(bytes.slice(0, 8))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
  const oggMagic =
    bytes.length >= 4 &&
    bytes[0] === 0x4f &&
    bytes[1] === 0x67 &&
    bytes[2] === 0x67 &&
    bytes[3] === 0x53;
  debugLog(
    `Voice download: wrote ${bytes.length} bytes to ${localPath} ext=${ext} header=${header || "empty"} oggMagic=${oggMagic}`
  );
  return localPath;
}

async function downloadDocumentFromMessage(
  token: string,
  message: TelegramMessage
): Promise<{ localPath: string; originalName: string } | null> {
  const doc = message.document;
  if (!doc || !isDocumentAttachment(doc)) return null;

  const fileMeta = await callApi<{ ok: boolean; result: TelegramFile }>(
    token,
    "getFile",
    { file_id: doc.file_id }
  );
  if (!fileMeta.ok || !fileMeta.result.file_path) return null;

  const remotePath = fileMeta.result.file_path;
  const downloadUrl = `${FILE_API_BASE}${token}/${remotePath}`;
  const bytes = await downloadBytes(downloadUrl);

  const dir = telegramInboxDir();
  await mkdir(dir, { recursive: true });

  const originalName = doc.file_name ?? `document${extname(remotePath) || ""}`;
  const ext = extname(originalName) || extname(remotePath) || "";
  const filename = `${message.chat.id}-${message.message_id}-${Date.now()}${ext}`;
  const localPath = join(dir, filename);
  await Bun.write(localPath, bytes);
  return { localPath, originalName };
}

export async function handleMyChatMember(update: TelegramMyChatMemberUpdate): Promise<void> {
  return enqueueBridge("telegram", `${update.chat.id}:main`, () => processMyChatMember(update));
}

async function processMyChatMember(update: TelegramMyChatMemberUpdate): Promise<void> {
  const config = getSettings().telegram;
  const chat = update.chat;
  if (!config.allowedUserIds.includes(update.from.id)) return;
  const policy = resolveTelegramPolicy(await getSharedDb(), chat.id, false);
  if (policy.mode === "delivery-only" || policy.deliveryRole === "delivery") return;
  if (!botUsername && update.new_chat_member.user.username) botUsername = update.new_chat_member.user.username;
  if (!botId) botId = update.new_chat_member.user.id;
  const oldStatus = update.old_chat_member.status;
  const newStatus = update.new_chat_member.status;
  const isGroup = chat.type === "group" || chat.type === "supergroup";
  const wasOut = oldStatus === "left" || oldStatus === "kicked";
  const isIn = newStatus === "member" || newStatus === "administrator";

  if (!isGroup || !wasOut || !isIn) return;

  const chatName = chat.title ?? String(chat.id);
  console.log(`[Telegram] Added to ${chat.type}: ${chatName} (${chat.id}) by ${update.from.id}`);

  const addedBy = update.from.username ?? `${update.from.first_name} (${update.from.id})`;
  const eventPrompt =
    `[Telegram system event] I was added to a ${chat.type}.\n` +
    `Group title: ${chatName}\n` +
    `Group id: ${chat.id}\n` +
    `Added by: ${addedBy}\n` +
    "Write a short first message for the group. It should confirm I was added and explain how to trigger me.";

  try {
    const result = await run("telegram", eventPrompt, telegramSessionTarget({ workspace: process.cwd(), chatId: chat.id, userId: update.from.id, isDm: false }, policy), undefined, "telegram");
    if (result.exitCode !== 0) {
      await sendMessage(config.token, chat.id, "I was added to this group. Mention me with a command to start.");
      return;
    }
    await sendMessage(config.token, chat.id, result.stdout || "I was added to this group.");
  } catch (err) {
    console.error(`[Telegram] group-added event error: ${err instanceof Error ? err.message : err}`);
    await sendMessage(config.token, chat.id, "I was added to this group. Mention me with a command to start.");
  }
}

// --- Message handler ---

const pendingForumCreations = new Map<number, (channel: string) => Promise<void>>();

export async function handleMessage(message: TelegramMessage): Promise<void> {
  if (!message.forward_origin && isCancelCommand(extractTelegramCommand(getMessageTextAndEntities(message).text))) return processMessage(message);
  if (message.message_thread_id !== undefined) pendingForumCreations.get(message.chat.id)?.(`${message.chat.id}:${message.message_thread_id}`);
  return enqueueBridge("telegram", `${message.chat.id}:${message.message_thread_id ?? "main"}`, () => processMessage(message));
}

async function processMessage(message: TelegramMessage): Promise<void> {
  const config = getSettings().telegram;
  const userId = message.from?.id;
  const chatId = message.chat.id;
  let threadId = message.message_thread_id;
  const { text } = getMessageTextAndEntities(message);
  const chatType = message.chat.type;
  const isPrivate = chatType === "private";
  const isGroup = chatType === "group" || chatType === "supergroup";
  const hasImage = Boolean((message.photo && message.photo.length > 0) || isImageDocument(message.document));
  const hasVoice = Boolean(message.voice || message.audio || isAudioDocument(message.document));
  const hasDocument = Boolean(message.document && isDocumentAttachment(message.document));

  if (!isPrivate && !isGroup) return;

  const triggerReason = isGroup ? groupTriggerReason(message) : "private_chat";
  debugLog(
    `Handle message chat=${chatId} type=${chatType} from=${userId ?? "unknown"} reason=${triggerReason} text="${(text ?? "").slice(0, 80)}"`
  );

  // Fail-closed auth: with an empty allowlist we treat the bridge as
  // "not configured yet" and refuse everyone. Previously an unset list
  // meant allow-all, so a half-configured bot acted as an open relay.
  if (config.allowedUserIds.length === 0) {
    if (isPrivate && userId !== undefined) {
      await sendMessage(
        config.token,
        chatId,
        "Unauthorized: no allowlist configured.",
      );
    } else {
      debugLog(`Skip message chat=${chatId} reason=no_allowlist_configured`);
    }
    return;
  }
  if (!userId || !config.allowedUserIds.includes(userId)) {
    if (isPrivate) {
      await sendMessage(config.token, chatId, "Unauthorized.");
    } else {
      console.log(
        `[Telegram] Ignored group message from unauthorized user ${userId ?? "unknown"} in chat ${chatId}`,
      );
      debugLog(`Skip group message chat=${chatId} from=${userId} reason=unauthorized_user`);
    }
    return;
  }

  if (!text.trim() && !hasImage && !hasVoice && !hasDocument) {
    debugLog(`Skip message chat=${chatId} from=${userId ?? "unknown"} reason=empty_text`);
    return;
  }

  const policy = resolveTelegramPolicy(await getSharedDb(), chatId, isPrivate, threadId);
  if (policy.mode === "delivery-only" || policy.deliveryRole === "delivery") return;
  if (isGroup && !triggerReason && !["listen", "free-response", "shared"].includes(policy.mode)) return;
  let target = telegramSessionTarget({ workspace: process.cwd(), chatId, userId, topicId: threadId, isDm: isPrivate }, policy);
  const preparationKey = target.key;
  const incomingCommand = message.forward_origin ? null : extractTelegramCommand(text);
  if (isCancelCommand(incomingCommand)) {
    await sendMessage(config.token, chatId, cancelConversation(target) ? "Cancellation requested for this conversation's active task." : "No active task in this conversation.", threadId);
    return;
  }
  return enqueueBridge("conversation", preparationKey, async () => {
    const command = text && !message.forward_origin ? extractTelegramCommand(text) : null;
    if (command) {
      const response = await preferenceCommand(target, command, text.trim().replace(/^\S+\s*/, ""), getSettings().model);
      if (response) { await sendMessage(config.token, chatId, response, threadId); return; }
    }
    if (command === "/start") {
      await sendMessage(
        config.token,
        chatId,
        "Hello! Send me a message and I'll respond using Claude.\nUse /reset to start a fresh session.",
        threadId
      );
      return;
    }

    if (command === "/reset") {
      await resetCurrentSession({ target });
      await sendMessage(config.token, chatId, "This conversation was reset. Next message starts fresh; saved memory is retained.", threadId);
      return;
    }

    if (command === "/forget") {
      await forgetCurrentSession(target);
      await sendMessage(config.token, chatId, "This conversation's Hermes history, saved facts and native auto memory were erased. Next message starts fresh.", threadId);
      return;
    }

    if (command === "/compact") {
      await sendMessage(config.token, chatId, "⏳ Compacting session...", threadId);
      const sink = createTelegramStatusSink({
        transport: telegramStatusTransport(config.token),
        chatId,
        ...(threadId !== undefined && { threadId }),
      });
      const result = await compactCurrentSession({ sink, target });
      await sendMessage(config.token, chatId, result.message, threadId);
      return;
    }

    if (command === "/status") {
      const session = await sessionAccess(target).peek();
      const settings = getSettings();
      if (!session) {
        await sendMessage(config.token, chatId, "📊 No active session.", threadId);
        return;
      }
      const lines = [
        "📊 **Session Status**",
        `Session: \`${session.sessionId.slice(0, 8)}\``,
        `Turns: ${session.turnCount ?? 0}`,
        `Model: ${(await conversationPreference(target)).model ?? target.policy?.modelPolicy?.model ?? (settings.model || "default")}`,
        `Security: ${settings.security.level}`,
        `Created: ${session.createdAt}`,
        `Last used: ${session.lastUsedAt}`,
        `Compact warned: ${(session as any).compactWarned ? "yes" : "no"}`,
      ];
      await sendMessage(config.token, chatId, lines.join("\n"), threadId);
      return;
    }

    if (command === "/context") {
      const session = await sessionAccess(target).peek();
      if (!session) {
        await sendMessage(config.token, chatId, "No active session.", threadId);
        return;
      }
      const home = homedir();
      const jsonlPath = await findSessionFile(home, target.workspace, session.sessionId);
      if (!jsonlPath) {
        await sendMessage(config.token, chatId, "Conversation file not found.", threadId);
        return;
      }
      try {
        const raw = await readFile(jsonlPath, "utf8");
        await sendMessage(config.token, chatId, formatContextUsage(raw, session.turnCount ?? 0), threadId);
      } catch (err) {
        await sendMessage(config.token, chatId, `Failed to read context: ${err instanceof Error ? err.message : err}`, threadId);
      }
      return;
    }

    if (command && !isSkillAllowed(policy, command)) {
      await sendMessage(config.token, chatId, `Skill ${command} is not allowed in this conversation.`, threadId);
      return;
    }

    const label = message.from?.username ?? String(userId ?? "unknown");
    const mediaParts = [hasImage ? "image" : "", hasVoice ? "voice" : "", hasDocument ? "doc" : ""].filter(Boolean);
    const mediaSuffix = mediaParts.length > 0 ? ` [${mediaParts.join("+")}]` : "";
    console.log(
      `[${new Date().toLocaleTimeString()}] Telegram ${label}${mediaSuffix}: "${text.slice(0, 60)}${text.length > 60 ? "..." : ""}"`
    );

    // Keep typing indicator alive while queued/running
    const typingInterval = setInterval(() => sendTyping(config.token, chatId, threadId), 4000);

    try {
      const reply = async () => {
        await sendTyping(config.token, chatId, threadId);
        let imagePath: string | null = null;
        let voicePath: string | null = null;
        let voiceTranscript: string | null = null;
        if (hasImage) {
          try {
            imagePath = await downloadImageFromMessage(config.token, message);
          } catch (err) {
            console.error(`[Telegram] Failed to download image for ${label}: ${err instanceof Error ? err.message : err}`);
          }
        }
        if (hasVoice) {
          try {
            voicePath = await downloadVoiceFromMessage(config.token, message);
          } catch (err) {
            console.error(`[Telegram] Failed to download voice for ${label}: ${err instanceof Error ? err.message : err}`);
          }

          if (voicePath) {
            try {
              debugLog(`Voice file saved: path=${voicePath}`);
              voiceTranscript = await transcribeAudioToText(voicePath, {
                debug: telegramDebug,
                log: (message) => debugLog(message),
              });
            } catch (err) {
              console.error(`[Telegram] Failed to transcribe voice for ${label}: ${err instanceof Error ? err.message : err}`);
            }
          }
        }

        // Skill routing: resolve slash commands to SKILL.md prompts
        let skillContext: string | null = null;
        if (command && command !== "/start" && command !== "/reset" && command !== "/compact" && command !== "/status" && command !== "/context") {
          try {
            skillContext = await resolveSkillPrompt(command);
            if (skillContext) {
              debugLog(`Skill resolved for ${command}: ${skillContext.length} chars`);
            }
          } catch (err) {
            debugLog(`Skill resolution failed for ${command}: ${err instanceof Error ? err.message : err}`);
          }
        }

        let documentInfo: { localPath: string; originalName: string } | null = null;
        if (hasDocument) {
          try {
            documentInfo = await downloadDocumentFromMessage(config.token, message);
          } catch (err) {
            console.error(
              `[Telegram] Failed to download document for ${label}: ${err instanceof Error ? err.message : err}`
            );
          }
        }

        const promptParts = [`[Telegram from ${label}]`];
        const reference = message.reply_to_message;
        const quote = quotedContext("reply", message.quote?.text ?? reference?.text ?? reference?.caption ?? "", reference?.message_id === undefined ? undefined : String(reference.message_id));
        if (quote) promptParts.push(quote);
        if (message.forward_origin) promptParts.push(quotedContext("forward-origin", message.forward_origin.sender_user?.first_name ?? message.forward_origin.sender_user_name ?? message.forward_origin.type));
        if (threadId) promptParts.push(`[thread:${threadId}]`);
        if (skillContext) {
          // Strip the slash command from the message text and pass remaining args
          const args = text.trim().slice(command!.length).trim();
          promptParts.push(`<command-name>${command}</command-name>`);
          promptParts.push(skillContext);
          if (args) promptParts.push(`User arguments: ${args}`);
        } else if (message.forward_origin) {
          promptParts.push(quotedContext("forward", text, String(message.message_id)));
        } else if (text.trim()) {
          promptParts.push(`Message: ${text}`);
        }
        if (imagePath) {
          promptParts.push(`Image path: ${imagePath}`);
          promptParts.push("The user attached an image. Inspect this image file directly before answering.");
        } else if (hasImage) {
          promptParts.push("The user attached an image, but downloading it failed. Respond and ask them to resend.");
        }
        if (voiceTranscript) {
          if (message.forward_origin) promptParts.push(quotedContext("forwarded-audio", voiceTranscript, String(message.message_id)));
          else {
            promptParts.push(`Voice transcript: ${voiceTranscript}`);
            promptParts.push("The user attached voice audio. Use the transcript as their spoken message.");
          }
        } else if (hasVoice) {
          promptParts.push(
            "The user attached voice audio, but it could not be transcribed. Respond and ask them to resend a clearer clip."
          );
        }
        if (documentInfo) {
          promptParts.push(`Document path: ${documentInfo.localPath}`);
          promptParts.push(`Original filename: ${documentInfo.originalName}`);
          promptParts.push(
            "The user attached a document. Read and process this file directly."
          );
        } else if (hasDocument) {
          promptParts.push(
            "The user attached a document, but downloading it failed. Respond and ask them to resend."
          );
        }
        if (reference) {
          const quotedMessage: TelegramMessage = { ...reference, message_id: reference.message_id ?? message.message_id, chat: message.chat };
          const source = String(reference.message_id ?? "unknown");
          try {
            const image = await downloadImageFromMessage(config.token, quotedMessage);
            if (image) promptParts.push(quotedContext("reply-image", `Image path: ${image}`, source));
            const doc = await downloadDocumentFromMessage(config.token, quotedMessage);
            if (doc) promptParts.push(quotedContext("reply-document", `Document path: ${doc.localPath}; original filename: ${doc.originalName}`, source));
            const audio = await downloadVoiceFromMessage(config.token, quotedMessage);
            if (audio) promptParts.push(quotedContext("reply-audio", `Audio path: ${audio}. Treat this as quoted audio, not the current user's instructions.`, source));
          } catch (error) {
            debugLog(`Referenced attachment unavailable: ${error}`);
            promptParts.push("A referenced attachment could not be downloaded. Ask for the needed file.");
          }
        }
        const prefixedPrompt = promptParts.join("\n");
        const statusSink = createTelegramStatusSink({
            preview: true, verbose: (await conversationPreference(target)).verbose ?? false,
          transport: telegramStatusTransport(config.token),
          chatId,
          ...(threadId !== undefined && { threadId }),
        });
        const threadArg = target;
        const result = await runUserMessage("telegram", {text: message.forward_origin ? "" : text || voiceTranscript || "", context: prefixedPrompt}, threadArg, statusSink, "telegram");

        if (result.exitCode !== 0) {
          await sendMessage(config.token, chatId, `Error (exit ${result.exitCode}): ${result.stderr || "Unknown error"}`, threadId);
        } else {
          const visibleText = extractSessionAndResultFromText(result.stdout || "").result ?? result.stdout ?? "";
          const { cleanedText: afterReact, reactionEmoji } = extractReactionDirective(visibleText);
          const { cleanedText, filePaths } = extractSendFileDirectives(afterReact);
          if (reactionEmoji) {
            await sendReaction(config.token, chatId, message.message_id, reactionEmoji).catch((err) => {
              console.error(`[Telegram] Failed to send reaction for ${label}: ${err instanceof Error ? err.message : err}`);
            });
          }
          if (cleanedText) {
            await sendMessage(config.token, chatId, cleanedText, threadId);
          }
          for (const fp of filePaths) {
            try {
              await sendDocumentToChat(config.token, chatId, fp, artifactDirectory(target.workspace, target.key), threadId);
            } catch (err) {
              console.error(`[Telegram] Failed to send document for ${label}: ${err instanceof Error ? err.message : err}`);
              await sendMessage(config.token, chatId, `Failed to send file: ${fp.split("/").pop()}`, threadId);
            }
          }
          if (!cleanedText && filePaths.length === 0) {
            await sendMessage(config.token, chatId, "(empty response)", threadId);
          }
        }
      };
      if (isGroup && policy.autoThread && threadId === undefined) {
        if (!message.chat.is_forum) {
          await sendMessage(config.token, chatId, "autoThread requires a Telegram forum supergroup. Enable topics or disable autoThread for this chat.");
          return;
        }
        const transfer = prepareBridgeTransfer<number>("telegram", async topicId => {
          threadId = topicId;
          target = telegramSessionTarget({workspace:process.cwd(),chatId,userId,topicId,isDm:false},resolveTelegramPolicy(await getSharedDb(),chatId,false,topicId));
          if (target.key === preparationKey) await reply();
          else await enqueueBridge("conversation", target.key, reply);
        });
        pendingForumCreations.set(chatId, transfer.reserve);
        try {
          const topic = await callApi<{result:{message_thread_id:number}}>(config.token, "createForumTopic", {
            chat_id: chatId, name: (text.trim() || `${label}'s conversation`).slice(0,100),
          });
          await transfer.complete(`${chatId}:${topic.result.message_thread_id}`, topic.result.message_thread_id);
        } finally {
          transfer.cancel();
          pendingForumCreations.delete(chatId);
        }
      } else {
        await reply();
      }

    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[Telegram] Error for ${label}: ${errMsg}`);
      await sendMessage(config.token, chatId, `Error: ${errMsg}`, threadId);
    } finally {
      clearInterval(typingInterval);
    }
  });
}

// --- Callback query handler ---

async function handleCallbackQuery(query: TelegramCallbackQuery): Promise<void> {
  const config = getSettings().telegram;

  // Fail-closed auth: an empty allowlist rejects everyone, and any
  // non-allowlisted caller gets a polite toast and we drop the query.
  const fromId = query.from?.id;
  if (
    config.allowedUserIds.length === 0 ||
    fromId === undefined ||
    !config.allowedUserIds.includes(fromId)
  ) {
    await callApi(config.token, "answerCallbackQuery", {
      callback_query_id: query.id,
      text: "Unauthorized.",
    }).catch(() => {});
    return;
  }

  // No callback patterns are handled today — ack with no text so Telegram
  // stops the spinner on the user's button.
  await callApi(config.token, "answerCallbackQuery", { callback_query_id: query.id }).catch(() => {});
}

// --- Bot command menu registration ---

async function registerBotCommands(token: string): Promise<void> {
  try {
    const skills = await listSkills();
    const commands = [
      { command: "start", description: "Show welcome message" },
      { command: "reset", description: "Reset session and start fresh" },
      { command: "forget", description: "Erase this conversation's saved memory and history" },
      { command: "compact", description: "Compact session to reduce context size" },
      { command: "status", description: "Show current session status" },
      { command: "context", description: "Show context window usage" },
      { command: "cancel", description: "Stop this conversation's active task" },
      { command: "model", description: "Show or change this conversation's model" },
      { command: "verbose", description: "Toggle detailed progress with on or off" },
    ];
    const registered = new Set(commands.map(command => command.command));
    for (const skill of skills) {
      // Telegram commands: 1-32 chars, lowercase a-z, 0-9, underscores only
      const cmd = skill.name
        .toLowerCase()
        .replace(/[-.:]/g, "_")
        .replace(/[^a-z0-9_]/g, "")
        .slice(0, 32);
      if (!cmd || registered.has(cmd)) continue;
      if (cmd.length > 30) continue;
      const desc = skill.description.length >= 3
        ? skill.description.slice(0, 256)
        : `Run ${skill.name} skill`;
      commands.push({ command: cmd, description: desc });
      registered.add(cmd);
    }
    if (commands.length > 100) commands.length = 100;
    try {
      await callApi(token, "setMyCommands", { commands });
      console.log(`  Commands registered: ${commands.length} (${commands.map((c) => "/" + c.command).join(", ")})`);
    } catch (regErr) {
      // Skill-generated commands may violate Telegram constraints; retry with built-in commands only
      console.warn(`[Telegram] Full command registration failed, retrying with built-in commands only: ${regErr instanceof Error ? regErr.message : regErr}`);
      const builtinOnly = commands.filter((c) => ["start", "reset", "forget", "compact", "status", "context"].includes(c.command));
      await callApi(token, "setMyCommands", { commands: builtinOnly });
      console.log(`  Commands registered (built-in only): ${builtinOnly.length}`);
    }
  } catch (err) {
    console.error(`[Telegram] Failed to register commands: ${err instanceof Error ? err.message : err}`);
  }
}

// --- Polling loop ---

let pollingController: AbortController | null = null;

export async function poll(signal: AbortSignal): Promise<void> {
  const config = getSettings().telegram;
  // A Telegram token's prefix is the bot ID, stable across token rotation.
  let account = config.token.split(":", 1)[0];
  try {
    const me = await callApi<{ ok: boolean; result: TelegramMe }>(config.token, "getMe", undefined, { signal });
    if (signal.aborted) return;
    if (me.ok) {
      botUsername = me.result.username ?? null;
      botId = me.result.id;
      account = String(me.result.id);
      console.log(`  Bot: ${botUsername ? `@${botUsername}` : botId}`);
      console.log(`  Group privacy: ${me.result.can_read_all_group_messages ? "disabled (reads all messages)" : "enabled (commands & mentions only)"}`);
    }
  } catch (err) {
    console.error(`[Telegram] getMe failed: ${err instanceof Error ? err.message : err}`);
  }

  if (signal.aborted) return;
  const db = await getSharedDb();
  const checkpoint = telegramCheckpoint(db, account);
  for (const receipt of checkpoint.pending()) {
    if (signal.aborted) return;
    const authorized = receipt.userId !== undefined && config.allowedUserIds.includes(receipt.userId);
    const policy = receipt.chatId === undefined ? null : resolveTelegramPolicy(db, receipt.chatId, receipt.isDm ?? false, receipt.topicId);
    const triggered = receipt.isDm || receipt.triggered || (policy && ["listen", "free-response", "shared"].includes(policy.mode));
    if (!authorized || !triggered || !policy || policy.mode === "delivery-only" || policy.deliveryRole === "delivery") {
      checkpoint.complete(receipt.updateId);
      continue;
    }
    try {
      await callApi(config.token, "sendMessage", {
        chat_id: receipt.chatId,
        text: "An earlier request was interrupted or its delivery was not confirmed when Hermes restarted. It may have partially run. Check its effects before sending it again.",
        ...(receipt.messageId === undefined ? {} : { reply_parameters: { message_id: receipt.messageId, allow_sending_without_reply: true } }),
        ...(receipt.topicId === undefined ? {} : { message_thread_id: receipt.topicId }),
      }, { signal });
      checkpoint.complete(receipt.updateId);
    } catch (err) {
      console.error(`[Telegram] Recovery notice failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log("Telegram bot started (long polling)");
  console.log(`  Allowed users: ${config.allowedUserIds.length === 0 ? "none (fail-closed)" : config.allowedUserIds.join(", ")}`);
  if (telegramDebug) console.log("  Debug: enabled");

  // Register available skills as bot command menu (non-blocking)
  registerBotCommands(config.token).catch(() => {});

  await pollUpdates<TelegramUpdate>({
    signal, getOffset: checkpoint.offset,
    admit: update => {
      const message = update.message;
      // Non-message updates still advance the durable checkpoint, but carry no
      // reply destination. Never persist the user's message body or credentials.
      checkpoint.admit({ updateId: update.update_id, ...(message ? {
        chatId: message.chat.id, userId: message.from?.id, messageId: message.message_id,
        topicId: message.message_thread_id, isDm: message.chat.type === "private",
        triggered: Boolean(groupTriggerReason(message)),
      } : {}) });
    },
    request: async offset => {
      const data = await callApi<{ ok: boolean; result: TelegramUpdate[] }>(config.token, "getUpdates",
        { offset, timeout: 30, allowed_updates: ["message", "my_chat_member", "callback_query"] },
        { signal, maxRetries: 0 });
      return data.result;
    },
    handle: async update => {
      if (update.message) await handleMessage(update.message);
      if (update.my_chat_member) await handleMyChatMember(update.my_chat_member);
      if (update.callback_query) await handleCallbackQuery(update.callback_query);
      checkpoint.complete(update.update_id);
    },
    onError: err => console.error(`[Telegram] Poll error: ${err instanceof Error ? err.message : err}`),
  });
}

// --- Exports ---

/** Send a message to a specific chat (used by heartbeat forwarding) */
export { sendMessage };

export function stopPolling(): void {
  pollingController?.abort(); pollingController = null;
  botId = null; botUsername = null;
}
process.on("SIGTERM", stopPolling);
process.on("SIGINT", stopPolling);

/** Start polling in-process (called by start.ts when token is configured) */
export function startPolling(debug = false): void {
  telegramDebug = debug;
  stopPolling();
  const controller = new AbortController();
  pollingController = controller;
  (async () => {
    await ensureProjectClaudeMd();
    if (!controller.signal.aborted) await withBridgeSignal(controller.signal, () => poll(controller.signal));
  })().catch((err) => {
    console.error(`[Telegram] Fatal: ${err}`);
  });
}

/** Standalone entry point (bun run src/index.ts telegram) */
export async function telegram() {
  await loadSettings();
  await ensureProjectClaudeMd();
  stopPolling();
  pollingController = new AbortController();
  const signal = pollingController.signal;
  await withBridgeSignal(signal, () => poll(signal));
}
