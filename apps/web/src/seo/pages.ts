// The pages search engines should know about, in one place. Three things read
// this list:
//   - the build (vite.config.ts → seo/build.ts) writes a copy of index.html per
//     page with its own <title>/description/preview tags, plus sitemap.xml and
//     robots.txt, so crawlers and link previews (Zalo, Facebook) get the right
//     text without running any JavaScript;
//   - SeoManager keeps document.title and the meta tags right while the app runs
//     and the language changes;
//   - vercel.json must route each path to its file (checked by seo.test.ts).
//
// No app imports: vite.config.ts loads this file in Node before the app exists.
// (blog/posts.ts is plain data with no imports of its own, so it is safe.)
// Vietnamese is what the built HTML carries, because the audience searches in
// Vietnamese; English is used in the running app when the visitor picks it.

import { POSTS } from "../blog/posts.ts";

export const SITE_URL = "https://www.etymos.site";
export const SITE_NAME = "Etymos";
export const OG_IMAGE = "/og/etymos.jpg";
export const OG_IMAGE_WIDTH = 1200;
export const OG_IMAGE_HEIGHT = 600;

export interface PageText {
  title: string;
  description: string;
}

export interface PublicPage {
  path: string;
  vi: PageText;
  en: PageText;
  /** sitemap.xml <changefreq>. */
  changefreq: "weekly" | "monthly" | "yearly";
  /** sitemap.xml <priority>, 0–1. */
  priority: number;
}

export const PUBLIC_PAGES: PublicPage[] = [
  {
    path: "/",
    vi: {
      title: "Etymos - Kiểm tra đạo văn và nội dung AI cho Sinh viên Việt Nam",
      description:
        "Kiểm tra đạo văn và phát hiện nội dung do AI viết, tối ưu cho tiếng Việt. Giải thích rõ từng đoạn trùng lặp, chỉ ra nguồn và gợi ý viết lại theo văn phong học thuật. Giá phải chăng cho sinh viên.",
    },
    en: {
      title: "Etymos - Plagiarism and AI-content checker for Vietnamese Student",
      description:
        "Affordable, Vietnamese-optimized plagiarism and AI-content detection with explainable AI, matched sources and one-click academic rewriting.",
    },
    changefreq: "weekly",
    priority: 1,
  },
  {
    path: "/features",
    vi: {
      title: "Tính năng — Etymos",
      description:
        "Phát hiện đạo văn diễn ý, giải thích bằng AI, phát hiện nội dung do AI viết, nguồn trùng khớp, viết lại học thuật và kiểm tra lại từng bản nháp, tối ưu cho tiếng Việt.",
    },
    en: {
      title: "Features — Etymos",
      description:
        "Paraphrase detection, explainable AI, AI-writing detection, matched sources, academic rewriting and draft re-checks, built for Vietnamese.",
    },
    changefreq: "monthly",
    priority: 0.9,
  },
  {
    path: "/pricing",
    vi: {
      title: "Bảng giá — Etymos",
      description:
        "Các gói kiểm tra đạo văn và nội dung AI của Etymos: dùng miễn phí, gói Standard và Premium, ưu đãi cho sinh viên. Thanh toán qua MoMo, ZaloPay hoặc chuyển khoản.",
    },
    en: {
      title: "Pricing — Etymos",
      description:
        "Etymos plagiarism and AI-content checking plans: free to try, Standard and Premium, with student discounts. Pay with MoMo, ZaloPay or bank transfer.",
    },
    changefreq: "monthly",
    priority: 0.9,
  },
  {
    path: "/about",
    vi: {
      title: "Giới thiệu — Etymos",
      description:
        "Tầm nhìn và sứ mệnh của Etymos: kiểm tra đạo văn chính xác cho tiếng Việt, giải thích rõ ràng và có giá phù hợp với sinh viên, nhà nghiên cứu.",
    },
    en: {
      title: "About — Etymos",
      description:
        "Why Etymos exists: originality checking that's accurate for Vietnamese, clear enough to act on, and affordable for students and researchers.",
    },
    changefreq: "yearly",
    priority: 0.6,
  },
  {
    path: "/contact",
    vi: {
      title: "Liên hệ — Etymos",
      description: "Liên hệ đội ngũ Etymos để được hỗ trợ về tài khoản, thanh toán hoặc kết quả kiểm tra đạo văn.",
    },
    en: {
      title: "Contact — Etymos",
      description: "Get in touch with the Etymos team about your account, payments or a plagiarism check result.",
    },
    changefreq: "yearly",
    priority: 0.5,
  },
  {
    path: "/blog",
    vi: {
      title: "Blog — Etymos",
      description:
        "Hướng dẫn thực tế về đạo văn, cách diễn đạt lại và trích dẫn nguồn cho sinh viên, nhà nghiên cứu viết bằng tiếng Việt.",
    },
    en: {
      title: "Blog — Etymos",
      description:
        "Practical guides on plagiarism, paraphrasing and citing sources, for students and researchers writing in Vietnamese.",
    },
    changefreq: "weekly",
    priority: 0.7,
  },
  ...POSTS.map(
    (post): PublicPage => ({
      path: `/blog/${post.slug}`,
      vi: { title: `${post.vi.title} — Etymos`, description: post.vi.description },
      en: { title: `${post.en.title} — Etymos`, description: post.en.description },
      changefreq: "yearly",
      priority: 0.6,
    }),
  ),
  {
    path: "/terms",
    vi: { title: "Điều khoản sử dụng — Etymos", description: "Điều khoản sử dụng dịch vụ kiểm tra đạo văn và nội dung AI Etymos." },
    en: { title: "Terms of Service — Etymos", description: "The terms for using the Etymos plagiarism and AI-content checking service." },
    changefreq: "yearly",
    priority: 0.3,
  },
  {
    path: "/privacy-policy",
    vi: { title: "Chính sách bảo mật — Etymos", description: "Cách Etymos thu thập, sử dụng và bảo vệ dữ liệu và tài liệu của bạn." },
    en: { title: "Privacy Policy — Etymos", description: "How Etymos collects, uses and protects your data and documents." },
    changefreq: "yearly",
    priority: 0.3,
  },
  {
    path: "/payment-policy",
    vi: { title: "Chính sách thanh toán — Etymos", description: "Các phương thức thanh toán và quy định thanh toán khi mua gói Etymos." },
    en: { title: "Payment Policy — Etymos", description: "Payment methods and rules for buying an Etymos plan." },
    changefreq: "yearly",
    priority: 0.3,
  },
  {
    path: "/refund-policy",
    vi: { title: "Chính sách hoàn tiền — Etymos", description: "Khi nào và làm thế nào để được hoàn tiền khi mua gói Etymos." },
    en: { title: "Refund Policy — Etymos", description: "When and how you can get a refund for an Etymos purchase." },
    changefreq: "yearly",
    priority: 0.3,
  },
  {
    path: "/complaint-policy",
    vi: { title: "Chính sách khiếu nại — Etymos", description: "Cách gửi và giải quyết khiếu nại về dịch vụ Etymos." },
    en: { title: "Complaint Policy — Etymos", description: "How to raise a complaint about the Etymos service and how it is handled." },
    changefreq: "yearly",
    priority: 0.3,
  },
  {
    path: "/plans-and-credits",
    vi: { title: "Gói dịch vụ và lượt kiểm tra — Etymos", description: "Quy định về các gói dịch vụ, lượt kiểm tra và thời hạn sử dụng của Etymos." },
    en: { title: "Plans and Credits — Etymos", description: "How Etymos plans, check credits and their validity work." },
    changefreq: "yearly",
    priority: 0.3,
  },
];

/** Signed-in and one-off screens: kept out of the index (robots.txt + noindex). */
export const PRIVATE_PREFIXES = [
  "/upload",
  "/analyzing",
  "/report",
  "/documents",
  "/history",
  "/trash",
  "/paywall",
  "/checkout",
  "/payment-success",
  "/account",
  "/verify-student",
  "/verify-email",
  "/auth",
  "/email-verified",
  "/forgot-password",
  "/reset-password",
  "/recover-account",
  "/waitlist",
  "/support",
];

export function findPublicPage(pathname: string): PublicPage | undefined {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return PUBLIC_PAGES.find((p) => p.path === path);
}

export function canonicalUrl(path: string): string {
  return path === "/" ? `${SITE_URL}/` : `${SITE_URL}${path}`;
}
