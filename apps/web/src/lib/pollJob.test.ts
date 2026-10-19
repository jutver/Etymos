// pollJob: brief connection drops are retried, definite answers end polling.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@etymos/shared", () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: { access_token: "t" } }, error: null }) } },
}));

import { JOB_POLL_MS, JobDeadlineError, isTransientApiError, ApiError, pollJob } from "./api";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("pollJob", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function run<T>(promise: Promise<T>, polls: number): Promise<T> {
    const settled = promise.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    for (let i = 0; i < polls; i++) await vi.advanceTimersByTimeAsync(JOB_POLL_MS);
    const result = (await settled) as { value?: T; error?: unknown };
    if ("error" in result) throw result.error;
    return result.value as T;
  }

  it("keeps going through network errors and server errors", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ status: "running" }))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(json({ detail: "Bad gateway" }, 502))
      .mockResolvedValueOnce(json({ status: "completed", report_id: "r1" }));
    vi.stubGlobal("fetch", fetch);
    const onUnreachable = vi.fn();

    const job = await run(pollJob("j1", undefined, { onUnreachable }), 4);
    expect(job.status).toBe("completed");
    expect(onUnreachable).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("waits 5 seconds between requests", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ status: "running" }));
    vi.stubGlobal("fetch", fetch);
    void pollJob("j1").catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("stops on a 404: the job is gone", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ detail: "Job not found" }, 404)));
    await expect(run(pollJob("j1"), 1)).rejects.toMatchObject({ status: 404 });
  });

  it("gives up once the deadline passes", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const deadline = Date.now() + 2 * JOB_POLL_MS;
    await expect(run(pollJob("j1", undefined, { deadline }), 4)).rejects.toBeInstanceOf(JobDeadlineError);
  });
});

describe("isTransientApiError", () => {
  it("retries no-answer, 5xx, 408 and 429, not other client errors", () => {
    expect(isTransientApiError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isTransientApiError(new ApiError("x", 503))).toBe(true);
    expect(isTransientApiError(new ApiError("x", 429))).toBe(true);
    expect(isTransientApiError(new ApiError("x", 404))).toBe(false);
    expect(isTransientApiError(new ApiError("x", 403))).toBe(false);
  });
});
