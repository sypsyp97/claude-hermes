import { canonicalWorkspace } from "../paths";
import { bridgeSignal } from "./bridge-context";

const lanes = new Map<string, Promise<unknown>>();

/** Admission precedes downloads and policy lookup; execution keeps its own session lane. */
export function enqueueBridge<T>(source: string, channel: string, work: () => Promise<T>): Promise<T> {
  const key = JSON.stringify([canonicalWorkspace(), source, channel]);
  const signal = bridgeSignal();
  const task = (lanes.get(key) ?? Promise.resolve())
    .catch(() => {})
    .then(() => {
      signal?.throwIfAborted();
      return work();
    });
  const tail = task.catch(() => {});
  lanes.set(key, tail);
  void tail.finally(() => {
    if (lanes.get(key) === tail) lanes.delete(key);
  });
  return task;
}
