// Documents tab of a user's page: totals across the account, then every
// document with its scores. A row opens the document's moderation page.
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { cn } from "@etymos/shared";
import { DataTable, type Column } from "../../components/DataTable";
import { StatusBadge, docStatusTone, moderationTone } from "../../components/StatusBadge";
import {
  listUserDocuments,
  summarizeUserDocuments,
  type UserDocument,
} from "../../lib/userDocumentsQueries";
import { friendlyError } from "../../lib/errors";
import { currentLocale, t, tr } from "../../lib/i18n";
import { useUserDetail } from "./userDetailContext";

const PAGE_SIZE = 25;

type Sort = "newest" | "similarity";

const LANGUAGE_NAMES: Record<string, string> = {
  vi: tr("Vietnamese"),
  en: tr("English"),
  fr: tr("French"),
  ja: tr("Japanese"),
};

function percent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)}%`;
}

function SummaryBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-control border border-border bg-surface px-3.5 py-2.5 shadow-card">
      <p className="text-caption text-fg-muted">{label}</p>
      <p className="mt-0.5 text-h2 font-semibold tabular-nums text-fg">{value}</p>
    </div>
  );
}

function Toggle({ on, onClick, children }: { on: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        "rounded-control px-3 py-1.5 text-caption font-medium transition-colors",
        on ? "bg-accent-bg text-accent" : "border border-border text-fg-muted hover:bg-surface-raised hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}

export default function DocumentsTab() {
  const { profile } = useUserDetail();
  const navigate = useNavigate();
  const [docs, setDocs] = useState<UserDocument[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hideTrashed, setHideTrashed] = useState(false);
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [sort, setSort] = useState<Sort>("newest");
  const [page, setPage] = useState(0);

  useEffect(() => {
    let cancelled = false;
    listUserDocuments(profile.id)
      .then((rows) => !cancelled && setDocs(rows))
      .catch((err: unknown) => !cancelled && setError(friendlyError(err)));
    return () => {
      cancelled = true;
    };
  }, [profile.id]);

  const summary = useMemo(() => summarizeUserDocuments(docs ?? []), [docs]);

  const shown = useMemo(() => {
    const list = (docs ?? []).filter(
      (d) => (!hideTrashed || !d.is_trashed) && (!flaggedOnly || d.moderation_status === "flagged"),
    );
    if (sort === "similarity") {
      list.sort((a, b) => (b.similarity_score ?? -1) - (a.similarity_score ?? -1));
    }
    return list;
  }, [docs, hideTrashed, flaggedOnly, sort]);

  // A filter change can leave the page past the end.
  const pageCount = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const rows = shown.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  const columns: Column<UserDocument>[] = [
    {
      key: "title",
      label: tr("Document"),
      render: (d) => (
        <span className="flex min-w-0 items-center gap-2">
          <span className="max-w-[320px] truncate">{d.title || d.file_name || d.id}</span>
          {d.is_trashed && <StatusBadge label={t("In trash")} tone="neutral" capitalize={false} />}
        </span>
      ),
    },
    {
      key: "similarity",
      label: tr("Similarity"),
      render: (d) =>
        d.status ? (
          <span className="inline-flex items-center gap-2">
            <span className="tabular-nums">{percent(d.similarity_score)}</span>
            <StatusBadge label={d.status} tone={docStatusTone(d.status)} />
          </span>
        ) : (
          "—"
        ),
    },
    { key: "ai", label: tr("AI writing"), render: (d) => <span className="tabular-nums">{percent(d.ai_score)}</span> },
    { key: "rechecks", label: tr("Re-checks"), render: (d) => <span className="tabular-nums">{d.rechecks}</span> },
    {
      key: "words",
      label: tr("Words"),
      render: (d) => (d.word_count === null ? "—" : <span className="tabular-nums">{d.word_count.toLocaleString(currentLocale())}</span>),
    },
    {
      key: "language",
      label: tr("Language"),
      render: (d) => (d.language ? t(LANGUAGE_NAMES[d.language] ?? d.language) : "—"),
    },
    {
      key: "moderation",
      label: tr("Moderation"),
      render: (d) => <StatusBadge label={d.moderation_status} tone={moderationTone(d.moderation_status)} />,
    },
    { key: "uploaded", label: tr("Uploaded"), render: (d) => new Date(d.uploaded_at).toLocaleDateString(currentLocale()) },
  ];

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        <SummaryBox label={t("Documents")} value={docs ? summary.total.toLocaleString(currentLocale()) : "…"} />
        <SummaryBox label={t("Average similarity")} value={docs ? percent(summary.averageSimilarity) : "…"} />
        <SummaryBox label={t("Highest similarity")} value={docs ? percent(summary.highestSimilarity) : "…"} />
        <SummaryBox label={t("Checks run")} value={docs ? summary.checks.toLocaleString(currentLocale()) : "…"} />
        <SummaryBox label={t("Flagged")} value={docs ? summary.flagged.toLocaleString(currentLocale()) : "…"} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Toggle
          on={hideTrashed}
          onClick={() => {
            setHideTrashed((v) => !v);
            setPage(0);
          }}
        >
          {t("Hide trashed")}
        </Toggle>
        <Toggle
          on={flaggedOnly}
          onClick={() => {
            setFlaggedOnly((v) => !v);
            setPage(0);
          }}
        >
          {t("Flagged only")}
        </Toggle>
        <label className="ml-auto flex items-center gap-1.5 text-caption text-fg-muted">
          {t("Sort")}
          <select
            value={sort}
            onChange={(e) => {
              setSort(e.target.value as Sort);
              setPage(0);
            }}
            className="cursor-pointer rounded-control border border-border bg-surface-muted px-2.5 py-2 text-caption text-fg outline-none focus-visible:border-accent"
          >
            <option value="newest">{t("Newest first")}</option>
            <option value="similarity">{t("Highest similarity")}</option>
          </select>
        </label>
      </div>

      {error && <p className="text-caption text-destructive">{error}</p>}

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(d) => d.id}
        loading={docs === null && !error}
        emptyMessage={docs?.length ? t("No documents match these filters.") : t("This user has no documents yet.")}
        onRowClick={(d) => navigate(`/moderation/${d.id}`)}
        page={safePage}
        pageCount={pageCount}
        onPageChange={setPage}
      />
    </div>
  );
}
