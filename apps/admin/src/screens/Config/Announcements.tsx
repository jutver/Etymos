import { useEffect, useState } from "react";
import { StatusBadge } from "../../components/StatusBadge";
import { Switch } from "../../components/Switch";
import { useAdminAuth } from "../../lib/auth";
import { listAnnouncements, createAnnouncement, setAnnouncementActive } from "../../lib/configQueries";
import type { Announcement, AnnouncementSeverity } from "../../lib/types";
import { friendlyError } from "../../lib/errors";

const SEVERITIES: AnnouncementSeverity[] = ["info", "success", "warning", "error"];

const SEVERITY_TONE: Record<AnnouncementSeverity, "info" | "accent" | "warning" | "destructive"> = {
  info: "info",
  success: "accent",
  warning: "warning",
  error: "destructive",
};

export default function AnnouncementsPage() {
  const { user } = useAdminAuth();
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [severity, setSeverity] = useState<AnnouncementSeverity>("info");
  const [creating, setCreating] = useState(false);

  function refresh() {
    return listAnnouncements()
      .then(setAnnouncements)
      .catch((err: unknown) => setError(friendlyError(err)));
  }

  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, []);

  async function handleCreate() {
    if (!user || !message.trim()) return;
    setCreating(true);
    setError(null);
    try {
      await createAnnouncement({ message: message.trim(), severity }, user.id);
      setMessage("");
      await refresh();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setCreating(false);
    }
  }

  async function toggleActive(a: Announcement, isActive: boolean) {
    setAnnouncements((prev) => prev.map((x) => (x.id === a.id ? { ...x, is_active: isActive } : x)));
    try {
      await setAnnouncementActive(a.id, isActive);
    } catch (err) {
      setError(friendlyError(err));
      setAnnouncements((prev) => prev.map((x) => (x.id === a.id ? { ...x, is_active: !isActive } : x)));
    }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-card border border-border bg-surface p-5">
        <h2 className="text-h2 font-semibold text-fg">New announcement</h2>
        <div className="mt-3 space-y-3">
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={2}
            placeholder="Message shown to users…"
            className="w-full rounded-control border border-border bg-surface-muted px-3 py-2 text-body text-fg outline-none focus-visible:border-accent"
          />
          <div className="flex items-center gap-3">
            <select
              value={severity}
              onChange={(e) => setSeverity(e.target.value as AnnouncementSeverity)}
              className="rounded-control border border-border bg-surface-muted px-3 py-2 text-body text-fg outline-none focus-visible:border-accent"
            >
              {SEVERITIES.map((s) => (
                <option key={s} value={s} className="capitalize">
                  {s}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={creating || !message.trim()}
              onClick={handleCreate}
              className="cursor-pointer rounded-control bg-accent px-4 py-2 text-body font-semibold text-bg transition hover:opacity-90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {creating ? "Publishing…" : "Publish"}
            </button>
          </div>
        </div>
      </div>

      {error && <p className="text-caption text-destructive">{error}</p>}

      {loading ? (
        <p className="text-body text-fg-muted">Loading…</p>
      ) : announcements.length === 0 ? (
        <div className="rounded-card border border-border bg-surface p-6 text-body text-fg-subtle">
          No announcements yet.
        </div>
      ) : (
        <div className="divide-y divide-border rounded-card border border-border bg-surface">
          {announcements.map((a) => (
            <div key={a.id} className="flex items-center justify-between gap-4 px-5 py-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <StatusBadge label={a.severity} tone={SEVERITY_TONE[a.severity]} />
                  <span className="text-caption text-fg-subtle">
                    {new Date(a.created_at).toLocaleDateString()}
                  </span>
                </div>
                <p className="mt-1 truncate text-body text-fg">{a.message}</p>
              </div>
              <Switch checked={a.is_active} onChange={(v) => toggleActive(a, v)} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
