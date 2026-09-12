import { resolve } from "node:path";
const pending = new Map<string, Promise<unknown>>();

/** Serialize Hermes writers that share a memory file, including Dream rewrites. */
export function withMemoryFileLock<T>(path: string, work: () => Promise<T> | T): Promise<T> {
  const key = resolve(path);
  const result = (pending.get(key) ?? Promise.resolve()).catch(() => {}).then(work);
  const tail = result.catch(() => {});
  pending.set(key, tail);
  void tail.finally(() => {
    if (pending.get(key) === tail) pending.delete(key);
  });
  return result;
}
