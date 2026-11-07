import { describe, expect, it } from "vitest";
import type { LogRow } from "../../lib/opsApi";
import { formatSeconds, lineTone, logTime, rowAsText, shortJob } from "./format";

const row: LogRow = {
  seq: 1,
  ts: Date.UTC(2026, 10, 7, 14, 36, 55, 309) / 1000,
  level: "INFO",
  levelno: 20,
  logger: "api.requests",
  message: "<- GET /api/reports 200 in 12ms",
  exc: null,
  job: null,
  request: "55f40959",
  user: "1a2b3c4d-0000-0000-0000-000000000000",
  thread: "MainThread",
};

describe("Logs formatting", () => {
  it("shortens job ids the way the backend's text log does", () => {
    expect(shortJob("job_1234567890abcdef")).toBe("job_12345678");
  });

  it("writes a row as a text log line, with the request and user", () => {
    expect(rowAsText(row)).toBe(
      "2026-11-07T14:36:55.309Z INFO  [r:55f40959 u:1a2b3c4d] api.requests: <- GET /api/reports 200 in 12ms",
    );
    expect(rowAsText({ ...row, job: "job_1234567890abcdef", exc: "Traceback…" })).toContain(
      "[job_12345678] api.requests",
    );
    expect(rowAsText({ ...row, exc: "Traceback…" }).endsWith("\nTraceback…")).toBe(true);
  });

  it("shows the date only for lines from another day", () => {
    const now = new Date(row.ts * 1000);
    expect(logTime(row.ts, now)).toMatch(/^\d\d:\d\d:\d\d\.309$/);
    expect(logTime(row.ts, new Date(now.getTime() + 2 * 86400_000))).toMatch(/^\d\d\/\d\d \d\d:/);
  });

  it("colours file lines by their level word", () => {
    expect(lineTone("2026-11-07 10:00:00.000 +0700 ERROR app: boom")).toBe("error");
    expect(lineTone("Traceback (most recent call last):")).toBe("error");
    expect(lineTone("2026-11-07 10:00:00.000 +0700 WARNING app: slow")).toBe("warning");
    expect(lineTone("2026-11-07 10:00:00.000 +0700 INFO  app: fine")).toBe("normal");
  });

  it("formats durations", () => {
    expect(formatSeconds(42)).toBe("42s");
    expect(formatSeconds(125)).toBe("2m 05s");
    expect(formatSeconds(3720)).toBe("1h 02m");
  });
});
