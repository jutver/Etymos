// The blog posts' text, in both languages. Kept apart from ./posts.ts so the
// articles load with the blog screens, not with every page.

export type ArticleBlock =
  | { kind: "p"; text: string }
  | { kind: "h2"; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "note"; text: string };

export interface Article {
  vi: ArticleBlock[];
  en: ArticleBlock[];
}

export const ARTICLES: Record<string, Article> = {
  "dao-van-la-gi": {
    vi: [
      { kind: "p", text: "Khi nghe đến đạo văn, đa số chúng ta nghĩ ngay đến việc chép nguyên một đoạn văn của người khác rồi ghi tên mình. Nhưng trên thực tế, phần lớn các trường hợp bị đánh dấu trong bài luận, khóa luận hay bài báo không cố ý như vậy. Chúng đến từ thói quen ghi chép thiếu cẩn thận, từ việc không biết đâu là ranh giới, hoặc đơn giản là vội vàng trước hạn nộp." },
      { kind: "p", text: "Hiểu rõ các dạng đạo văn là cách đơn giản nhất để tránh chúng. Dưới đây là năm dạng thường gặp nhất." },
      { kind: "h2", text: "1. Sao chép nguyên văn không trích dẫn" },
      { kind: "p", text: "Đây là dạng dễ nhận ra nhất: một câu, một đoạn hoặc cả một phần được lấy y nguyên từ nguồn khác mà không có dấu ngoặc kép và không ghi nguồn. Ngay cả khi bạn có ghi nguồn ở danh mục tài liệu tham khảo, việc dùng nguyên văn mà không đặt trong ngoặc kép vẫn khiến người đọc hiểu nhầm rằng đó là câu chữ của bạn." },
      { kind: "h2", text: "2. Diễn đạt lại quá sát bản gốc" },
      { kind: "p", text: "Thay một vài từ bằng từ đồng nghĩa, đảo vị trí hai vế câu, nhưng giữ nguyên cấu trúc và mạch lập luận của tác giả. Dạng này đặc biệt phổ biến trong tiếng Việt vì có rất nhiều cặp từ Hán Việt và thuần Việt tương đương, như “quan trọng” và “hệ trọng”, “sử dụng” và “dùng”. Câu văn trông có vẻ khác, nhưng thực chất vẫn là của người khác." },
      { kind: "h2", text: "3. Tự đạo văn" },
      { kind: "p", text: "Dùng lại bài tiểu luận đã nộp ở môn trước, hoặc đưa nguyên các đoạn trong bài báo cũ của chính mình vào bài mới mà không nói rõ. Nhiều người ngạc nhiên khi biết đây cũng là đạo văn: bài làm được kỳ vọng là mới, và người chấm có quyền biết phần nào đã được công bố hoặc chấm điểm trước đó." },
      { kind: "h2", text: "4. Ghép nhiều nguồn thành một bài" },
      { kind: "p", text: "Mỗi đoạn lấy từ một nguồn khác nhau, nối lại bằng vài câu chuyển ý. Kết quả là một bài viết không có đoạn nào trùng quá nhiều với một nguồn duy nhất, nhưng toàn bộ ý tưởng và câu chữ đều không phải của người viết." },
      { kind: "h2", text: "5. Trích dẫn sai hoặc thiếu" },
      { kind: "p", text: "Ghi nguồn nhưng sai tác giả, sai năm, hoặc trích dẫn một nguồn thứ cấp như thể đã đọc bản gốc. Dạng này thường không cố ý, nhưng vẫn làm người đọc không thể kiểm chứng thông tin và có thể bị xem là vi phạm liêm chính học thuật." },
      { kind: "h2", text: "Cách tránh ngay từ khi viết" },
      {
        kind: "list",
        items: [
          "Khi ghi chép, đánh dấu rõ đâu là câu chép nguyên văn, đâu là ý bạn tự tóm tắt, và luôn ghi kèm nguồn.",
          "Đọc hiểu nguồn, gấp tài liệu lại, rồi viết ý đó bằng lời của bạn. Sau đó mới mở ra đối chiếu.",
          "Đặt mọi câu chữ giữ nguyên trong ngoặc kép, kèm trích dẫn đầy đủ.",
          "Nếu muốn dùng lại bài cũ của mình, hỏi giảng viên trước và ghi rõ trong bài.",
          "Kiểm tra bài trước khi nộp để thấy những chỗ bạn đã vô tình viết quá sát nguồn.",
        ],
      },
      { kind: "note", text: "Etymos đối chiếu bài viết với các trang web và bài báo khoa học, cho biết từng đoạn trùng khớp là chép nguyên văn hay diễn đạt lại, và giải thích lý do. Nhờ vậy bạn sửa đúng chỗ thay vì đoán." },
    ],
    en: [
      { kind: "p", text: "When people hear the word plagiarism, most picture someone copying a whole paragraph and putting their own name on it. In practice, most of what gets flagged in essays, theses and papers isn't that deliberate. It comes from careless note-taking, from not knowing where the line is, or simply from rushing before a deadline." },
      { kind: "p", text: "Knowing the forms plagiarism takes is the simplest way to avoid it. Here are the five you're most likely to meet." },
      { kind: "h2", text: "1. Copying word for word without citing" },
      { kind: "p", text: "The easiest to spot: a sentence, a paragraph or a whole section taken unchanged from another source, with no quotation marks and no citation. Even if the source appears in your reference list, using its exact words without quotation marks tells the reader those words are yours." },
      { kind: "h2", text: "2. Paraphrasing too closely" },
      { kind: "p", text: "Swapping a few words for synonyms or flipping the order of a clause, while keeping the author's structure and line of argument. It's especially common in Vietnamese, which has many equivalent pairs of Sino-Vietnamese and native words. The sentence looks different, but it's still someone else's." },
      { kind: "h2", text: "3. Self-plagiarism" },
      { kind: "p", text: "Handing in an essay you already submitted for another course, or reusing passages from your own earlier paper without saying so. Many people are surprised this counts. A new assignment is expected to be new work, and your marker has a right to know what has already been published or graded." },
      { kind: "h2", text: "4. Patchwriting from several sources" },
      { kind: "p", text: "Each paragraph comes from a different source, stitched together with a few linking sentences. No single paragraph matches one source too strongly, but neither the ideas nor the wording belong to the writer." },
      { kind: "h2", text: "5. Wrong or missing citations" },
      { kind: "p", text: "Citing the wrong author or year, or citing an original you only read about in a secondary source as if you'd read it yourself. Usually unintentional, it still leaves readers unable to check your claims and can be treated as a breach of academic integrity." },
      { kind: "h2", text: "How to avoid it as you write" },
      {
        kind: "list",
        items: [
          "When taking notes, mark clearly what's copied word for word and what's your own summary, and always note the source.",
          "Read and understand the source, close it, then write the idea in your own words. Only then compare.",
          "Put any wording you keep in quotation marks, with a full citation.",
          "If you want to reuse your own earlier work, ask your lecturer first and say so in the text.",
          "Check your work before you submit, to catch places where you've stayed too close to a source without noticing.",
        ],
      },
      { kind: "note", text: "Etymos compares your writing with web pages and academic papers, says whether each match was copied word for word or paraphrased, and explains why, so you fix the right thing instead of guessing." },
    ],
  },

  "dien-dat-lai-dung-cach": {
    vi: [
      { kind: "p", text: "Diễn đạt lại (paraphrase) là kỹ năng mà hầu như bài viết học thuật nào cũng cần: bạn dùng ý của người khác để làm nền cho lập luận của mình, nhưng nói bằng lời của bạn. Vấn đề là nhiều người hiểu diễn đạt lại là “đổi từ cho khác đi”, và đó chính là lý do bài của họ vẫn bị đánh dấu." },
      { kind: "h2", text: "Đổi từ không phải là diễn đạt lại" },
      { kind: "p", text: "Thử so sánh. Câu gốc: “Việc sử dụng điện thoại thông minh quá nhiều có thể làm giảm khả năng tập trung của sinh viên trong giờ học.” Một bản “diễn đạt lại” thường gặp: “Việc dùng smartphone quá mức có khả năng làm suy giảm sự tập trung của sinh viên trong lớp học.”" },
      { kind: "p", text: "Mỗi từ quan trọng đều đã được thay, nhưng thứ tự ý, cấu trúc câu và cả nhịp câu vẫn giữ nguyên. Một công cụ kiểm tra hiểu ngữ nghĩa sẽ nhận ra hai câu này nói cùng một điều theo cùng một cách, và người chấm cũng vậy." },
      { kind: "h2", text: "Diễn đạt lại thật sự trông như thế nào" },
      { kind: "p", text: "Một bản diễn đạt lại tốt bắt đầu từ việc hiểu ý, không phải từ câu chữ (tên tác giả và năm dưới đây chỉ là ví dụ): “Theo Nguyễn (2024), sinh viên khó giữ sự chú ý trên lớp hơn khi họ thường xuyên dùng điện thoại.” Câu này đổi góc nhìn (từ thiết bị sang sinh viên), đổi cấu trúc, rút gọn ý, và quan trọng nhất là ghi rõ ý đó của ai." },
      { kind: "h2", text: "Bốn bước để diễn đạt lại" },
      {
        kind: "list",
        items: [
          "Đọc đoạn gốc cho đến khi bạn có thể giải thích nó cho một người bạn mà không cần nhìn lại.",
          "Gấp tài liệu lại và viết ý đó ra theo cách bạn sẽ nói, bắt đầu từ một điểm khác với câu gốc.",
          "Mở tài liệu ra đối chiếu: nếu có cụm từ đặc trưng nào trùng nguyên, hãy viết lại hoặc đặt cụm đó trong ngoặc kép.",
          "Thêm trích dẫn. Luôn luôn.",
        ],
      },
      { kind: "h2", text: "Viết lại rồi vẫn phải trích dẫn" },
      { kind: "p", text: "Đây là hiểu lầm phổ biến nhất. Diễn đạt lại thay đổi câu chữ, nhưng ý tưởng vẫn là của tác giả gốc. Bỏ trích dẫn sau khi đã viết lại cẩn thận vẫn là đạo văn, chỉ là khó phát hiện hơn. Ngược lại, một câu diễn đạt lại có trích dẫn đầy đủ cho thấy bạn đã đọc, hiểu và biết đặt nguồn đúng chỗ, và đó là điểm cộng." },
      { kind: "h2", text: "Khi nào nên trích nguyên văn" },
      { kind: "p", text: "Khi chính câu chữ là điều quan trọng: một định nghĩa chính thức, một điều luật, một câu nói nổi tiếng, hoặc khi bạn sắp phân tích cách tác giả dùng từ. Khi đó, hãy giữ nguyên, đặt trong ngoặc kép và ghi nguồn kèm số trang nếu có. Dùng ít và đúng chỗ." },
      { kind: "note", text: "Khi Etymos phát hiện một đoạn diễn đạt lại quá sát nguồn, mỗi nguồn đều đi kèm giải thích vì sao đoạn đó bị đánh dấu, một gợi ý viết lại và một trích dẫn soạn sẵn để bạn chèn vào bài." },
    ],
    en: [
      { kind: "p", text: "Paraphrasing is a skill almost every piece of academic writing needs: you use someone else's idea to support your own argument, but in your own words. The trouble is that many people think paraphrasing means “change the words so they look different”, which is exactly why their work still gets flagged." },
      { kind: "h2", text: "Swapping words isn't paraphrasing" },
      { kind: "p", text: "Compare. Original: “Heavy smartphone use can reduce students' ability to concentrate during class.” A typical “paraphrase”: “Excessive use of smartphones may lower the concentration of students in lessons.”" },
      { kind: "p", text: "Every key word has been replaced, but the order of ideas, the sentence structure and even its rhythm are unchanged. A checker that understands meaning will see that both sentences say the same thing in the same way, and so will your marker." },
      { kind: "h2", text: "What a real paraphrase looks like" },
      { kind: "p", text: "A good paraphrase starts from the idea, not the wording (the author and year here are only an example): “Nguyen (2024) found that students who often reach for their phones find it harder to stay attentive in class.” It shifts the point of view (from the device to the student), changes the structure, tightens the idea, and above all says whose idea it is." },
      { kind: "h2", text: "Four steps to paraphrase" },
      {
        kind: "list",
        items: [
          "Read the passage until you could explain it to a friend without looking.",
          "Close the source and write the idea the way you'd say it, starting from a different point than the original.",
          "Open the source and compare: if a distinctive phrase survived, rewrite it or put it in quotation marks.",
          "Add the citation. Every time.",
        ],
      },
      { kind: "h2", text: "You still cite after rewriting" },
      { kind: "p", text: "This is the most common misunderstanding. Paraphrasing changes the words, but the idea still belongs to the original author. Dropping the citation after a careful rewrite is still plagiarism, just harder to spot. A well-cited paraphrase, on the other hand, shows you read the source, understood it and know where it belongs, and that counts in your favour." },
      { kind: "h2", text: "When to quote instead" },
      { kind: "p", text: "When the exact words matter: an official definition, a legal provision, a well-known line, or wording you're about to analyse. Then keep it as it is, put it in quotation marks and cite it, with a page number if there is one. Use quotes sparingly and on purpose." },
      { kind: "note", text: "When Etymos finds a passage paraphrased too closely, each source comes with an explanation of why it was flagged, a suggested rewrite and a ready-made citation to drop into your text." },
    ],
  },

  "doc-hieu-bao-cao-dao-van": {
    vi: [
      { kind: "p", text: "Bạn vừa nhận được báo cáo kiểm tra đạo văn và thấy một con số: 18%, 32% hay 7%. Câu hỏi đầu tiên gần như luôn là: như vậy có ổn không? Câu trả lời thật là: tùy vào những gì nằm sau con số đó." },
      { kind: "h2", text: "Không có một ngưỡng chung" },
      { kind: "p", text: "Mỗi trường, mỗi khoa, thậm chí mỗi loại bài có quy định riêng về mức tương đồng chấp nhận được. Một bài tổng quan tài liệu tự nhiên sẽ trùng nhiều hơn một bài phân tích số liệu. Hãy hỏi giảng viên hướng dẫn hoặc đọc quy chế của trường, thay vì dựa vào một con số nghe được ở đâu đó." },
      { kind: "h2", text: "Điểm tương đồng đo điều gì" },
      { kind: "p", text: "Điểm tương đồng cho biết bao nhiêu phần văn bản của bạn trùng hoặc rất giống với các nguồn khác. Nó không cho biết phần trùng đó có phải là lỗi hay không. Một bài 25% có thể hoàn toàn hợp lệ nếu phần lớn là trích dẫn đúng cách, còn một bài 8% có thể có vấn đề nếu toàn bộ 8% đó là một đoạn lập luận chính lấy từ một nguồn duy nhất không ghi tên." },
      { kind: "h2", text: "Những trùng khớp thường vô hại" },
      {
        kind: "list",
        items: [
          "Câu trích dẫn đã đặt trong ngoặc kép và ghi nguồn.",
          "Danh mục tài liệu tham khảo.",
          "Thuật ngữ chuyên ngành, tên văn bản pháp luật, tên tổ chức.",
          "Các cụm từ học thuật thông dụng như “kết quả nghiên cứu cho thấy”.",
        ],
      },
      { kind: "h2", text: "Những trùng khớp cần sửa" },
      {
        kind: "list",
        items: [
          "Một đoạn dài trùng nguyên văn mà không có ngoặc kép.",
          "Một đoạn được đánh dấu là diễn đạt lại sát nguồn và không có trích dẫn.",
          "Nhiều đoạn liên tiếp cùng khớp với một nguồn: dấu hiệu bài đang dựa quá nhiều vào một tài liệu.",
        ],
      },
      { kind: "h2", text: "Đọc từng nguồn, không chỉ con số" },
      { kind: "p", text: "Hãy bắt đầu từ nguồn trùng nhiều nhất. Xem từng đoạn được tô màu, đọc lý do nó bị đánh dấu, rồi quyết định: thêm ngoặc kép và trích dẫn, viết lại bằng lời của bạn, hay giữ nguyên vì đó là trùng hợp vô hại. Sửa xong, kiểm tra lại để chắc chắn." },
      { kind: "h2", text: "Về ước tính nội dung do AI viết" },
      { kind: "p", text: "Phát hiện văn bản do AI viết là một ước tính dựa trên xác suất, không phải bằng chứng. Văn phong rất trang trọng, rập khuôn hoặc đã qua nhiều lần chỉnh sửa đôi khi cũng bị đánh giá cao. Hãy dùng kết quả này để xem lại những đoạn nghe chưa giống giọng văn của bạn, không phải để kết luận về ai đó." },
      { kind: "note", text: "Trong Etymos, mỗi đoạn trùng khớp được tô theo màu của nguồn, nhấn vào là chuyển đến nguồn đó kèm giải thích. Sau khi sửa, bạn chỉ cần kiểm tra lại những phần đã thay đổi." },
    ],
    en: [
      { kind: "p", text: "You've just got your plagiarism report back and there's a number on it: 18%, 32% or 7%. The first question is almost always: is that OK? The honest answer is: it depends on what's behind the number." },
      { kind: "h2", text: "There's no single threshold" },
      { kind: "p", text: "Every university, faculty and even type of assignment has its own idea of acceptable similarity. A literature review will naturally match more than a data analysis. Ask your supervisor or read your school's regulations rather than relying on a figure you heard somewhere." },
      { kind: "h2", text: "What the similarity score measures" },
      { kind: "p", text: "The similarity score tells you how much of your text matches or closely resembles other sources. It doesn't tell you whether that overlap is a problem. A 25% report can be perfectly fine if most of it is properly cited quotation, while an 8% report can be a real problem if all of that 8% is one key argument taken uncredited from a single source." },
      { kind: "h2", text: "Matches that are usually harmless" },
      {
        kind: "list",
        items: [
          "Quotations in quotation marks, with a citation.",
          "Your reference list.",
          "Technical terms, names of laws and organisations.",
          "Common academic phrases such as “the results show that”.",
        ],
      },
      { kind: "h2", text: "Matches you should fix" },
      {
        kind: "list",
        items: [
          "A long passage matched word for word with no quotation marks.",
          "A passage flagged as closely paraphrased, with no citation.",
          "Several paragraphs in a row matching the same source: a sign the work leans too heavily on one text.",
        ],
      },
      { kind: "h2", text: "Read the sources, not just the score" },
      { kind: "p", text: "Start with the source that matches most. Look at each highlighted passage, read why it was flagged, then decide: add quotation marks and a citation, rewrite it in your own words, or leave it because the overlap is harmless. Once you've made your changes, check again to be sure." },
      { kind: "h2", text: "About the AI-writing estimate" },
      { kind: "p", text: "AI-writing detection is a probability-based estimate, not proof. Very formal, formulaic or heavily edited writing can sometimes score high. Use it to revisit passages that don't sound like you, not to reach a verdict about anyone." },
      { kind: "note", text: "In Etymos, every matched passage is highlighted in its source's colour, and clicking one takes you to that source and its explanation. After you've made changes, you only re-check the parts you edited." },
    ],
  },
};
