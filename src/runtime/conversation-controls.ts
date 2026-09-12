import { canonicalWorkspace } from "../paths";
import { getSharedDb } from "../state/shared-db";
import { getPolicy, upsertPolicy } from "../state/repos/policies";
import { bridgeSignal, withBridgeSignal } from "./bridge-context";
import type { SessionTarget } from "./session-target";

const active = new Map<string, AbortController>();
const activeKey = (target: SessionTarget) =>
  JSON.stringify([canonicalWorkspace(target.workspace), target.key]);

/** Called inside the runner's existing queue, so each key owns one active turn. */
export async function withActiveConversation<T>(target: SessionTarget, work: () => Promise<T>): Promise<T> {
  const key = activeKey(target);
  const controller = new AbortController();
  const parent = bridgeSignal();
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
  active.set(key, controller);
  try {
    return await withBridgeSignal(signal, work);
  } finally {
    if (active.get(key) === controller) active.delete(key);
  }
}

export function cancelConversation(target: SessionTarget): boolean {
  const controller = active.get(activeKey(target));
  if (!controller || controller.signal.aborted) return false;
  controller.abort(new Error("Conversation task cancelled"));
  return true;
}

export interface ConversationPreference {
  model?: string;
  verbose?: boolean;
}
const preferenceKey = (target: SessionTarget) => ({ source: "session", channel: target.key });
export async function conversationPreference(target: SessionTarget): Promise<ConversationPreference> {
  return getPolicy<ConversationPreference>(await getSharedDb(target.workspace), preferenceKey(target)) ?? {};
}
export async function setConversationPreference(
  target: SessionTarget,
  patch: ConversationPreference
): Promise<void> {
  const db = await getSharedDb(target.workspace);
  const key = preferenceKey(target);
  upsertPolicy(db, key, { ...getPolicy<ConversationPreference>(db, key), ...patch });
}

export function isCancelCommand(command: string | null | undefined): boolean {
  return ["cancel", "kill", "stop"].includes((command ?? "").replace(/^\//, "").toLowerCase());
}

export async function preferenceCommand(
  target: SessionTarget,
  command: string,
  argument: string,
  defaultModel: string
): Promise<string | null> {
  const name = command.replace(/^\//, "");
  if (name !== "model" && name !== "verbose") return null;
  const value = argument.trim();
  if (name === "model") {
    if (value && value !== "default" && !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/.test(value))
      return "Usage: /model [default|sonnet|opus|haiku|model-id]";
    if (value) await setConversationPreference(target, { model: value === "default" ? undefined : value });
    const preference = await conversationPreference(target);
    return `This conversation's model: ${(preference.model ?? target.policy?.modelPolicy?.model ?? defaultModel) || "Claude default"}.`;
  }
  if (value && !["on", "off"].includes(value)) return "Usage: /verbose [on|off]";
  if (value) await setConversationPreference(target, { verbose: value === "on" });
  return `Detailed progress: ${(await conversationPreference(target)).verbose ? "on" : "off"}.`;
}
