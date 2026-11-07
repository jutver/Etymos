// Logs screen: the backend's live log, its log files, server status and the
// fixed list of server actions (backend/api/admin_ops.py, /api/admin/logs*
// and /api/admin/server*). All of it needs an admin session with an
// authenticator code; there is no way to run arbitrary commands.
import { supabase } from "@etymos/shared";
import { ApiError } from "./api";
import { t } from "./i18n";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:8000";

export type LogLevel = "DEBUG" | "INFO" | "WARNING" | "ERROR";
export const LOG_LEVELS: LogLevel[] = ["DEBUG", "INFO", "WARNING", "ERROR"];

export interface LogRow {
  seq: number;
  /** Unix seconds. */
  ts: number;
  level: LogLevel | "CRITICAL";
  levelno: number;
  logger: string;
  message: string;
  /** Traceback or stack, when the line carried one. */
  exc: string | null;
  /** Full job id (job_<hex>) when logged while a check ran. */
  job: string | null;
  /** Short request id (also the X-Request-ID response header). */
  request: string | null;
  user: string | null;
  thread: string;
}

export interface LiveLogPage {
  rows: LogRow[];
  truncated: boolean;
  last_seq: number;
  oldest_seq: number;
  capacity: number;
  level: LogLevel;
  started_at: string;
  pid: number;
}

export interface LiveLogFilters {
  level: LogLevel;
  q: string;
  job: string;
  request: string;
  userId: string;
}

export interface LogFileInfo {
  name: string;
  file: string;
  description: string;
  exists: boolean;
  size_bytes: number;
  modified_at: string | null;
}

export interface LogFileTail extends LogFileInfo {
  lines: string[];
  /** The file goes back further than what was returned. */
  more: boolean;
}

export interface JobRow {
  job_id: string;
  input_type: string;
  input_name: string | null;
  user_id: string | null;
  status: "queued" | "processing" | "completed" | "failed";
  progress: number;
  current_step: string;
  message: string;
  report_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  age_seconds: number;
  step_seconds: number;
}

export interface ServerStatus {
  checked_at: string;
  process: {
    pid: number;
    started_at: string;
    uptime: string;
    uptime_seconds: number;
    commit: string;
    python: string;
    threads: number;
    log_level: LogLevel;
    log_buffer: { capacity: number; last_seq: number };
    supervised: boolean;
  };
  host: {
    name: string;
    platform: string;
    cpus: number | null;
    load: number[] | null;
    disk: { path: string; total_gb: number; free_gb: number; used_percent: number } | null;
  };
  memory: {
    rss_mb: number | null;
    peak_mb: number;
    system_total_mb: number | null;
    system_available_mb: number | null;
  };
  gpu: {
    available: boolean;
    name?: string;
    total_gb?: number;
    free_gb?: number;
    allocated_gb?: number;
    reserved_gb?: number;
    peak_gb?: number;
    budget_gb?: number | null;
    error?: string;
    queue: { slots: number; running: number; waiting: number };
    models: { name: string; size_gb: number; in_use: number }[];
  };
  background: { notifications: boolean; support_inbox: boolean };
  jobs: { active: JobRow[]; recent: JobRow[]; counts: Record<string, number> };
}

export type ServerAction =
  | "log-level"
  | "dump-threads"
  | "free-gpu"
  | "run-notifications"
  | "poll-support-inbox"
  | "restart-api";

export interface ActionResult {
  action: ServerAction;
  ms: number;
  level?: LogLevel;
  previous?: LogLevel;
  threads?: number;
  freed?: string[];
  counts?: Record<string, number>;
  restarting?: boolean;
  lost_checks?: number;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new ApiError(t("Your session has expired. Sign in again."), 401);
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const text = await response.text();
    let message = text;
    try {
      const detail = (JSON.parse(text) as { detail?: unknown }).detail;
      if (typeof detail === "string") message = detail;
    } catch {
      // not JSON
    }
    if (response.status === 403) message = t("Only admins signed in with an authenticator code can see this.");
    throw new ApiError(message || t("Request failed with {{status}}", { status: response.status }), response.status);
  }
  return (await response.json()) as T;
}

export function liveLogQuery(after: number, filters: LiveLogFilters, limit = 500): string {
  const params = new URLSearchParams({ after: String(after), limit: String(limit), level: filters.level });
  if (filters.q.trim()) params.set("q", filters.q.trim());
  if (filters.job.trim()) params.set("job", filters.job.trim());
  if (filters.request.trim()) params.set("request", filters.request.trim());
  if (filters.userId.trim()) params.set("user_id", filters.userId.trim());
  return params.toString();
}

export function fetchLiveLog(after: number, filters: LiveLogFilters, limit = 500): Promise<LiveLogPage> {
  return request(`/api/admin/logs?${liveLogQuery(after, filters, limit)}`);
}

export function fetchLogFiles(): Promise<{ dir: string; files: LogFileInfo[] }> {
  return request("/api/admin/logs/files");
}

export function fetchLogFile(name: string, lines: number, q: string): Promise<LogFileTail> {
  const params = new URLSearchParams({ lines: String(lines) });
  if (q.trim()) params.set("q", q.trim());
  return request(`/api/admin/logs/files/${encodeURIComponent(name)}?${params}`);
}

export function fetchServerStatus(): Promise<ServerStatus> {
  return request("/api/admin/server");
}

export function runServerAction(
  action: ServerAction,
  body: { level?: LogLevel; force?: boolean } = {},
): Promise<ActionResult> {
  return request(`/api/admin/server/actions/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
