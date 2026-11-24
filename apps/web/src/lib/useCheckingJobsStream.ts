import { useEffect } from "react";
import { streamJobs } from "./api";
import { CHECK_STALE_MS, INTERRUPTED_MESSAGE, useAppStore } from "./store";

/**
 * Keeps in-progress document rows on Documents and History synchronized in real time
 * via `GET /api/jobs/stream` instead of periodic polling intervals.
 */
export function useCheckingJobsStream(active: boolean): void {
  const history = useAppStore((s) => s.history);
  const settleCheckingJob = useAppStore((s) => s.settleCheckingJob);
  const markMissingCheckingJobs = useAppStore((s) => s.markMissingCheckingJobs);
  const reconcileCheckingDocuments = useAppStore((s) => s.reconcileCheckingDocuments);

  const checkingKey = active
    ? history
        .filter((h) => h.checkState === "checking")
        .map((h) => `${h.id}:${h.checkJobId ?? ""}`)
        .sort()
        .join("|")
    : "";

  useEffect(() => {
    if (!active || !checkingKey) return;

    const checking = useAppStore
      .getState()
      .history.filter((h) => h.checkState === "checking");

    const now = Date.now();
    const jobIds: string[] = [];
    let hasStaleWithoutJobId = false;

    for (const entry of checking) {
      if (entry.checkJobId) {
        jobIds.push(entry.checkJobId);
      } else {
        const startedAt = new Date(entry.startedAt).getTime();
        if (Number.isFinite(startedAt) && now - startedAt > CHECK_STALE_MS) {
          hasStaleWithoutJobId = true;
        }
      }
    }

    if (hasStaleWithoutJobId) {
      void reconcileCheckingDocuments();
    }
    if (jobIds.length === 0) return;

    const abort = new AbortController();
    void streamJobs(
      jobIds,
      {
        onSnapshot: (snapshot) => {
          for (const job of snapshot.jobs ?? []) {
            if (job.status === "completed" || job.status === "failed") {
              void settleCheckingJob(job);
            }
          }
          if (snapshot.missing_job_ids?.length) {
            void markMissingCheckingJobs(snapshot.missing_job_ids, INTERRUPTED_MESSAGE);
          }
        },
        onJob: (job) => {
          if (job.status === "completed" || job.status === "failed") {
            void settleCheckingJob(job);
          }
        },
      },
      { signal: abort.signal },
    ).catch(() => undefined);

    return () => abort.abort();
  }, [active, checkingKey, settleCheckingJob, markMissingCheckingJobs, reconcileCheckingDocuments]);
}
