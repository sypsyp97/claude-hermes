import { createHash } from "node:crypto";
import type { Database } from "../../state/db";

/** Metadata only: uncertain requests are reported after restart, never replayed. */
export interface TelegramReceipt {
  updateId: number;
  chatId?: number;
  userId?: number;
  messageId?: number;
  topicId?: number;
  isDm?: boolean;
  triggered?: boolean;
}

export function telegramCheckpoint(db: Database, account: string) {
  const prefix = `telegram.${createHash("sha256").update(account).digest("hex")}.`;
  const offsetKey = `${prefix}offset`;
  const pendingPrefix = `${prefix}pending.`;
  const put = db.prepare(
    "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at"
  );
  const offset = (): number => {
    const row = db
      .query<{ value: string; updated_at: string }, [string]>(
        "SELECT value, updated_at FROM kv WHERE key = ?"
      )
      .get(offsetKey);
    // After a week without updates Telegram may choose a lower, random ID.
    if (!row || Date.now() - Date.parse(row.updated_at) >= 7 * 24 * 60 * 60_000) return 0;
    const value = Number(row.value);
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  };
  return {
    offset,
    admit(receipt: TelegramReceipt): void {
      db.transaction(() => {
        const now = new Date().toISOString();
        put.run(`${pendingPrefix}${receipt.updateId}`, JSON.stringify(receipt), now);
        put.run(offsetKey, String(Math.max(offset(), receipt.updateId + 1)), now);
      })();
    },
    pending(): TelegramReceipt[] {
      return db
        .query<{ value: string }, [string]>("SELECT value FROM kv WHERE key LIKE ? ORDER BY updated_at, key")
        .all(`${pendingPrefix}%`)
        .map((row) => JSON.parse(row.value) as TelegramReceipt);
    },
    complete(updateId: number): void {
      db.prepare("DELETE FROM kv WHERE key = ?").run(`${pendingPrefix}${updateId}`);
    },
  };
}
