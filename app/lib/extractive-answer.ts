import type { AnswerPart, SearchResult } from "./types";

type Source = { title: string; url: string; excerpts: string[] };
const stopWords = new Set("a an and are as at be been by can could did do does for from had has have how i in into is it its me my of on or our should tell than that the their them there these they this those to us was were what when where which who why will with would you your about explain please question".split(" "));
const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });

function words(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((word) => !stopWords.has(word))
    .map((word) => word.length > 4 && !/(?:ss|us|is)$/.test(word) ? word.replace(/s$/, "") : word));
}

function cleanExcerpt(excerpt: string): string {
  return excerpt
    .replace(/<(script|style|nav)\b[^>]*>[\s\S]*?<\/\1>/gi, "\n")
    .split(/\r?\n/)
    .filter((line) => {
      // Link-heavy menus and tables are poor answer evidence. Keep prose links.
      const links = line.match(/\[[^\]]*\]\([^)]*\)/g) ?? [];
      return links.length < 3 && (line.match(/\|/g) ?? []).length < 2;
    })
    .map((line) => line
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/<\/?[a-z][^<>]*>/gi, " ")
      .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+\.\s+)/, "")
      .replace(/\*\*|__|`+/g, "")
      .replace(/(?<!\w)[*_]([^*_\n]+)[*_](?!\w)/g, "$1")
      .replace(/\s+/g, " ").trim())
    .filter((line) => line && !isBoilerplate(line))
    .join("\n");
}

function isBoilerplate(text: string): boolean {
  return /^(?:home|menu|navigation|skip to|sign[ -]?(?:up|in)|log[ -]?in|subscribe|join (?:us|our)|get started|create (?:an? |your )?account|we use cookies|accept (?:all |our )?cookies|cookie (?:policy|settings|preferences)|privacy policy|terms (?:of|and)|all rights reserved|copyright|share (?:this|on)|follow us|related (?:articles|posts)|read more|learn more|contact us|table of contents|advertisement)\b/i.test(text) ||
    /^(?:https?:\/\/\S+|[\W_]+)$/i.test(text);
}

function shortSnippet(text: string): string {
  if (text.length <= 220) return text;
  const prefix = text.slice(0, 217);
  const boundary = prefix.lastIndexOf(" ");
  return `${prefix.slice(0, boundary > 160 ? boundary : prefix.length)}…`;
}

function nearDuplicate(left: string, right: string): boolean {
  const tokens = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?|[%+−-]/gu) ?? [];
  // Keep numeric, negative, and qualified claims separate even when almost all
  // their other words match. Compare phrases too, so word order still matters.
  const important = (text: string) => tokens(text).filter((word) =>
    /\d|^[%+−-]$|^(?:no|not|never|without|cannot|only|except|before|after|above|below|more|less|may|might|can|could|must|should|will|would|always|sometimes|usually|rarely|all|some|none|.*n['’]t)$/.test(word)).sort().join(" ");
  if (important(left) !== important(right)) return false;
  const leftWords = words(left);
  const rightWords = words(right);
  const overlap = [...leftWords].filter((word) => rightWords.has(word)).length;
  const union = new Set([...leftWords, ...rightWords]).size;
  if (overlap / Math.max(union, 1) < 0.8) return false;
  const phrases = (text: string) => {
    const list = tokens(text);
    return new Set(list.slice(1).map((word, index) => `${list[index]} ${word}`));
  };
  const leftPhrases = phrases(left);
  const rightPhrases = phrases(right);
  const shared = [...leftPhrases].filter((phrase) => rightPhrases.has(phrase)).length;
  return (2 * shared) / Math.max(leftPhrases.size + rightPhrases.size, 1) >= 0.7;
}

// Rank verbatim sentences across ALL returned excerpts. Cleaning removes only
// formatting and boilerplate; selected claims are never paraphrased or spliced.
export function selectEvidence(query: string, sources: Source[]): { results: SearchResult[]; answerParts: AnswerPart[] } {
  const queryWords = words(query);
  const candidates: { text: string; sourceUrl: string; score: number }[] = [];
  const results = sources.map((source) => {
    const cleaned = source.excerpts.map(cleanExcerpt).filter(Boolean).join("\n\n");
    const fullExcerpt = cleaned.slice(0, 2000);
    const sentences = cleaned.split("\n").flatMap((line) =>
      Array.from(segmenter.segment(line), (part) => part.segment.trim()))
      .filter((text) => text.length >= 20 && !isBoilerplate(text) && (text.match(/[\p{L}\p{N}]+/gu) ?? []).length >= 4);
    const ranked = sentences.map((text) => {
      const terms = words(text);
      const matches = [...queryWords].filter((word) => terms.has(word)).length;
      const coverage = queryWords.size ? matches / queryWords.size : 0;
      const relevant = matches >= Math.min(2, queryWords.size) && (coverage >= 0.35 || matches >= 3);
      const score = relevant && matches > 0 ? coverage + matches / Math.max(terms.size, 1) : 0;
      return { text, sourceUrl: source.url, score };
    }).sort((a, b) => b.score - a.score);
    candidates.push(...ranked.filter((part) => part.score > 0 && part.text.length <= 280));
    return { title: source.title, url: source.url, snippet: shortSnippet(ranked[0]?.text ?? ""), fullExcerpt };
  });

  const answerParts: AnswerPart[] = [];
  let characters = 0;
  for (const candidate of candidates.sort((a, b) => b.score - a.score)) {
    // Keep the highest-ranked quote and its original source attribution.
    if (answerParts.some((part) => nearDuplicate(part.text, candidate.text)) || characters + candidate.text.length > 720) continue;
    answerParts.push({ text: candidate.text, sourceUrl: candidate.sourceUrl });
    characters += candidate.text.length;
    if (answerParts.length === 3) break;
  }
  return { results, answerParts };
}
