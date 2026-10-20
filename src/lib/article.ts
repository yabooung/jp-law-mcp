/** 条番号の解釈と、e-Gov 法令API v2 の JSON（簡易版）条文の文字列化。 */

const DIGIT: Record<string, number> = { 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const UNIT: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };

/** 漢数字（千まで）を数に。数字だけの文字列もそのまま受ける。 */
export function kanjiToNumber(s: string): number | null {
  const t = s.normalize("NFKC").trim();
  if (/^\d+$/.test(t)) return Number(t);
  if (!/^[〇一二三四五六七八九十百千]+$/.test(t)) return null;
  let total = 0;
  let cur = 0;
  for (const ch of t) {
    if (ch in DIGIT) cur = DIGIT[ch];
    else {
      total += (cur || 1) * UNIT[ch];
      cur = 0;
    }
  }
  return total + cur;
}

/**
 * 「8」「第8条」「第八条」「8条の2」「第三十六条の二」「36-2」「36の2の3」を
 * e-Gov の要素指定 `Article_36_2` の番号部分（"36_2"）に変換する。読めなければ null。
 */
export function parseArticleNumber(input: string): string | null {
  let s = input.normalize("NFKC").replace(/\s+/g, "");
  s = s.replace(/^第/, "").replace(/条/, "");
  const parts = s.split(/の|-|‐|_/).filter(Boolean);
  if (parts.length === 0) return null;
  const nums = parts.map(kanjiToNumber);
  if (nums.some((n) => n === null || n <= 0)) return null;
  return nums.join("_");
}

/** "36_2" → 「第三十六条の二」ではなく利用者向けの「第36条の2」 */
export function articleLabel(num: string): string {
  const [head, ...rest] = num.split("_");
  return `第${head}条` + rest.map((r) => `の${r}`).join("");
}

type Json = unknown;

function sentences(node: Json): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(sentences).filter(Boolean).join("");
  if (typeof node === "object") {
    const o = node as Record<string, Json>;
    if ("Column" in o) return (o.Column as Json[]).map(sentences).filter(Boolean).join("　");
    if ("Sentence" in o) return sentences(o.Sentence);
    if ("TableStruct" in o || "Table" in o) return "［表あり — 原文を参照］";
    if ("FigStruct" in o || "Fig" in o) return "［図あり — 原文を参照］";
    return Object.values(o).map(sentences).filter(Boolean).join("");
  }
  return "";
}

const SUBITEM_KEYS = Array.from({ length: 10 }, (_, i) => `Subitem${i + 1}`);

function renderItems(o: Record<string, Json>, key: string, depth: number, out: string[]): void {
  const list = o[key];
  if (!Array.isArray(list)) return;
  for (const it of list as Array<Record<string, Json>>) {
    const title = (it[`${key}Title`] as string | undefined) ?? "";
    const body = sentences(it[`${key}Sentence`]);
    out.push(`${"　".repeat(depth)}${title}${title ? "　" : ""}${body}`);
    for (const sk of SUBITEM_KEYS) if (sk in it) renderItems(it, sk, depth + 1, out);
    if ("TableStruct" in it) out.push(`${"　".repeat(depth + 1)}［表あり — 原文を参照］`);
  }
}

/** 条文（簡易版 JSON の `{Article: {...}}`）を行の配列に。1 行目は条名と見出し。 */
export function renderArticle(fullText: Json): string[] {
  const art = (fullText as { Article?: Record<string, Json> })?.Article;
  if (!art) return [sentences(fullText)];
  const out = [`${art.ArticleTitle ?? ""}${art.ArticleCaption ?? ""}`];
  const paras = Array.isArray(art.Paragraph) ? art.Paragraph : art.Paragraph ? [art.Paragraph] : [];
  for (const p of paras as Array<Record<string, Json>>) {
    const num = (p.ParagraphNum as string | null) ?? "";
    out.push(`${num}${num ? "　" : ""}${sentences(p.ParagraphSentence)}`);
    renderItems(p, "Item", 1, out);
    if ("TableStruct" in p) out.push("　［表あり — 原文を参照］");
  }
  return out;
}

/** 二つの行配列の差分（最長共通部分列）。共通は "  "、削除は "- "、追加は "+ "。 */
export function diffLines(a: string[], b: string[]): string[] {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push(`  ${a[i]}`); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push(`- ${a[i++]}`);
    else out.push(`+ ${b[j++]}`);
  }
  while (i < n) out.push(`- ${a[i++]}`);
  while (j < m) out.push(`+ ${b[j++]}`);
  return out;
}
