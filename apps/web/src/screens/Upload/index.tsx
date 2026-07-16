import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { submitTextCheck, submitPdfCheck } from "../../lib/api";
import {
  CaretDown,
  CheckCircle,
  ClockCounterClockwise,
  FileText,
  FolderSimple,
  GraduationCap,
  Globe,
  LockSimple,
  Plus,
  Sparkle,
  UploadSimple,
  X,
} from "@phosphor-icons/react";
import { Button } from "../../components/ui/Button";
import { Toggle } from "../../components/ui/Toggle";
import { UsageMeter } from "../../components/UsageMeter";
import { StatusPill } from "../../components/Severity";
import { PlagiarismPdfViewer } from "../../components/PlagiarismPdfViewer";
import { useAppStore, planLabel, planWordLimit } from "../../lib/store";
import { formatDate, cn } from "@etymos/shared";
import { MOCK_DOCUMENTS } from "../../lib/mockData";
import type { Language } from "@etymos/shared";

const languages: { id: Language; label: string }[] = [
  { id: "vi", label: "Tiếng Việt" },
  { id: "en", label: "English" },
  { id: "fr", label: "Français" },
  { id: "ja", label: "日本語" },
];

const VISIBLE_SAMPLE_COUNT = 5;

export default function UploadPage() {
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const plan = useAppStore((s) => s.plan);
  const history = useAppStore((s) => s.history);
  const projects = useAppStore((s) => s.projects);
  const addProject = useAppStore((s) => s.addProject);
  const hasCompletedFirstCheck = useAppStore((s) => s.hasCompletedFirstCheck);
  const requestCheck = useAppStore((s) => s.requestCheck);
  const remaining = useAppStore((s) => s.remaining());

  const [tab, setTab] = useState<"file" | "paste">("file");
  const [dragActive, setDragActive] = useState(false);
  const [files, setFiles] = useState<{ name: string; size: number; file: File }[]>([]);
  const [pastedText, setPastedText] = useState("");
  const [webSources, setWebSources] = useState(true);
  const [academicSources, setAcademicSources] = useState(true);
  const [language, setLanguage] = useState<Language>("vi");
  const [langOpen, setLangOpen] = useState(false);

  const [project, setProject] = useState<string>(projects[0] ?? "");
  const [projectQuery, setProjectQuery] = useState("");
  const [projectOpen, setProjectOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const wordCount = pastedText.trim() ? pastedText.trim().split(/\s+/).length : 0;
  const wordLimit = planWordLimit(plan);
  const overLimit = wordCount > wordLimit;

  const hasContent = tab === "file" ? files.length > 0 : pastedText.trim().length > 0;
  const docLabels = tab === "file" ? files.map((f) => f.name) : [pastedText.trim() ? "Pasted text" : ""].filter(Boolean);

  const visibleSamples = MOCK_DOCUMENTS.slice(
    0,
    hasCompletedFirstCheck ? MOCK_DOCUMENTS.length : VISIBLE_SAMPLE_COUNT,
  );
  const lockedSampleCount = MOCK_DOCUMENTS.length - visibleSamples.length;

  const filteredProjects = projects.filter((p) =>
    p.toLowerCase().includes(projectQuery.trim().toLowerCase()),
  );
  const canCreateProject =
    projectQuery.trim().length > 0 &&
    !projects.some((p) => p.toLowerCase() === projectQuery.trim().toLowerCase());

  function handleFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    const added = Array.from(fileList).map((f) => ({ name: f.name, size: f.size, file: f }));
    setFiles((prev) => [...prev, ...added]);
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  function loadSample(sampleId: string) {
    const sample = MOCK_DOCUMENTS.find((d) => d.id === sampleId);
    if (!sample) return;
    setTab("paste");
    setPastedText(sample.passages.map((p) => p.text).join("\n\n"));
  }

  function chooseProject(name: string) {
    setProject(name);
    setProjectQuery("");
    setProjectOpen(false);
  }

  function createProject() {
    const name = projectQuery.trim();
    if (!name) return;
    addProject(name);
    chooseProject(name);
  }

  async function handleSubmit() {
    if (!hasContent || overLimit) return;

    const summaryLabel = docLabels.length > 1 ? `${docLabels.length} documents` : docLabels[0];
    const allowed = requestCheck(summaryLabel || "Untitled document", docLabels.length);
    if (!allowed) {
      navigate("/paywall");
      return;
    }

    setSubmitting(true);
    setSubmitError(null);

    try {
      if (tab === "paste") {
        const job = await submitTextCheck(pastedText.trim());
        navigate("/analyzing", {
          state: {
            docLabels,
            project,
            webSources,
            academicSources,
            language,
            jobId: job.job_id,
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

        const job = await submitPdfCheck(file);
        navigate("/analyzing", {
          state: {
            docLabels,
            project,
            webSources,
            academicSources,
            language,
            jobId: job.job_id,
            reportMode: "backend",
            pdfDataUrl,
          },
        });
        return;
      }

      throw new Error("Please add content before checking.");
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Unable to start analysis.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-7xl px-5 py-10 sm:px-8">
      <div className="flex flex-col gap-1.5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-h1 font-bold tracking-tight text-navy-900">Check a new document</h1>
          <p className="mt-1.5 text-body text-ink-600">
            Upload one or more files or paste your text. We'll scan the web and academic papers.
          </p>
        </div>
      </div>

      <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-[1.7fr_1fr]">
        {/* Main upload card */}
        <div className="rounded-[var(--radius-card-lg)] border border-line bg-white p-6 shadow-[var(--shadow-card)] sm:p-7">
          <div className="flex gap-1 rounded-full bg-surface-muted p-1">
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
            <div className="mt-6">
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
                onClick={() => fileInputRef.current?.click()}
                className={cn(
                  "flex cursor-pointer flex-col items-center justify-center gap-3 rounded-[var(--radius-card)] border-2 border-dashed px-6 py-12 text-center transition-colors",
                  dragActive ? "border-brand-500 bg-brand-100/40" : "border-line hover:border-brand-300 hover:bg-surface-tint",
                )}
              >
                <div className="flex size-14 items-center justify-center rounded-full bg-brand-100 text-brand-600">
                  <UploadSimple size={26} weight="bold" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-ink-900">
                    Drag & drop one or more files here
                  </p>
                  <p className="mt-1 text-xs text-ink-500">
                    or <span className="font-semibold text-brand-600">browse files</span> on your
                    computer
                  </p>
                </div>
                <p className="text-[0.6875rem] text-ink-300">
                  PDF, DOC, DOCX or TXT · up to {wordLimit.toLocaleString()} words on {planLabel(plan)}
                </p>
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

              {files.length > 0 && (
                <div className="mt-6 flex flex-col gap-2">
                  {files.map((f, i) => (
                    <div
                      key={`${f.name}-${i}`}
                      className="flex items-center justify-between rounded-[var(--radius-card)] border border-line bg-surface-tint px-5 py-3.5"
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-100 text-brand-600">
                          <FileText size={18} weight="bold" />
                        </div>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-ink-900">{f.name}</p>
                          <p className="text-xs text-ink-500">{(f.size / 1024).toFixed(0)} KB</p>
                        </div>
                      </div>
                      <button
                        onClick={() => removeFile(i)}
                        aria-label="Remove file"
                        className="flex size-8 shrink-0 items-center justify-center rounded-full text-ink-400 hover:bg-white hover:text-severity-high"
                      >
                        <X size={16} />
                      </button>
                    </div>
                  ))}
                  <p className="text-xs font-medium text-ink-400">
                    {files.length} file{files.length === 1 ? "" : "s"} ready to check
                  </p>
                </div>
              )}

              {files.length > 0 && (
                <div className="mt-8 border-t border-line pt-6">
                  <h3 className="mb-4 text-sm font-semibold text-navy-900">Preview tài liệu:</h3>
                  <PlagiarismPdfViewer pdfUrl={files[0].file} matches={[]} />
                </div>
              )}
            </div>
          ) : (
            <div className="mt-6">
              <textarea
                value={pastedText}
                onChange={(e) => setPastedText(e.target.value)}
                placeholder="Paste your document text here..."
                rows={10}
                className="w-full resize-none rounded-[var(--radius-card)] border border-line bg-white p-4 text-sm leading-relaxed text-ink-900 placeholder:text-ink-300 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-200"
              />
              <div className="mt-2 flex items-center justify-between">
                <span className="text-xs text-ink-400">Or try a sample below</span>
                <p className={cn("text-xs", overLimit ? "font-semibold text-severity-high" : "text-ink-400")}>
                  {wordCount.toLocaleString()} words / {wordLimit.toLocaleString()} limit
                </p>
              </div>
              {overLimit && (
                <p className="mt-2 rounded-lg bg-severity-high-bg px-3 py-2 text-xs font-medium text-severity-high">
                  This exceeds the {planLabel(plan)} plan's {wordLimit.toLocaleString()}-word limit.
                  {plan !== "professional" && " Upgrade for a higher limit."}
                </p>
              )}

              <div className="mt-5 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                {visibleSamples.map((sample) => (
                  <button
                    key={sample.id}
                    onClick={() => loadSample(sample.id)}
                    className="flex flex-col items-start gap-1 rounded-[var(--radius-card)] border border-line bg-white p-3.5 text-left transition-colors hover:border-brand-300 hover:bg-surface-tint"
                  >
                    <p className="line-clamp-1 text-xs font-bold text-navy-900">{sample.title}</p>
                    <p className="line-clamp-2 text-[0.6875rem] leading-relaxed text-ink-500">
                      {sample.passages[0]?.text}
                    </p>
                  </button>
                ))}
                {lockedSampleCount > 0 && (
                  <div className="flex flex-col items-center justify-center gap-1.5 rounded-[var(--radius-card)] border border-dashed border-line bg-surface-tint p-3.5 text-center">
                    <LockSimple size={16} className="text-ink-300" />
                    <p className="text-[0.6875rem] font-medium text-ink-400">
                      {lockedSampleCount} more samples unlock after your first real check
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}

          {submitError && (
            <p className="mt-4 rounded-lg border border-severity-high-line bg-severity-high-bg px-3 py-2 text-sm text-severity-high">
              {submitError}
            </p>
          )}

          <div className="mt-7 grid grid-cols-1 gap-3 sm:grid-cols-2">
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

          <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
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
                    placeholder="Search or create a project"
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
                        onClick={createProject}
                        className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-semibold text-brand-600 hover:bg-brand-100/50"
                      >
                        <Plus size={14} weight="bold" />
                        Create "{projectQuery.trim()}"
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>

            <Button
              size="lg"
              disabled={!hasContent || overLimit || submitting}
              loading={submitting}
              onClick={handleSubmit}
              iconLeft={<Sparkle size={18} weight="fill" />}
              className="w-full sm:ml-auto sm:w-auto"
            >
              {docLabels.length > 1 ? `Check ${docLabels.length} documents` : "Check for plagiarism"}
            </Button>
          </div>
        </div>

        {/* Sidebar */}
        <div className="flex flex-col gap-5">
          <div className="rounded-[var(--radius-card-lg)] border border-line bg-white p-5">
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

          <div className="rounded-[var(--radius-card-lg)] border border-line bg-white p-5">
            <div className="flex items-center justify-between">
              <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-500">
                <ClockCounterClockwise size={14} />
                Recent checks
              </p>
              <button onClick={() => navigate("/history")} className="text-xs font-semibold text-brand-600 hover:underline">
                View all
              </button>
            </div>
            <div className="mt-3 flex flex-col gap-1">
              {history.slice(0, 4).map((h) => (
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
  );
}