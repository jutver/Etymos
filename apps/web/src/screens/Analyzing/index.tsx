import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "motion/react";
import { CheckCircle, CircleNotch, ClockCounterClockwise, FileMagnifyingGlass } from "@phosphor-icons/react";
import { cn } from "@etymos/shared";
import { useAppStore } from "../../lib/store";
import { statusFromScore } from "../../components/Severity";
import { Button } from "../../components/ui/Button";
import { pollJob, getReport } from "../../lib/api";
import type { CheckedDocument, HistoryEntry, MatchedSource, Severity } from "@etymos/shared";

interface LocationState {
  docLabels?: string[];
  project?: string;
  webSources?: boolean;
  academicSources?: boolean;
  language?: string;
  jobId?: string;
  reportMode?: string;
  pdfDataUrl?: string | null;
}

const TOTAL_DURATION = 10000;

function splitDocumentIntoPassages(text: string) {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];

  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (paragraphs.length > 1) return paragraphs;

  return normalized
    .split(/(?<=[.!?])\s+/u)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

export default function AnalyzingPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const state = (location.state as LocationState) ?? {};
  const docLabels = state.docLabels?.length ? state.docLabels : ["Bien-doi-khi-hau-DBSCL.docx"];

  const addHistoryEntries = useAppStore((s) => s.addHistoryEntries);
  const recordCheckedDocument = useAppStore((s) => s.recordCheckedDocument);
  const markFirstCheckComplete = useAppStore((s) => s.markFirstCheckComplete);
  const [jobStatus, setJobStatus] = useState<string | null>(null);
  const [jobMessage, setJobMessage] = useState<string | null>(null);
  const [jobProgress, setJobProgress] = useState<number | null>(null);

  const steps = useMemo(() => {
    const all = [
      { id: "extract", label: docLabels.length > 1 ? "Extracting text from all documents" : "Extracting text" },
      { id: "web", label: "Scanning web sources", skip: state.webSources === false },
      { id: "academic", label: "Comparing academic papers", skip: state.academicSources === false },
      { id: "semantic", label: "Running semantic detection" },
      { id: "explain", label: "Generating explanations" },
    ];
    return all.filter((s) => !s.skip);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.webSources, state.academicSources]);

  const stepDuration = TOTAL_DURATION / steps.length;
  const [stepIndex, setStepIndex] = useState(0);
  const [resultIds, setResultIds] = useState<string[] | null>(null);
  const completedRef = useRef(false);

  useEffect(() => {
    if (state.reportMode === "backend" && state.jobId) {
      let cancelled = false;

      async function runBackendAnalysis() {
        try {
          const job = await pollJob(state.jobId!, (next) => {
            if (cancelled) return;
            setJobStatus(next.status);
            setJobMessage(next.message ?? next.current_step ?? null);
            setJobProgress(next.progress ?? null);
          });

          if (cancelled) return;

          if (job.status === "failed") {
            setJobStatus("failed");
            setJobMessage(job.error ?? "Analysis failed.");
            return;
          }

          const report = await getReport(job.report_id!);
          const today = new Date().toISOString().slice(0, 10);
          const entries: HistoryEntry[] = [];
          const ids: string[] = [];

          const docId = `check-${Date.now()}`;
          const cleanTitle = docLabels[0] && docLabels[0] !== "Pasted text"
            ? docLabels[0].replace(/\.(pdf|docx?|txt)$/i, "")
            : "Backend analysis";

          const matches: MatchedSource[] = (report.matches ?? []).map((match: any, index: number) => ({
            id: `${docId}-match-${index}`,
            severity: (match.label === "likely_plagiarism" ? "high" : match.label === "suspicious" ? "moderate" : "low") as Severity,
            detectionType: "traditional",
            matchPercent: Math.round(Math.max(0, Math.min(100, match.semantic_similarity * 100))),
            sourceTitle: match.source_title ?? match.source_paper_id,
            sourceAuthor: "",
            sourceKind: "academic",
            citation: match.source_paper_id,
            userSnippet: match.input_sentence,
            sourceSnippet: match.source_sentence,
            explanation: `Matched ${match.label.replace(/_/g, " ")}.`,
            rewriteSuggestions: [],
          }));

          const passages = splitDocumentIntoPassages(report.input_text ?? "").map((text, index) => {
            const matchingMatch = matches.find((match) => {
              const userSnippet = match.userSnippet?.trim() ?? "";
              return Boolean(userSnippet) && (text.trim() === userSnippet || text.includes(userSnippet));
            });

            return {
              id: `${docId}-passage-${index}`,
              text,
              severity: matchingMatch?.severity,
              matchId: matchingMatch?.id,
            };
          });

          const doc: CheckedDocument = {
            id: docId,
            title: cleanTitle,
            fileName: docLabels[0] ?? "analysis",
            language: (state.language as "vi" | "en" | "fr" | "ja") ?? "vi",
            wordCount: Math.max(1, Math.round((report.total_input_chunks || 1) * 900)),
            uploadedAt: today,
            similarityScore: report.overall_score,
            similarityScoreFree: report.overall_score,
            webSourcesScanned: report.coverage?.total_candidate_papers as number ?? 0,
            academicSourcesScanned: report.coverage?.checked_papers as number ?? 0,
            passages: passages.length > 0 ? passages : report.matches.slice(0, 5).map((match: any, index: number) => ({
              id: `${docId}-passage-${index}`,
              text: match.input_sentence,
              severity: match.label === "likely_plagiarism" ? "high" : match.label === "suspicious" ? "moderate" : "low",
              matchId: `${docId}-match-${index}`,
            })),
            matches,
            pdfUrl: state.pdfDataUrl ?? undefined, // ← thêm dòng này
          };

          recordCheckedDocument(doc);
          entries.push({
            id: docId,
            title: cleanTitle,
            date: today,
            similarityScore: report.overall_score,
            status: statusFromScore(report.overall_score),
            project: state.project || undefined,
            wordCount: doc.wordCount,
          });
          ids.push(docId);

          addHistoryEntries(entries);
          markFirstCheckComplete();
          setResultIds(ids);
        } catch (error) {
          setJobStatus("failed");
          setJobMessage(error instanceof Error ? error.message : "Analysis failed.");
        }
      }

      runBackendAnalysis();
      return;
    }

    if (stepIndex >= steps.length) {
      if (completedRef.current) return;
      completedRef.current = true;

      const today = new Date().toISOString().slice(0, 10);
      const entries: HistoryEntry[] = [];
      const ids: string[] = [];

      docLabels.forEach((label, i) => {
        const template = {
          id: `mock-${Date.now()}-${i}`,
          title: label,
          fileName: label,
          language: (state.language as "vi" | "en" | "fr" | "ja") ?? "vi",
          wordCount: 1200,
          uploadedAt: today,
          similarityScore: 83,
          similarityScoreFree: 63,
          webSourcesScanned: 0,
          academicSourcesScanned: 0,
          passages: [],
          matches: [],
        };
        const id = `check-${Date.now()}-${i}`;
        const cleanTitle = label && label !== "Pasted text" ? label.replace(/\.(pdf|docx?|txt)$/i, "") : "Sample document";
        const doc: CheckedDocument = { ...template, id, fileName: label, title: cleanTitle, uploadedAt: today };
        recordCheckedDocument(doc);
        entries.push({
          id,
          title: cleanTitle,
          date: today,
          similarityScore: template.similarityScore,
          status: statusFromScore(template.similarityScore),
          project: state.project || undefined,
          wordCount: template.wordCount,
        });
        ids.push(id);
      });

      addHistoryEntries(entries);
      markFirstCheckComplete();
      setResultIds(ids);
      return;
    }
    const t = setTimeout(() => setStepIndex((i) => i + 1), stepDuration);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepIndex, steps.length, stepDuration]);

  const progress = Math.min(100, Math.round((stepIndex / steps.length) * 100));
  const docLabel = docLabels.length > 1 ? `${docLabels.length} documents` : docLabels[0];

  return (
    <div className="mx-auto flex min-h-[calc(100dvh-68px)] max-w-2xl flex-col items-center justify-center px-5 py-16 text-center">
      <motion.div
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 0.4 }}
        className={cn(
          "flex size-16 items-center justify-center rounded-full",
          resultIds ? "bg-success-bg text-success" : "bg-brand-100 text-brand-600",
        )}
      >
        {resultIds ? <CheckCircle size={30} weight="fill" /> : <FileMagnifyingGlass size={30} weight="bold" />}
      </motion.div>

      <h1 className="mt-6 text-h2 font-bold tracking-tight text-navy-900">
        {resultIds ? "Analysis complete" : "Analyzing your document"}
      </h1>
      <p className="mt-2 max-w-sm text-sm text-ink-500">{docLabel}</p>
      {state.reportMode === "backend" && !resultIds && (
        <div className="mt-4 w-full max-w-sm rounded-lg border border-line bg-white px-4 py-3 text-left text-sm text-ink-600">
          <p className="font-semibold text-ink-900">{jobStatus === "completed" ? "Finishing up" : jobMessage ?? "Waiting for backend"}</p>
          {jobProgress !== null && <p className="mt-1 text-xs text-ink-500">Progress: {jobProgress}%</p>}
        </div>
      )}

      {!resultIds && (
        <div className="mt-8 w-full max-w-sm">
          <div className="h-2 w-full overflow-hidden rounded-full bg-surface-muted">
            <motion.div
              className="h-full rounded-full brand-gradient"
              animate={{ width: `${progress}%` }}
              transition={{ duration: 0.4, ease: "easeOut" }}
            />
          </div>
          <p className="mt-2 text-xs font-medium text-ink-400">{progress}% complete</p>
        </div>
      )}

      <div className="mt-10 flex w-full max-w-sm flex-col gap-3 text-left">
        <AnimatePresence initial={false}>
          {steps.map((step, i) => {
            const done = i < stepIndex || resultIds;
            const active = i === stepIndex && !resultIds;
            if (i > stepIndex && !resultIds) return null;
            return (
              <motion.div
                key={step.id}
                initial={{ opacity: 0, x: -12 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.3 }}
                className={cn(
                  "flex items-center gap-3 rounded-[var(--radius-control)] border px-4 py-3",
                  active ? "border-brand-300 bg-brand-100/40" : "border-line bg-white",
                )}
              >
                {done ? (
                  <CheckCircle size={20} weight="fill" className="text-success shrink-0" />
                ) : (
                  <CircleNotch size={20} className="shrink-0 animate-spin text-brand-500" />
                )}
                <span className={cn("text-sm font-medium", done ? "text-ink-500" : "text-ink-900")}>
                  {step.label}
                </span>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>

      {resultIds && (
        <div className="mt-8 flex w-full max-w-sm flex-col gap-3">
          {resultIds.length === 1 && (
            <Button
              size="lg"
              fullWidth
              onClick={() => navigate(`/report/${resultIds[0]}`, { replace: true })}
            >
              View report
            </Button>
          )}
          <Button
            size="lg"
            variant={resultIds.length === 1 ? "outline" : "primary"}
            fullWidth
            iconLeft={<ClockCounterClockwise size={18} />}
            onClick={() => navigate("/history", { replace: true })}
          >
            Go to History
          </Button>
        </div>
      )}
    </div>
  );
}
