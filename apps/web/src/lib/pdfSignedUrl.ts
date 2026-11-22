export const PDF_SIGNED_URL_TTL_SECONDS = 3600;
export const PDF_SIGNED_URL_REFRESH_BUFFER_MS = 60_000;

export function computeSignedUrlExpiresAt(
  nowMs = Date.now(),
  ttlSeconds = PDF_SIGNED_URL_TTL_SECONDS,
): number {
  return nowMs + ttlSeconds * 1000;
}

export function isSignedUrlStale(
  expiresAtMs: number | null,
  nowMs = Date.now(),
  bufferMs = PDF_SIGNED_URL_REFRESH_BUFFER_MS,
): boolean {
  if (expiresAtMs === null) return true;
  return nowMs >= expiresAtMs - bufferMs;
}
