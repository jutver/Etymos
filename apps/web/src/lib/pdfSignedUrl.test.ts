import { describe, expect, it } from "vitest";
import {
  PDF_SIGNED_URL_REFRESH_BUFFER_MS,
  PDF_SIGNED_URL_TTL_SECONDS,
  computeSignedUrlExpiresAt,
  isSignedUrlStale,
} from "./pdfSignedUrl";

describe("pdfSignedUrl", () => {
  it("computes expiry timestamp from TTL seconds", () => {
    const now = 1_700_000_000_000;
    expect(computeSignedUrlExpiresAt(now)).toBe(now + PDF_SIGNED_URL_TTL_SECONDS * 1000);
    expect(computeSignedUrlExpiresAt(now, 300)).toBe(now + 300_000);
  });

  it("treats null expiry as stale", () => {
    expect(isSignedUrlStale(null, 1_700_000_000_000)).toBe(true);
  });

  it("treats fresh URLs outside the refresh buffer as valid", () => {
    const issuedAt = 1_700_000_000_000;
    const expiresAt = computeSignedUrlExpiresAt(issuedAt);
    expect(isSignedUrlStale(expiresAt, issuedAt)).toBe(false);
    expect(isSignedUrlStale(expiresAt, expiresAt - PDF_SIGNED_URL_REFRESH_BUFFER_MS - 1)).toBe(false);
  });

  it("treats URLs inside the pre-expiry buffer or past expiry as stale", () => {
    const issuedAt = 1_700_000_000_000;
    const expiresAt = computeSignedUrlExpiresAt(issuedAt);
    expect(isSignedUrlStale(expiresAt, expiresAt - PDF_SIGNED_URL_REFRESH_BUFFER_MS)).toBe(true);
    expect(isSignedUrlStale(expiresAt, expiresAt + 5_000)).toBe(true);
  });
});
