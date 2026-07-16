// Supabase/Postgres errors are already human-worded (e.g. RLS violations,
// constraint failures) and useful to an admin debugging data issues, so those
// pass through unchanged. Only browser-level network failures — which surface
// as an opaque "TypeError: Failed to fetch" — get rewritten into something a
// user can act on.
export function friendlyError(err: unknown): string {
  if (err instanceof TypeError && /fetch/i.test(err.message)) {
    return "Couldn't reach the server. Check your connection and try again.";
  }
  if (err instanceof Error) {
    return err.message;
  }
  return "Something went wrong. Please try again.";
}
