/**
 * 文章と条文の数値（金額・割合・年数・月数）を取り出して比べる。答えの文が挙げた要件の数値が、引用した条の本文にない
 * ことを知らせるため（「5,000万円」と書いたが条文は「三千万円」など、条はあるのに中身を誤る幻覚の一部）。
 * 計算の結果（「5,000万円×5%=250万円」の 250万円）も条文にはないので、判定ではなく参考の注意にとどめる。
 *
 * 条文は漢数字（「三千万円」「百分の五」「五年」「六月」）、答えは算用数字（「3,000万円」「5%」「5年」「6か月」）で
 * 書くことが多いので、どちらも値に直して比べる。年号・西暦の年と日付は数えない。
 */
const DIGIT: Record<string, number> = { 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 漢数字（万・億まで）を算用数字に。「三千万」→「3000万」のように万・億は単位として残す */
function kanjiRun(s: string): string {
  let total = 0;
  let cur = 0;
  let digit = 0;
  for (const ch of s) {
    if (ch in DIGIT) digit = DIGIT[ch];
    else if (ch === "十" || ch === "百" || ch === "千") {
      cur += (digit || 1) * (ch === "十" ? 10 : ch === "百" ? 100 : 1000);
      digit = 0;
    }
  }
  total = cur + digit;
  return String(total);
}

/** 半角化し、漢数字の並び（〇一二…十百千）を算用数字に、桁区切りを外す */
export function normalizeNumbers(text: string): string {
  return text.normalize("NFKC")
    .replace(/[〇一二三四五六七八九十百千]+/g, (m) => kanjiRun(m))
    .replace(/(\d),(?=\d{3})/g, "$1");
}

export type Quantity = { kind: "円" | "率" | "年" | "月"; value: number; raw: string };

const ERA = /(?:令和|平成|昭和|大正|明治)\s*$/;

/** 正規化した文章から数値を取り出す */
export function quantities(normalized: string): Quantity[] {
  const out: Quantity[] = [];
  const t = normalized;
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*(億|万|千)?\s*円/g)) {
    const unit = m[2] === "億" ? 1e8 : m[2] === "万" ? 1e4 : m[2] === "千" ? 1e3 : 1;
    out.push({ kind: "円", value: Number(m[1]) * unit, raw: m[0] });
  }
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*(?:%|パーセント)/g)) out.push({ kind: "率", value: Number(m[1]) / 100, raw: m[0] });
  for (const m of t.matchAll(/(\d+)\s*分の\s*(\d+(?:\.\d+)?)/g)) out.push({ kind: "率", value: Number(m[2]) / Number(m[1]), raw: m[0] });
  for (const m of t.matchAll(/(\d+)\s*割(?![引増り])/g)) out.push({ kind: "率", value: Number(m[1]) / 10, raw: m[0] });
  for (const m of t.matchAll(/(\d+)\s*年(?!\s*\d+\s*月)(?:以内|以上|未満|を超え|間|後|前|を経過)?/g)) {
    const before = t.slice(Math.max(0, (m.index ?? 0) - 4), m.index);
    if (ERA.test(before) || Number(m[1]) >= 1900) continue; // 年号・西暦の年は期間ではない
    out.push({ kind: "年", value: Number(m[1]), raw: m[0] });
  }
  // 「6か月」「6ヶ月」「6月（条文の六月）」。日付の「10月1日」と「第6月」は除く
  for (const m of t.matchAll(/(\d+)\s*(?:か月|ヶ月|カ月|ケ月|箇月|月)(?!\s*\d+\s*日)/g)) {
    const before = t.slice(Math.max(0, (m.index ?? 0) - 1), m.index);
    if (before === "第" || /年\s*$/.test(t.slice(Math.max(0, (m.index ?? 0) - 6), m.index))) continue;
    out.push({ kind: "月", value: Number(m[1]), raw: m[0] });
  }
  return out;
}

const same = (a: Quantity, b: Quantity) => a.kind === b.kind && Math.abs(a.value - b.value) < 1e-9 * Math.max(1, Math.abs(a.value));

// 要件として書いた数値（「250万円を超える」「5年以内」「50%相当額」「年間50,000円が限度」）。例の金額や計算の結果は見ない
const THRESHOLD = /^\s*(?:以上|以下|未満|超|を超え|以内|まで|が限度|を限度|相当額|に相当する)/;

/** 答えの文の、要件として書いた数値（重複は除く） */
export function claimThresholds(claim: string): Quantity[] {
  const seen = new Set<string>();
  const norm = normalizeNumbers(claim);
  return quantities(norm).filter((q) => {
    const at = norm.indexOf(q.raw);
    const req = /(?:以内|以上|未満|を超え)$/.test(q.raw) || THRESHOLD.test(norm.slice(at + q.raw.length, at + q.raw.length + 6));
    if (at < 0 || !req) return false;
    const k = `${q.kind}|${q.value}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * 答えの文の要件の数値のうち、引用した条（複数なら合わせた本文）と食い違うもの。条文に同じ種類の数値（金額なら金額）が
 * あって、どれとも値が違うときだけ挙げる。同じ種類の数値が条文になければ、その数値は施行令・別表など別の所の話とみなす
 */
export function missingQuantities(claim: string, article: string): Quantity[] {
  const inArticle = quantities(normalizeNumbers(article));
  return claimThresholds(claim).filter((q) => inArticle.some((x) => x.kind === q.kind) && !inArticle.some((x) => same(x, q)));
}

/** 位置 at を含む文（「。」と改行で区切る） */
export function sentenceAt(text: string, at: number): string {
  const start = Math.max(text.lastIndexOf("。", at - 1), text.lastIndexOf("\n", at - 1)) + 1;
  const ends = [text.indexOf("。", at), text.indexOf("\n", at)].filter((x) => x >= 0);
  return text.slice(start, ends.length ? Math.min(...ends) + 1 : text.length);
}
