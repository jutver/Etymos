import { describe, expect, it } from "vitest";
import { POSTS } from "./posts";
import { ARTICLES } from "./articles";

describe("blog posts", () => {
  it("each post has a unique, URL-safe slug and a body in both languages", () => {
    expect(new Set(POSTS.map((p) => p.slug)).size).toBe(POSTS.length);
    for (const post of POSTS) {
      expect(post.slug, post.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(ARTICLES[post.slug]?.vi.length, post.slug).toBeGreaterThan(0);
      expect(ARTICLES[post.slug]?.en.length, post.slug).toBeGreaterThan(0);
    }
  });

  it("lists posts newest first, with valid dates", () => {
    for (const post of POSTS) expect(Number.isNaN(Date.parse(post.date)), post.slug).toBe(false);
    const dates = POSTS.map((p) => p.date);
    expect(dates).toEqual([...dates].sort().reverse());
  });
});
