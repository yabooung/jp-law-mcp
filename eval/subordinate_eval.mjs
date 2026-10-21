/**
 * get_article が添える「この条を引用している施行令・施行規則」の評価（npm run build の後。外部 API は呼ばない）。
 *
 * 国税庁 質疑応答事例の正解（jlawcite の eval/v2/nta_gold.jsonl）で、施行令・施行規則の条と、その親の法律の条が
 * 同じ事例の正解にあるものを数え、親の法律の正解の条を get_article で読んだときの一覧に、正解の施行令・施行規則の条が
 * 出るかを見る（委任先の条を記憶で書かずに一覧から選べる割合）。
 *
 *   node eval/subordinate_eval.mjs --gold <jlawcite リポジトリの eval/v2/nta_gold.jsonl>
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { subordinateCiting } from "../build/lib/subordinate.js";
import { CitationGraph } from "../build/sources/graph.js";
import { LawNames } from "../build/sources/names.js";

const { values: a } = parseArgs({ options: { gold: { type: "string" } } });
if (!a.gold) throw new Error("--gold が必要です");
const g = CitationGraph.load();
const names = LawNames.load();
const cases = readFileSync(a.gold, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((c) => c.gold_articles.length);

let n = 0;
let listed = 0;
for (const c of cases) {
  const arts = c.gold_articles.map((k) => {
    const [law, art] = k.split("_a");
    return { law, art: art.replace(/-/g, "_") };
  });
  for (const sub of arts) {
    const title = names.titleOf(sub.law) ?? "";
    const m = /^(.+?)施行(?:令|規則)$/.exec(title);
    if (!m) continue;
    const parent = names.lookup(m[1]).find((h) => h.kind === "canonical")?.lawId;
    const acts = arts.filter((x) => x.law === parent);
    if (!acts.length) continue;
    n++;
    const [head, ...rest] = sub.art.split("_");
    const want = `第${head}条${rest.map((x) => `の${x}`).join("")}`;
    const found = acts.some((act) => (subordinateCiting(g, act.law, act.art) ?? "").split("／")
      .some((seg) => seg.startsWith(`${title} `) && seg.split(/ |・/).includes(want)));
    if (found) listed++;
  }
}
const result = {
  date: new Date().toISOString().slice(0, 10), snapshot: g.meta.egov_snapshot,
  sub_articles: n, listed, rate: n ? Math.round((listed / n) * 10000) / 10000 : null,
};
mkdirSync("eval/results", { recursive: true });
writeFileSync("eval/results/subordinate.json", JSON.stringify(result, null, 1));
console.log(JSON.stringify(result));
