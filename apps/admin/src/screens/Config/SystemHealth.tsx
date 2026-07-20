import { useEffect, useState } from "react";
import { CheckCircle, XCircle } from "@phosphor-icons/react";
import { supabase } from "@etymos/shared";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:8000";

interface HealthState {
  connectivityOk: boolean;
  latencyMs: number | null;
  backendOk: boolean;
  backendLatencyMs: number | null;
  backendDetail: string;
  checkedAt: string;
}

async function checkBackendHealth(): Promise<{ ok: boolean; latencyMs: number | null; detail: string }> {
  const start = performance.now();
  try {
    const response = await fetch(`${API_BASE_URL}/api/health`);
    const latencyMs = Math.round(performance.now() - start);
    if (!response.ok) {
      return { ok: false, latencyMs, detail: `Responded with HTTP ${response.status}` };
    }
    const body = (await response.json()) as { status?: string; service?: string };
    return { ok: body.status === "ok", latencyMs, detail: body.service ?? "Responding" };
  } catch {
    return { ok: false, latencyMs: null, detail: "Unreachable — check the backend deployment" };
  }
}

async function checkHealth(): Promise<HealthState> {
  const start = performance.now();
  const { error } = await supabase.from("plan_definitions").select("id").limit(1);
  const latencyMs = Math.round(performance.now() - start);

  const backend = await checkBackendHealth();

  return {
    connectivityOk: !error,
    latencyMs,
    backendOk: backend.ok,
    backendLatencyMs: backend.latencyMs,
    backendDetail: backend.detail,
    checkedAt: new Date().toISOString(),
  };
}

function Indicator({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return (
    <div className="flex items-center gap-3 rounded-card border border-border bg-surface p-5 shadow-card">
      {ok ? (
        <CheckCircle size={22} weight="fill" className="shrink-0 text-accent" />
      ) : (
        <XCircle size={22} weight="fill" className="shrink-0 text-destructive" />
      )}
      <div>
        <p className="text-body font-medium text-fg">{label}</p>
        <p className="text-caption text-fg-muted">{detail}</p>
      </div>
    </div>
  );
}

export default function SystemHealthPage() {
  const [health, setHealth] = useState<HealthState | null>(null);
  const [loading, setLoading] = useState(true);

  function refresh() {
    setLoading(true);
    checkHealth()
      .then(setHealth)
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    refresh();
  }, []);

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <p className="text-caption text-fg-subtle">
          {health ? `Checked ${new Date(health.checkedAt).toLocaleTimeString()}` : ""}
        </p>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="cursor-pointer rounded-control border border-border px-3.5 py-1.5 text-caption font-medium text-fg-muted transition hover:bg-surface-raised active:scale-95 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading ? "Checking…" : "Recheck"}
        </button>
      </div>

      {loading && !health ? (
        <p className="text-body text-fg-muted">Checking…</p>
      ) : (
        health && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Indicator
              ok={health.connectivityOk}
              label="Supabase connectivity"
              detail={
                health.connectivityOk
                  ? `Responding (${health.latencyMs}ms)`
                  : "Query failed — check RLS policies and credentials"
              }
            />
            <Indicator
              ok={health.backendOk}
              label="Backend API"
              detail={
                health.backendOk
                  ? `${health.backendDetail} (${health.backendLatencyMs}ms)`
                  : health.backendDetail
              }
            />
          </div>
        )
      )}
    </div>
  );
}
