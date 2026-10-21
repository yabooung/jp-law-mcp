/**
 * 基本通達の番号確認の評価（npm run build の後。外部 API は呼ばない）。
 *
 * 国税庁 質疑応答事例の関係法令欄（jlawcite の eval/v2/nta_gold.jsonl）に国税庁自身が書いた通達の引用から、
 * 基本通達 5 種（data/tsutatsu.json.gz）の番号を取り出し、一覧にあるかを数える。国税庁の引用なので本来すべて実在し、
 * 「見つからない」は誤った警告か、事例を書いた後の番号の付け替え。見つからないものは全部 detail に書き出す。
 * 逆に、番号の最後の数を 50 増やした（一覧にない）番号を作り、verify_citations の通達の確認が「見つからない」と言うかも数える。
 *
 *   node eval/notice_eval.mjs --gold <jlawcite リポジトリの eval/v2/nta_gold.jsonl>
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { otherCitations } from "../build/lib/others.js";
import { NoticeIndex, normalizeNoticeNumber } from "../build/sources/tsutatsu.js";
import { checkNotices } from "../build/tools/verify.js";

const { values: a } = parseArgs({ options: { gold: { type: "string" } } });
if (!a.gold) throw new Error("--gold が必要です");
const idx = NoticeIndex.load();
if (!idx) throw new Error("data/tsutatsu.json.gz がありません（scripts/export_tsutatsu.py）");
const cases = readFileSync(a.gold, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

const seen = new Set();
const missing = [];
let checked = 0;
let unresolved = 0;
let injected = 0;
let flagged = 0;
for (const c of cases) {
  for (const o of otherCitations(c.kankeihrei.join("\n").normalize("NFKC"))) {
    if (o.kind !== "通達") continue;
    const key = o.name && o.number ? idx.resolve(o.name) : undefined;
    if (!key) { unresolved++; continue; }
    const k = `${key}|${normalizeNoticeNumber(o.number)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    checked++;
    if (idx.item(key, o.number) === undefined) missing.push({ id: c.id, raw: o.raw, notice: key, number: normalizeNoticeNumber(o.number) });
    const bad = normalizeNoticeNumber(o.number).replace(/(\d+)$/, (d) => String(Number(d) + 50));
    if (idx.item(key, bad) === undefined) {
      injected++;
      if (checkNotices(otherCitations(`${o.name}${bad}`.normalize("NFKC")), idx).missing === 1) flagged++;
    }
  }
}
const result = {
  date: new Date().toISOString().slice(0, 10), fetched: idx.fetched,
  checked_unique: checked, found: checked - missing.length, missing: missing.length,
  found_rate: checked ? Math.round(((checked - missing.length) / checked) * 10000) / 10000 : null,
  other_notices_not_checked: unresolved,
  injected, injected_flagged: flagged,
};
mkdirSync("eval/results", { recursive: true });
mkdirSync("eval/.cache", { recursive: true });
writeFileSync("eval/results/notice.json", JSON.stringify(result, null, 1));
writeFileSync("eval/.cache/notice_missing.json", JSON.stringify(missing, null, 1));
console.log(JSON.stringify(result));
