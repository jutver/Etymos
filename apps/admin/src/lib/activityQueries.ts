// Activity dashboard data. All aggregation happens in SQL
// (`admin_activity_summary`, supabase/migrations/20260727000000_*) so this
// scales with the event table instead of pulling rows into the browser the
// way the main Dashboard's client-side aggregation does.
import { supabase } from "@etymos/shared";
import type { DateRange } from "./dashboardQueries";
import { tr } from "./i18n";

export interface ActivityDailyPoint {
  date: string;
  users: number;
  sessions: number;
}

export interface ActivityFunnelStep {
  step: string;
  count: number;
}

export interface ActivityFeatureUsage {
  event: string;
  events: number;
  users: number;
}

export interface ActivityPage {
  path: string;
  views: number;
}

export interface ActivitySummary {
  events_total: number;
  sessions: number;
  active_users: number;
  returning_users: number;
  dau: number;
  wau: number;
  mau: number;
  /** Average daily actives over the last 30 days / MAU, 0..1. */
  stickiness: number;
  avg_session_minutes: number;
  series: ActivityDailyPoint[];
  funnel: ActivityFunnelStep[];
  features: ActivityFeatureUsage[];
  top_pages: ActivityPage[];
}

/** Thrown when the RPC/table doesn't exist yet, i.e. the migration hasn't been applied. */
export class ActivityNotSetUpError extends Error {
  constructor() {
    super(
      tr("Activity tracking isn't set up on this database yet. Run supabase/migrations/20260727000000_user_events_and_activity_summary.sql in the Supabase SQL Editor."),
    );
    this.name = "ActivityNotSetUpError";
  }
}

export async function fetchActivitySummary(range: DateRange): Promise<ActivitySummary> {
  const { data, error } = await supabase.rpc("admin_activity_summary", {
    p_start: range.start,
    p_end: range.end,
  });
  if (error) {
    // PGRST202 = function not found in PostgREST's schema cache; 42883 = undefined_function.
    if (error.code === "PGRST202" || error.code === "42883") throw new ActivityNotSetUpError();
    throw error;
  }
  return data as ActivitySummary;
}
