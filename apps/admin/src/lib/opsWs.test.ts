import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wsUrl } from "./opsApi";
import { createAdminWsClient, type WsConnectionState, WS_CLOSE_FORBIDDEN, WS_CLOSE_UNAUTHORIZED } from "./opsWs";

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readonly url: string;
  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason?: string }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  send(data: string) {
    this.sent.push(data);
  }

  receive(payload: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  close(code = 1000, reason = "") {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("wsUrl", () => {
  it("builds WebSocket URLs matching the API path", () => {
    const built = wsUrl("/api/admin/logs/ws");
    expect(built).toMatch(/^wss?:\/\/.+\/api\/admin\/logs\/ws$/);
  });
});

describe("createAdminWsClient", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("authenticates on first frame, handles ping/pong and refresh_auth, and stops cleanly", async () => {
    const states: WsConnectionState[] = [];
    const messages: Record<string, unknown>[] = [];
    const authHook: { notify: ((token: string | null) => void) | null } = { notify: null };

    const client = createAdminWsClient({
      path: "/api/admin/logs/ws",
      buildAuthFrame: (token) => ({ type: "auth", token, after: 0 }),
      onMessage: (msg) => messages.push(msg),
      onStateChange: (s) => states.push(s),
      getToken: async () => "jwt-1",
      subscribeAuthChange: (cb) => {
        authHook.notify = cb;
        return () => {
          authHook.notify = null;
        };
      },
      WebSocketImpl: MockWebSocket as unknown as typeof WebSocket,
    });

    client.start();
    await flushMicrotasks();

    const ws = MockWebSocket.instances[0]!;
    expect(ws.url).toMatch(/\/api\/admin\/logs\/ws$/);
    ws.open();
    expect(JSON.parse(ws.sent[0]!)).toEqual({ type: "auth", token: "jwt-1", after: 0 });

    ws.receive({ type: "auth_ok", pid: 100 });
    expect(states).toContain("connected");
    expect(messages.at(-1)).toEqual({ type: "auth_ok", pid: 100 });

    ws.receive({ type: "ping" });
    expect(JSON.parse(ws.sent[1]!)).toEqual({ type: "pong" });

    authHook.notify?.("jwt-2");
    expect(JSON.parse(ws.sent[2]!)).toEqual({ type: "refresh_auth", token: "jwt-2" });

    client.stop();
    expect(ws.readyState).toBe(MockWebSocket.CLOSED);
    expect(states.at(-1)).toBe("disconnected");
    expect(authHook.notify).toBeNull();
  });

  it("reconnects with backoff on unexpected disconnect", async () => {
    const states: WsConnectionState[] = [];
    const client = createAdminWsClient({
      path: "/api/admin/server/ws",
      buildAuthFrame: (token) => ({ type: "auth", token }),
      onMessage: () => undefined,
      onStateChange: (s) => states.push(s),
      getToken: async () => "jwt-1",
      subscribeAuthChange: () => () => undefined,
      WebSocketImpl: MockWebSocket as unknown as typeof WebSocket,
      backoffMs: [1000, 2000],
    });

    client.start();
    await flushMicrotasks();
    expect(MockWebSocket.instances).toHaveLength(1);

    MockWebSocket.instances[0]!.open();
    MockWebSocket.instances[0]!.close(1006);
    expect(states.at(-1)).toBe("reconnecting");

    await vi.advanceTimersByTimeAsync(999);
    expect(MockWebSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(MockWebSocket.instances).toHaveLength(2);

    // Second failure uses next backoff (2000ms).
    MockWebSocket.instances[1]!.close(1006);
    await vi.advanceTimersByTimeAsync(1999);
    expect(MockWebSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(MockWebSocket.instances).toHaveLength(3);

    client.stop();
  });

  it.each([WS_CLOSE_UNAUTHORIZED, WS_CLOSE_FORBIDDEN])("halts reconnect on auth failure close code %i", async (code) => {
    const errors: { msg: string; fatal: boolean }[] = [];
    const client = createAdminWsClient({
      path: "/api/admin/logs/ws",
      buildAuthFrame: (token) => ({ type: "auth", token }),
      onMessage: () => undefined,
      onStateChange: () => undefined,
      onError: (msg, fatal) => errors.push({ msg, fatal }),
      getToken: async () => "jwt-bad",
      subscribeAuthChange: () => () => undefined,
      WebSocketImpl: MockWebSocket as unknown as typeof WebSocket,
      backoffMs: [100],
    });

    client.start();
    await flushMicrotasks();
    MockWebSocket.instances[0]!.open();
    MockWebSocket.instances[0]!.close(code);

    await vi.advanceTimersByTimeAsync(5000);
    await flushMicrotasks();
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(errors.at(-1)?.fatal).toBe(true);
    expect(errors.at(-1)?.msg.length).toBeGreaterThan(0);
  });
});
