// The user panel's third column: every recorded action on the account,
// newest first, filterable by category. See lib/activityLogQueries.ts.
import { useEffect, useState } from "react";
import {
  ChatCircleText,
  Coins,
  Crown,
  FileText,
  GraduationCap,
  type Icon,
  ListBullets,
  LockKey,
  ShoppingCart,
  UserCircle,
} from "@phosphor-icons/react";
import { cn } from "@etymos/shared";
import { ListItemsSkeleton } from "../../components/Skeleton";
import { StatusBadge } from "../../components/StatusBadge";
import {
  ACTIVITY_CATEGORIES,
  ACTIVITY_PAGE_SIZE,
  describeActivity,
  listUserActivity,
  type ActivityCategory,
  type ActivityLogEntry,
} from "../../lib/activityLogQueries";
import { friendlyError } from "../../lib/errors";
import { currentLocale, t, tr } from "../../lib/i18n";

const CATEGORY_ICONS: Record<ActivityCategory, Icon> = {
  account: UserCircle,
  plan: Crown,
  credits: Coins,
  purchase: ShoppingCart,
  document: FileText,
  security: LockKey,
  verification: GraduationCap,
  support: ChatCircleText,
};

export function UserActivityLog({
  userId,
  adminId,
  refreshKey,
}: {
  userId: string;
  adminId: string | undefined;
  /** Bumped by the panel after an admin action, to reload the first page. */
  refreshKey: number;
}) {
  const [category, setCategory] = useState<ActivityCategory | null>(null);
  const [entries, setEntries] = useState<ActivityLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listUserActivity(userId, { category })
      .then((rows) => {
        if (cancelled) return;
        setEntries(rows);
        setHasMore(rows.length === ACTIVITY_PAGE_SIZE);
      })
      .catch((err: unknown) => !cancelled && setError(friendlyError(err)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [userId, category, refreshKey]);

  async function loadMore() {
    setLoadingMore(true);
    try {
      const rows = await listUserActivity(userId, { category, offset: entries.length });
      setEntries((prev) => [...prev, ...rows]);
      setHasMore(rows.length === ACTIVITY_PAGE_SIZE);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="space-y-4 rounded-card border border-border bg-surface p-6 shadow-card">
      <div className="flex items-center gap-2">
        <ListBullets size={18} weight="bold" className="text-fg-muted" />
        <h2 className="text-h2 font-semibold text-fg">{t("User activities log")}</h2>
      </div>
      <p className="text-caption text-fg-muted">
        {t("Everything that happened on this account — sign-ins, plan and credit changes, purchases, documents, recovery email and support — recorded by the database as it happens.")}
      </p>

      <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("Filter by category")}>
        {[{ id: null, label: tr("All") }, ...ACTIVITY_CATEGORIES].map((c) => (
          <button
            key={c.id ?? "all"}
            type="button"
            onClick={() => setCategory(c.id)}
            aria-pressed={category === c.id}
            className={cn(
              "cursor-pointer rounded-full border px-2.5 py-1 text-caption font-medium transition active:scale-95",
              category === c.id
                ? "border-accent/40 bg-accent-bg text-accent"
                : "border-border text-fg-muted hover:bg-surface-raised",
            )}
          >
            {t(c.label)}
          </button>
        ))}
      </div>

      {loading ? (
        <ListItemsSkeleton count={5} />
      ) : error && entries.length === 0 ? (
        <p className="text-caption text-destructive">{t(error)}</p>
      ) : entries.length === 0 ? (
        <p className="text-body text-fg-muted">{t("No activity recorded for this user yet.")}</p>
      ) : (
        <>
          <ul className="max-h-[70vh] space-y-2 overflow-y-auto pr-1">
            {entries.map((entry) => {
              const { title, detail } = describeActivity(entry);
              const CategoryIcon = CATEGORY_ICONS[entry.category] ?? ListBullets;
              return (
                <li key={entry.id} className="flex gap-3 rounded-control border border-border bg-surface-muted p-3">
                  <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-raised text-fg-muted">
                    <CategoryIcon size={15} weight="bold" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-3">
                      <span className="text-body font-medium text-fg">{title}</span>
                      <span className="shrink-0 text-caption text-fg-muted">
                        {new Date(entry.created_at).toLocaleString(currentLocale())}
                      </span>
                    </div>
                    {detail && <p className="mt-0.5 break-words text-caption text-fg-muted">{detail}</p>}
                    {(entry.actor_kind !== "user" || entry.metadata?.backfilled === true) && (
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {entry.actor_kind === "admin" && (
                          <StatusBadge
                            label={entry.actor_id === adminId ? tr("By you") : tr("By an admin")}
                            tone="accent"
                            capitalize={false}
                          />
                        )}
                        {entry.actor_kind === "system" && <StatusBadge label={tr("System")} tone="neutral" />}
                        {entry.metadata?.backfilled === true && (
                          <StatusBadge label={tr("From earlier records")} tone="info" capitalize={false} />
                        )}
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          {error && <p className="text-caption text-destructive">{t(error)}</p>}
          {hasMore && (
            <button
              type="button"
              onClick={loadMore}
              disabled={loadingMore}
              className="w-full cursor-pointer rounded-control border border-border px-3.5 py-2 text-caption font-semibold text-fg-muted transition hover:bg-surface-raised active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loadingMore ? t("Loading…") : t("Load more")}
            </button>
          )}
        </>
      )}
    </div>
  );
}
