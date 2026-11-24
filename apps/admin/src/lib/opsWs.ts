// Shared authenticated WebSocket client for Admin Ops streams (/api/admin/logs/ws
// and /api/admin/server/ws): handles first-frame JWT auth, token refreshes,
// ping/pong keepalives, exponential backoff reconnection, and fatal auth closure.
import { supabase } from "@etymos/shared";
import { wsUrl } from "./opsApi";
import { t } from "./i18n";

export const WS_CLOSE_UNAUTHORIZED = 4401;
export const WS_CLOSE_FORBIDDEN = 4403;
export const WS_CLOSE_TIMEOUT = 4408;

export type WsConnectionState = "connecting" | "connected" | "reconnecting" | "disconnected";

export type WsFrame = Record<string, unknown> & { type?: string };

export interface AdminWsClient {
  start: () => void;
  stop: () => void;
  send: (payload: Record<string, unknown>) => boolean;
  reconnectNow: () => void;
}

export interface AdminWsClientOptions {
  path: string;
  buildAuthFrame: (token: string) => Record<string, unknown>;
  onMessage: (msg: WsFrame) => void;
  onStateChange: (state: WsConnectionState) => void;
  onError?: (message: string, fatal: boolean) => void;
  getToken?: () => Promise<string | null>;
  subscribeAuthChange?: (cb: (token: string | null) => void) => () => void;
  WebSocketImpl?: typeof WebSocket;
  backoffMs?: number[];
}

const DEFAULT_BACKOFF_MS = [1000, 2000, 4000, 8000, 10000];

async function defaultGetToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

function defaultSubscribeAuthChange(cb: (token: string | null) => void): () => void {
  const { data } = supabase.auth.onAuthStateChange((_event, session) => {
    cb(session?.access_token ?? null);
  });
  return () => data.subscription.unsubscribe();
}

export function createAdminWsClient(options: AdminWsClientOptions): AdminWsClient {
  const {
    path,
    buildAuthFrame,
    onMessage,
    onStateChange,
    onError,
    getToken = defaultGetToken,
    subscribeAuthChange = defaultSubscribeAuthChange,
    WebSocketImpl = WebSocket,
    backoffMs = DEFAULT_BACKOFF_MS,
  } = options;

  let socket: WebSocket | null = null;
  let stopped = false;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribeAuth: (() => void) | null = null;
  let connectGeneration = 0;

  function clearReconnectTimer() {
    if (reconnectTimer !== null) {
      globalThis.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function closeSocket(code = 1000) {
    const active = socket;
    socket = null;
    if (active && active.readyState < WebSocketImpl.CLOSING) {
      try {
        active.close(code);
      } catch {
        // Ignore close races on already-closing sockets.
      }
    }
  }

  function send(payload: Record<string, unknown>): boolean {
    if (!socket || socket.readyState !== WebSocketImpl.OPEN) return false;
    socket.send(JSON.stringify(payload));
    return true;
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer !== null) return;
    const delay = backoffMs[Math.min(attempt, Math.max(0, backoffMs.length - 1))] ?? 1000;
    attempt += 1;
    reconnectTimer = globalThis.setTimeout(() => {
      reconnectTimer = null;
      void connect(true);
    }, delay);
  }

  async function connect(isReconnect: boolean) {
    if (stopped) return;
    clearReconnectTimer();
    const gen = ++connectGeneration;
    onStateChange(isReconnect ? "reconnecting" : "connecting");

    let token: string | null = null;
    try {
      token = await getToken();
    } catch {
      token = null;
    }
    if (stopped || gen !== connectGeneration) return;

    if (!token) {
      onStateChange("disconnected");
      onError?.(t("Your session has expired. Sign in again."), true);
      return;
    }

    const ws = new WebSocketImpl(wsUrl(path));
    socket = ws;

    ws.onopen = () => {
      if (stopped || socket !== ws) return;
      ws.send(JSON.stringify(buildAuthFrame(token)));
    };

    ws.onmessage = (event) => {
      if (stopped || socket !== ws) return;
      let msg: WsFrame;
      try {
        msg = JSON.parse(String(event.data)) as WsFrame;
      } catch {
        return;
      }
      if (msg.type === "ping") {
        if (ws.readyState === WebSocketImpl.OPEN) {
          ws.send(JSON.stringify({ type: "pong" }));
        }
        return;
      }
      if (msg.type === "auth_ok") {
        attempt = 0;
        onStateChange("connected");
      }
      onMessage(msg);
    };

    ws.onclose = (event) => {
      if (socket !== ws) return;
      socket = null;
      if (stopped || event.code === 1000) {
        onStateChange("disconnected");
        return;
      }
      if (event.code === WS_CLOSE_UNAUTHORIZED) {
        stopped = true;
        onStateChange("disconnected");
        onError?.(t("Your session has expired. Sign in again."), true);
        return;
      }
      if (event.code === WS_CLOSE_FORBIDDEN) {
        stopped = true;
        onStateChange("disconnected");
        onError?.(t("Only admins signed in with an authenticator code can see this."), true);
        return;
      }
      onStateChange("reconnecting");
      onError?.("", false);
      scheduleReconnect();
    };
  }

  return {
    start() {
      stopped = false;
      unsubscribeAuth?.();
      unsubscribeAuth = subscribeAuthChange((newToken) => {
        if (stopped || !newToken) return;
        send({ type: "refresh_auth", token: newToken });
      });
      void connect(false);
    },
    stop() {
      stopped = true;
      clearReconnectTimer();
      unsubscribeAuth?.();
      unsubscribeAuth = null;
      closeSocket(1000);
      onStateChange("disconnected");
    },
    send,
    reconnectNow() {
      if (stopped) return;
      clearReconnectTimer();
      attempt = 0;
      closeSocket(1000);
      void connect(true);
    },
  };
}
