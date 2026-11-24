import { tr, t } from "./i18n";

export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

export class SseHttpError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "SseHttpError";
    this.status = status;
  }
}

export interface OpenSseOptions {
  url: string;
  getToken?: () => Promise<string | null>;
  requireAuth?: boolean;
  onOpen?: () => void;
  onEvent: (event: SseEvent) => void;
  signal?: AbortSignal;
  heartbeatTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Incremental Server-Sent Events parser compliant with the WHATWG EventSource wire format.
 * Handles CRLF/LF line endings, multi-line `data:` fields, custom `event:` names, and `:` comments.
 */
export function createSseParser(onEvent: (event: SseEvent) => void): (chunk: string) => void {
  let buffer = "";
  let eventName = "message";
  let dataLines: string[] = [];
  let eventId: string | undefined;

  function flush(): void {
    if (dataLines.length === 0 && eventId === undefined) {
      eventName = "message";
      return;
    }
    const payload: SseEvent = {
      event: eventName || "message",
      data: dataLines.join("\n"),
      ...(eventId !== undefined ? { id: eventId } : {}),
    };
    eventName = "message";
    dataLines = [];
    eventId = undefined;
    onEvent(payload);
  }

  function processLine(rawLine: string): void {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "") {
      flush();
      return;
    }
    if (line.startsWith(":")) {
      return;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "event") eventName = value || "message";
    else if (field === "data") dataLines.push(value);
    else if (field === "id" && !value.includes("\0")) eventId = value;
  }

  return (chunk: string) => {
    if (!chunk) return;
    buffer += chunk;
    let idx = buffer.indexOf("\n");
    while (idx !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      processLine(line);
      idx = buffer.indexOf("\n");
    }
  };
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const text = await response.text();
    try {
      const parsed = JSON.parse(text) as { detail?: unknown };
      if (typeof parsed.detail === "string") return parsed.detail;
      if (parsed.detail && typeof parsed.detail === "object") {
        const msg = (parsed.detail as { message?: unknown }).message;
        if (typeof msg === "string") return msg;
      }
    } catch {
      // plain text fallback
    }
    if (text) return text;
  } catch {
    // ignore body read errors
  }
  return t("Request failed with {{status}}", { status: response.status });
}

/**
 * Opens a single SSE connection over `fetch` + `ReadableStream` using an optional fresh
 * Bearer token provider per attempt. Resolves cleanly when the server closes the stream or
 * throws on HTTP errors, aborted signals, or missing heartbeat keepalives.
 */
export async function openSseStream({
  url,
  getToken,
  requireAuth = false,
  onOpen,
  onEvent,
  signal,
  heartbeatTimeoutMs = 55_000,
  fetchImpl = fetch,
}: OpenSseOptions): Promise<void> {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
  }

  const headers: Record<string, string> = { Accept: "text/event-stream" };
  if (getToken) {
    const token = await getToken();
    if (!token) {
      if (requireAuth) {
        throw new SseHttpError(tr("Your session has expired. Please sign in again and retry."), 401);
      }
    } else {
      headers.Authorization = `Bearer ${token}`;
    }
  } else if (requireAuth) {
    throw new SseHttpError(tr("Your session has expired. Please sign in again and retry."), 401);
  }

  const localAbort = new AbortController();
  const onParentAbort = () => localAbort.abort(signal?.reason);
  if (signal) signal.addEventListener("abort", onParentAbort, { once: true });

  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;

  const resetTimer = () => {
    if (stallTimer !== null) globalThis.clearTimeout(stallTimer);
    if (heartbeatTimeoutMs > 0 && Number.isFinite(heartbeatTimeoutMs)) {
      stallTimer = globalThis.setTimeout(() => {
        timedOut = true;
        localAbort.abort(new Error("SSE heartbeat timeout"));
      }, heartbeatTimeoutMs);
    }
  };

  try {
    resetTimer();
    const response = await fetchImpl(url, {
      method: "GET",
      headers,
      cache: "no-store",
      signal: localAbort.signal,
    });

    if (!response.ok) {
      throw new SseHttpError(await readErrorMessage(response), response.status);
    }

    if (!response.body) {
      throw new Error("SSE response body is unavailable");
    }

    onOpen?.();
    resetTimer();

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const feed = createSseParser(onEvent);

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        resetTimer();
        feed(decoder.decode(value, { stream: true }));
      }
      const trailing = decoder.decode();
      if (trailing) feed(trailing);
      // Dispatch a synthetic trailing blank line in case stream closed mid-event cleanly
      feed("\n");
    } finally {
      try {
        await reader.cancel();
      } catch {
        // ignore cancel failures on already-closed streams
      }
    }
  } catch (err) {
    if (timedOut) {
      throw new Error("SSE heartbeat timeout");
    }
    throw err;
  } finally {
    if (stallTimer !== null) globalThis.clearTimeout(stallTimer);
    if (signal) signal.removeEventListener("abort", onParentAbort);
  }
}
