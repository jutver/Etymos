import { describe, expect, it } from "vitest";
import { readDateSelection, withDateSelection } from "./dateSelection";

describe("date selection in the URL", () => {
  it("reads one day, a range, or all time", () => {
    expect(readDateSelection(new URLSearchParams("day=2026-11-07"))).toEqual({
      mode: "day",
      span: { start: "2026-11-07", end: "2026-11-07" },
    });
    expect(readDateSelection(new URLSearchParams("from=2026-11-10&to=2026-11-01"))).toEqual({
      mode: "range",
      span: { start: "2026-11-01", end: "2026-11-10" },
    });
    expect(readDateSelection(new URLSearchParams("day=yesterday"))).toEqual({ mode: "all", span: null });
  });

  it("keeps the other params when writing", () => {
    const next = withDateSelection(new URLSearchParams("filter=all&day=2026-11-07"), {
      mode: "range",
      span: { start: "2026-11-01", end: "2026-11-07" },
    });
    expect(next.toString()).toBe("filter=all&from=2026-11-01&to=2026-11-07");
    expect(withDateSelection(next, { mode: "all", span: null }).toString()).toBe("filter=all");
  });
});
