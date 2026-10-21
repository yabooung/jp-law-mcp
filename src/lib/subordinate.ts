/**
 * 法律の条を引用している、その法律の施行令・施行規則の条（「法第九条第一項第十八号に規定する政令で定める…」の側）。
 * get_article が法律の条を返すときに添える。委任先の条を記憶で書かずに済むように（引用グラフ data/graph.json.gz から）。
 */
import { articleLabel } from "./article.js";
import type { CitationGraph } from "../sources/graph.js";

const MAX_PER_LAW = 20;
const label = (path: string) => articleLabel(path.replace(/^a/, "").replace(/-/g, "_"));
const key = (path: string) => path.replace(/^a/, "").split("-").map(Number);
const byNumber = (a: string, b: string) => {
  const [x, y] = [key(a), key(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
};

/** 「所得税法施行令 第30条・第31条／所得税法施行規則 第5条」の形。なければ undefined */
export function subordinateCiting(g: CitationGraph, lawId: string, num: string): string | undefined {
  const art = g.findArticle(lawId, num);
  const law = g.findLaw(lawId);
  if (art === undefined || law === undefined) return undefined;
  const parent = g.lawTitle(law);
  const byLaw = new Map<string, Set<string>>();
  for (const e of g.citing(art)) {
    const t = g.lawTitle(g.lawOf(e.art));
    if (!t.startsWith(parent) || !/施行(?:令|規則)$/.test(t)) continue;
    if (!byLaw.has(t)) byLaw.set(t, new Set());
    byLaw.get(t)!.add(g.pathOf(e.art));
  }
  if (byLaw.size === 0) return undefined;
  return [...byLaw.entries()]
    .sort(([a], [b]) => (a.endsWith("施行令") ? 0 : 1) - (b.endsWith("施行令") ? 0 : 1))
    .map(([t, paths]) => {
      const sorted = [...paths].sort(byNumber);
      return `${t} ${sorted.slice(0, MAX_PER_LAW).map(label).join("・")}${sorted.length > MAX_PER_LAW ? ` ほか ${sorted.length - MAX_PER_LAW} 条` : ""}`;
    })
    .join("／");
}
