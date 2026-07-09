import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CheckCircle, FileImage, GraduationCap, UploadSimple, X } from "@phosphor-icons/react";
import { Button } from "../../components/ui/Button";
import { useAppStore } from "../../lib/store";

export default function VerifyStudentPage() {
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingCheckoutItem = useAppStore((s) => s.pendingCheckoutItem);
  const completeStudentVerification = useAppStore((s) => s.completeStudentVerification);
  const pushToast = useAppStore((s) => s.pushToast);

  const [dragActive, setDragActive] = useState(false);
  const [file, setFile] = useState<{ name: string; previewUrl: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function pickFile(list: FileList | null) {
    const picked = list?.[0];
    if (!picked) return;
    setFile({ name: picked.name, previewUrl: URL.createObjectURL(picked) });
  }

  function submit() {
    if (!file) return;
    setSubmitting(true);
    setTimeout(() => {
      completeStudentVerification();
      pushToast({
        kind: "success",
        title: "Student status verified",
        description: "Demo mockup — uploads are approved automatically, no real review occurs.",
      });
      if (pendingCheckoutItem?.kind === "plan" && pendingCheckoutItem.plan === "student") {
        navigate("/checkout");
      } else {
        navigate("/account/plan");
      }
    }, 1200);
  }

  return (
    <div className="mx-auto max-w-xl px-5 py-14 sm:px-8">
      <div className="flex size-12 items-center justify-center rounded-full bg-brand-100 text-brand-600">
        <GraduationCap size={24} weight="fill" />
      </div>
      <h1 className="mt-4 text-h2 font-bold tracking-tight text-navy-900">Verify your student status</h1>
      <p className="mt-1.5 text-sm text-ink-500">
        Student Premium requires a quick one-time verification. Upload a photo of your student ID or
        an enrollment document to continue.
      </p>

      <div className="mt-8 rounded-[var(--radius-card-lg)] border border-line bg-white p-6 shadow-[var(--shadow-card)]">
        {file ? (
          <div className="flex items-center justify-between rounded-[var(--radius-card)] border border-line bg-surface-tint px-5 py-3.5">
            <div className="flex min-w-0 items-center gap-3">
              <img
                src={file.previewUrl}
                alt=""
                className="size-11 shrink-0 rounded-lg object-cover ring-1 ring-line"
              />
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-ink-900">{file.name}</p>
                <p className="text-xs text-ink-500">Ready to submit</p>
              </div>
            </div>
            <button
              onClick={() => setFile(null)}
              aria-label="Remove file"
              className="flex size-8 shrink-0 items-center justify-center rounded-full text-ink-400 hover:bg-white hover:text-severity-high"
            >
              <X size={16} />
            </button>
          </div>
        ) : (
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragActive(false);
              pickFile(e.dataTransfer.files);
            }}
            onClick={() => fileInputRef.current?.click()}
            className={`flex cursor-pointer flex-col items-center justify-center gap-3 rounded-[var(--radius-card)] border-2 border-dashed px-6 py-12 text-center transition-colors ${
              dragActive ? "border-brand-500 bg-brand-100/40" : "border-line hover:border-brand-300 hover:bg-surface-tint"
            }`}
          >
            <div className="flex size-14 items-center justify-center rounded-full bg-brand-100 text-brand-600">
              <UploadSimple size={26} weight="bold" />
            </div>
            <div>
              <p className="text-sm font-semibold text-ink-900">Drag & drop your document here</p>
              <p className="mt-1 text-xs text-ink-500">
                or <span className="font-semibold text-brand-600">browse files</span> on your computer
              </p>
            </div>
            <p className="flex items-center gap-1.5 text-[0.6875rem] text-ink-300">
              <FileImage size={13} /> JPG, PNG, or PDF of a student ID or enrollment letter
            </p>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,.pdf"
              className="hidden"
              onChange={(e) => {
                pickFile(e.target.files);
                e.target.value = "";
              }}
            />
          </div>
        )}

        <Button
          size="lg"
          fullWidth
          className="mt-6"
          disabled={!file}
          loading={submitting}
          iconLeft={<CheckCircle size={18} weight="fill" />}
          onClick={submit}
        >
          {submitting ? "Verifying..." : "Submit for verification"}
        </Button>
        <p className="mt-3 text-center text-[0.6875rem] text-ink-400">
          Demo mockup — any file is instantly approved, no document is reviewed or stored.
        </p>
      </div>
    </div>
  );
}
