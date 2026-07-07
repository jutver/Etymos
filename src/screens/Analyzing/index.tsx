import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "motion/react";
import { CheckCircle, CircleNotch, ClockCounterClockwise, FileMagnifyingGlass } from "@phosphor-icons/react";
import { cn } from "../../lib/cn";
import { useAppStore } from "../../lib/store";
import { MOCK_DOCUMENTS } from "../../lib/mockData";
import { statusFromScore } from "../../components/Severity";
import { Button } from "../../components/ui/Button";
import type { CheckedDocument, HistoryEntry } from "../../lib/types";

interface LocationState {
  docLabels?: string[];
  project?: string;
  webSources?: boolean;
  academicSources?: boolean;
  language?: string;
}

const TOTAL_DURATION = 10000;

export default function AnalyzingPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const state = (location.state as LocationState) ?? {};
  const docLabels = state.docLabels?.length ? state.docLabels : ["Bien-doi-khi-hau-DBSCL.docx"];

  const addHistoryEntries = useAppStore((s) => s.addHistoryEntries);
  const recordCheckedDocument = useAppStore((s) => s.recordCheckedDocument);
  const markFirstCheckComplete = useAppStore((s) => s.markFirstCheckComplete);

  const steps = useMemo(() => {
    const all = [
      { id: "extract", label: docLabels.length > 1 ? "Extracting text from all documents" : "Extracting text" },
      { id: "web", label: "Scanning web sources", skip: state.webSources === false },
      { id: "academic", label: "Comparing academic papers", skip: state.academicSources === false },
      { id: "semantic", label: "Running semantic & AI-content detection" },
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
    if (stepIndex >= steps.length) {
      if (completedRef.current) return;
      completedRef.current = true;

      const today = new Date().toISOString().slice(0, 10);
      const entries: HistoryEntry[] = [];
      const ids: string[] = [];

      docLabels.forEach((label, i) => {
        const template = MOCK_DOCUMENTS[Math.floor(Math.random() * MOCK_DOCUMENTS.length)]!;
        const id = `check-${Date.now()}-${i}`;
        const cleanTitle = label && label !== "Pasted text" ? label.replace(/\.(pdf|docx?|txt)$/i, "") : template.title;
        const doc: CheckedDocument = { ...template, id, fileName: label, title: cleanTitle, uploadedAt: today };
        recordCheckedDocument(doc);
        entries.push({
          id,
          title: cleanTitle,
          date: today,
          similarityScore: template.similarityScore,
          status: statusFromScore(template.similarityScore),
          aiFlagged: template.aiContentScore >= 50,
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
