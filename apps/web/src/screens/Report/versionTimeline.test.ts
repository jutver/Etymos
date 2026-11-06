import { describe, expect, it } from "vitest";
import { buildTimeline } from "./versionTimeline";
import type { DocumentVersion, VersionCheck } from "./VersionHistoryMenu";

function check(score: number, previousScore: number | null, extra: Partial<VersionCheck> = {}): VersionCheck {
  return { id: `c${score}`, paid: false, score, previousScore, aiScore: null, previousAiScore: null, ...extra };
}

function version(id: string, createdAt: string, c?: VersionCheck): DocumentVersion {
  return { id, label: id, savedAt: "", createdAt, wordCount: 100, html: `<p>${id}</p>`, changedRatio: 0.1, check: c };
}

const upload: DocumentVersion = {
  id: "upload-x",
  label: "Original upload",
  savedAt: "",
  createdAt: "2026-11-02T10:00:00Z",
  wordCount: 100,
  html: "",
  check: check(32, null, { aiScore: 41 }),
};

describe("buildTimeline", () => {
  it("orders the upload, drafts and re-checks oldest first", () => {
    const versions = [
      version("v3", "2026-11-03T12:00:00Z", check(14, 20, { paid: true })),
      version("v2", "2026-11-03T11:00:00Z"),
      version("v1", "2026-11-03T10:00:00Z", check(20, 32)),
    ];
    const { points } = buildTimeline({ versions, original: upload, uploadedAt: "2026-11-01" });
    expect(points.map((p) => [p.id, p.kind])).toEqual([
      ["upload-x", "upload"],
      ["v1", "free_recheck"],
      ["v2", "draft"],
      ["v3", "paid_recheck"],
    ]);
    expect(points[0].at).toBe("2026-11-01");
    expect(points[2].similarity).toBeNull();
  });

  it("summarises first, latest, best and counts", () => {
    const versions = [
      version("v3", "2026-11-03T12:00:00Z", check(18, 14)),
      version("v2", "2026-11-03T11:00:00Z", check(14, 20)),
      version("v1", "2026-11-03T10:00:00Z"),
    ];
    const { summary } = buildTimeline({ versions, original: upload });
    expect(summary).toMatchObject({ checks: 3, drafts: 1, first: 32, latest: 18, delta: -14 });
    expect(summary?.best.id).toBe("v2");
  });

  it("falls back to the first re-check's before score for the upload", () => {
    const versions = [version("v1", "2026-11-03T10:00:00Z", check(20, 35, { previousAiScore: 50, aiScore: 30 }))];
    const { points, summary } = buildTimeline({ versions, uploadedAt: "2026-11-01" });
    expect(points[0]).toMatchObject({ kind: "upload", similarity: 35, ai: 50, version: null });
    expect(summary).toMatchObject({ first: 35, latest: 20, aiFirst: 50, aiLatest: 30, aiDelta: -20 });
  });

  it("has no summary with a single check", () => {
    const { points, summary } = buildTimeline({ versions: [version("v1", "2026-11-03T10:00:00Z")], original: upload });
    expect(points).toHaveLength(2);
    expect(summary).toBeNull();
  });

  it("leaves AI out of the summary when it ran fewer than twice", () => {
    const versions = [version("v1", "2026-11-03T10:00:00Z", check(20, 32))];
    const { summary } = buildTimeline({ versions, original: upload });
    expect(summary?.aiDelta).toBeNull();
  });
});
