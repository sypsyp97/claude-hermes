import { AsyncLocalStorage } from "node:async_hooks";
const lifecycle = new AsyncLocalStorage<AbortSignal>();

export function bridgeSignal(): AbortSignal | undefined {
  return lifecycle.getStore();
}

export function withBridgeSignal<T>(signal: AbortSignal, work: () => T): T {
  return lifecycle.run(signal, work);
}
