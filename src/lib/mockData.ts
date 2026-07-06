import type {
  CheckedDocument,
  CreditPack,
  HistoryEntry,
  PlanDefinition,
} from "./types";

export const PLANS: PlanDefinition[] = [
  {
    id: "free",
    name: "Free",
    tagline: "Get started and try a real check",
    priceMonthly: 0,
    priceAnnual: 0,
    audience: "New users, occasional checks",
    features: [
      "3 documents / month, up to 3,000 words each",
      "Traditional plagiarism detection",
      "Similarity score & matched sources",
      "Basic report",
      "7-day history",
      "Ad-supported",
    ],
  },
  {
    id: "student",
    name: "Student Premium",
    tagline: "For students, grad and PhD researchers",
    priceMonthly: 99000,
    priceAnnual: 950000,
    audience: "Students, grad & PhD researchers",
    mostPopular: true,
    features: [
      "Unlimited documents, unlimited words",
      "Semantic plagiarism detection",
      "AI-generated content detection",
      "Explainable AI, in plain language",
      "AI Rewrite Assistant",
      "Multi-language checking",
      "PDF report export",
      "12-month history, no ads",
      "Priority support",
    ],
  },
  {
    id: "professional",
    name: "Professional",
    tagline: "For lecturers, researchers & agencies",
    priceMonthly: 299000,
    priceAnnual: 2870000,
    audience: "Lecturers, researchers, content & SEO teams",
    features: [
      "Everything in Student Premium",
      "Batch checking",
      "Statistics dashboard",
      "Multi-project management",
      "API integration",
      "In-depth advanced report export",
      "Team roles & permissions",
      "24/7 priority support",
    ],
  },
];

export const CREDIT_PACKS: CreditPack[] = [
  { id: "pack1", label: "1 check", checks: 1, price: 19000, perCheck: 19000 },
  {
    id: "pack5",
    label: "5 checks",
    checks: 5,
    price: 89000,
    perCheck: 17800,
    badge: "Save 6%",
  },
  {
    id: "pack10",
    label: "10 checks",
    checks: 10,
    price: 169000,
    perCheck: 16900,
    badge: "Best value",
  },
];

export const COMPETITORS = [
  {
    name: "Turnitin",
    audience: "Universities",
    price: "Not sold directly",
    limitation: "Hard for individuals to access",
  },
  {
    name: "Copyleaks",
    audience: "Individuals",
    price: "~$9.99/mo",
    limitation: "Not optimized for Vietnamese",
  },
  {
    name: "Grammarly Premium",
    audience: "Individuals",
    price: "~$30/mo",
    limitation: "English-focused",
  },
  {
    name: "Quetext Pro",
    audience: "Individuals",
    price: "~$13.99/mo",
    limitation: "Weak Vietnamese semantic detection",
  },
  {
    name: "Etymos",
    audience: "Vietnamese users",
    price: "~99,000 VND/mo (~$3.8)",
    limitation: "Vietnamese-optimized, Explainable AI, AI Rewrite",
    highlight: true,
  },
];

export const FEATURE_MATRIX: {
  feature: string;
  free: boolean | string;
  student: boolean | string;
  professional: boolean | string;
}[] = [
  { feature: "Traditional plagiarism detection", free: true, student: true, professional: true },
  { feature: "Similarity score", free: true, student: true, professional: true },
  { feature: "Matched-source suggestions", free: true, student: true, professional: true },
  { feature: "Semantic plagiarism detection", free: false, student: true, professional: true },
  { feature: "Explainable AI (why it's flagged)", free: false, student: true, professional: true },
  { feature: "AI Rewrite Assistant", free: false, student: true, professional: true },
  { feature: "AI-generated content detection", free: false, student: true, professional: true },
  { feature: "Multi-language checking", free: false, student: true, professional: true },
  { feature: "PDF export", free: false, student: true, professional: true },
  { feature: "Ads", free: "Shown", student: "None", professional: "None" },
  { feature: "Documents / month", free: "3", student: "Unlimited", professional: "Unlimited" },
  { feature: "Words / document", free: "3,000", student: "Unlimited", professional: "Unlimited" },
  { feature: "History retention", free: "7 days", student: "12 months", professional: "12 months" },
  { feature: "Batch checking", free: false, student: false, professional: true },
  { feature: "Statistics dashboard", free: false, student: false, professional: true },
  { feature: "Multi-project management", free: false, student: false, professional: true },
  { feature: "API integration", free: false, student: false, professional: true },
  { feature: "Team roles & permissions", free: false, student: false, professional: true },
  { feature: "Support", free: "Basic", student: "Priority", professional: "24/7 priority" },
];

const title =
  "Tác Động Của Biến Đổi Khí Hậu Đến Sản Xuất Nông Nghiệp Tại Đồng Bằng Sông Cửu Long";

export const SAMPLE_DOCUMENT: CheckedDocument = {
  id: "doc-current",
  title,
  fileName: "Bien-doi-khi-hau-DBSCL.docx",
  language: "vi",
  wordCount: 1842,
  uploadedAt: "2026-07-05",
  similarityScore: 34,
  similarityScoreFree: 22,
  aiContentScore: 62,
  aiContentExplanation:
    "Đoạn văn có khả năng do AI tạo ra dựa trên các dấu hiệu: câu văn trau chuốt và đồng đều bất thường, dùng nhiều cụm từ trừu tượng mang tính khái quát ('kiến tạo tương lai', 'hệ sinh thái bền vững'), và thiếu số liệu cụ thể thường thấy trong văn phong học thuật của người viết.",
  webSourcesScanned: 48200000,
  academicSourcesScanned: 186400,
  passages: [
    {
      id: "p1",
      text: "Đồng bằng sông Cửu Long là vựa lúa lớn nhất của Việt Nam, đóng góp hơn 50% sản lượng lúa gạo và gần 70% sản lượng thủy sản xuất khẩu của cả nước. Tuy nhiên, trong hai thập kỷ gần đây, khu vực này đang phải đối mặt với những thách thức nghiêm trọng từ biến đổi khí hậu, bao gồm xâm nhập mặn, sụt lún đất và nước biển dâng.",
    },
    {
      id: "p2",
      text: "Theo kịch bản biến đổi khí hậu của Bộ Tài nguyên và Môi trường, đến năm 2050, khoảng 38% diện tích của Đồng bằng sông Cửu Long có nguy cơ bị ngập do nước biển dâng nếu không có các biện pháp ứng phó kịp thời. Con số này đặc biệt đáng lo ngại đối với các tỉnh ven biển như Bến Tre, Trà Vinh và Sóc Trăng, nơi sinh kế của hàng triệu nông dân phụ thuộc trực tiếp vào canh tác lúa nước.",
      severity: "high",
      matchId: "m1",
    },
    {
      id: "p3",
      text: "Xâm nhập mặn là một trong những hệ quả rõ rệt nhất của biến đổi khí hậu tại khu vực này. Mùa khô năm 2020, ranh mặn 4g/l đã xâm nhập sâu hơn 50km vào một số cửa sông, khiến hàng chục nghìn hecta lúa bị thiệt hại.",
    },
    {
      id: "p4",
      text: "Nhiều nghiên cứu đã chỉ ra rằng việc khai thác nước ngầm quá mức để phục vụ nuôi trồng thủy sản và sinh hoạt là nguyên nhân chính gây ra hiện tượng sụt lún đất, với tốc độ trung bình từ 1 đến 3 cm mỗi năm tại một số khu vực ven biển, nhanh hơn tốc độ nước biển dâng toàn cầu.",
      severity: "moderate",
      matchId: "m2",
    },
    {
      id: "p5",
      text: "Trước thực trạng đó, nông dân tại nhiều địa phương đã bắt đầu chuyển đổi mô hình canh tác, từ độc canh cây lúa sang mô hình lúa - tôm hoặc luân canh với các loại cây chịu mặn tốt hơn.",
    },
    {
      id: "p6",
      text: "Mô hình lúa - tôm được xem là một giải pháp thích ứng bền vững, giúp nông dân vừa duy trì thu nhập vừa giảm thiểu rủi ro trước tình trạng xâm nhập mặn ngày càng gia tăng.",
      severity: "low",
      matchId: "m3",
    },
    {
      id: "p7",
      text: "Việc ứng dụng công nghệ số trong nông nghiệp thông minh không chỉ tối ưu hóa quy trình canh tác mà còn tạo ra một hệ sinh thái bền vững, nơi dữ liệu và tự động hóa hòa quyện với tri thức bản địa để kiến tạo tương lai nông nghiệp xanh cho toàn vùng.",
      aiFlag: true,
    },
    {
      id: "p8",
      text: "Bên cạnh các giải pháp canh tác, chính quyền địa phương cũng đã đầu tư xây dựng hệ thống cống ngăn mặn tại các cửa sông lớn nhằm kiểm soát nguồn nước ngọt phục vụ sản xuất trong mùa khô.",
    },
    {
      id: "p9",
      text: "Dự án Cống Cái Lớn - Cái Bé, một trong những công trình thủy lợi lớn nhất khu vực, được kỳ vọng sẽ kiểm soát nguồn nước cho khoảng 384.000 hecta đất sản xuất nông nghiệp và nuôi trồng thủy sản tại các tỉnh Kiên Giang, Hậu Giang, Bạc Liêu và một phần Sóc Trăng.",
      severity: "high",
      matchId: "m4",
    },
    {
      id: "p10",
      text: "Nhìn chung, việc ứng phó với biến đổi khí hậu tại Đồng bằng sông Cửu Long đòi hỏi một chiến lược tổng thể, kết hợp giữa giải pháp công trình, chuyển đổi mô hình canh tác và sự tham gia chủ động của cộng đồng địa phương.",
    },
  ],
  matches: [
    {
      id: "m1",
      severity: "high",
      detectionType: "traditional",
      matchPercent: 92,
      sourceTitle: "Kịch bản biến đổi khí hậu và nước biển dâng cho Việt Nam",
      sourceAuthor: "Bộ Tài nguyên và Môi trường, 2022",
      sourceKind: "academic",
      citation: "Bộ TN&MT, 2022, tr. 47",
      userSnippet:
        "Theo kịch bản biến đổi khí hậu của Bộ Tài nguyên và Môi trường, đến năm 2050, khoảng 38% diện tích của Đồng bằng sông Cửu Long có nguy cơ bị ngập do nước biển dâng nếu không có các biện pháp ứng phó kịp thời.",
      sourceSnippet:
        "Theo kịch bản biến đổi khí hậu của Bộ Tài nguyên và Môi trường, đến năm 2050, gần 38% diện tích Đồng bằng sông Cửu Long có nguy cơ ngập do nước biển dâng nếu Việt Nam không triển khai kịp thời các biện pháp ứng phó.",
      explanation:
        "Câu văn giữ gần như nguyên vẹn cấu trúc và số liệu của nguồn gốc, chỉ thay đổi vài từ nối. Đây là dạng sao chép gần nguyên văn (near-verbatim), không phải diễn giải lại bằng ngôn ngữ của người viết.",
      rewriteSuggestions: [
        "Dựa trên kịch bản biến đổi khí hậu do Bộ Tài nguyên và Môi trường công bố, gần 38% diện tích Đồng bằng sông Cửu Long được dự báo sẽ chịu ảnh hưởng của ngập lụt do nước biển dâng vào năm 2050 nếu thiếu các giải pháp ứng phó phù hợp. Các tỉnh ven biển như Bến Tre, Trà Vinh và Sóc Trăng là những khu vực chịu rủi ro cao nhất, do phần lớn dân cư nơi đây sống dựa vào canh tác lúa nước.",
        "Số liệu dự báo của Bộ Tài nguyên và Môi trường cho thấy, nếu không triển khai các giải pháp ứng phó phù hợp, gần 2/5 diện tích Đồng bằng sông Cửu Long có thể bị ảnh hưởng bởi ngập lụt do nước biển dâng vào giữa thế kỷ. Rủi ro này đặc biệt cao tại các tỉnh ven biển như Bến Tre, Trà Vinh và Sóc Trăng, nơi phần lớn sinh kế người dân gắn với cây lúa.",
      ],
    },
    {
      id: "m2",
      severity: "moderate",
      detectionType: "semantic",
      matchPercent: 61,
      sourceTitle: "Sụt lún đất ở Đồng bằng sông Cửu Long: Nguyên nhân và giải pháp",
      sourceAuthor: "Nguyễn Hồng Quân và cộng sự, Tạp chí Khoa học Thủy lợi",
      sourceKind: "academic",
      citation: "Nguyễn H. Quân và cộng sự, 2021, tr. 12",
      userSnippet:
        "Nhiều nghiên cứu đã chỉ ra rằng việc khai thác nước ngầm quá mức để phục vụ nuôi trồng thủy sản và sinh hoạt là nguyên nhân chính gây ra hiện tượng sụt lún đất, với tốc độ trung bình từ 1 đến 3 cm mỗi năm.",
      sourceSnippet:
        "Kết quả quan trắc cho thấy khai thác nước ngầm quá mức phục vụ nuôi trồng thủy sản và sinh hoạt là nguyên nhân chủ yếu dẫn đến sụt lún đất, với tốc độ trung bình 1-3 cm/năm ở một số khu vực ven biển.",
      explanation:
        "Đoạn văn diễn đạt lại câu chữ nhưng giữ nguyên toàn bộ lập luận, số liệu và trình tự lý giải nguyên nhân - kết quả của nguồn. Đây là dạng đạo văn ngữ nghĩa (paraphrase), khó phát hiện bằng công cụ so khớp từ khóa thông thường.",
      rewriteSuggestions: [
        "Việc khai thác nước ngầm vượt mức cho phép, phục vụ nuôi trồng thủy sản và sinh hoạt hàng ngày, được xác định là nguyên nhân hàng đầu gây sụt lún đất tại một số khu vực ven biển, với tốc độ trung bình 1 đến 3 cm mỗi năm, vượt xa tốc độ dâng lên của mực nước biển trên phạm vi toàn cầu.",
        "Tại nhiều khu vực ven biển, tình trạng sụt lún đất diễn ra với tốc độ trung bình 1 đến 3 cm mỗi năm, nhanh hơn đáng kể so với tốc độ nước biển dâng toàn cầu. Nguyên nhân chủ yếu được cho là do khai thác nước ngầm quá mức phục vụ sinh hoạt và nuôi trồng thủy sản.",
      ],
    },
    {
      id: "m3",
      severity: "low",
      detectionType: "traditional",
      matchPercent: 34,
      sourceTitle: "Chuyển đổi mô hình lúa - tôm thích ứng biến đổi khí hậu",
      sourceAuthor: "Cổng thông tin Nông nghiệp Việt Nam",
      sourceKind: "web",
      citation: "nongnghiep.vn, truy cập 2026",
      userSnippet:
        "Mô hình lúa - tôm được xem là một giải pháp thích ứng bền vững, giúp nông dân vừa duy trì thu nhập vừa giảm thiểu rủi ro trước tình trạng xâm nhập mặn ngày càng gia tăng.",
      sourceSnippet:
        "Mô hình lúa - tôm được đánh giá là giải pháp thích ứng bền vững, giúp nông dân duy trì thu nhập ổn định trong khi giảm thiểu rủi ro do xâm nhập mặn.",
      explanation:
        "Đây chủ yếu là cách diễn đạt phổ biến, lặp lại trong nhiều bài viết cùng chủ đề. Mức độ trùng khớp thấp và không bắt buộc trích dẫn, nhưng nên diễn đạt theo văn phong riêng để đảm bảo tính nguyên bản.",
      rewriteSuggestions: [
        "Chuyển sang mô hình canh tác lúa kết hợp nuôi tôm giúp nông dân giữ được nguồn thu nhập ổn định, đồng thời hạn chế rủi ro từ tình trạng xâm nhập mặn ngày càng diễn biến phức tạp.",
        "Đây được xem là hướng canh tác thích ứng hiệu quả, cho phép nông dân duy trì thu nhập trong khi giảm bớt tác động tiêu cực của xâm nhập mặn.",
      ],
    },
    {
      id: "m4",
      severity: "high",
      detectionType: "traditional",
      matchPercent: 88,
      sourceTitle: "Báo cáo tổng kết Dự án Hệ thống thủy lợi Cái Lớn - Cái Bé",
      sourceAuthor: "Bộ Nông nghiệp và Phát triển Nông thôn",
      sourceKind: "academic",
      citation: "Bộ NN&PTNT, 2023, tr. 5",
      userSnippet:
        "Dự án Cống Cái Lớn - Cái Bé, một trong những công trình thủy lợi lớn nhất khu vực, được kỳ vọng sẽ kiểm soát nguồn nước cho khoảng 384.000 hecta đất sản xuất nông nghiệp và nuôi trồng thủy sản.",
      sourceSnippet:
        "Hệ thống công trình thủy lợi Cái Lớn - Cái Bé được kỳ vọng kiểm soát nguồn nước cho 384.000 ha đất sản xuất nông nghiệp, nuôi trồng thủy sản thuộc các tỉnh Kiên Giang, Hậu Giang, Bạc Liêu và một phần tỉnh Sóc Trăng.",
      explanation:
        "Số liệu diện tích, tên dự án và danh sách địa phương được sao chép gần như chính xác từ báo cáo gốc mà không có trích dẫn nguồn. Cần bổ sung trích dẫn trực tiếp hoặc diễn đạt lại toàn bộ câu bằng văn phong riêng.",
      rewriteSuggestions: [
        "Theo báo cáo của Bộ Nông nghiệp và Phát triển Nông thôn (2023), hệ thống cống Cái Lớn - Cái Bé hướng đến mục tiêu kiểm soát nguồn nước cho gần 384.000 hecta đất nông nghiệp và nuôi trồng thủy sản trải rộng trên địa bàn các tỉnh Kiên Giang, Hậu Giang, Bạc Liêu và một phần Sóc Trăng.",
        "Công trình cống Cái Lớn - Cái Bé, theo số liệu công bố năm 2023, dự kiến phục vụ kiểm soát nguồn nước cho khoảng 384.000 hecta đất sản xuất nông nghiệp và thủy sản tại bốn tỉnh Kiên Giang, Hậu Giang, Bạc Liêu và một phần Sóc Trăng.",
      ],
    },
  ],
};

export const HISTORY_SEED: HistoryEntry[] = [
  {
    id: "hist-1",
    title: title,
    date: "2026-07-05",
    similarityScore: 34,
    status: "moderate",
    aiFlagged: true,
    project: "Luận văn tốt nghiệp",
    wordCount: 1842,
  },
  {
    id: "hist-2",
    title: "Ứng Dụng Trí Tuệ Nhân Tạo Trong Chẩn Đoán Hình Ảnh Y Khoa",
    date: "2026-06-28",
    similarityScore: 18,
    status: "low",
    aiFlagged: false,
    project: "Nghiên cứu khoa học",
    wordCount: 2310,
  },
  {
    id: "hist-3",
    title: "Tác Động Của Mạng Xã Hội Đến Hành Vi Tiêu Dùng Của Sinh Viên",
    date: "2026-06-20",
    similarityScore: 52,
    status: "high",
    aiFlagged: true,
    project: "Báo cáo môn học",
    wordCount: 1590,
  },
  {
    id: "hist-4",
    title: "Phân Tích Chuỗi Cung Ứng Nông Sản Việt Nam Trong Bối Cảnh Hội Nhập",
    date: "2026-05-30",
    similarityScore: 8,
    status: "clean",
    aiFlagged: false,
    project: "Nghiên cứu khoa học",
    wordCount: 3120,
  },
  {
    id: "hist-5",
    title: "Nghiên Cứu Về Hiệu Quả Học Tập Trực Tuyến Sau Đại Dịch COVID-19",
    date: "2026-05-12",
    similarityScore: 12,
    status: "low",
    aiFlagged: false,
    project: "Báo cáo môn học",
    wordCount: 2075,
  },
];
