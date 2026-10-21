import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { articleLabel, diffLines, parseArticleNumber, renderArticle } from "../lib/article.js";
import type { LawNames } from "../sources/names.js";
import {
  ASOF_MIN, EGOV_SOURCE, EgovClient, EgovError, LAW_ID_RE, egovLawUrl,
  type LawDataResponse, type RevisionInfo,
} from "../sources/egov.js";

const STATUS: Record<string, string> = {
  CurrentEnforced: "現行", PreviousEnforced: "過去の版", UnEnforced: "未施行",
  Repeal: "廃止", Expire: "失効", LossOfEffectiveness: "失効",
};
const statusLabel = (s?: string | null) => (s ? STATUS[s] ?? s : "");
const FOOTER = `出典: ${EGOV_SOURCE}。正確な内容は原文リンクで確認してください。`;
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD 形式");

type Text = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
const ok = (text: string): Text => ({ content: [{ type: "text", text }] });
const fail = (text: string): Text => ({ isError: true, content: [{ type: "text", text }] });

export class UserError extends Error {}

/**
 * 法令ID ならそのまま。名前は、同梱の法令名辞書（data/law_names.json.gz）で正式名称か略称がちょうど 1 法令に
 * 当たればそれを使い（e-Gov を呼ばない）、当たらなければ e-Gov で探して 1 件に絞る。絞れなければ候補を示して止める。
 * 辞書は現行法令だけなので、廃止法令やスナップショット後の新法令・改題は e-Gov で探すことになる。
 */
export async function resolveLaw(client: EgovClient, law: string, names?: LawNames): Promise<{ lawId: string; title?: string }> {
  const q = law.normalize("NFKC").trim();
  if (LAW_ID_RE.test(q)) return { lawId: q };
  const local = new Set((names?.lookup(q) ?? []).filter((h) => h.kind === "canonical" || h.kind === "abbrev").map((h) => h.lawId));
  if (local.size === 1) {
    const [lawId] = local;
    return { lawId, title: names!.titleOf(lawId) };
  }
  const res = await client.searchLaws(q, { limit: 20 });
  const laws = res.laws;
  if (laws.length === 0) throw new UserError(`「${q}」に当たる法令が見つかりません（NOT_FOUND）。正式名称・略称・法令IDで指定してください。`);
  const pick = (pred: (r: RevisionInfo) => boolean) => laws.filter((l) => pred(l.current_revision_info ?? l.revision_info));
  const exact = pick((r) => r.law_title === q);
  const abbrev = pick((r) => (r.abbrev ?? "").split(",").includes(q));
  const chosen = exact.length === 1 ? exact[0] : abbrev.length === 1 ? abbrev[0] : laws.length === 1 ? laws[0] : null;
  if (chosen) return { lawId: chosen.law_info.law_id, title: (chosen.current_revision_info ?? chosen.revision_info).law_title };
  const list = laws.slice(0, 8).map((l) => `- ${(l.current_revision_info ?? l.revision_info).law_title}（${l.law_info.law_id}）`);
  throw new UserError(`「${q}」に当たる法令が ${res.total_count} 件あります。law に法令IDか正式名称を指定してください。\n${list.join("\n")}`);
}

function versionLine(r: RevisionInfo): string {
  const by = [r.amendment_law_title, r.amendment_law_num && `（${r.amendment_law_num}）`].filter(Boolean).join("");
  const date = r.amendment_enforcement_date ?? r.amendment_scheduled_enforcement_date ?? "施行日未定";
  return `${date} 施行${by ? `・${by}による改正` : ""}［${statusLabel(r.current_revision_status)}］`;
}

function errorText(e: unknown): string {
  if (e instanceof UserError) return e.message;
  if (e instanceof EgovError) {
    if (e.code === "404004" || e.code === "400021") return `指定の条が見つかりません（NOT_FOUND）。本則の条番号か確認してください（附則・別表は未対応）。[${e.code}]`;
    return `e-Gov 法令APIのエラー: ${e.message}${e.code ? ` [${e.code}]` : ""}`;
  }
  return `予期しないエラー: ${(e as Error).message}`;
}

function checkAsof(asof?: string): void {
  if (asof && asof < ASOF_MIN) {
    throw new UserError(`e-Gov 法令APIの時点指定は ${ASOF_MIN} 以降のみです（${asof} は指定できません）。それより前の条文は官報や法令沿革で確認してください。`);
  }
}

async function fetchArticle(client: EgovClient, law: string, article: string, asof?: string, names?: LawNames) {
  const num = parseArticleNumber(article);
  if (!num) throw new UserError(`条番号「${article}」を読めませんでした。例: 8、第八条、36条の2`);
  checkAsof(asof);
  const { lawId } = await resolveLaw(client, law, names);
  const data: LawDataResponse = await client.article(lawId, num, asof);
  return { lawId, num, data, lines: renderArticle(data.law_full_text) };
}

export function registerLawTools(
  server: McpServer, client: EgovClient, today: () => string = () => new Date().toISOString().slice(0, 10), names?: () => LawNames,
): void {
  const dict = () => names?.();
  server.registerTool(
    "find_law",
    {
      title: "法令を探す",
      description: "法令名・略称の一部から法令を探し、法令ID・正式名称・種別・現行かどうかを返します。他のツールに渡す法令IDを調べるときにも使います。",
      inputSchema: {
        title: z.string().min(1).max(100).describe("法令名または略称の一部。例: 行政手続法、行手法、個人情報"),
        limit: z.number().int().min(1).max(30).default(10),
      },
    },
    async ({ title, limit }) => {
      try {
        const res = await client.searchLaws(title.normalize("NFKC").trim(), { limit });
        if (res.laws.length === 0) return ok(`「${title}」に当たる法令は見つかりませんでした（NOT_FOUND）。\n${FOOTER}`);
        const lines = [`該当 ${res.total_count} 件（上位 ${res.laws.length} 件）`];
        for (const l of res.laws) {
          const r = l.current_revision_info ?? l.revision_info;
          const status = statusLabel(r.current_revision_status);
          const repeal = r.repeal_status && r.repeal_status !== "None" ? statusLabel(r.repeal_status) : "";
          const label = repeal && repeal !== status ? `${status}・${repeal}` : status;
          lines.push(`- ${r.law_title}${r.abbrev ? `（略称: ${r.abbrev}）` : ""}｜${l.law_info.law_num}｜法令ID ${l.law_info.law_id}｜${label}${r.repeal_date ? `（${r.repeal_date}）` : ""}`);
        }
        lines.push("", FOOTER);
        return ok(lines.join("\n"));
      } catch (e) {
        return fail(errorText(e));
      }
    },
  );

  server.registerTool(
    "get_article",
    {
      title: "条文を読む（時点指定可）",
      description:
        "法令の条文（本則の条）を返します。asof を指定すると、その日に施行されていた版の条文を返します（2017-04-01 以降）。" +
        "処分・申請の当時に適用された条文（行為時法）の確認に使います。現行の条文には施行予定の改正があれば知らせます。",
      inputSchema: {
        law: z.string().min(1).max(120).describe("法令名・略称・法令ID。例: 行政手続法、405AC0000000088"),
        article: z.string().min(1).max(30).describe("条番号。例: 8、第八条、36条の2"),
        asof: DATE.optional().describe("時点 YYYY-MM-DD（2017-04-01 以降）。省略で現行"),
      },
    },
    async ({ law, article, asof }) => {
      try {
        const [{ lawId, num, data, lines }, revs] = await Promise.all([
          fetchArticle(client, law, article, asof, dict()),
          resolveLaw(client, law, dict()).then(({ lawId }) => client.revisions(lawId)).catch(() => null),
        ]);
        const r = data.revision_info;
        const out = [
          `${r.law_title} ${articleLabel(num)}`,
          `法令ID ${lawId}｜${data.law_info.law_num}`,
          `版: ${versionLine(r)}${asof ? `（${asof} 時点で施行されていた版）` : ""}`,
          "",
          ...lines,
          "",
        ];
        if (revs) {
          const shown = r.amendment_enforcement_date ?? "";
          const later = revs.revisions
            .filter((x) => (x.amendment_enforcement_date ?? x.amendment_scheduled_enforcement_date ?? "9999") > shown)
            .sort((a, b) => (a.amendment_enforcement_date ?? "9999").localeCompare(b.amendment_enforcement_date ?? "9999"));
          if (asof && later.length > 0) {
            out.push(`この版の次の改正: ${versionLine(later[0])}。版は法令全体の改正単位で、この条が変わったとは限りません（compare_article で確認できます）。`);
          }
          const pending = revs.revisions.filter((x) => x.current_revision_status === "UnEnforced");
          if (!asof || asof >= today()) {
            for (const p of pending) out.push(`⚠ 施行予定の改正: ${versionLine(p)}${p.amendment_enforcement_comment ? `（${p.amendment_enforcement_comment}）` : ""}`);
          }
        }
        out.push(`原文: ${egovLawUrl(lawId, r.law_revision_id)}`, FOOTER);
        return ok(out.join("\n"));
      } catch (e) {
        return fail(errorText(e));
      }
    },
  );

  server.registerTool(
    "law_history",
    {
      title: "法令の改正履歴",
      description: "法令の改正履歴（2017-04-01 以降の版）を新しい順に返します。施行日・改正法令・現行/過去/未施行の区別。",
      inputSchema: {
        law: z.string().min(1).max(120).describe("法令名・略称・法令ID"),
        limit: z.number().int().min(1).max(50).default(20),
      },
    },
    async ({ law, limit }) => {
      try {
        const { lawId } = await resolveLaw(client, law, dict());
        const res = await client.revisions(lawId);
        const title = res.revisions[0]?.law_title ?? lawId;
        const lines = [`${title}（${res.law_info.law_num}・法令ID ${lawId}）の改正履歴 ${res.revisions.length} 件`];
        for (const r of res.revisions.slice(0, limit)) lines.push(`- ${versionLine(r)}｜原文 ${egovLawUrl(lawId, r.law_revision_id)}`);
        if (res.revisions.length > limit) lines.push(`…ほか ${res.revisions.length - limit} 件`);
        lines.push("", FOOTER);
        return ok(lines.join("\n"));
      } catch (e) {
        return fail(errorText(e));
      }
    },
  );

  server.registerTool(
    "compare_article",
    {
      title: "条文の新旧比較",
      description: "同じ条の二つの時点の条文を比べ、変わった行を示します（- が旧、+ が新）。どちらの時点も 2017-04-01 以降。",
      inputSchema: {
        law: z.string().min(1).max(120).describe("法令名・略称・法令ID"),
        article: z.string().min(1).max(30).describe("条番号。例: 8、第八条、36条の2"),
        from: DATE.describe("旧の時点 YYYY-MM-DD"),
        to: DATE.optional().describe("新の時点 YYYY-MM-DD。省略で現行"),
      },
    },
    async ({ law, article, from, to }) => {
      try {
        const [a, b] = await Promise.all([fetchArticle(client, law, article, from, dict()), fetchArticle(client, law, article, to, dict())]);
        const ra = a.data.revision_info;
        const rb = b.data.revision_info;
        const head = [
          `${rb.law_title} ${articleLabel(a.num)} 新旧比較`,
          `旧: ${from} 時点 — ${versionLine(ra)}`,
          `新: ${to ?? "現行"} — ${versionLine(rb)}`,
          "",
        ];
        const d = diffLines(a.lines, b.lines);
        const changed = d.some((l) => !l.startsWith("  "));
        const body = changed ? d : ["差分なし（この条は両時点で同じ文言です）。"];
        return ok([...head, ...body, "", `旧原文: ${egovLawUrl(a.lawId, ra.law_revision_id)}`, `新原文: ${egovLawUrl(b.lawId, rb.law_revision_id)}`, FOOTER].join("\n"));
      } catch (e) {
        return fail(errorText(e));
      }
    },
  );
}
