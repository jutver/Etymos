// Announcements > Personal messages: every pop-up sent to a single user from
// their page, kept apart from the global announcements. Writing and editing
// happen on the user's Messages tab; this is the overview.
import { useCallback, useEffect, useMemo, useState } from "react";
import { MagnifyingGlass } from "@phosphor-icons/react";
import { cn } from "@etymos/shared";
import { ListItemsSkeleton } from "../../components/Skeleton";
import {
  MESSAGE_STATUS_LABELS,
  listPersonalMessages,
  personalMessageStatus,
  type PersonalMessage,
  type PersonalMessageStatus,
} from "../../lib/personalMessagesQueries";
import { friendlyError } from "../../lib/errors";
import { t, tr } from "../../lib/i18n";
import { PersonalMessageList } from "./PersonalMessageList";

const FILTERS: ["all" | PersonalMessageStatus, string][] = [
  ["all", tr("All")],
  ["showing", MESSAGE_STATUS_LABELS.showing],
  ["seen", MESSAGE_STATUS_LABELS.seen],
  ["scheduled", MESSAGE_STATUS_LABELS.scheduled],
  ["off", MESSAGE_STATUS_LABELS.off],
  ["ended", MESSAGE_STATUS_LABELS.ended],
];

export function PersonalMessages() {
  const [messages, setMessages] = useState<PersonalMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | PersonalMessageStatus>("all");

  const refresh = useCallback(() => {
    listPersonalMessages()
      .then(setMessages)
      .catch((err: unknown) => setError(friendlyError(err)));
  }, []);
  useEffect(() => refresh(), [refresh]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (messages ?? []).filter((m) => {
      if (filter !== "all" && personalMessageStatus(m) !== filter) return false;
      if (!q) return true;
      return [m.email, m.recipient?.display_name].some((s) => s?.toLowerCase().includes(q));
    });
  }, [messages, search, filter]);

  return (
    <div className="space-y-4">
      <p className="text-body text-fg-muted">
        {t("Pop-ups sent to one user from their page (Users > a user > Messages). Only that user sees each one.")}
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative max-w-sm flex-1 sm:min-w-[240px]">
          <MagnifyingGlass size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("Search by email or name…")}
            className="w-full rounded-control border border-border bg-surface-muted py-2 pl-9 pr-3 text-body text-fg outline-none focus-visible:border-accent"
          />
        </div>
        <div className="flex flex-wrap gap-1">
          {FILTERS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
              className={cn(
                "rounded-control px-3 py-1.5 text-caption font-medium transition-colors",
                filter === value ? "bg-accent-bg text-accent" : "text-fg-muted hover:bg-surface-raised hover:text-fg",
              )}
            >
              {t(label)}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="text-caption text-destructive">{error}</p>}

      {!messages ? (
        <div className="rounded-card border border-border bg-surface p-4 shadow-card">
          <ListItemsSkeleton count={4} />
        </div>
      ) : shown.length === 0 ? (
        <div className="rounded-card border border-border bg-surface p-6 text-body text-fg-subtle shadow-card">
          {messages.length === 0 ? t("No personal messages sent yet.") : t("No messages match.")}
        </div>
      ) : (
        <PersonalMessageList messages={shown} showRecipient onChanged={refresh} />
      )}
    </div>
  );
}
