/**
 * verify_citations の評価（npm run build の後に実行）。
 *
 * 資料: 国税庁 質疑応答事例の「関係法令」欄と、それを条に結び付けた正解（jlawcite の pipeline/resolve_gold.py）。
 *       正解の作り方はこのツールの抽出と別のコードなので、照らし合わせる意味がある。
 *
 * A. 正しい引用を誤って警告しないか: 関係法令欄を確かめ、正解の条と一致した引用のうち ✅ 以外になった割合（誤警告率）。
 *    正解の条をツールが取りこぼした理由（法令名なし・名前不明・複数該当・取り出せず）も数える。
 * B. 誤りを見つけるか: A で ✅ になった引用に誤りを 1 つずつ入れて、警告が出るかを見る。
 *    存在しない条（枝番・末尾超え）・存在しない項・存在しない法令名（前に語を足す）・括弧内の法令番号の食い違い。
 *    「存在しない」はスナップショットの条・項の数（scripts/export_structure.py）で確かめてから作る。
 * C. 文章の中の引用: 回答本文（AI の回答に近い、文の中に引用が混ざった文章）を確かめ、判定の内訳を数える。
 *    条ごとの正解はないので、❌ になったものは detail に全部書き出し、人が原因を分類する。
 *
 * 事例は id のハッシュで dev / test に半分ずつ分ける。直すのは dev を見てだけ。test は --unseal を付けたときだけ、最後に一度。
 *
 * e-Gov API は呼ばない（maxApiCalls: 0。CONTRIBUTING.md「外部 API の使い方」）。ツールは条・項・号の有無を
 * 同梱のスナップショット data/structure.json.gz で判定するので、評価はその判定そのものを測る。正解も同じ
 * スナップショット（e-Gov 2026-09-27）から作られているので時点がそろう。現行版での確かめ直しと抜粋は含まない。
 *
 *   python scripts/export_structure.py --nodes <jlawcite のパイプライン出力 jp_nodes.jsonl> --snapshot 2026-09-27
 *   node eval/verify_eval.mjs --gold <jlawcite リポジトリの eval/v2/nta_gold.jsonl> --split dev
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";

import { LawNames } from "../build/sources/names.js";
import { LawStructure } from "../build/sources/structure.js";
import { verifyText } from "../build/tools/verify.js";

const { values: a } = parseArgs({
  options: {
    gold: { type: "string" },
    structure: { type: "string", default: "data/structure.json.gz" },
    split: { type: "string", default: "dev" },
    unseal: { type: "boolean", default: false },
    inject: { type: "string", default: "300" },
    seed: { type: "string", default: "20261020" },
  },
});
if (!a.gold) throw new Error("--gold が必要です");
if (a.split === "test" && !a.unseal) throw new Error("test は封印中です。設定を dev で確定したあと --unseal を付けて一度だけ実行します");

const SALT = "jp-law-mcp/verify-eval/2026-10-20";
const splitOf = (id) => (createHash("sha256").update(`${SALT}:${id}`).digest()[0] < 128 ? "dev" : "test");

// ---- スナップショット（ツールと同じ data/structure.json.gz） ----
const raw = JSON.parse(gunzipSync(readFileSync(a.structure)).toString("utf-8"));
const st = new LawStructure(raw);
const structure = {}; // 誤りを作るときの「本当にないか」の確認用: law_id → 条 → { p: 項数 }
const meta = {};
for (const [id, [title, num, active, arts]] of Object.entries(raw.laws)) {
  meta[id] = { title, num, active: active === 1 };
  structure[id] = Object.fromEntries((arts ? arts.split(";") : []).map((x) => { const [art, n] = x.split(":"); return [art, { p: Number(n) }]; }));
}
const client = { async article() { throw new Error("評価では e-Gov を呼ばない"); } };
const names = LawNames.load();
const cases = readFileSync(a.gold, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  .filter((c) => c.gold_articles.length && splitOf(c.id) === a.split);

const goldKey = (lawId, article) => `${lawId}_a${article.replace(/_/g, "-")}`;
const label = (article) => { const [n, ...b] = article.split("_"); return `第${n}条${b.map((x) => `の${x}`).join("")}`; };
const tally = (xs) => xs.reduce((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});

// ---- A. 正しい引用 ----
const matched = []; // { id, citation, verdict }
const missed = [];  // { id, gold, reason }
const extra = [];   // 正解にない、ツールが法令を特定した引用
let done = 0;
await Promise.all(cases.map(async (c) => {
  const res = await verifyText(c.kankeihrei.join("\n"), { client, names, structure: st, maxApiCalls: 0 });
  const gold = new Set(c.gold_articles);
  const found = new Set();
  for (const { citation, verdict } of res.checked) {
    if (!citation.lawId) continue;
    const k = goldKey(citation.lawId, citation.article);
    if (gold.has(k)) { matched.push({ id: c.id, citation, verdict }); found.add(k); }
    else extra.push({ id: c.id, raw: citation.raw, key: k, code: verdict.code });
  }
  for (const g of gold) {
    if (found.has(g)) continue;
    const art = g.split("_a")[1].replace(/-/g, "_");
    const near = res.checked.find((x) => !x.citation.lawId && x.citation.article === art);
    missed.push({ id: c.id, gold: g, reason: near ? near.verdict.code : "not_extracted", lines: c.kankeihrei });
  }
  if (++done % 100 === 0) console.error(`[A] ${done}/${cases.length}`);
}));
// 同じ条を何度も数えない（事例が違っても同じ引用文字列・同じ条なら 1 件）
const uniq = new Map();
for (const m of matched) uniq.set(`${m.citation.raw}|${m.citation.paragraph ?? ""}|${m.citation.item ?? ""}`, m);
const okA = [...uniq.values()];
const falseAlarm = okA.filter((m) => m.verdict.mark !== "✅");

// ---- B. 誤りを入れた引用 ----
let rng = Number(a.seed);
const rand = () => ((rng = (rng * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const shuffle = (xs) => { const ys = [...xs]; for (let i = ys.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [ys[i], ys[j]] = [ys[j], ys[i]]; } return ys; };
const base = shuffle(okA.filter((m) => m.verdict.code === "ok" && m.citation.lawName && structure[m.citation.lawId]))
  .slice(0, Number(a.inject));

// 括弧に入れる他の法令の番号: 「平成五年法律第八十八号」の形のもの（人事院規則の「一〇―一二」や、省名を連ねた長い省令番号は除く）
const lawNum = new Map(Object.entries(meta)
  .filter(([, m]) => m.active && m.num && m.num.length <= 30 && names.byPromulgation(m.num) !== null)
  .map(([id, m]) => [id, m.num]));
const PREFIXES = ["地方", "特定", "国際", "個人", "一般", "新"];

function inject(m, i) {
  const c = m.citation;
  const arts = structure[c.lawId];
  const head = c.lawName;
  const tests = [];
  const [n] = c.article.split("_");
  // 存在しない枝番の条（「第57条の2」があるなら「第57条の9」のような番号）
  for (let k = 2; k <= 15; k++) {
    const art = `${n}_${k}`;
    if (!arts[art]) { tests.push({ kind: "no_article_branch", text: `${head}${label(art)}`, expect: ["no_article"] }); break; }
  }
  const maxN = Math.max(...Object.keys(arts).map((x) => Number(x.split("_")[0])));
  tests.push({ kind: "no_article_beyond", text: `${head}${label(String(maxN + 1 + (i % 5)))}`, expect: ["no_article"] });
  const p = arts[c.article]?.p ?? 0;
  tests.push({ kind: "no_paragraph", text: `${head}${label(c.article)}第${Math.max(p, 1) + 1}項`, expect: ["no_paragraph"] });
  const pre = PREFIXES.find((x) => names.lookup(`${x}${head}`).length === 0);
  if (pre) tests.push({ kind: "fake_name_prefix", text: `${pre}${head}${label(c.article)}`, expect: ["unknown_law"] });
  const others = [...lawNum.entries()].filter(([id]) => id !== c.lawId);
  if (others.length) {
    const [, num] = others[Math.floor(rand() * others.length)];
    tests.push({ kind: "wrong_promulgation", text: `${head}（${num}）${label(c.article)}`, expect: ["promulgation_mismatch"] });
  }
  return tests;
}

const injected = base.flatMap((m, i) => inject(m, i).map((t) => ({ ...t, from: m.citation.raw })));
const outB = await Promise.all(injected.map(async (t) => {
  const res = await verifyText(t.text, { client, names, structure: st, maxApiCalls: 0 });
  const v = res.checked[0]?.verdict;
  return { ...t, got: v?.code ?? "not_extracted", mark: v?.mark ?? "-", flagged: !!v && v.mark !== "✅", right: !!v && t.expect.includes(v.code) };
}));

// ---- C. 回答本文 ----
const outC = [];
await Promise.all(cases.map(async (c) => {
  const res = await verifyText(c.answer, { client, names, structure: st, maxApiCalls: 0 });
  for (const { citation, verdict } of res.checked) outC.push({ id: c.id, raw: citation.raw, code: verdict.code, mark: verdict.mark, text: verdict.text });
}));

// ---- 集計 ----
const rate = (k, n) => ({ k, n, rate: n ? Math.round((k / n) * 10000) / 10000 : null });
const byKind = {};
for (const t of outB) {
  byKind[t.kind] ??= { tests: 0, flagged: 0, right: 0, got: {} };
  const b = byKind[t.kind];
  b.tests++; b.flagged += t.flagged; b.right += t.right; b.got[t.got] = (b.got[t.got] ?? 0) + 1;
}
const goldTotal = cases.reduce((s, c) => s + c.gold_articles.length, 0);
const result = {
  split: a.split,
  date: new Date().toISOString().slice(0, 10),
  cases: cases.length,
  A: {
    gold_articles: goldTotal,
    found: rate(goldTotal - missed.length, goldTotal),
    missed_by_reason: tally(missed.map((m) => m.reason)),
    correct_citations_unique: okA.length,
    false_alarm: rate(falseAlarm.length, okA.length),
    false_alarm_by_code: tally(falseAlarm.map((m) => m.verdict.code)),
    extra_not_in_gold: extra.length,
    extra_by_code: tally(extra.map((e) => e.code)),
  },
  B: {
    base_citations: base.length,
    tests: outB.length,
    flagged: rate(outB.filter((t) => t.flagged).length, outB.length),
    right_reason: rate(outB.filter((t) => t.right).length, outB.length),
    by_kind: byKind,
  },
  C: {
    citations: outC.length,
    by_mark: tally(outC.map((x) => x.mark)),
    by_code: tally(outC.map((x) => x.code)),
  },
  source: `e-Gov snapshot ${st.snapshot} (data/structure.json.gz, no API calls)`,
};
mkdirSync("eval/results", { recursive: true });
writeFileSync(`eval/results/verify_${a.split}.json`, JSON.stringify(result, null, 1));
writeFileSync(`eval/.cache/verify_${a.split}_detail.json`, JSON.stringify({
  false_alarm: falseAlarm.map((m) => ({ id: m.id, raw: m.citation.raw, code: m.verdict.code, text: m.verdict.text })),
  missed, extra, missed_injection: outB.filter((t) => !t.right),
  answer_not_found: outC.filter((x) => x.mark === "❌"),
  answer_warn: outC.filter((x) => x.mark === "⚠"),
}, null, 1));
console.log(JSON.stringify(result, null, 1));
