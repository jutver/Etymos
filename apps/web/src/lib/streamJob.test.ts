import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, JobDeadlineError, streamJob, streamJobs } from "./api";

function sseResponse(frames: string[], status = 200): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    }),
    { status, headers: { "Content-Type": "text/event-stream" } },
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("streamJob", () => {
  it("streams progress frames until completed", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      sseResponse([
        'event: job\ndata: {"job_id":"j1","status":"processing","progress":40,"input_type":"pdf"}\n\n',
        'event: ping\ndata: {"server_time":"now"}\n\n',
        'event: job\ndata: {"job_id":"j1","status":"completed","progress":100,"report_id":"r1","input_type":"pdf"}\n\n',
      ]),
    );
    const seen: number[] = [];
    const job = await streamJob("j1", (j) => seen.push(j.progress ?? -1), {
      fetchImpl: fetchMock,
      getToken: async () => "jwt-1",
    });

    expect(seen).toEqual([40, 100]);
    expect(job).toMatchObject({ job_id: "j1", status: "completed", report_id: "r1" });
  });

  it("reconnects with a fresh token after transient disconnect", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const tokens = ["jwt-1", "jwt-2"];
    const fetchMock = vi.fn<typeof fetch>(async () => {
      calls += 1;
      if (calls === 1) {
        return sseResponse([
          'event: job\ndata: {"job_id":"j1","status":"processing","progress":10,"input_type":"pdf"}\n\n',
        ]);
      }
      return sseResponse([
        'event: job\ndata: {"job_id":"j1","status":"completed","progress":100,"report_id":"r1","input_type":"pdf"}\n\n',
      ]);
    });

    const promise = streamJob("j1", undefined, {
      fetchImpl: fetchMock,
      getToken: async () => tokens[calls] ?? "jwt-2",
    });
    await vi.runAllTimersAsync();
    const job = await promise;

    expect(job.status).toBe("completed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: "Bearer jwt-1" });
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({ Authorization: "Bearer jwt-2" });
  });

  it.each([401, 403, 404])("stops immediately without retrying on HTTP %i", async (status) => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ detail: "Stopped" }), { status }),
    );
    await expect(
      streamJob("j1", undefined, {
        fetchImpl: fetchMock,
        getToken: async () => "jwt-1",
      }),
    ).rejects.toSatisfy((err: unknown) => err instanceof ApiError && err.status === status);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws JobDeadlineError once deadline expires on transient disconnects", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new TypeError("network down");
    });

    await expect(
      streamJob("j1", undefined, {
        deadline: 9_000,
        fetchImpl: fetchMock,
        getToken: async () => "jwt-1",
      }),
    ).rejects.toBeInstanceOf(JobDeadlineError);
  });
});

describe("streamJobs", () => {
  it("delivers initial snapshot, live updates, and exits once all jobs finish", async () => {
    const snapshots: Array<{ jobs: unknown[]; missing_job_ids: string[] }> = [];
    const jobs: Array<{ job_id: string; status: string }> = [];
    const fetchMock = vi.fn<typeof fetch>(async () =>
      sseResponse([
        'event: snapshot\ndata: {"jobs":[{"job_id":"j1","status":"processing","input_type":"pdf"}],"missing_job_ids":["j_gone"]}\n\n',
        'event: job\ndata: {"job_id":"j1","status":"completed","report_id":"r1","input_type":"pdf"}\n\n',
      ]),
    );

    await streamJobs(
      ["j1", "j_gone"],
      {
        onSnapshot: (s) => snapshots.push(s),
        onJob: (j) => jobs.push({ job_id: j.job_id, status: j.status }),
      },
      { fetchImpl: fetchMock, getToken: async () => "jwt-1" },
    );

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.missing_job_ids).toEqual(["j_gone"]);
    expect(jobs).toEqual([{ job_id: "j1", status: "completed" }]);
  });
});
