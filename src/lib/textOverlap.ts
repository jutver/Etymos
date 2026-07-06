function normalize(word: string): string {
  return word.toLowerCase().replace(/[.,!?;:"'“”()]/g, "");
}

export interface OverlapToken {
  text: string;
  matched: boolean;
}

export function tokenizeWithOverlap(text: string, otherText: string): OverlapToken[] {
  const otherWords = new Set(
    otherText
      .split(/\s+/)
      .map(normalize)
      .filter((w) => w.length > 2),
  );

  return text.split(/(\s+)/).map((chunk) => {
    if (/^\s+$/.test(chunk)) return { text: chunk, matched: false };
    const norm = normalize(chunk);
    return { text: chunk, matched: norm.length > 2 && otherWords.has(norm) };
  });
}
