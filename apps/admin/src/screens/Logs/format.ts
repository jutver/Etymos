// Shared helpers for the Logs screens.
import type { LogRow } from "../../lib/opsApi";

/** job_<32 hex> -> job_<first 8>, as the backend's text log writes it. */
export function shortJob(jobId: string): string {
  return jobId.startsWith("job_") ? jobId.slice(0, 12) : jobId.slice(0, 8);
}

/** "21:36:55.309" in the viewer's time zone, with the date when it isn't today. */
export function logTime(ts: number, now = new Date()): string {
  const d = new Date(ts * 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? time : `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${time}`;
}

/** One row as a line of the backend's text log, for copying and downloads. */
export function rowAsText(row: LogRow): string {
  const d = new Date(row.ts * 1000);
  const ctx = row.job
    ? `[${shortJob(row.job)}] `
    : row.request
      ? `[r:${row.request}${row.user ? ` u:${row.user.slice(0, 8)}` : ""}] `
      : "";
  const line = `${d.toISOString()} ${row.level.padEnd(5)} ${ctx}${row.logger}: ${row.message}`;
  return row.exc ? `${line}\n${row.exc}` : line;
}

export type LineTone = "error" | "warning" | "debug" | "normal";

/** Colour for a plain text line from a log file, guessed from its level word. */
export function lineTone(line: string): LineTone {
  if (/\b(ERROR|CRITICAL|Traceback|FAILED|failed|Exception)\b/.test(line)) return "error";
  if (/\bWARN(ING)?\b|\bSkipping\b|\brolling back\b/i.test(line)) return "warning";
  if (/\bDEBUG\b/.test(line)) return "debug";
  return "normal";
}

export const TONE_CLASS: Record<LineTone, string> = {
  error: "text-red-300",
  warning: "text-amber-200",
  debug: "text-white/40",
  normal: "text-white/85",
};

export function levelTone(level: string): LineTone {
  if (level === "ERROR" || level === "CRITICAL") return "error";
  if (level === "WARNING") return "warning";
  if (level === "DEBUG") return "debug";
  return "normal";
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatSeconds(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export function download(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
