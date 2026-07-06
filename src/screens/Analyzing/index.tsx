import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "motion/react";
import { CheckCircle, CircleNotch, FileMagnifyingGlass } from "@phosphor-icons/react";
import { cn } from "../../lib/cn";

interface LocationState {
  docLabel?: string;
  webSources?: boolean;
  academicSources?: boolean;
  language?: string;
}

const STEP_DURATION = 950;

export default function AnalyzingPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const state = (location.state as LocationState) ?? {};
  const docLabel = state.docLabel ?? "Bien-doi-khi-hau-DBSCL.docx";

  const steps = useMemo(() => {
    const all = [
      { id: "extract", label: "Extracting text" },
      { id: "web", label: "Scanning web sources", skip: state.webSources === false },
      { id: "academic", label: "Comparing academic papers", skip: state.academicSources === false },
      { id: "semantic", label: "Running semantic & AI-content detection" },
      { id: "explain", label: "Generating explanations" },
    ];
    return all.filter((s) => !s.skip);
  }, [state.webSources, state.academicSources]);

  const [stepIndex, setStepIndex] = useState(0);

  useEffect(() => {
    if (stepIndex >= steps.length) {
      const t = setTimeout(() => navigate("/report/doc-current", { replace: true }), 500);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setStepIndex((i) => i + 1), STEP_DURATION);
    return () => clearTimeout(t);
  }, [stepIndex, steps.length, navigate]);

  const progress = Math.min(100, Math.round((stepIndex / steps.length) * 100));

  return (
    <div className="mx-auto flex min-h-[calc(100dvh-68px)] max-w-2xl flex-col items-center justify-center px-5 py-16 text-center">
      <motion.div
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 0.4 }}
        className="flex size-16 items-center justify-center rounded-full bg-brand-100 text-brand-600"
      >
        <FileMagnifyingGlass size={30} weight="bold" />
      </motion.div>

      <h1 className="mt-6 text-h2 font-bold tracking-tight text-navy-900">
        Analyzing your document
      </h1>
      <p className="mt-2 max-w-sm text-sm text-ink-500">{docLabel}</p>

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

      <div className="mt-10 flex w-full max-w-sm flex-col gap-3 text-left">
        <AnimatePresence initial={false}>
          {steps.map((step, i) => {
            const done = i < stepIndex;
            const active = i === stepIndex;
            if (i > stepIndex) return null;
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
    </div>
  );
}
