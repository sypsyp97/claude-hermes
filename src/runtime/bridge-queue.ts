import { canonicalWorkspace } from "../paths";
import { bridgeSignal, withBridgeSignal } from "./bridge-context";

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

/** Reserve newly observed destinations while their creation response is in flight. */
export function prepareBridgeTransfer<T>(source: string, work: (value: T) => Promise<void>) {
  const signal = bridgeSignal();
  let resolve!: (destination: { channel: string; value: T } | null) => void;
  const ready = new Promise<{ channel: string; value: T } | null>((r) => {
    resolve = r;
  });
  const reservations = new Map<string, Promise<void>>();
  const reserve = (channel: string): Promise<void> => {
    const existing = reservations.get(channel);
    if (existing) return existing;
    const admit = () =>
      enqueueBridge(source, channel, async () => {
        const destination = await ready;
        if (destination?.channel === channel) await work(destination.value);
      });
    const task = signal ? withBridgeSignal(signal, admit) : admit();
    void task.catch(() => {}); // The selected destination is observed by complete().
    reservations.set(channel, task);
    return task;
  };
  return {
    reserve,
    complete(channel: string, value: T): Promise<void> {
      const task = reserve(channel);
      resolve({ channel, value });
      return task;
    },
    cancel(): void {
      resolve(null);
    },
  };
}
