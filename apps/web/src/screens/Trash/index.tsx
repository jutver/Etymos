import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowCounterClockwise, Trash } from "@phosphor-icons/react";
import { useAppStore } from "../../lib/store";
import { formatDate } from "@etymos/shared";
import { StatusPill } from "../../components/Severity";
import { Button } from "../../components/ui/Button";

export default function TrashPage() {
  const navigate = useNavigate();
  const trash = useAppStore((s) => s.trash);
  const restoreFromTrash = useAppStore((s) => s.restoreFromTrash);
  const permanentlyDeleteTrash = useAppStore((s) => s.permanentlyDeleteTrash);
  const pushToast = useAppStore((s) => s.pushToast);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  function restore(id: string) {
    restoreFromTrash(id);
    pushToast({ kind: "success", title: "Document restored", description: "It's back in your History." });
  }

  function deleteForever(id: string) {
    permanentlyDeleteTrash(id);
    setConfirmId(null);
    pushToast({ kind: "info", title: "Document permanently deleted" });
  }

  return (
    <div className="mx-auto max-w-7xl px-5 py-10 sm:px-8">
      <div>
        <h1 className="text-h1 font-bold tracking-tight text-navy-900">My Trash</h1>
        <p className="mt-1.5 text-sm text-ink-500">
          Documents deleted from History land here. Restore them or delete them permanently.
        </p>
      </div>

      <div className="mt-6 rounded-[var(--radius-card-lg)] border border-line bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs font-semibold uppercase tracking-wide text-ink-400">
              <th className="px-5 py-3 font-semibold">Document</th>
              <th className="px-5 py-3 font-semibold">Date</th>
              <th className="px-5 py-3 font-semibold">Similarity</th>
              <th className="px-5 py-3 font-semibold">Status</th>
              <th className="px-5 py-3 font-semibold">Project</th>
              <th className="px-5 py-3 font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody>
            {trash.map((h) => (
              <tr key={h.id} className="border-b border-line last:border-0 hover:bg-surface-tint">
                <td className="max-w-xs truncate px-5 py-4 font-medium text-ink-900">
                  <button onClick={() => navigate(`/report/${h.id}`)} className="flex items-center gap-2 hover:underline">
                    {h.title}
                  </button>
                </td>
                <td className="whitespace-nowrap px-5 py-4 text-ink-500">{formatDate(h.date)}</td>
                <td className="px-5 py-4 font-semibold text-ink-700">{h.similarityScore}%</td>
                <td className="px-5 py-4">
                  <StatusPill status={h.status} />
                </td>
                <td className="px-5 py-4 text-ink-500">{h.project ?? "—"}</td>
                <td className="px-5 py-4">
                  {confirmId === h.id ? (
                    <div className="flex items-center gap-2">
                      <Button size="sm" variant="danger" onClick={() => deleteForever(h.id)}>
                        Confirm
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirmId(null)}>
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        iconLeft={<ArrowCounterClockwise size={14} />}
                        onClick={() => restore(h.id)}
                      >
                        Restore
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        iconLeft={<Trash size={14} />}
                        className="text-severity-high hover:bg-severity-high-bg"
                        onClick={() => setConfirmId(h.id)}
                      >
                        Delete forever
                      </Button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {trash.length === 0 && (
              <tr>
                <td colSpan={6} className="px-5 py-12 text-center text-sm text-ink-400">
                  Trash is empty.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
