import { describe, expect, it } from "vitest";
import type { DocumentVersionHistory, HistoryEntryWithCheck } from "../../lib/documentsQueries";
import { buildHistoryRows } from "./historyRows";

function entry(id: string, startedAt: string, score = 40): HistoryEntryWithCheck {
  return {
    id,
    title: "paper.pdf",
    fileName: "paper.pdf",
    date: startedAt.slice(0, 10),
    similarityScore: score,
    status: "moderate",
    wordCount: 100,
    checkState: "completed",
    startedAt,
  };
}

function version(id: string, documentId: string, createdAt: string, score: number | null = null) {
  return { id, documentId, label: id, createdAt, score };
}

describe("buildHistoryRows", () => {
  it("lists a document's saved versions with its check, newest first", () => {
    const doc = entry("d1", "2026-10-20T08:00:00Z");
    const histories = new Map<string, DocumentVersionHistory>([
      [
        "d1",
        {
          versions: [version("v2", "d1", "2026-10-22T08:00:00Z"), version("v1", "d1", "2026-10-21T08:00:00Z")],
          uploadScore: null,
          rechecked: false,
        },
      ],
    ]);
    const rows = buildHistoryRows([doc], histories);
    expect(rows.map((r) => r.key)).toEqual(["version-v2", "version-v1", "check-d1"]);
    // Only saved: no score. The upload's check keeps its score.
    expect(rows.map((r) => r.score)).toEqual([null, null, 40]);
  });

  it("scores a re-checked version, and the upload by its own check", () => {
    // After a re-check the document's score (12) is the re-check's.
    const doc = entry("d1", "2026-10-20T08:00:00Z", 12);
    const histories = new Map<string, DocumentVersionHistory>([
      ["d1", { versions: [version("v1", "d1", "2026-10-21T08:00:00Z", 12)], uploadScore: 40, rechecked: true }],
    ]);
    const rows = buildHistoryRows([doc], histories);
    expect(rows.map((r) => [r.key, r.score])).toEqual([
      ["version-v1", 12],
      ["check-d1", 40],
    ]);
  });

  it("interleaves the versions of several uploads of one file by time", () => {
    const older = entry("d1", "2026-10-01T08:00:00Z");
    const newer = entry("d2", "2026-10-10T08:00:00Z");
    const histories = new Map<string, DocumentVersionHistory>([
      ["d1", { versions: [version("late-edit", "d1", "2026-10-15T08:00:00Z")], uploadScore: null, rechecked: false }],
    ]);
    expect(buildHistoryRows([newer, older], histories).map((r) => r.key)).toEqual([
      "version-late-edit",
      "check-d2",
      "check-d1",
    ]);
  });

  it("shows no score for a check that hasn't finished", () => {
    const checking = { ...entry("d1", "2026-10-20T08:00:00Z"), checkState: "checking" as const };
    expect(buildHistoryRows([checking], new Map())[0]?.score).toBeNull();
  });
});
