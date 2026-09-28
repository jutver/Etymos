import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "motion/react";
import { CheckCircle, CircleNotch, ClockCounterClockwise, FileMagnifyingGlass, WarningCircle } from "@phosphor-icons/react";
import { cn } from "../../lib/cn";
import { useAppStore } from "../../lib/store";
import { statusFromScore } from "../../components/Severity";
import { Button } from "../../components/ui/Button";
import { pollJob, getReport, type BackendDocumentBlock } from "../../lib/api";
import { finalizeCheckingDocument, markCheckFailed } from "../../lib/documentsQueries";
import { trackEvent } from "../../lib/analytics";
import { parseExplanationFacts } from "../../lib/matchExplanation";
import { parseAiDetection } from "../../lib/aiDetection";
import type { CheckedDocument, HistoryEntry, MatchedSource, Severity } from "../../lib/types";
import { t as tl, tr } from "../../lib/i18n";

interface LocationState {
  docLabels?: string[];
  project?: string;
  webSources?: boolean;
  academicSources?: boolean;
  language?: string;
  jobId?: string;
  /** Id of the `documents` row inserted the moment the check was requested
   * (see screens/Upload). Present both on the initial navigation and when the
   * user re-opens a still-checking document from Documents/History. */
  documentId?: string | null;
  reportMode?: string;
  pdfDataUrl?: string | null;
}

const TOTAL_DURATION = 10000;

/** Per-match severity thresholds on matchPercent (= semantic_similarity *
 * 100): Low <20, Moderate 20-60, High >60. Intentionally DIFFERENT from
 * the whole-document aggregate in components/Severity.tsx's
 * `statusFromScore` (thresholds 15/30/50, over `overall_score`) — that is
 * a separate metric, out of scope here. Mirrors
 * backend/api/report_store.py's `_severity_from_percent`, which the
 * Supabase-reload path uses for the same field. */
function severityFromMatchPercent(matchPercent: number): Severity {
  if (matchPercent > 60) return "high";
  if (matchPercent >= 20) return "moderate";
  return "low";
}

/** A passage plus where it sits in the report's `input_text`.
 *
 * The offsets matter: the backend reports match positions as absolute
 * character indices into `input_text`, but the Report screen highlights
 * *within* a passage, so we need each passage's own origin to rebase them.
 * Everything here therefore indexes the raw string — no `\r\n` normalisation
 * and no leading trim of the whole document, either of which would shift
 * every offset after it and silently mis-place highlights. */
interface PassageSlice {
  text: string;
  /** Inclusive offset of `text[0]` in the original `input_text`. */
  start: number;
  /** Exclusive end offset of `text` in the original `input_text`. */
  end: number;
}

/** Trims `text.slice(start, end)` and records where the trimmed run landed.
 * Blank segments are dropped, matching the previous split behaviour. */
function pushSlice(text: string, start: number, end: number, out: PassageSlice[]): void {
  const raw = text.slice(start, end);
  const trimmed = raw.trim();
  if (!trimmed) return;
  const leading = raw.length - raw.trimStart().length;
  out.push({ text: trimmed, start: start + leading, end: start + leading + trimmed.length });
}

/** Splits on `separator` (which must be global) while tracking offsets. */
function sliceOn(text: string, separator: RegExp): PassageSlice[] {
  const out: PassageSlice[] = [];
  let cursor = 0;
  for (const hit of text.matchAll(separator)) {
    pushSlice(text, cursor, hit.index, out);
    cursor = hit.index + hit[0].length;
  }
  pushSlice(text, cursor, text.length, out);
  return out;
}

function splitDocumentIntoPassages(text: string): PassageSlice[] {
  if (!text.trim()) return [];

  // `\r?\n` rather than `\n` so CRLF documents split the same way without
  // rewriting the string (which would invalidate the offsets).
  const paragraphs = sliceOn(text, /(?:\r?\n){2,}/g);
  if (paragraphs.length > 1) return paragraphs;

  return sliceOn(text, /(?<=[.!?])\s+/gu);
}

/** Backend block types the Document view knows how to render. Anything else
 * (a value the backend might add later) degrades to a plain paragraph
 * rather than being dropped — see DocumentCanvas's rendering switch. */
const KNOWN_BLOCK_TYPES = new Set(["title", "heading", "paragraph", "list_item", "table", "image"]);

/**
 * Builds passages straight from the backend's structural blocks
 * (`report.document.blocks` — backend/document_model.py) instead of
 * re-splitting the flat `input_text` client-side. This is what gives the
 * Document view real headings/lists/tables/page-breaks: each block already
 * carries its own type, level, list marker, source page, and (for tables)
 * grid rows, and its `start`/`end` are exact offsets into `input_text` — no
 * guessing paragraph boundaries the way splitDocumentIntoPassages() has to
 * for inputs that don't carry a `document` (the pasted-text check path,
 * and any report generated before this shipped).
 */
function toHeadingLevel(level: number | undefined): 1 | 2 | 3 | undefined {
  return level === 1 || level === 2 || level === 3 ? level : undefined;
}

function toListType(listType: string | undefined): "bullet" | "number" | undefined {
  return listType === "bullet" || listType === "number" ? listType : undefined;
}

function buildPassagesFromBlocks(
  blocks: BackendDocumentBlock[],
  inputText: string,
  matches: MatchedSource[],
  docId: string,
): CheckedDocument["passages"] {
  return blocks
    .map((block, index) => {
      // Section headings are zero-length and bring their own words in
      // `block.text` (see BackendDocumentBlock.text).
      const text = inputText.slice(block.start, block.end).trim() || block.text?.trim() || "";
      // An "image" block is zero-length by construction (backend/
      // document_model.py's _interleave_image_blocks — it has no text of
      // its own, only a position in reading order), so it would otherwise
      // be silently dropped by the empty-text check every other block
      // type needs. Every other block type keeps the original behaviour.
      if (!text && block.type !== "image") return null;

      const matchingMatch =
        matches.find(
          (match) =>
            match.startOffset != null &&
            match.endOffset != null &&
            match.startOffset >= block.start &&
            match.endOffset <= block.end,
        ) ??
        matches.find((match) => {
          if (match.startOffset != null) return false;
          const userSnippet = match.userSnippet?.trim() ?? "";
          return Boolean(userSnippet) && (text === userSnippet || text.includes(userSnippet));
        });

      const level = toHeadingLevel(block.level);
      const listType = toListType(block.list_type);

      return {
        id: `${docId}-passage-${index}`,
        text,
        startOffset: block.start,
        endOffset: block.end,
        severity: matchingMatch?.severity,
        matchId: matchingMatch?.id,
        blockType: KNOWN_BLOCK_TYPES.has(block.type) ? (block.type as CheckedDocument["passages"][number]["blockType"]) : "paragraph",
        level,
        listType,
        page: block.page,
        tableRows: block.rows,
        imageUrl: block.image_url,
        textMarks: block.marks,
      };
    })
    .filter((p): p is NonNullable<typeof p> => p !== null);
}

export default function AnalyzingPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const state = (location.state as LocationState) ?? {};
  const docLabels = state.docLabels?.length ? state.docLabels : ["Bien-doi-khi-hau-DBSCL.docx"];

  const addHistoryEntries = useAppStore((s) => s.addHistoryEntries);
  const recordCheckedDocument = useAppStore((s) => s.recordCheckedDocument);
  const markFirstCheckComplete = useAppStore((s) => s.markFirstCheckComplete);
  const updateHistoryEntry = useAppStore((s) => s.updateHistoryEntry);
  const replaceHistoryEntryId = useAppStore((s) => s.replaceHistoryEntryId);
  const [jobStatus, setJobStatus] = useState<string | null>(null);
  const [jobMessage, setJobMessage] = useState<string | null>(null);
  const [jobProgress, setJobProgress] = useState<number | null>(null);

  const steps = useMemo(() => {
    const all = [
      { id: "extract", label: docLabels.length > 1 ? tr("Extracting text from all documents") : tr("Extracting text") },
      { id: "web", label: tr("Scanning web sources"), skip: state.webSources === false },
      { id: "academic", label: tr("Comparing academic papers"), skip: state.academicSources === false },
      { id: "semantic", label: tr("Running semantic detection") },
      { id: "explain", label: tr("Generating explanations") },
    ];
    return all.filter((s) => !s.skip);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.webSources, state.academicSources]);

  const stepDuration = TOTAL_DURATION / steps.length;
  const [stepIndex, setStepIndex] = useState(0);
  const [resultIds, setResultIds] = useState<string[] | null>(null);
  const completedRef = useRef(false);

  useEffect(() => {
    // Re-opened a "Checking" row whose job id was never recorded (the tab
    // closed between inserting the row and the submit returning). There is
    // nothing to poll, and falling through to the simulated path below would
    // fabricate a report — settle it as failed instead.
    if (state.reportMode === "backend" && state.documentId && !state.jobId) {
      if (completedRef.current) return;
      completedRef.current = true;
      const message = tr("This check was interrupted and never finished. Please run it again.");
      setJobStatus("failed");
      setJobMessage(message);
      void markCheckFailed(state.documentId, message).catch(() => undefined);
      updateHistoryEntry(state.documentId, { checkState: "failed", checkError: message });
      return;
    }

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
            const message = job.error ?? tr("Analysis failed.");
            setJobStatus("failed");
            setJobMessage(message);
            // Settle the row the Upload screen inserted, so Documents/History
            // show it as failed instead of checking forever.
            if (state.documentId) {
              void markCheckFailed(state.documentId, message).catch(() => undefined);
              updateHistoryEntry(state.documentId, { checkState: "failed", checkError: message });
            }
            return;
          }

          const report = await getReport(job.report_id!);
          const today = new Date().toISOString().slice(0, 10);
          const entries: HistoryEntry[] = [];
          const ids: string[] = [];

          const overallScore = report.overall_score;
          const estimatedWordCount = Math.max(1, Math.round((report.total_input_chunks || 1) * 900));

          // Settle the placeholder row and adopt whichever id ends up being
          // canonical — the backend's own report row when it persisted one,
          // otherwise the placeholder itself. Using that id (rather than a
          // synthetic `check-<ts>`) means /report/:id resolves against
          // Supabase after a reload, not just this session's local cache.
          let docId = `check-${Date.now()}`;
          if (state.documentId) {
            try {
              docId = await finalizeCheckingDocument({
                placeholderId: state.documentId,
                reportId: job.report_id ?? null,
                results: {
                  status: statusFromScore(overallScore),
                  similarityScore: overallScore,
                  wordCount: estimatedWordCount,
                  webSourcesScanned: (report.coverage?.total_candidate_papers as number) ?? 0,
                  academicSourcesScanned: (report.coverage?.checked_papers as number) ?? 0,
                },
              });
            } catch {
              // Couldn't settle in Supabase — fall back to the placeholder id
              // so the local view is still coherent; reconciliation on the
              // next Documents/History mount retries the write.
              docId = state.documentId;
            }
          }

          const cleanTitle = docLabels[0] && docLabels[0] !== "Pasted text"
            ? docLabels[0].replace(/\.(pdf|docx?|txt)$/i, "")
            : "Backend analysis";

          const matches: MatchedSource[] = (report.matches ?? []).map((match: any, index: number) => {
            const matchPercent = Math.round(Math.max(0, Math.min(100, match.semantic_similarity * 100)));
            const sourceAuthors: string[] = Array.isArray(match.source_authors) ? match.source_authors : [];

            return {
              id: `${docId}-match-${index}`,
              // Severity is now purely a function of matchPercent (Low <20,
              // Moderate 20-60, High >60) — NOT the categorical `label`,
              // which previously meant two matches sharing a label always
              // rendered the same severity regardless of how similar they
              // actually were. See severityFromMatchPercent below.
              severity: severityFromMatchPercent(matchPercent),
              detectionType: "traditional",
              matchPercent,
              sourceTitle: match.source_title ?? match.source_paper_id,
              sourceAuthor: sourceAuthors.filter((a) => a && a.trim()).join(", "),
              // Backend now tags every candidate "web" or "academic" (see
              // backend/search_paper/search_sources.py) instead of this
              // always being hardcoded "academic".
              sourceKind: match.source_kind === "web" ? "web" : "academic",
              citation: match.source_paper_id,
              sourceYear: match.source_year || undefined,
              sourceUrl: match.source_url || match.source_pdf_url || undefined,
              sourceDoi: match.source_doi || undefined,
              userSnippet: match.input_sentence,
              sourceSnippet: match.source_sentence,
              // Real per-match explanation from the backend
              // (final_report_builder.py's _build_explanation) when
              // present — references this match's own similarity score,
              // source title, and excerpt, so two matches sharing a label
              // no longer render byte-identical text. Falls back to the
              // old template only for reports built before this field
              // existed.
              explanation: match.explanation ?? tl("Matched {{label}}.", { label: match.label.replace(/_/g, " ") }),
              // Lets MatchCard write the explanation in the UI language (lib/matchExplanation.ts).
              explanationFacts: parseExplanationFacts(match.explanation_facts),
              rewriteSuggestions: [],
              // `input_offset` is omitted (never zeroed) when the backend could
              // not localise the sentence, so its presence is the capability
              // check. Spreading conditionally keeps the fields genuinely
              // absent rather than `undefined`-but-present.
              ...(match.input_offset
                ? {
                    startOffset: match.input_offset.start,
                    endOffset: match.input_offset.end,
                    blockId: match.input_offset.block_id ?? undefined,
                    sectionId: match.input_offset.section ?? undefined,
                  }
                : {}),
              ...(match.source_offset
                ? {
                    sourceStartOffset: match.source_offset.chunk_start ?? undefined,
                    sourceEndOffset: match.source_offset.chunk_end ?? undefined,
                  }
                : {}),
            };
          });

          // Prefer the backend's structural blocks (real headings/lists/
          // tables/page numbers) over re-splitting the flat text; only
          // fall back to the old paragraph/sentence heuristic when a
          // report has no `document` at all (the pasted-text check path).
          const blocks = report.document?.blocks;
          const passages =
            blocks && blocks.length > 0
              ? buildPassagesFromBlocks(blocks, report.input_text ?? "", matches, docId)
              : splitDocumentIntoPassages(report.input_text ?? "").map((slice, index) => {
                  // Prefer the backend's offsets: a match belongs to the passage
                  // whose character range contains it. Falls back to the old
                  // snippet-containment guess for matches without offsets.
                  const matchingMatch =
                    matches.find(
                      (match) =>
                        match.startOffset != null &&
                        match.endOffset != null &&
                        match.startOffset >= slice.start &&
                        match.endOffset <= slice.end,
                    ) ??
                    matches.find((match) => {
                      if (match.startOffset != null) return false;
                      const userSnippet = match.userSnippet?.trim() ?? "";
                      return (
                        Boolean(userSnippet) &&
                        (slice.text.trim() === userSnippet || slice.text.includes(userSnippet))
                      );
                    });

                  return {
                    id: `${docId}-passage-${index}`,
                    text: slice.text,
                    startOffset: slice.start,
                    endOffset: slice.end,
                    severity: matchingMatch?.severity,
                    matchId: matchingMatch?.id,
                  };
                });

          const doc: CheckedDocument = {
            id: docId,
            title: cleanTitle,
            fileName: docLabels[0] ?? "analysis",
            language: (state.language as "vi" | "en" | "fr" | "ja") ?? "vi",
            wordCount: estimatedWordCount,
            uploadedAt: today,
            similarityScore: overallScore,
            similarityScoreFree: overallScore,
            webSourcesScanned: report.coverage?.total_candidate_papers as number ?? 0,
            academicSourcesScanned: report.coverage?.checked_papers as number ?? 0,
            passages: passages.length > 0 ? passages : report.matches.slice(0, 5).map((match: any, index: number) => ({
              id: `${docId}-passage-${index}`,
              text: match.input_sentence,
              severity: severityFromMatchPercent(
                Math.round(Math.max(0, Math.min(100, match.semantic_similarity * 100))),
              ),
              matchId: `${docId}-match-${index}`,
            })),
            matches,
            pdfUrl: state.pdfDataUrl ?? undefined, // ← thêm dòng này
            aiDetection: parseAiDetection(report.ai_detection),
          };

          recordCheckedDocument(doc);
          const settled = {
            id: docId,
            title: cleanTitle,
            date: today,
            similarityScore: overallScore,
            status: statusFromScore(overallScore),
            project: state.project || undefined,
            wordCount: doc.wordCount,
          };
          ids.push(docId);

          if (state.documentId) {
            // The row already exists (added on submit) — settle it in place so
            // the list doesn't end up with both a "Checking" and a completed
            // copy of the same check.
            if (docId === state.documentId) {
              updateHistoryEntry(docId, {
                ...settled,
                checkState: "completed",
                checkError: undefined,
              });
            } else {
              replaceHistoryEntryId(state.documentId, docId);
              updateHistoryEntry(docId, { ...settled, checkState: "completed" });
            }
          } else {
            entries.push(settled);
            addHistoryEntries(entries);
          }
          markFirstCheckComplete();
          trackEvent("check_completed", { documents: ids.length });
          setResultIds(ids);
        } catch (error) {
          const message = error instanceof Error ? error.message : tr("Analysis failed.");
          setJobStatus("failed");
          setJobMessage(message);
          if (state.documentId) {
            void markCheckFailed(state.documentId, message).catch(() => undefined);
            updateHistoryEntry(state.documentId, { checkState: "failed", checkError: message });
          }
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
      trackEvent("check_completed", { documents: ids.length });
      setResultIds(ids);
      return;
    }
    const t = setTimeout(() => setStepIndex((i) => i + 1), stepDuration);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepIndex, steps.length, stepDuration]);

  const progress = Math.min(100, Math.round((stepIndex / steps.length) * 100));
  const docLabel = docLabels.length > 1 ? tl("{{count}} documents", { count: docLabels.length }) : docLabels[0];
  const failed = jobStatus === "failed";

  return (
    <div className="mx-auto flex min-h-[calc(100dvh-68px)] max-w-2xl flex-col items-center justify-center px-5 py-16 text-center">
      <motion.div
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 0.4 }}
        className={cn(
          "flex size-16 items-center justify-center rounded-full",
          failed
            ? "bg-severity-high-bg text-severity-high"
            : resultIds
              ? "bg-success-bg text-success"
              : "bg-brand-100 text-brand-600",
        )}
      >
        {failed ? (
          <WarningCircle size={30} weight="fill" />
        ) : resultIds ? (
          <CheckCircle size={30} weight="fill" />
        ) : (
          <FileMagnifyingGlass size={30} weight="bold" />
        )}
      </motion.div>

      <h1 className="mt-6 text-h2 font-bold tracking-tight text-navy-900">
        {failed ? tl("Analysis failed") : resultIds ? tl("Analysis complete") : tl("Analyzing your document")}
      </h1>
      <p className="mt-2 max-w-sm text-sm text-ink-500">{tl(docLabel)}</p>

      {failed ? (
        <div className="mt-4 w-full max-w-sm rounded-lg border border-severity-high-line bg-severity-high-bg px-4 py-3 text-left text-sm">
          <p className="font-semibold text-severity-high">
            {tl("We couldn't finish analyzing this document. Please try again.")}</p>
          {jobMessage && <p className="mt-1 text-xs text-severity-high/80">{tl(jobMessage)}</p>}
        </div>
      ) : (
        state.reportMode === "backend" &&
        !resultIds && (
          <div className="mt-4 w-full max-w-sm rounded-lg border border-line bg-white px-4 py-3 text-left text-sm text-ink-600">
            <p className="font-semibold text-ink-900">{jobStatus === "completed" ? tl("Finishing up") : tl(jobMessage) ?? tl("Waiting for backend")}</p>
            {jobProgress !== null && <p className="mt-1 text-xs text-ink-500">{tl("Progress: {{percent}}%", { percent: jobProgress })}</p>}
          </div>
        )
      )}

      {!resultIds && !failed && (
        <div className="mt-8 w-full max-w-sm">
          <div className="h-2 w-full overflow-hidden rounded-full bg-surface-muted">
            <motion.div
              className="h-full rounded-full brand-gradient"
              animate={{ width: `${progress}%` }}
              transition={{ duration: 0.4, ease: "easeOut" }}
            />
          </div>
          <p className="mt-2 text-xs font-medium text-ink-400">{progress}{tl("% complete")}</p>
        </div>
      )}

      {!resultIds && !failed && state.documentId && (
        <div className="mt-6 flex w-full max-w-sm flex-col items-center gap-3">
          <p className="text-xs text-ink-400">
            {tl("This check keeps running if you leave — it stays in your documents as “Checking”.")}</p>
          <Button
            size="sm"
            variant="outline"
            iconLeft={<ClockCounterClockwise size={15} />}
            onClick={() => navigate("/documents")}
          >
            {tl("Continue in background")}</Button>
        </div>
      )}

      {!failed && (
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
                    <CircleNotch size={20} className="shrink-0 animate-spin motion-reduce:animate-none text-brand-500" />
                  )}
                  <span className={cn("text-sm font-medium", done ? "text-ink-500" : "text-ink-900")}>
                    {tl(step.label)}
                  </span>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      )}

      {failed && (
        <div className="mt-8 flex w-full max-w-sm flex-col gap-3">
          <Button size="lg" fullWidth onClick={() => navigate("/upload", { replace: true })}>
            {tl("Try again")}</Button>
          <Button
            size="lg"
            variant="outline"
            fullWidth
            iconLeft={<ClockCounterClockwise size={18} />}
            onClick={() => navigate("/history", { replace: true })}
          >
            {tl("Go to History")}</Button>
        </div>
      )}

      {resultIds && (
        <div className="mt-8 flex w-full max-w-sm flex-col gap-3">
          {resultIds.length === 1 && (
            <Button
              size="lg"
              fullWidth
              onClick={() => navigate(`/report/${resultIds[0]}`, { replace: true })}
            >
              {tl("View report")}</Button>
          )}
          <Button
            size="lg"
            variant={resultIds.length === 1 ? "outline" : "primary"}
            fullWidth
            iconLeft={<ClockCounterClockwise size={18} />}
            onClick={() => navigate("/history", { replace: true })}
          >
            {tl("Go to History")}</Button>
        </div>
      )}
    </div>
  );
}
