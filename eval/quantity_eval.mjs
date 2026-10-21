/**
 * 数値の突き合わせ（verify_citations detail=true の「条文にない数値」）の評価（npm run build の後。外部 API は呼ばない）。
 *
 * 国税庁 質疑応答事例の回答（jlawcite の eval/v2/nta_gold.jsonl の answer。国税庁が書いた正しい文章）で、
 * 正解の条を引用している文のうち、金額・割合・年数・月数を含む文を集める。条文は検索DBから書き出した本文
 * （scripts/export_texts.py → work/eval_texts.json.gz）を使う。
 *   false_alert: 正しい文なのに「条文にない数値」が出た割合（計算の結果や別の条の数値もここに入る）
 *   detect     : 条文にある数値を 1 つ別の値（金額 2 倍・割合 2 倍・年数 +1・月数 +1）に書き換えた文で、それを挙げた割合
 *
 *   node eval/quantity_eval.mjs --gold <nta_gold.jsonl> --texts work/eval_texts.json.gz
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";

import { extractCitations } from "../build/lib/citations.js";
import { claimThresholds, missingQuantities, normalizeNumbers, sentenceAt } from "../build/lib/quantities.js";
import { LawNames } from "../build/sources/names.js";

const { values: a } = parseArgs({ options: { gold: { type: "string" }, texts: { type: "string", default: "work/eval_texts.json.gz" } } });
if (!a.gold) throw new Error("--gold が必要です");
const texts = JSON.parse(gunzipSync(readFileSync(a.texts)).toString("utf-8"));
const names = LawNames.load();
const articleText = (lawId, art) => {
  const law = texts.laws[lawId];
  const found = law?.[5].find(([x]) => x === art);
  return found ? found[1].map(([, t, items]) => t + items.map(([h, b]) => h + b).join("")).join("") : undefined;
};
const cases = readFileSync(a.gold, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((c) => c.gold_articles.length);

let sentences = 0, alerted = 0, injected = 0, detected = 0;
const alerts = [];
for (const c of cases) {
  const gold = new Set(c.gold_articles);
  const text = c.answer.normalize("NFKC");
  const seen = new Set();
  for (const cit of extractCitations(c.answer, names)) {
    if (!cit.lawId || cit.at == null || !gold.has(`${cit.lawId}_a${cit.article.replace(/_/g, "-")}`)) continue;
    const sentence = sentenceAt(text, cit.at);
    if (seen.has(sentence) || claimThresholds(sentence).length === 0) continue;   // 要件の数値がない文は数えない
    // 同じ文で引用した条の本文を合わせて比べる（法律と施行令を並べて引用することが多い）
    const art = extractCitations(sentence, names).map((x) => x.lawId && articleText(x.lawId, x.article)).filter(Boolean).join("");
    if (!art) continue;
    seen.add(sentence);
    sentences++;
    const miss = missingQuantities(sentence, art);
    if (miss.length) { alerted++; alerts.push({ id: c.id, sentence: sentence.slice(0, 160), missing: miss.map((q) => q.raw) }); continue; }
    // 条文にある数値を 1 つ書き換える
    const q = claimThresholds(sentence)[0];
    const changed = q.kind === "円" || q.kind === "率" ? q.raw.replace(/\d+(?:\.\d+)?/, (d) => String(Number(d) * 2)) : q.raw.replace(/\d+/, (d) => String(Number(d) + 1));
    const altered = normalizeNumbers(sentence).replace(q.raw, changed);
    if (altered === normalizeNumbers(sentence)) continue;
    injected++;
    if (missingQuantities(altered, art).some((m) => m.raw.replace(/\s/g, "") === changed.replace(/\s/g, "") || m.kind === q.kind)) detected++;
  }
}
const r = (k, n) => (n ? Math.round((k / n) * 10000) / 10000 : null);
const result = { date: new Date().toISOString().slice(0, 10), sentences, false_alert: { k: alerted, n: sentences, rate: r(alerted, sentences) }, detect: { k: detected, n: injected, rate: r(detected, injected) } };
mkdirSync("eval/results", { recursive: true });
mkdirSync("eval/.cache", { recursive: true });
writeFileSync("eval/results/quantity.json", JSON.stringify(result, null, 1));
writeFileSync("eval/.cache/quantity_alerts.json", JSON.stringify(alerts, null, 1));
console.log(JSON.stringify(result));
