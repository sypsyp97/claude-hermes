/** Discord connection lifecycle with one socket and cancellable timers per generation. */
export interface GatewaySocket {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: (() => void) | null;
}

interface GatewayOptions {
  token: string;
  onDispatch(name: string, data: any): void;
  log?(message: string): void;
  socket?: (url: string) => GatewaySocket;
  random?: () => number;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (timer: unknown) => void;
}

const BASE_URL = "wss://gateway.discord.gg";
const FATAL = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
const INTENTS = (1 << 0) | (1 << 9) | (1 << 10) | (1 << 12) | (1 << 15);

export function createGateway(options: GatewayOptions) {
  const schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = options.cancel ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const random = options.random ?? Math.random;
  const makeSocket = options.socket ?? ((url) => new WebSocket(url) as unknown as GatewaySocket);
  const timers = new Set<unknown>();
  let socket: GatewaySocket | null = null;
  let running = false;
  let generation = 0;
  let attempts = 0;
  let sessionId: string | null = null;
  let sequence: number | null = null;
  let resumeUrl: string | null = null;

  function clearTimers() {
    for (const timer of timers) cancel(timer);
    timers.clear();
  }
  function later(fn: () => void, ms: number) {
    const owner = generation;
    const timer = schedule(() => {
      timers.delete(timer);
      if (running && owner === generation) fn();
    }, ms);
    timers.add(timer);
  }
  function clearSession() {
    sessionId = null;
    sequence = null;
    resumeUrl = null;
  }
  function retire() {
    generation++;
    clearTimers();
    const old = socket;
    socket = null;
    try {
      old?.close(4000, "Connection retired");
    } catch {
      /* already closed */
    }
  }
  function reconnect(resumable = true, minimumDelay = 0) {
    retire();
    if (!running) return;
    if (!resumable) clearSession();
    const delay = Math.max(
      minimumDelay,
      Math.min(30_000, 1000 * 2 ** Math.min(attempts++, 5)) * (1 + random() * 0.5)
    );
    later(connect, delay);
  }
  function connect() {
    if (!running) return;
    const url = new URL(resumeUrl ?? BASE_URL);
    url.searchParams.set("v", "10");
    url.searchParams.set("encoding", "json");
    let current: GatewaySocket;
    try {
      current = makeSocket(url.toString());
    } catch {
      reconnect();
      return;
    }
    socket = current;
    const owner = generation;
    const live = () => running && socket === current && generation === owner;
    const send = (op: number, d: unknown) => {
      if (!live() || current.readyState !== 1) return;
      try {
        current.send(JSON.stringify({ op, d }));
      } catch {
        reconnect();
      }
    };
    let acked = true;
    let greeted = false;
    const heartbeat = (interval: number) => {
      if (!acked) {
        reconnect();
        return;
      }
      acked = false;
      send(1, sequence);
      if (live()) later(() => heartbeat(interval), interval);
    };
    // A socket that never reaches HELLO must not stall the bridge forever.
    const helloTimer = schedule(() => {
      timers.delete(helloTimer);
      if (live() && !greeted) reconnect();
    }, 30_000);
    timers.add(helloTimer);
    current.onmessage = (event) => {
      if (!live()) return;
      try {
        const payload = JSON.parse(String(event.data));
        switch (payload.op) {
          case 10: {
            if (greeted) return;
            const interval = payload.d?.heartbeat_interval;
            if (!Number.isFinite(interval) || interval <= 0) {
              reconnect(false);
              return;
            }
            greeted = true;
            cancel(helloTimer);
            timers.delete(helloTimer);
            later(() => heartbeat(interval), random() * interval);
            if (sessionId && sequence !== null)
              send(6, { token: options.token, session_id: sessionId, seq: sequence });
            else
              send(2, {
                token: options.token,
                intents: INTENTS,
                properties: { os: process.platform, browser: "claude-hermes", device: "claude-hermes" },
              });
            break;
          }
          case 11:
            acked = true;
            break;
          case 1:
            send(1, sequence);
            break;
          case 7:
            reconnect();
            break;
          case 9:
            reconnect(payload.d === true, 1000 + random() * 4000);
            break;
          case 0:
            if (typeof payload.s === "number") {
              if (sequence !== null && payload.s <= sequence) return;
              sequence = payload.s;
            }
            if (payload.t === "READY") {
              sessionId = payload.d.session_id;
              resumeUrl = payload.d.resume_gateway_url;
              attempts = 0;
            } else if (payload.t === "RESUMED") attempts = 0;
            options.onDispatch(payload.t, payload.d);
            break;
        }
      } catch (error) {
        options.log?.(`Gateway payload failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    current.onclose = (event) => {
      if (!live()) return;
      if (FATAL.has(event.code)) {
        options.log?.(`Discord gateway stopped after fatal close ${event.code}`);
        running = false;
        retire();
        clearSession();
        return;
      }
      reconnect(![4007, 4009].includes(event.code));
    };
    current.onerror = () => {
      if (live()) reconnect();
    };
  }
  return {
    start() {
      if (running) return;
      running = true;
      attempts = 0;
      connect();
    },
    stop() {
      running = false;
      retire();
      clearSession();
    },
  };
}
