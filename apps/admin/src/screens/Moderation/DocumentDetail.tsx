import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Flag, Trash, ArrowCounterClockwise } from "@phosphor-icons/react";
import { StatusBadge, moderationTone, docStatusTone } from "../../components/StatusBadge";
import { getDocument, setModerationStatus } from "../../lib/moderationQueries";
import { useAdminAuth } from "../../lib/auth";
import type { AdminDocument } from "../../lib/types";
import { friendlyError } from "../../lib/errors";
import { t, currentLocale } from "../../lib/i18n";

export default function DocumentDetailPage() {
  const { documentId } = useParams<{ documentId: string }>();
  const navigate = useNavigate();
  const { user } = useAdminAuth();
  const [doc, setDoc] = useState<AdminDocument | null>(null);
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  useEffect(() => {
    if (!documentId) return;
    let cancelled = false;
    setLoading(true);
    getDocument(documentId)
      .then((d) => {
        if (cancelled) return;
        setDoc(d);
        setNotes(d.moderation_notes ?? "");
      })
      .catch((err: unknown) => !cancelled && setError(friendlyError(err)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [documentId]);

  async function applyStatus(status: AdminDocument["moderation_status"]) {
    if (!documentId || !user) return;
    setSaving(true);
    setError(null);
    setConfirmingRemove(false);
    try {
      await setModerationStatus(documentId, status, notes, user.id);
      const refreshed = await getDocument(documentId);
      setDoc(refreshed);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <p className="text-body text-fg-muted">{t("Loading…")}</p>;
  }

  if (!doc) {
    return <p className="text-body text-destructive">{error ?? t("Document not found.")}</p>;
  }

  return (
    <div className="max-w-2xl">
      <button
        type="button"
        onClick={() => navigate("/moderation")}
        className="mb-4 flex cursor-pointer items-center gap-1.5 text-caption font-medium text-fg-muted transition-colors hover:text-fg"
      >
        <ArrowLeft size={14} weight="bold" />
        {t("Back to Moderation")}</button>

      <div className="flex items-center gap-3">
        <h1 className="text-h1 font-semibold text-fg">{doc.title ?? doc.file_name ?? doc.id}</h1>
        {doc.status && <StatusBadge label={doc.status} tone={docStatusTone(doc.status)} />}
        <StatusBadge label={doc.moderation_status} tone={moderationTone(doc.moderation_status)} />
      </div>
      <p className="mt-1 text-body text-fg-muted">
        {t("Owner:")}{" "}{doc.profiles?.email ?? doc.profiles?.display_name ?? doc.user_id} {" "}{t("· Uploaded")}{" "}
        {new Date(doc.uploaded_at).toLocaleDateString(currentLocale())}
        {doc.similarity_score != null ? t(" · {{similarity_score}}% similarity", { similarity_score: doc.similarity_score }) : ""}
      </p>

      <div className="mt-6 space-y-4 rounded-card border border-border bg-surface p-6">
        <h2 className="text-h2 font-semibold text-fg">{t("Moderation")}</h2>

        <div>
          <label className="mb-1.5 block text-caption font-medium text-fg-muted">{t("Notes")}</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            placeholder={t("Optional context for this moderation decision…")}
            className="w-full rounded-control border border-border bg-surface-muted px-3 py-2 text-body text-fg outline-none focus-visible:border-accent"
          />
        </div>

        {error && <p className="text-caption text-destructive">{error}</p>}

        <div className="flex flex-wrap gap-2">
          {doc.moderation_status !== "flagged" && (
            <button
              type="button"
              disabled={saving}
              onClick={() => applyStatus("flagged")}
              className="flex cursor-pointer items-center gap-1.5 rounded-control border border-warning/40 bg-warning-bg px-3.5 py-2 text-body font-medium text-warning transition hover:opacity-90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Flag size={16} weight="bold" />
              {t("Flag")}</button>
          )}

          {doc.moderation_status !== "none" && (
            <button
              type="button"
              disabled={saving}
              onClick={() => applyStatus("none")}
              className="flex cursor-pointer items-center gap-1.5 rounded-control border border-border px-3.5 py-2 text-body font-medium text-fg-muted transition-colors hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-60"
            >
              <ArrowCounterClockwise size={16} weight="bold" />
              {t("Clear")}</button>
          )}

          {doc.moderation_status !== "removed" && !confirmingRemove && (
            <button
              type="button"
              disabled={saving}
              onClick={() => setConfirmingRemove(true)}
              className="flex cursor-pointer items-center gap-1.5 rounded-control border border-destructive/40 bg-destructive-bg px-3.5 py-2 text-body font-medium text-destructive transition hover:opacity-90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Trash size={16} weight="bold" />
              {t("Remove")}</button>
          )}

          {confirmingRemove && (
            <div className="flex items-center gap-2 rounded-control border border-destructive/40 bg-destructive-bg px-3.5 py-2">
              <span className="text-body font-medium text-destructive">{t("Remove this document?")}</span>
              <button
                type="button"
                onClick={() => applyStatus("removed")}
                className="cursor-pointer text-body font-semibold text-destructive underline"
              >
                {t("Confirm")}</button>
              <button
                type="button"
                onClick={() => setConfirmingRemove(false)}
                className="cursor-pointer text-body text-fg-muted underline"
              >
                {t("Cancel")}</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
