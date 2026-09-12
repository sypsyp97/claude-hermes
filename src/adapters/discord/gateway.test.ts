import { expect, test } from "bun:test";
import { createGateway, type GatewaySocket } from "./gateway";

function harness() {
  const sockets: Array<GatewaySocket & { sent: any[]; url: string; closed: boolean }> = [];
  const timers = new Map<number, { fn: () => void; ms: number }>();
  const events: string[] = [];
  let id = 0;
  const gateway = createGateway({
    token: "fake",
    onDispatch: (name) => {
      events.push(name);
    },
    random: () => 0,
    schedule: (fn, ms) => {
      timers.set(++id, { fn, ms });
      return id;
    },
    cancel: (key) => {
      timers.delete(key as number);
    },
    socket: (url) => {
      const socket = {
        url,
        readyState: 1,
        sent: [] as any[],
        closed: false,
        onmessage: null,
        onclose: null,
        onerror: null,
        send(data: string) {
          this.sent.push(JSON.parse(data));
        },
        close() {
          this.closed = true;
        },
      } as GatewaySocket & { sent: any[]; url: string; closed: boolean };
      sockets.push(socket);
      return socket;
    },
  });
  function payload(
    socket = sockets.at(-1)!,
    op = 10,
    d: any = { heartbeat_interval: 1000 },
    s: number | null = null,
    t: string | null = null
  ) {
    socket.onmessage?.({ data: JSON.stringify({ op, d, s, t }) });
  }
  function next() {
    const pair = [...timers].sort((a, b) => a[1].ms - b[1].ms)[0];
    if (!pair) throw new Error("No timer");
    timers.delete(pair[0]);
    pair[1].fn();
  }
  function ready() {
    payload();
    payload(
      sockets.at(-1),
      0,
      { session_id: "s", resume_gateway_url: "wss://resume.discord.gg" },
      1,
      "READY"
    );
  }
  return { gateway, sockets, timers, events, payload, next, ready };
}

test("stop cancels reconnect and obsolete socket callbacks cannot revive a gateway", () => {
  const h = harness();
  h.gateway.start();
  h.ready();
  const old = h.sockets[0];
  old.onclose?.({ code: 1006, reason: "network" });
  h.gateway.stop();
  expect(h.timers.size).toBe(0);
  old.onclose?.({ code: 1006, reason: "late" });
  expect(h.timers.size).toBe(0);
  h.gateway.start();
  h.ready();
  old.onclose?.({ code: 4004, reason: "stale token" });
  expect(h.sockets[1].closed).toBe(false);
  h.gateway.stop();
});

test("resume preserves version and encoding; expired sessions identify again", () => {
  const h = harness();
  h.gateway.start();
  h.ready();
  h.sockets[0].onclose?.({ code: 1006, reason: "network" });
  h.next();
  h.payload();
  expect(h.sockets[1].url).toBe("wss://resume.discord.gg/?v=10&encoding=json");
  expect(h.sockets[1].sent[0].op).toBe(6);
  h.sockets[1].onclose?.({ code: 4009, reason: "expired" });
  h.next();
  h.payload();
  expect(h.sockets[2].sent[0].op).toBe(2);
  h.gateway.stop();
});

test("duplicate dispatch sequence is ignored and invalid sessions reconnect once", () => {
  const h = harness();
  h.gateway.start();
  h.ready();
  h.payload(undefined, 0, {}, 2, "MESSAGE_CREATE");
  h.payload(undefined, 0, {}, 2, "MESSAGE_CREATE");
  expect(h.events.filter((name) => name === "MESSAGE_CREATE")).toHaveLength(1);
  h.payload(undefined, 9, false);
  h.sockets[0].onclose?.({ code: 1006, reason: "late" });
  expect(h.timers.size).toBe(1);
  h.next();
  h.payload();
  expect(h.sockets[1].sent[0].op).toBe(2);
  h.gateway.stop();
});

test("missing heartbeat ACK reconnects; fatal authentication failures stop", () => {
  const h = harness();
  h.gateway.start();
  h.ready();
  h.next();
  expect(h.sockets[0].sent.at(-1).op).toBe(1);
  h.next();
  expect(h.sockets[0].closed).toBe(true);
  h.next();
  h.payload();
  h.sockets[1].onclose?.({ code: 4004, reason: "auth" });
  expect(h.timers.size).toBe(0);
  h.gateway.stop();
});
