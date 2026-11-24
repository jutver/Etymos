import { describe, expect, it, vi, afterEach } from "vitest";
import { SseHttpError, createSseParser, openSseStream } from "./sse";

function streamFromChunks(chunks: string[], delayMs = 0): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of chunks) {
        if (delayMs > 0) await new Promise((r) => globalThis.setTimeout(r, delayMs));
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createSseParser", () => {
  it("parses chunked CRLF events, multi-line data, and ignores comments", () => {
    const events: Array<{ event: string; data: string; id?: string }> = [];
    const feed = createSseParser((e) => events.push(e));

    feed(": heartbeat comment\r\n");
    feed("event: status\r\nid: 1\r\ndata: {\"ok\":");
    feed("true}\r\n\r\n");
    feed("data: line one\ndata: line two\n\n");

    expect(events).toEqual([
      { event: "status", id: "1", data: "{\"ok\":true}" },
      { event: "message", data: "line one\nline two" },
    ]);
  });
});

describe("openSseStream", () => {
  it("sends fresh Bearer token per call and yields parsed events", async () => {
    const events: Array<{ event: string; data: string }> = [];
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(streamFromChunks(["event: job\ndata: {\"status\":\"completed\"}\n\n"]), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );

    await openSseStream({
      url: "https://api.example.com/api/jobs/j1/stream",
      getToken: async () => "jwt-fresh",
      requireAuth: true,
      onEvent: (e) => events.push({ event: e.event, data: e.data }),
      fetchImpl: fetchMock,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      Accept: "text/event-stream",
      Authorization: "Bearer jwt-fresh",
    });
    expect(events).toEqual([{ event: "job", data: "{\"status\":\"completed\"}" }]);
  });

  it("throws 401 SseHttpError immediately when session token is missing", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    await expect(
      openSseStream({
        url: "https://api.example.com/api/jobs/j1/stream",
        getToken: async () => null,
        requireAuth: true,
        onEvent: () => undefined,
        fetchImpl: fetchMock,
      }),
    ).rejects.toMatchObject({ name: "SseHttpError", status: 401 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws SseHttpError with status for 403 and 404 responses", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ detail: "Job not found." }), { status: 404 }),
    );
    await expect(
      openSseStream({
        url: "https://api.example.com/api/jobs/missing/stream",
        onEvent: () => undefined,
        fetchImpl: fetchMock,
      }),
    ).rejects.toEqual(new SseHttpError("Job not found.", 404));
  });

  it("aborts stalled streams after heartbeatTimeoutMs", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>((_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(init.signal?.reason ?? new DOMException("Aborted", "AbortError"));
        });
      });
    });

    const promise = openSseStream({
      url: "https://api.example.com/api/status/stream",
      onEvent: () => undefined,
      heartbeatTimeoutMs: 500,
      fetchImpl: fetchMock,
    });
    const assertion = expect(promise).rejects.toThrow("SSE heartbeat timeout");
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
  });
});
