import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  CaretDown,
  ClockCounterClockwise,
  FileText,
  GraduationCap,
  Globe,
  Sparkle,
  UploadSimple,
  X,
} from "@phosphor-icons/react";
import { Button } from "../../components/ui/Button";
import { Toggle } from "../../components/ui/Toggle";
import { UsageMeter } from "../../components/UsageMeter";
import { StatusPill } from "../../components/Severity";
import { useAppStore, planLabel } from "../../lib/store";
import { formatDate } from "../../lib/format";
import { cn } from "../../lib/cn";
import type { Language } from "../../lib/types";

const languages: { id: Language; label: string }[] = [
  { id: "vi", label: "Tiếng Việt" },
  { id: "en", label: "English" },
  { id: "fr", label: "Français" },
  { id: "ja", label: "日本語" },
];

export default function UploadPage() {
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const plan = useAppStore((s) => s.plan);
  const history = useAppStore((s) => s.history);
  const requestCheck = useAppStore((s) => s.requestCheck);
  const remaining = useAppStore((s) => s.remaining());

  const [tab, setTab] = useState<"file" | "paste">("file");
  const [dragActive, setDragActive] = useState(false);
  const [file, setFile] = useState<{ name: string; size: number } | null>(null);
  const [pastedText, setPastedText] = useState("");
  const [webSources, setWebSources] = useState(true);
  const [academicSources, setAcademicSources] = useState(true);
  const [language, setLanguage] = useState<Language>("vi");
  const [langOpen, setLangOpen] = useState(false);

  const wordCount = pastedText.trim() ? pastedText.trim().split(/\s+/).length : 0;
  const wordLimit = plan === "free" ? 3000 : null;
  const overLimit = wordLimit !== null && wordCount > wordLimit;

  const hasContent = tab === "file" ? file !== null : pastedText.trim().length > 0;
  const docLabel = tab === "file" ? file?.name ?? "" : "Pasted text";

  function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const f = files[0];
    setFile({ name: f.name, size: f.size });
  }

  function loadSample() {
    setPastedText(
      "Đồng bằng sông Cửu Long là vựa lúa lớn nhất của Việt Nam, đóng góp hơn 50% sản lượng lúa gạo và gần 70% sản lượng thủy sản xuất khẩu của cả nước. Tuy nhiên, trong hai thập kỷ gần đây, khu vực này đang phải đối mặt với những thách thức nghiêm trọng từ biến đổi khí hậu, bao gồm xâm nhập mặn, sụt lún đất và nước biển dâng...",
    );
  }

  function handleSubmit() {
    if (!hasContent || overLimit) return;
    const allowed = requestCheck(docLabel || "Untitled document");
    if (allowed) {
      navigate("/analyzing", {
        state: { docLabel: docLabel || "Untitled document", webSources, academicSources, language },
      });
    } else {
      navigate("/paywall");
    }
  }

  return (
    <div className="mx-auto max-w-7xl px-5 py-10 sm:px-8">
      <div className="flex flex-col gap-1.5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-h1 font-bold tracking-tight text-navy-900">Check a new document</h1>
          <p className="mt-1.5 text-body text-ink-600">
            Upload a file or paste your text. We'll scan the web, academic papers, and check for
            AI-generated content.
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
              Upload file
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
              {!file ? (
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
                    "flex cursor-pointer flex-col items-center justify-center gap-3 rounded-[var(--radius-card)] border-2 border-dashed px-6 py-16 text-center transition-colors",
                    dragActive ? "border-brand-500 bg-brand-100/40" : "border-line hover:border-brand-300 hover:bg-surface-tint",
                  )}
                >
                  <div className="flex size-14 items-center justify-center rounded-full bg-brand-100 text-brand-600">
                    <UploadSimple size={26} weight="bold" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-ink-900">
                      Drag & drop your file here
                    </p>
                    <p className="mt-1 text-xs text-ink-500">
                      or <span className="font-semibold text-brand-600">browse files</span> on your
                      computer
                    </p>
                  </div>
                  <p className="text-[0.6875rem] text-ink-300">
                    PDF, DOC, DOCX or TXT
                    {plan === "free" ? " · up to 3,000 words on Free" : " · unlimited words"}
                  </p>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".pdf,.doc,.docx,.txt"
                    className="hidden"
                    onChange={(e) => handleFiles(e.target.files)}
                  />
                </div>
              ) : (
                <div className="flex items-center justify-between rounded-[var(--radius-card)] border border-line bg-surface-tint px-5 py-4">
                  <div className="flex items-center gap-3">
                    <div className="flex size-11 items-center justify-center rounded-lg bg-brand-100 text-brand-600">
                      <FileText size={22} weight="bold" />
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-ink-900">{file.name}</p>
                      <p className="text-xs text-ink-500">{(file.size / 1024).toFixed(0)} KB</p>
                    </div>
                  </div>
                  <button
                    onClick={() => setFile(null)}
                    aria-label="Remove file"
                    className="flex size-8 items-center justify-center rounded-full text-ink-400 hover:bg-white hover:text-severity-high"
                  >
                    <X size={18} />
                  </button>
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
                <button
                  onClick={loadSample}
                  className="text-xs font-semibold text-brand-600 hover:underline"
                >
                  Load sample text
                </button>
                <p className={cn("text-xs", overLimit ? "font-semibold text-severity-high" : "text-ink-400")}>
                  {wordCount.toLocaleString()} words{wordLimit ? ` / ${wordLimit.toLocaleString()} limit` : ""}
                </p>
              </div>
              {overLimit && (
                <p className="mt-2 rounded-lg bg-severity-high-bg px-3 py-2 text-xs font-medium text-severity-high">
                  This exceeds the Free plan's 3,000-word limit. Upgrade to Student Premium for
                  unlimited words.
                </p>
              )}
            </div>
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

          <div className="mt-5 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
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

            <Button
              size="lg"
              disabled={!hasContent || overLimit}
              onClick={handleSubmit}
              iconLeft={<Sparkle size={18} weight="fill" />}
              className="w-full sm:w-auto"
            >
              Check for plagiarism
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
              <button onClick={() => navigate("/dashboard")} className="text-xs font-semibold text-brand-600 hover:underline">
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

          {plan === "free" && (
            <div className="rounded-[var(--radius-card-lg)] border border-dashed border-line bg-surface-tint p-5 text-center">
              <p className="text-[0.625rem] font-bold uppercase tracking-wide text-ink-400">Advertisement</p>
              <p className="mt-2 text-sm font-semibold text-ink-700">
                Remove ads and unlock unlimited checks
              </p>
              <Button as="link" to="/pricing" size="sm" variant="outline" fullWidth className="mt-3">
                Go Premium
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
