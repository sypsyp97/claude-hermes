// A single daemon-wide budget covers buffered Claude, streamed Claude and STT.
let active = 0;
const waiting: Array<() => void> = [];
const MAX_CONCURRENT = 4;

export async function withExecutionSlot<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const cancel = () => {
      const index = waiting.indexOf(enter);
      if (index !== -1) waiting.splice(index, 1);
      reject(signal?.reason);
    };
    const enter = () => {
      signal?.removeEventListener("abort", cancel);
      active++;
      resolve();
    };
    if (active < MAX_CONCURRENT) enter();
    else {
      waiting.push(enter);
      signal?.addEventListener("abort", cancel, { once: true });
    }
  });
  try {
    signal?.throwIfAborted();
    return await work();
  } finally {
    active--;
    waiting.shift()?.();
  }
}
