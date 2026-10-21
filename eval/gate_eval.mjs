/**
 * 幻覚ゲートとしての verify_citations の評価: AI が実際に書いた答え（eval/answer_eval.mjs が集めた答え）を確かめ、
 * 判定の内訳を数える（npm run build の後に実行。e-Gov は呼ばない — 同梱スナップショットでの判定）。
 *
 * verify_eval.mjs の関係法令欄は整った書き方なので、文の中に混ざった引用（「同法施行令第4条」「措置法第37条の5」）で
 * どれだけ取りこぼし・誤った警告が出るかはここで見る。答えは問の id のハッシュで tune / holdout に分け、
 * 直すときは tune だけを見る（holdout は直し終えてから一度だけ数える）。
 *
 *   node eval/gate_eval.mjs --split tune [--dump]     # 判定の内訳。--dump で ℹ・⚠・❌ の引用を全部出す
 *   node eval/gate_eval.mjs --split holdout --unseal
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
    split: { type: "string", default: "tune" }, unseal: { type: "boolean", default: false }, dump: { type: "boolean", default: false },
    // 直すときに見ていない答え（例 mcp@v2,mcp@v3）を全部使って測るときは --conds でその条件を、--split all を指定する
    conds: { type: "string", default: "mcp,none" },
  },
});
if (a.split === "holdout" && !a.unseal) throw new Error("holdout は封印中です。tune で直し終えたあと --unseal を付けて一度だけ実行します");
const splitOf = (id) => (createHash("sha256").update(`jp-law-mcp/gate-eval/2026-10-21:${id}`).digest()[0] < 128 ? "tune" : "holdout");

const raw = JSON.parse(gunzipSync(readFileSync("data/structure.json.gz")).toString("utf-8"));
const st = new LawStructure(raw);
const names = LawNames.load();
const client = { async article() { throw new Error("評価では e-Gov を呼ばない"); } };

const answers = [];
for (const cond of a.conds.split(",")) {
  for (const l of readFileSync(`eval/.cache/answer_${cond}.jsonl`, "utf-8").split("\n").filter(Boolean)) {
    const r = JSON.parse(l);
    if (r.answer && (a.split === "all" || splitOf(r.id) === a.split)) answers.push({ ...r, cond });
  }
}
const tally = {};
const byMark = {};
const out = [];
for (const r of answers) {
  const res = await verifyText(r.answer, { client, names, structure: st, maxApiCalls: 0 });
  for (const { citation, verdict } of res.checked) {
    tally[verdict.code] = (tally[verdict.code] ?? 0) + 1;
    byMark[verdict.mark] = (byMark[verdict.mark] ?? 0) + 1;
    if (verdict.mark !== "✅") {
      const norm = r.answer.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0)); // 位置は半角化した文章で（空白の詰めは近似）
      const ctx = citation.at == null ? "" : norm.slice(Math.max(0, citation.at - 60), citation.at + 12).replace(/\n/g, "⏎");
      out.push({ id: r.id, cond: r.cond, mark: verdict.mark, code: verdict.code, raw: citation.raw, lawId: citation.lawId ?? null, ctx });
    }
  }
}
const total = Object.values(tally).reduce((s, x) => s + x, 0);
const result = { split: a.split, date: new Date().toISOString().slice(0, 10), answers: answers.length, citations: total, by_mark: byMark, by_code: tally, source: `e-Gov snapshot ${raw.snapshot}` };
console.log(JSON.stringify(result, null, 1));
mkdirSync("eval/.cache", { recursive: true });
writeFileSync(`eval/.cache/gate_${a.split}_detail.json`, JSON.stringify(out, null, 1));
if (a.split === "holdout") writeFileSync("eval/results/gate_holdout.json", JSON.stringify(result, null, 1));
if (a.split === "all") writeFileSync(`eval/results/gate_fresh.json`, JSON.stringify({ ...result, conds: a.conds }, null, 1));
if (a.dump) for (const x of out) console.log(`${x.mark} ${x.code}\t${x.id}/${x.cond}\t${x.raw}\t…${x.ctx}`);
