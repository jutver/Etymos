import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { openSseStream } from "./sse";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:8000";

export type ServerConnectionStatus = "connecting" | "connected" | "reconnecting" | "offline";

export interface ConnectivityState {
  isOnline: boolean;
  serverStatus: ServerConnectionStatus;
  lastConnectedAt: number | null;
}

const DEFAULT_STATE: ConnectivityState = {
  isOnline: typeof navigator !== "undefined" ? navigator.onLine : true,
  serverStatus: typeof navigator !== "undefined" && !navigator.onLine ? "offline" : "connecting",
  lastConnectedAt: null,
};

const ConnectivityContext = createContext<ConnectivityState>(DEFAULT_STATE);

const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 10000];

export function ConnectivityProvider({ children }: { children: ReactNode }) {
  const [isOnline, setIsOnline] = useState<boolean>(() =>
    typeof navigator !== "undefined" ? navigator.onLine : true,
  );
  const [serverStatus, setServerStatus] = useState<ServerConnectionStatus>(() =>
    typeof navigator !== "undefined" && !navigator.onLine ? "offline" : "connecting",
  );
  const [lastConnectedAt, setLastConnectedAt] = useState<number | null>(null);
  const hasConnectedRef = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => {
      setIsOnline(false);
      setServerStatus("offline");
    };
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  useEffect(() => {
    if (!isOnline) {
      setServerStatus("offline");
      return;
    }

    let cancelled = false;
    let activeAbort: AbortController | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;

    setServerStatus(hasConnectedRef.current ? "reconnecting" : "connecting");

    const scheduleRetry = () => {
      if (cancelled) return;
      const delay = RECONNECT_DELAYS_MS[Math.min(attempts, RECONNECT_DELAYS_MS.length - 1)]!;
      attempts += 1;
      setServerStatus(attempts >= 2 ? "offline" : "reconnecting");
      retryTimer = globalThis.setTimeout(() => {
        if (!cancelled) void connect();
      }, delay);
    };

    const connect = async () => {
      if (cancelled) return;
      const abort = new AbortController();
      activeAbort = abort;

      try {
        await openSseStream({
          url: `${API_BASE_URL}/api/status/stream`,
          requireAuth: false,
          heartbeatTimeoutMs: 55_000,
          signal: abort.signal,
          onOpen: () => {
            if (cancelled) return;
            attempts = 0;
            hasConnectedRef.current = true;
            setServerStatus("connected");
            setLastConnectedAt(Date.now());
          },
          onEvent: (event) => {
            if (cancelled) return;
            if (event.event === "status" || event.event === "ping") {
              attempts = 0;
              hasConnectedRef.current = true;
              setServerStatus("connected");
              setLastConnectedAt(Date.now());
            }
          },
        });
        if (!cancelled) scheduleRetry();
      } catch {
        if (!cancelled) scheduleRetry();
      }
    };

    void connect();

    return () => {
      cancelled = true;
      if (retryTimer !== null) globalThis.clearTimeout(retryTimer);
      activeAbort?.abort();
    };
  }, [isOnline]);

  return (
    <ConnectivityContext.Provider value={{ isOnline, serverStatus, lastConnectedAt }}>
      {children}
    </ConnectivityContext.Provider>
  );
}

export function useConnectivity(): ConnectivityState {
  return useContext(ConnectivityContext);
}
