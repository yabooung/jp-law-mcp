import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { articleLabel, parseArticleNumber } from "../lib/article.js";
import { EgovClient, LAW_ID_RE, egovLawUrl } from "../sources/egov.js";
import { CitationGraph, REL_DELEGATES } from "../sources/graph.js";
import { UserError, resolveLaw } from "./law.js";

type Text = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
const ok = (text: string): Text => ({ content: [{ type: "text", text }] });
const fail = (text: string): Text => ({ isError: true, content: [{ type: "text", text }] });

const pathLabel = (path: string) => articleLabel(path.replace(/^a/, "").replace(/-/g, "_"));
const pathKey = (path: string) => path.replace(/^a/, "").split("-").map(Number);
function byArticleNumber(a: string, b: string): number {
  const x = pathKey(a);
  const y = pathKey(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

function footer(g: CitationGraph): string {
  return [
    `範囲: ${g.meta.egov_snapshot} 時点の法令の本則から自動抽出した引用・委任（附則からの参照は含まない）。抽出漏れ・誤りがありえます。改正の影響判断は原文で確認してください。`,
    `出典: ${g.meta.source}（${g.meta.license}）`,
  ].join("\n");
}

/** 条の番号の集まりを法令ごとにまとめて、多い順に書く */
function groupByLaw(g: CitationGraph, arts: Iterable<number>, maxLaws: number, maxPerLaw = 12): string[] {
  const byLaw = new Map<number, string[]>();
  for (const a of arts) {
    const l = g.lawOf(a);
    const list = byLaw.get(l) ?? [];
    list.push(g.pathOf(a));
    byLaw.set(l, list);
  }
  const rows = [...byLaw.entries()].sort((x, y) => y[1].length - x[1].length || g.lawTitle(x[0]).localeCompare(g.lawTitle(y[0])));
  const out = rows.slice(0, maxLaws).map(([l, paths]) => {
    paths.sort(byArticleNumber);
    const shown = paths.slice(0, maxPerLaw).map(pathLabel).join("・");
    return `- ${g.lawTitle(l)}（${g.lawId(l)}）: ${shown}${paths.length > maxPerLaw ? ` ほか ${paths.length - maxPerLaw} 条` : ""}`;
  });
  if (rows.length > maxLaws) out.push(`…ほか ${rows.length - maxLaws} 法令`);
  return out;
}

async function lawIdOf(g: CitationGraph, egov: EgovClient, law: string): Promise<string> {
  const q = law.normalize("NFKC").trim();
  if (LAW_ID_RE.test(q)) return q;
  const hits = g.findLawsByTitle(q);
  if (hits.length === 1) return g.lawId(hits[0]);
  return (await resolveLaw(egov, q)).lawId; // 略称・部分一致は e-Gov で
}

export function registerGraphTools(server: McpServer, graph: () => CitationGraph, egov: EgovClient): void {
  server.registerTool(
    "find_citing_provisions",
    {
      title: "この条を引用している条文（逆引き）",
      description:
        "指定した条（または法令全体）を引用・委任元として参照している他の条文を、法令ごとにまとめて返します。" +
        "「この条が改正されたら、どの法令のどの条に影響しうるか」「この規定を準用・引用している手続はどれか」を調べるときに使います。" +
        "depth=2 で、引用している条をさらに引用している条の範囲（間接的な影響）も数えます。",
      inputSchema: {
        law: z.string().min(1).max(120).describe("法令名・略称・法令ID。例: 行政手続法"),
        article: z.string().max(30).optional().describe("条番号。例: 8、第八条、36条の2。省略で法令全体"),
        include_same_law: z.boolean().default(false).describe("同じ法令の中からの引用も含める"),
        depth: z.union([z.literal(1), z.literal(2)]).default(1),
        max_laws: z.number().int().min(1).max(50).default(15),
      },
    },
    async ({ law, article, include_same_law, depth, max_laws }) => {
      try {
        const g = graph();
        const lawId = await lawIdOf(g, egov, law);
        const li = g.findLaw(lawId);
        let targets: number[];
        let what: string;
        const title = li !== undefined ? g.lawTitle(li) : lawId;
        if (article) {
          const num = parseArticleNumber(article);
          if (!num) throw new UserError(`条番号「${article}」を読めませんでした。例: 8、第八条、36条の2`);
          const ai = g.findArticle(lawId, num);
          what = `${title} ${articleLabel(num)}`;
          targets = ai === undefined ? [] : [ai];
        } else {
          what = `${title}（法令全体）`;
          targets = li === undefined ? [] : g.articlesOfLaw(li);
        }
        const targetSet = new Set(targets);
        const other = new Set<number>();
        const same = new Set<number>();
        let delegations = 0;
        const add = (src: number, rel: number) => {
          if (targetSet.has(src)) return;
          (g.lawOf(src) === li ? same : other).add(src);
          if (rel === REL_DELEGATES) delegations++;
        };
        for (const t of targets) for (const e of g.citing(t)) add(e.art, e.rel);
        // 「同法」など条を特定しない参照は、法令全体を尋ねたときだけ数える
        if (!article && li !== undefined) for (const e of g.citingLaw(li)) add(e.art, e.rel);

        const direct = include_same_law ? new Set([...other, ...same]) : other;
        if (direct.size === 0) {
          return ok([`${what} を引用・委任元として参照している条文は見つかりませんでした（NOT_FOUND）${!include_same_law && same.size ? `。同じ法令内からの引用は ${same.size} 条あります（include_same_law=true で表示）` : ""}。`, "", footer(g)].join("\n"));
        }
        const lines = [
          `${what} を参照している条文`,
          `他の法令から: ${other.size} 条（${new Set([...other].map((a) => g.lawOf(a))).size} 法令）｜同じ法令内: ${same.size} 条${include_same_law ? "" : "（非表示）"}`,
          "",
          ...groupByLaw(g, direct, max_laws),
        ];
        if (depth === 2) {
          const second = new Set<number>();
          for (const a of direct) for (const e of g.citing(a)) if (!direct.has(e.art) && !targetSet.has(e.art)) second.add(e.art);
          const secondLaws = new Set([...second].map((a) => g.lawOf(a)));
          lines.push("", `間接に関わりうる範囲（上の ${direct.size} 条を参照している条文）: ${second.size} 条（${secondLaws.size} 法令）。多い順:`);
          lines.push(...groupByLaw(g, second, Math.min(max_laws, 10), 6));
        }
        lines.push("", `原文: ${egovLawUrl(lawId)}`, footer(g));
        return ok(lines.join("\n"));
      } catch (e) {
        return fail(e instanceof UserError ? e.message : `予期しないエラー: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "find_cited_provisions",
    {
      title: "この条が引用・委任している先",
      description: "指定した条が本文で引用している他の条と、委任している政令・省令などを法令ごとにまとめて返します。条文を読むときに参照先をたどるのに使います。",
      inputSchema: {
        law: z.string().min(1).max(120).describe("法令名・略称・法令ID"),
        article: z.string().min(1).max(30).describe("条番号。例: 8、第八条、36条の2"),
        max_laws: z.number().int().min(1).max(50).default(20),
      },
    },
    async ({ law, article, max_laws }) => {
      try {
        const g = graph();
        const lawId = await lawIdOf(g, egov, law);
        const num = parseArticleNumber(article);
        if (!num) throw new UserError(`条番号「${article}」を読めませんでした。例: 8、第八条、36条の2`);
        const li = g.findLaw(lawId);
        const what = `${li !== undefined ? g.lawTitle(li) : lawId} ${articleLabel(num)}`;
        const ai = g.findArticle(lawId, num);
        if (ai === undefined) return ok(`${what} から他の条への引用・委任は見つかりませんでした（NOT_FOUND）。\n\n${footer(g)}`);
        const cites = g.cited(ai).filter((e) => e.rel !== REL_DELEGATES).map((e) => e.art);
        const delegatedArts = g.cited(ai).filter((e) => e.rel === REL_DELEGATES).map((e) => e.art);
        const lawRefs = g.citedLaws(ai);
        const lines = [`${what} が参照している先`, ""];
        if (cites.length) lines.push(`引用している条: ${cites.length} 条`, ...groupByLaw(g, cites, max_laws), "");
        const delegLaws = [...new Set(lawRefs.filter((e) => e.rel === REL_DELEGATES).map((e) => e.law))];
        if (delegLaws.length || delegatedArts.length) {
          lines.push("委任先:");
          for (const l of delegLaws) lines.push(`- ${g.lawTitle(l)}（${g.lawId(l)}）`);
          if (delegatedArts.length) lines.push(...groupByLaw(g, delegatedArts, max_laws));
          lines.push("");
        }
        const otherLaws = [...new Set(lawRefs.filter((e) => e.rel !== REL_DELEGATES).map((e) => e.law))];
        if (otherLaws.length) lines.push("条を特定しない法令への参照:", ...otherLaws.map((l) => `- ${g.lawTitle(l)}（${g.lawId(l)}）`), "");
        lines.push(footer(g));
        return ok(lines.join("\n"));
      } catch (e) {
        return fail(e instanceof UserError ? e.message : `予期しないエラー: ${(e as Error).message}`);
      }
    },
  );
}
