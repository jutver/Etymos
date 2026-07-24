import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { submitTextCheck, submitPdfCheck } from "../../lib/api";
import {
  CaretDown,
  CheckCircle,
  ClockCounterClockwise,
  Coins,
  FileText,
  FolderSimple,
  GraduationCap,
  Globe,
  Plus,
  Sparkle,
  UploadSimple,
  X,
} from "@phosphor-icons/react";
import { Button } from "../../components/ui/Button";
import { Toggle } from "../../components/ui/Toggle";
import { Modal, ModalCloseButton } from "../../components/ui/Modal";
import { UsageMeter } from "../../components/UsageMeter";
import { StatusPill } from "../../components/Severity";
import { PlagiarismPdfViewer } from "../../components/PlagiarismPdfViewer";
import { useAppStore, planLabel, planWordLimit, PROJECTS } from "../../lib/store";
import type { BalanceSource } from "../../lib/store";
import { attachCheckJobId, createCheckingDocument, markCheckFailed } from "../../lib/documentsQueries";
import { useAuth } from "../../lib/auth";
import { formatDate } from "../../lib/format";
import { cn } from "../../lib/cn";
import type { Language } from "../../lib/types";

const languages: { id: Language; label: string }[] = [
  { id: "vi", label: "Tiếng Việt" },
  { id: "en", label: "English" },
];

const BALANCE_ICON: Record<BalanceSource, typeof GraduationCap> = {
  plan: GraduationCap,
  standard: Coins,
  premium: Sparkle,
};

function isPdfFile(file: File) {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

export default function UploadPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const plan = useAppStore((s) => s.plan);
  const addCheckingEntry = useAppStore((s) => s.addCheckingEntry);
  const updateHistoryEntry = useAppStore((s) => s.updateHistoryEntry);
  const history = useAppStore((s) => s.history);
  const fetchHistory = useAppStore((s) => s.fetchHistory);
  const knownProjects = useAppStore((s) => s.knownProjects);
  const addKnownProject = useAppStore((s) => s.addKnownProject);
  const requestCheck = useAppStore((s) => s.requestCheck);
  const remaining = useAppStore((s) => s.remaining());
  const selectedBalance = useAppStore((s) => s.selectedBalance);
  const setSelectedBalance = useAppStore((s) => s.setSelectedBalance);
  const balances = useAppStore((s) => s.balances());

  const [tab, setTab] = useState<"file" | "paste">("file");
  const [dragActive, setDragActive] = useState(false);
  const [files, setFiles] = useState<{ name: string; size: number; file: File }[]>([]);
  const [previewIndex, setPreviewIndex] = useState(0);
  const [pastedText, setPastedText] = useState("");
  const [webSources, setWebSources] = useState(true);
  const [academicSources, setAcademicSources] = useState(true);
  const [language, setLanguage] = useState<Language>("vi");
  const [langOpen, setLangOpen] = useState(false);

  const [project, setProject] = useState<string>(PROJECTS[0]);
  const [projectQuery, setProjectQuery] = useState("");
  const [projectOpen, setProjectOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [balanceDialogOpen, setBalanceDialogOpen] = useState(false);

  useEffect(() => {
    if (!user?.id) return;
    void fetchHistory(user.id);
  }, [user?.id, fetchHistory]);

  const wordCount = pastedText.trim() ? pastedText.trim().split(/\s+/).length : 0;
  const wordLimit = planWordLimit(plan);
  const overLimit = wordCount > wordLimit;

  const hasContent = tab === "file" ? files.length > 0 : pastedText.trim().length > 0;
  const docLabels = tab === "file" ? files.map((f) => f.name) : [pastedText.trim() ? "Pasted text" : ""].filter(Boolean);

  const activePreviewIndex = Math.min(previewIndex, Math.max(files.length - 1, 0));
  const previewFile = files[activePreviewIndex];

  // Balances the user could actually spend right now. The "which balance?"
  // dialog only makes sense to ask about when there's a real choice.
  const availableBalances = useMemo(() => balances.filter((b) => b.remaining > 0), [balances]);

  // Mirrors Documents.tsx's project-name aggregation: the Default bucket plus
  // any client-known-but-empty projects plus every distinct project name
  // already present in history.
  const allProjectNames = useMemo(() => {
    const names = new Set<string>([PROJECTS[0], ...knownProjects]);
    for (const h of history) names.add(h.project ?? PROJECTS[0]);
    return [...names].sort((a, b) => {
      if (a === PROJECTS[0]) return -1;
      if (b === PROJECTS[0]) return 1;
      return a.localeCompare(b);
    });
  }, [history, knownProjects]);

  const trimmedQuery = projectQuery.trim();
  const filteredProjects = allProjectNames.filter((p) =>
    p.toLowerCase().includes(trimmedQuery.toLowerCase()),
  );
  const canCreateProject =
    trimmedQuery.length > 0 && !allProjectNames.some((p) => p.toLowerCase() === trimmedQuery.toLowerCase());

  function handleFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    const added = Array.from(fileList).map((f) => ({ name: f.name, size: f.size, file: f }));
    // Jump the preview to the first newly-added file. `files` here is the
    // committed state at call time (this only ever runs from an event
    // handler), so it's safe to read directly rather than from a setState
    // updater, which must stay side-effect free.
    setPreviewIndex(files.length);
    setFiles((prev) => [...prev, ...added]);
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  function chooseProject(name: string) {
    setProject(name);
    setProjectQuery("");
    setProjectOpen(false);
  }

  function createProject(name: string) {
    if (name !== PROJECTS[0]) addKnownProject(name);
    chooseProject(name);
  }

  /** Entry point for the "Check for plagiarism" button. When the user has a
   * real choice of balance to spend (2-3 buckets with remaining > 0), ask
   * which one via a dialog before submitting. Otherwise skip straight to
   * `handleSubmit` with whatever single balance is available (or the current
   * `selectedBalance` default when none have anything left, so the existing
   * paywall-redirect behaviour in `requestCheck` still applies). */
  function handleCheckClick() {
    if (!hasContent || overLimit || submitting) return;
    if (availableBalances.length >= 2) {
      setBalanceDialogOpen(true);
      return;
    }
    const chosen = availableBalances[0]?.source ?? selectedBalance;
    void handleSubmit(chosen);
  }

  function confirmBalanceChoice(source: BalanceSource) {
    setBalanceDialogOpen(false);
    void handleSubmit(source);
  }

  async function handleSubmit(source: BalanceSource) {
    if (!hasContent || overLimit) return;
    setSelectedBalance(source);

    const summaryLabel = docLabels.length > 1 ? `${docLabels.length} documents` : docLabels[0];
    const allowed = requestCheck(source, summaryLabel || "Untitled document", docLabels.length);
    if (!allowed) {
      navigate("/paywall");
      return;
    }

    setSubmitting(true);
    setSubmitError(null);

    // Register the check in the document list *before* the upload request even
    // starts, so it shows as "Checking" in Documents/History from this moment
    // on — including if the user leaves the Analyzing screen or reloads.
    // Purely additive: if this fails (offline, Supabase down) the check still
    // runs, it just isn't listed until it completes, i.e. the old behaviour.
    const rawLabel = tab === "paste" ? "Pasted text" : (docLabels[0] ?? "Untitled document");
    const title = rawLabel !== "Pasted text" ? rawLabel.replace(/\.(pdf|docx?|txt)$/i, "") : rawLabel;
    let placeholderId: string | null = null;

    if (user?.id) {
      try {
        const entry = await createCheckingDocument({
          userId: user.id,
          title,
          fileName: tab === "paste" ? null : (docLabels[0] ?? null),
          language,
          project: project === PROJECTS[0] ? null : project,
        });
        placeholderId = entry.id;
        addCheckingEntry(entry);
      } catch {
        placeholderId = null;
      }
    }

    /** Links the placeholder to the backend job so a reload can reconcile it. */
    async function trackJob(jobId: string) {
      if (!placeholderId) return;
      try {
        await attachCheckJobId(placeholderId, jobId);
        updateHistoryEntry(placeholderId, { checkJobId: jobId });
      } catch {
        // Non-fatal: reconciliation ages the row out rather than stranding it.
      }
    }

    try {
      if (tab === "paste") {
        const job = await submitTextCheck(pastedText.trim(), source);
        await trackJob(job.job_id);
        navigate("/analyzing", {
          state: {
            docLabels,
            project,
            webSources,
            academicSources,
            language,
            jobId: job.job_id,
            documentId: placeholderId,
            reportMode: "backend",
          },
        });
        return;
      }

      if (files.length > 0) {
        const file = files[0]?.file;

        if (!file) {
          throw new Error("Please choose a PDF file to upload.");
        }

        // Đọc file thành base64 data URL để lưu được vào localStorage
        // (blob URL sẽ chết sau khi refresh trang, data URL thì không)
        const pdfDataUrl = await new Promise<string | null>((resolve) => {
          if (file.type !== "application/pdf") {
            resolve(null); // không phải PDF thì không preview được, bỏ qua
            return;
          }
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(file);
        });

        const job = await submitPdfCheck(file, source);
        await trackJob(job.job_id);
        navigate("/analyzing", {
          state: {
            docLabels,
            project,
            webSources,
            academicSources,
            language,
            jobId: job.job_id,
            documentId: placeholderId,
            reportMode: "backend",
            pdfDataUrl,
          },
        });
        return;
      }

      throw new Error("Please add content before checking.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to start analysis.";
      setSubmitError(message);
      // The job never started, so settle its row instead of leaving a
      // permanent "Checking" entry behind.
      if (placeholderId) {
        const failedId = placeholderId;
        void markCheckFailed(failedId, message).catch(() => undefined);
        updateHistoryEntry(failedId, { checkState: "failed", checkError: message });
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-7xl flex-col px-5 py-6 sm:px-8 lg:h-[calc(100dvh-68px)] lg:overflow-hidden">
      <div className="flex shrink-0 flex-col gap-1.5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-h1 font-bold tracking-tight text-navy-900">Check a new document</h1>
          <p className="mt-1.5 text-body text-ink-600">
            Upload one or more files or paste your text. We'll scan the web and academic papers.
          </p>
        </div>
      </div>

      <div className="mt-6 grid flex-1 min-h-0 grid-cols-1 gap-6 lg:grid-cols-[1.7fr_1fr] lg:overflow-hidden">
        {/* Main upload card */}
        <div className="flex flex-col rounded-[var(--radius-card-lg)] border border-line bg-white p-6 shadow-[var(--shadow-card)] sm:p-7 lg:h-full lg:overflow-hidden">
          <div className="flex shrink-0 gap-1 rounded-full bg-surface-muted p-1">
            <button
              onClick={() => setTab("file")}
              className={cn(
                "flex-1 rounded-full py-2 text-sm font-semibold transition-colors",
                tab === "file" ? "bg-white text-navy-900 shadow-sm" : "text-ink-500 hover:text-ink-700",
              )}
            >
              Upload files
            </button>
            <button
              onClick={() => setTab("paste")}
              className={cn(
                "flex-1 rounded-full py-2 text-sm font-semibold transition-colors",
                tab === "paste" ? "bg-white text-navy-900 shadow-sm" : "text-ink-500 hover:text-ink-700",
              )}
            >
              Paste text
            </button>
          </div>

          {tab === "file" ? (
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragActive(true);
              }}
              onDragLeave={() => setDragActive(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragActive(false);
                handleFiles(e.dataTransfer.files);
              }}
              className={cn(
                "mt-6 flex flex-1 min-h-0 flex-col rounded-[var(--radius-card)] transition-shadow",
                dragActive && files.length > 0 && "ring-2 ring-brand-400 ring-offset-2",
              )}
            >
              {files.length === 0 ? (
                <div
                  onClick={() => fileInputRef.current?.click()}
                  className={cn(
                    "flex flex-1 min-h-[22rem] cursor-pointer flex-col items-center justify-center gap-4 rounded-[var(--radius-card)] border-2 border-dashed px-6 text-center transition-colors",
                    dragActive ? "border-brand-500 bg-brand-100/40" : "border-line hover:border-brand-300 hover:bg-surface-tint",
                  )}
                >
                  <div className="flex size-16 items-center justify-center rounded-full bg-brand-100 text-brand-600">
                    <UploadSimple size={30} weight="bold" />
                  </div>
                  <div>
                    <p className="text-base font-semibold text-ink-900">
                      Drag & drop one or more files here
                    </p>
                    <p className="mt-1.5 text-sm text-ink-500">
                      or <span className="font-semibold text-brand-600">browse files</span> on your
                      computer
                    </p>
                  </div>
                  <p className="text-xs text-ink-300">
                    PDF, DOC, DOCX or TXT · up to {wordLimit.toLocaleString()} words on {planLabel(plan)}
                  </p>
                </div>
              ) : (
                <div className="flex flex-1 min-h-0 flex-col gap-3">
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    {files.map((f, i) => (
                      <button
                        key={`${f.name}-${i}`}
                        onClick={() => setPreviewIndex(i)}
                        className={cn(
                          "flex items-center gap-2 rounded-full border py-1.5 pl-1.5 pr-3 text-left transition-colors",
                          i === activePreviewIndex
                            ? "border-brand-400 bg-brand-100/50"
                            : "border-line bg-white hover:border-brand-300",
                        )}
                      >
                        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand-100 text-brand-600">
                          <FileText size={13} weight="bold" />
                        </span>
                        <span className="max-w-[10rem] truncate text-xs font-semibold text-ink-900">{f.name}</span>
                        <span className="text-[0.6875rem] text-ink-400">{(f.size / 1024).toFixed(0)} KB</span>
                        <span
                          role="button"
                          tabIndex={-1}
                          onClick={(e) => {
                            e.stopPropagation();
                            removeFile(i);
                          }}
                          aria-label="Remove file"
                          className="ml-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-ink-400 hover:bg-white hover:text-severity-high"
                        >
                          <X size={12} />
                        </span>
                      </button>
                    ))}
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      className="flex items-center gap-1.5 rounded-full border border-dashed border-line px-3 py-1.5 text-xs font-semibold text-ink-500 hover:border-brand-300 hover:text-brand-600"
                    >
                      <Plus size={13} weight="bold" />
                      Add more
                    </button>
                  </div>
                  <p className="shrink-0 text-xs font-medium text-ink-400">
                    {files.length} file{files.length === 1 ? "" : "s"} ready to check
                  </p>

                  <div className="min-h-0 flex-1 overflow-auto rounded-[var(--radius-card)] border border-line bg-surface-tint">
                    {previewFile && isPdfFile(previewFile.file) ? (
                      <div className="p-1">
                        <PlagiarismPdfViewer pdfUrl={previewFile.file} matches={[]} />
                      </div>
                    ) : (
                      <div className="flex h-full min-h-[16rem] flex-col items-center justify-center gap-2 p-8 text-center">
                        <div className="flex size-12 items-center justify-center rounded-full bg-white text-ink-400 shadow-sm">
                          <FileText size={22} weight="bold" />
                        </div>
                        <p className="text-sm font-semibold text-ink-700">{previewFile?.name}</p>
                        <p className="text-xs text-ink-400">
                          Preview isn't available for this file type — it'll still be checked.
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept=".pdf,.doc,.docx,.txt"
                className="hidden"
                onChange={(e) => {
                  handleFiles(e.target.files);
                  e.target.value = "";
                }}
              />
            </div>
          ) : (
            <div className="mt-6 flex flex-1 min-h-0 flex-col">
              <textarea
                value={pastedText}
                onChange={(e) => setPastedText(e.target.value)}
                placeholder="Paste your document text here..."
                className="w-full min-h-[16rem] flex-1 resize-none rounded-[var(--radius-card)] border border-line bg-white p-4 text-sm leading-relaxed text-ink-900 placeholder:text-ink-300 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-200"
              />
              <div className="mt-2 flex shrink-0 items-center justify-end">
                <p className={cn("text-xs", overLimit ? "font-semibold text-severity-high" : "text-ink-400")}>
                  {wordCount.toLocaleString()} words / {wordLimit.toLocaleString()} limit
                </p>
              </div>
              {overLimit && (
                <p className="mt-2 shrink-0 rounded-lg bg-severity-high-bg px-3 py-2 text-xs font-medium text-severity-high">
                  This exceeds the {planLabel(plan)} plan's {wordLimit.toLocaleString()}-word limit.
                  {plan !== "professional" && " Upgrade for a higher limit."}
                </p>
              )}
            </div>
          )}

          {submitError && (
            <p className="mt-4 shrink-0 rounded-lg border border-severity-high-line bg-severity-high-bg px-3 py-2 text-sm text-severity-high">
              {submitError}
            </p>
          )}

          <div className="mt-6 grid shrink-0 grid-cols-1 gap-3 sm:grid-cols-2">
            <Toggle
              checked={webSources}
              onChange={setWebSources}
              label="Web sources"
              description="Scan public websites"
              icon={<Globe size={18} />}
            />
            <Toggle
              checked={academicSources}
              onChange={setAcademicSources}
              label="Academic papers"
              description="Scan scholarly databases"
              icon={<GraduationCap size={18} />}
            />
          </div>

          <div className="mt-5 flex shrink-0 flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
            <div className="relative">
              <button
                onClick={() => setLangOpen((v) => !v)}
                className="flex items-center gap-2 rounded-[var(--radius-control)] border border-line bg-white px-4 py-2.5 text-sm font-medium text-ink-700 hover:border-brand-300"
              >
                {languages.find((l) => l.id === language)?.label}
                <CaretDown size={14} className={cn("transition-transform", langOpen && "rotate-180")} />
              </button>
              {langOpen && (
                <div className="absolute bottom-[calc(100%+6px)] left-0 z-20 w-40 rounded-[var(--radius-card)] border border-line bg-white p-1.5 shadow-[var(--shadow-pop)]">
                  {languages.map((l) => (
                    <button
                      key={l.id}
                      onClick={() => {
                        setLanguage(l.id);
                        setLangOpen(false);
                      }}
                      className={cn(
                        "block w-full rounded-lg px-3 py-2 text-left text-sm font-medium",
                        language === l.id ? "bg-brand-100 text-brand-700" : "text-ink-700 hover:bg-surface-tint",
                      )}
                    >
                      {l.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="relative">
              <button
                onClick={() => setProjectOpen((v) => !v)}
                className="flex items-center gap-2 rounded-[var(--radius-control)] border border-line bg-white px-4 py-2.5 text-sm font-medium text-ink-700 hover:border-brand-300"
              >
                <FolderSimple size={15} />
                {project || "No project"}
                <CaretDown size={14} className={cn("transition-transform", projectOpen && "rotate-180")} />
              </button>
              {projectOpen && (
                <div className="absolute bottom-[calc(100%+6px)] left-0 z-20 w-64 rounded-[var(--radius-card)] border border-line bg-white p-1.5 shadow-[var(--shadow-pop)]">
                  <input
                    autoFocus
                    value={projectQuery}
                    onChange={(e) => setProjectQuery(e.target.value)}
                    placeholder="Search or create projects"
                    className="mb-1 w-full rounded-lg border border-line bg-surface-tint px-3 py-2 text-sm placeholder:text-ink-300 focus:border-brand-400 focus:outline-none"
                  />
                  <div className="max-h-48 overflow-y-auto scrollbar-thin">
                    {filteredProjects.map((p) => (
                      <button
                        key={p}
                        onClick={() => chooseProject(p)}
                        className={cn(
                          "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium",
                          project === p ? "bg-brand-100 text-brand-700" : "text-ink-700 hover:bg-surface-tint",
                        )}
                      >
                        {project === p && <CheckCircle size={14} weight="fill" />}
                        {p}
                      </button>
                    ))}
                    {canCreateProject && (
                      <button
                        onClick={() => createProject(trimmedQuery)}
                        className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium text-brand-600 hover:bg-surface-tint"
                      >
                        <Plus size={14} weight="bold" />
                        Create project "{trimmedQuery}"
                      </button>
                    )}
                    {filteredProjects.length === 0 && !canCreateProject && (
                      <p className="px-3 py-2 text-sm text-ink-400">No projects found</p>
                    )}
                  </div>
                </div>
              )}
            </div>

            <Button
              size="lg"
              disabled={!hasContent || overLimit || submitting}
              loading={submitting}
              onClick={handleCheckClick}
              iconLeft={<Sparkle size={18} weight="fill" />}
              className="w-full sm:ml-auto sm:w-auto"
            >
              {docLabels.length > 1 ? `Check ${docLabels.length} documents` : "Check for plagiarism"}
            </Button>
          </div>
        </div>

        {/* Sidebar */}
        <div className="flex flex-col gap-5 lg:h-full lg:overflow-hidden">
          <div className="shrink-0 rounded-[var(--radius-card-lg)] border border-line bg-white p-5">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">Your balance</p>
            <div className="mt-3">
              <UsageMeter />
            </div>
            {remaining <= 1 && (
              <Button as="link" to="/pricing" size="sm" fullWidth className="mt-4">
                {planLabel(plan) === "Free" ? "Upgrade or buy credits" : "Top up credits"}
              </Button>
            )}
          </div>

          <div className="flex flex-1 min-h-0 flex-col rounded-[var(--radius-card-lg)] border border-line bg-white p-5">
            <div className="flex shrink-0 items-center justify-between">
              <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-500">
                <ClockCounterClockwise size={14} />
                Recent checks
              </p>
              <button onClick={() => navigate("/history")} className="text-xs font-semibold text-brand-600 hover:underline">
                View all
              </button>
            </div>
            <div className="mt-3 flex-1 min-h-0 overflow-y-auto scrollbar-thin">
              <div className="flex flex-col gap-1">
                {history.slice(0, 8).map((h) => (
                  <button
                    key={h.id}
                    onClick={() => navigate(`/report/${h.id}`)}
                    className="flex items-center justify-between gap-3 rounded-lg px-2 py-2.5 text-left transition-colors hover:bg-surface-tint"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-ink-900">{h.title}</p>
                      <p className="text-xs text-ink-400">{formatDate(h.date)}</p>
                    </div>
                    <StatusPill status={h.status} className="shrink-0" />
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Ask-which-balance dialog — only ever opened when 2 or 3 balances
          have remaining > 0 (see handleCheckClick). With exactly one (or
          zero) available, submission skips this and goes straight through. */}
      <Modal open={balanceDialogOpen} onClose={() => setBalanceDialogOpen(false)} maxWidth="max-w-md" labelledBy="balance-dialog-title">
        <div className="relative p-6">
          <ModalCloseButton onClose={() => setBalanceDialogOpen(false)} />
          <h2 id="balance-dialog-title" className="text-h3 font-bold text-navy-900">
            Which balance should we use?
          </h2>
          <p className="mt-1.5 text-sm text-ink-500">
            You have credits available in more than one place. Pick which one this check should spend.
          </p>
          <div className="mt-5 flex flex-col gap-2.5">
            {availableBalances.map((b) => {
              const Icon = BALANCE_ICON[b.source];
              return (
                <button
                  key={b.source}
                  onClick={() => confirmBalanceChoice(b.source)}
                  className="flex items-center justify-between gap-3 rounded-[var(--radius-card)] border border-line bg-white px-4 py-3.5 text-left transition-colors hover:border-brand-400 hover:bg-brand-100/30"
                >
                  <span className="flex items-center gap-3">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand-100 text-brand-600">
                      <Icon size={18} weight="bold" />
                    </span>
                    <span>
                      <span className="block text-sm font-semibold text-navy-900">{b.label}</span>
                      <span className="block text-xs text-ink-500">
                        {b.remaining} check{b.remaining === 1 ? "" : "s"} remaining
                      </span>
                    </span>
                  </span>
                  <span className="size-2.5 shrink-0 rounded-full border-2 border-line" />
                </button>
              );
            })}
          </div>
        </div>
      </Modal>
    </div>
  );
}
