
import { t } from "./i18n";// Thin client for the handful of admin actions that must go through the
// backend rather than a plain Supabase write — currently just force-delete
// (backend/api/app.py's `DELETE /api/admin/users/{id}`, which purges Storage
// objects and calls `client.auth.admin.delete_user`, neither of which a
// browser client can do directly). Mirrors apps/web/src/lib/api.ts's
// error-handling shape (ApiError carrying HTTP status, detail-first message
// extraction) so failures read the same way across both apps.
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:8000";

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function errorMessageFromResponse(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as { detail?: string };
    if (parsed.detail) return parsed.detail;
  } catch {
    // response wasn't JSON — fall back to raw text
  }
  return text || t("Request failed with {{status}}", { status: response.status });
}

/** Immediately and irreversibly deletes `targetUserId`'s account, no consent
 * dialog shown to them (CHANGES_I_WANT.md Admin Portal #3's "force delete").
 * `accessToken` must be the *admin's own* session token — the backend
 * derives the caller's admin privilege from it via `verify_supabase_jwt` +
 * `user.is_admin`, not from anything in this request body. */
export async function forceDeleteUser(targetUserId: string, accessToken: string): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/api/admin/users/${targetUserId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new ApiError(await errorMessageFromResponse(response), response.status);
  }
}
