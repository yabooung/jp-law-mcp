import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { articleLabel, parseArticleNumber, renderArticle } from "../lib/article.js";
import { EGOV_SOURCE, EgovClient, EgovError, egovLawUrl } from "../sources/egov.js";

const LAW_TYPES = ["Constitution", "Act", "CabinetOrder", "ImperialOrder", "MinisterialOrdinance", "Rule", "Misc"] as const;
const TYPE_JA: Record<string, string> = {
  Constitution: "憲法", Act: "法律", CabinetOrder: "政令", ImperialOrder: "勅令", MinisterialOrdinance: "府省令", Rule: "規則", Misc: "その他",
};
const LOCATE_MAX_LAWS = 3;
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD 形式");

// 文は途中で切られて届くことがあり、タグの切れ端（"</span" など）が末尾に残る
const dropCutTag = (s: string) => s.replace(/<[^>]*$/, "");
const plain = (s: string) => dropCutTag(s).replace(/<\/?span>/g, "");
const highlight = (s: string) => {
  const t = dropCutTag(s).replace(/<span>/g, "【").replace(/<\/span>/g, "】");
  return (t.match(/【/g)?.length ?? 0) > (t.match(/】/g)?.length ?? 0) ? `${t}】…` : t;
};
const squash = (s: string) => s.replace(/\s+/g, "");

/** 簡易版 JSON の本則から条を集める（章・節の入れ子をたどる）。附則は見ない。 */
export function collectArticles(fullText: unknown): Array<{ num: string; text: string }> {
  const out: Array<{ num: string; text: string }> = [];
  const visit = (node: unknown, inMain: boolean): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach((n) => visit(n, inMain)); return; }
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === "SupplProvision") continue;
      const main = inMain || k === "MainProvision";
      if (k === "Article" && main) {
        for (const a of Array.isArray(v) ? v : [v]) {
          const title = (a as { ArticleTitle?: string }).ArticleTitle ?? "";
          const num = parseArticleNumber(title);
          if (num) out.push({ num, text: squash(renderArticle({ Article: a }).join("")) });
        }
      } else visit(v, main);
    }
  };
  visit(fullText, false);
  return out;
}

export function registerSearchTools(server: McpServer, client: EgovClient): void {
  server.registerTool(
    "search_law_text",
    {
      title: "条文の全文検索",
      description:
        "法令の本文をキーワードで検索し、該当する法令と文を返します（e-Gov 法令API）。空白区切りは AND。" +
        "上位の法令は、その文が第何条にあるかも調べます。言い回し（「理由を示さなければならない」など）を含む規定を横断的に探すときに使います。",
      inputSchema: {
        keyword: z.string().min(1).max(100).describe("キーワード。空白区切りは AND。例: 理由を示さなければならない 申請"),
        law_type: z.array(z.enum(LAW_TYPES)).optional().describe("法令種別で絞る。例: [\"Act\"]"),
        asof: DATE.optional().describe("時点 YYYY-MM-DD。省略で現行"),
        limit: z.number().int().min(1).max(10).default(5).describe("法令の件数"),
        locate: z.boolean().default(true).describe(`上位 ${LOCATE_MAX_LAWS} 法令で条番号を調べる`),
      },
    },
    async ({ keyword, law_type, asof, limit, locate }) => {
      try {
        const res = await client.keyword(keyword.normalize("NFKC").trim(), { lawType: law_type?.join(","), asof, limit, sentencesLimit: limit * 3 });
        if (res.items.length === 0) {
          return { content: [{ type: "text" as const, text: `「${keyword}」を含む条文は見つかりませんでした（NOT_FOUND）。言い回しを短くするか、空白で区切った語を減らしてください。\n出典: ${EGOV_SOURCE}` }] };
        }
        const located = new Map<string, Array<{ num: string; text: string }>>();
        if (locate) {
          await Promise.all(res.items.slice(0, LOCATE_MAX_LAWS).map(async (it) => {
            try {
              const law = await client.fullLaw(it.law_info.law_id, asof);
              located.set(it.law_info.law_id, collectArticles(law.law_full_text));
            } catch { /* 条番号を出せないだけ */ }
          }));
        }
        const lines = [`「${keyword}」を含む文 ${res.total_count} 件（上位 ${res.items.length} 法令）`];
        for (const it of res.items) {
          const r = it.revision_info;
          lines.push("", `■ ${r.law_title}（${TYPE_JA[r.law_type] ?? r.law_type}・${it.law_info.law_num}・法令ID ${it.law_info.law_id}）`);
          const arts = located.get(it.law_info.law_id);
          for (const s of it.sentences.slice(0, 3)) {
            let where = s.position === "mainprovision" ? "本則" : "附則";
            if (arts && s.position === "mainprovision") {
              const probe = squash(plain(s.text)).slice(0, 40);
              const a = arts.find((x) => x.text.includes(probe));
              if (a) where = articleLabel(a.num);
            }
            lines.push(`- [${where}] ${highlight(s.text)}`);
          }
          if (it.sentences.length > 3) lines.push(`  …この法令でほか ${it.sentences.length - 3} 文`);
          lines.push(`  原文: ${egovLawUrl(it.law_info.law_id, r.law_revision_id)}`);
        }
        lines.push("", `条番号がわかったものは get_article で全文を読めます。出典: ${EGOV_SOURCE}。正確な内容は原文リンクで確認してください。`);
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (e) {
        const msg = e instanceof EgovError ? `e-Gov 法令APIのエラー: ${e.message}${e.code ? ` [${e.code}]` : ""}` : `予期しないエラー: ${(e as Error).message}`;
        return { isError: true, content: [{ type: "text" as const, text: msg }] };
      }
    },
  );
}
