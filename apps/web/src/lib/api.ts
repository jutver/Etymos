import { supabase } from "@etymos/shared";

export interface BackendJob {
  job_id: string;
  status: string;
  input_type: string;
  progress?: number;
  current_step?: string;
  message?: string;
  report_id?: string;
  input_name?: string;
  error?: string;
}

export interface BackendReport {
  overall_score: number;
  total_input_chunks: number;
  input_text?: string;
  matched_papers: Array<{
    source_paper_id: string;
    source_title: string;
    likely_count?: number;
    suspicious_count?: number;
    common_definition_count?: number;
    max_similarity?: number;
  }>;
  matches: Array<{
    label: string;
    input_section?: string;
    source_paper_id: string;
    source_title?: string;
    source_section?: string;
    input_chunk_id?: string;
    source_chunk_id?: string;
    input_sentence: string;
    source_sentence: string;
    semantic_similarity: number;
    word_overlap?: number;
    char_ngram_overlap?: number;
  }>;
  coverage?: Record<string, unknown>;
  queries?: string[];
  warnings?: string[];
}

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:8000";

function buildUrl(path: string) {
  return `${API_BASE_URL}${path}`;
}

async function errorMessageFromResponse(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as { detail?: string };
    if (parsed.detail) return parsed.detail;
  } catch {
    // response wasn't JSON — fall back to raw text
  }
  return text || `Request failed with ${response.status}`;
}

async function getAuthHeader(): Promise<Record<string, string>> {
  const { data, error } = await supabase.auth.getSession();
  const accessToken = data.session?.access_token;
  if (error || !accessToken) {
    throw new Error("Your session has expired. Please sign in again and retry.");
  }
  return { Authorization: `Bearer ${accessToken}` };
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const authHeader = await getAuthHeader();
  const response = await fetch(buildUrl(path), {
    ...init,
    headers: { "Content-Type": "application/json", ...authHeader, ...init?.headers },
  });

  if (!response.ok) {
    throw new Error(await errorMessageFromResponse(response));
  }

  return response.json() as Promise<T>;
}

export async function submitTextCheck(text: string): Promise<BackendJob> {
  return requestJson<BackendJob>("/api/check/text", {
    method: "POST",
    body: JSON.stringify({ text }),
  });
}

export async function submitPdfCheck(file: File): Promise<BackendJob> {
  const authHeader = await getAuthHeader();
  const formData = new FormData();
  formData.append("file", file);
  const response = await fetch(buildUrl("/api/check/pdf"), {
    method: "POST",
    headers: { ...authHeader },
    body: formData,
  });

  if (!response.ok) {
    throw new Error(await errorMessageFromResponse(response));
  }

  return response.json() as Promise<BackendJob>;
}

export async function getJob(jobId: string): Promise<BackendJob> {
  return requestJson<BackendJob>(`/api/jobs/${jobId}`);
}

export async function getReport(reportId: string): Promise<BackendReport> {
  return requestJson<BackendReport>(`/api/reports/${reportId}`);
}

export interface RewriteResponse {
  success: boolean;
  rewritten_text: string;
}

export async function rewriteText(inputSentence: string, sourceSentence: string): Promise<RewriteResponse> {
  return requestJson<RewriteResponse>("/api/ai/rewrite", {
    method: "POST",
    body: JSON.stringify({ input_sentence: inputSentence, source_sentence: sourceSentence }),
  });
}

export async function pollJob(jobId: string, onProgress?: (job: BackendJob) => void): Promise<BackendJob> {
  let job = await getJob(jobId);
  onProgress?.(job);

  while (job.status !== "completed" && job.status !== "failed") {
    await new Promise((resolve) => window.setTimeout(resolve, 1500));
    job = await getJob(jobId);
    onProgress?.(job);
  }

  return job;
}
