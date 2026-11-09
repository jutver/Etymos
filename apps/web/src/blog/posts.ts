// The blog's post list: what the index page, the search-engine pages
// (seo/pages.ts) and the sitemap need. The article text itself is in
// ./articles.ts, loaded only with the blog screens.
//
// No imports: vite.config.ts reads this (through seo/pages.ts) in Node.
//
// To publish a post:
//   1. add it here (newest first) and its body to ./articles.ts;
//   2. add a rewrite for /blog/<slug> to vercel.json (seo.test.ts checks).

export interface PostText {
  title: string;
  /** One or two sentences: the card summary and the search-result description (≤ 200 chars). */
  description: string;
  /** A short topic label shown above the title. */
  topic: string;
}

export interface PostMeta {
  slug: string;
  /** ISO date, YYYY-MM-DD. */
  date: string;
  readMinutes: number;
  vi: PostText;
  en: PostText;
}

export const POSTS: PostMeta[] = [
  {
    slug: "doc-hieu-bao-cao-dao-van",
    date: "2026-11-09",
    readMinutes: 6,
    vi: {
      title: "Đọc hiểu báo cáo đạo văn: con số không phải là tất cả",
      description:
        "Điểm tương đồng bao nhiêu là ổn? Cách đọc từng đoạn trùng khớp, phân biệt trùng hợp vô hại với lỗi cần sửa, và hiểu đúng ước tính nội dung do AI viết.",
      topic: "Hướng dẫn",
    },
    en: {
      title: "Reading a plagiarism report: the number isn't the whole story",
      description:
        "What similarity score is OK? How to read each match, tell harmless overlap from a real problem, and make sense of the AI-writing estimate.",
      topic: "Guide",
    },
  },
  {
    slug: "dien-dat-lai-dung-cach",
    date: "2026-11-05",
    readMinutes: 7,
    vi: {
      title: "Diễn đạt lại đúng cách: khi nào viết lại vẫn là sao chép",
      description:
        "Thay vài từ đồng nghĩa không biến ý của người khác thành của bạn. Cách diễn đạt lại thật sự, và vì sao vẫn phải trích dẫn sau khi đã viết lại.",
      topic: "Viết học thuật",
    },
    en: {
      title: "Paraphrasing properly: when rewording is still copying",
      description:
        "Swapping in a few synonyms doesn't make someone else's idea yours. How to paraphrase for real, and why you still cite after rewriting.",
      topic: "Academic writing",
    },
  },
  {
    slug: "dao-van-la-gi",
    date: "2026-11-01",
    readMinutes: 6,
    vi: {
      title: "Đạo văn là gì? Năm dạng đạo văn dễ mắc mà không hề hay biết",
      description:
        "Đạo văn không chỉ là chép nguyên văn. Năm dạng phổ biến, từ tự đạo văn đến trích dẫn sai nguồn, và cách tránh từng dạng ngay từ khi bắt đầu viết.",
      topic: "Kiến thức",
    },
    en: {
      title: "What is plagiarism? Five kinds that are easy to fall into",
      description:
        "Plagiarism isn't only copying word for word. Five common kinds, from self-plagiarism to citing the wrong source, and how to avoid each as you write.",
      topic: "Basics",
    },
  },
];

export function findPost(slug: string | undefined): PostMeta | undefined {
  return POSTS.find((p) => p.slug === slug);
}
