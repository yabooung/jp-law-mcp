import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { articleLabel } from "../lib/article.js";
import { extractCitations, type Citation } from "../lib/citations.js";
import { ASOF_MIN, EGOV_SOURCE, EgovClient, EgovError, LAW_ID_RE, egovLawUrl, type LawDataResponse } from "../sources/egov.js";
import type { LawNames } from "../sources/names.js";
import type { LawStructure } from "../sources/structure.js";

const MAX_CITATIONS = 30;
// 1 回の確認で e-Gov に送る上限（CONTRIBUTING.md「外部 API の使い方」）。実在はスナップショットで判定し、
// API は「ない」と出たものの現行版での確認と、「ある」と出たものの抜粋に使う
export const MAX_API_CALLS = 10;
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD 形式");

/** 判定の種類。評価（eval/verify_eval.mjs）はこの code で数える */
export type VerdictCode =
  | "ok" | "repealed" | "no_article" | "no_paragraph" | "no_item"
  | "unknown_law" | "ambiguous_law" | "promulgation_mismatch" | "no_law_name" | "old_version" | "suppl_provision" | "item_in_table" | "fetch_error";
export type Verdict = { mark: "✅" | "❌" | "⚠" | "ℹ"; code: VerdictCode; text: string };
export interface VerifyResult { total: number; apiCalls: number; checked: Array<{ citation: Citation; verdict: Verdict }> }

/** 項・号の形。スナップショットと API の応答の両方をこの形にして同じ規則で判定する */
interface Shape { paragraphs: number; items: number[]; tables: Set<number>; caption: string }

function sentencesOf(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(sentencesOf).join("");
  if (typeof node === "object") {
    const o = node as Record<string, unknown>;
    if ("Sentence" in o) return sentencesOf(o.Sentence);
    if ("Column" in o) return (o.Column as unknown[]).map(sentencesOf).join("　");
    return Object.values(o).map(sentencesOf).join("");
  }
  return "";
}

const asList = (x: unknown) => (Array.isArray(x) ? x : x ? [x] : []) as Array<Record<string, unknown>>;

function locate(c: Citation): string {
  return `${articleLabel(c.article)}${c.paragraph ? `第${c.paragraph}項` : ""}${c.item ? `第${c.item}号` : ""}`;
}

function apiShape(data: LawDataResponse): { shape: Shape; paras: Array<Record<string, unknown>> } {
  const art = (data.law_full_text as { Article?: Record<string, unknown> }).Article ?? {};
  const paras = asList(art.Paragraph);
  const tables = new Set<number>();
  paras.forEach((p, i) => {
    if ("TableStruct" in p || /次の表|同表|上欄|下欄/.test(sentencesOf(p.ParagraphSentence))) tables.add(i + 1);
  });
  return {
    shape: { paragraphs: paras.length, items: paras.map((p) => asList(p.Item).length), tables, caption: (art.ArticleCaption as string | undefined) ?? "" },
    paras,
  };
}

/** 項・号が実在しないときの判定。実在すれば null */
function judge(c: Citation, title: string, s: Shape): Verdict | null {
  const head = `${c.raw} → ${title} ${articleLabel(c.article)}`;
  const nParas = Math.max(s.paragraphs, 1);
  if (c.paragraph && c.paragraph > nParas) {
    return { mark: "❌", code: "no_paragraph", text: `${head}${s.caption}は第${nParas}項までです（第${c.paragraph}項は存在しません）` };
  }
  const pi = c.paragraph ?? 1;
  const nItems = s.items[pi - 1] ?? 0;
  const where = `${head}${c.paragraph ? `第${c.paragraph}項` : ""}${s.caption}`;
  // 表の形の項（「次の表の上欄に掲げる…」）には号がない。「第N号」は表の行を指していることがある
  if (c.item && nItems === 0 && s.tables.has(pi)) {
    return { mark: "⚠", code: "item_in_table", text: `${where}は表の形で、号はありません。表の欄（行）を指しているなら原文の表で確かめてください` };
  }
  if (c.item && c.item > nItems) {
    return { mark: "❌", code: "no_item", text: `${where}には第${c.item}号がありません（${nItems ? `第${nItems}号まで` : "号なし"}）` };
  }
  return null;
}

function excerptOf(c: Citation, paras: Array<Record<string, unknown>>): string {
  const para = paras[(c.paragraph ?? 1) - 1];
  const body = c.item ? sentencesOf(asList(para?.Item)[c.item - 1]?.ItemSentence) : sentencesOf(para?.ParagraphSentence);
  return body.length > 90 ? `${body.slice(0, 90)}…` : body;
}

function repealText(status: string | null | undefined): string {
  return status && status !== "None" ? `［この法令は${status === "Repeal" ? "廃止" : "失効"}されています］` : "";
}

/** 名前だけで決まる判定（附則・法令名なし・名前不明・複数該当・改正前の版）。法令が決まって条を確かめるべきなら null */
function nameVerdict(c: Citation, dict: LawNames, asof?: string): Verdict | null {
  if (c.issues.includes("suppl_provision")) {
    return { mark: "ℹ", code: "suppl_provision", text: `${c.raw}（附則）→ 附則の条は確かめていません（附則は改正のたびに付くため、どの改正の附則かを本文で確認してください）` };
  }
  if (c.issues.includes("no_law_name")) {
    return { mark: "ℹ", code: "no_law_name", text: `${c.raw}（法令名なし）→ 同じ法令の中の参照かもしれません。default_law に法令を指定すると確認できます` };
  }
  if (c.issues.includes("unknown_law")) {
    const near = c.candidates?.map((id) => dict.titleOf(id)).filter(Boolean).join("・");
    return { mark: "⚠", code: "unknown_law", text: `${c.raw} → 法令名「${c.lawName}」に当たる法令が見つかりません${near ? `（似た名前: ${near}）` : ""}。` +
      "誤った名前のほか、文章の外で定めた略称（措法など）・改正法・条約は見つからないことがあります" };
  }
  if (!c.lawId) {
    const cand = (c.candidates ?? []).map((id) => `${dict.titleOf(id) ?? id}（${id}）`).join("・");
    return { mark: "⚠", code: "ambiguous_law", text: `${c.raw} → 同じ名前の法令が複数あり特定できません: ${cand}。括弧で法令番号を付けると特定できます` };
  }
  if (c.issues.includes("old_version") && !asof) {
    const title = dict.titleOf(c.lawId) ?? c.lawName ?? c.lawId;
    return { mark: "⚠", code: "old_version", text: `${c.raw} → 改正前の${title}を指しているため、現行版では確かめていません。asof に当時の日付を指定すると確認できます（${ASOF_MIN} 以降）` };
  }
  return null;
}

/** 法令番号の食い違い・旧題名・略称の注記を付ける */
function withNotes(c: Citation, v: Verdict, title: string, lawNum: string, link: string): Verdict {
  const notes: string[] = [];
  if (c.issues.includes("promulgation_mismatch") && v.mark !== "❌") {
    v = { ...v, mark: "⚠", code: "promulgation_mismatch" };
    notes.push(`括弧内の法令番号「${c.promulgation}」は${title}（${lawNum}）と一致しません`);
  }
  if (c.nameKind === "old_name") notes.push(`「${c.lawName}」は旧題名です（現在は${title}）`);
  if (c.nameKind === "abbrev" || c.nameKind === "alias") notes.push(`「${c.lawName}」は${title}の略称として解釈`);
  return { ...v, text: `${v.text}${notes.length ? `\n   ${notes.join("。")}` : ""}\n   原文: ${link}` };
}

interface Job {
  c: Citation;
  title: string;
  snap?: Verdict;      // スナップショットでの判定（スナップショットにない法令・時点指定のときはなし）
  negative: boolean;   // スナップショットで「ない」と出た、またはスナップショットで確かめられない
}

/**
 * 文章の引用を取り出し、重複を除いて（上限 MAX_CITATIONS 件）確かめる。ツールと評価の共通部分。
 * maxApiCalls を 0 にすると e-Gov を呼ばない（評価）。
 */
export async function verifyText(
  text: string,
  { client, names: dict, structure, asof, defaultLaw: default_law, maxApiCalls = MAX_API_CALLS }:
    { client: EgovClient; names: LawNames; structure: LawStructure; asof?: string; defaultLaw?: string; maxApiCalls?: number },
): Promise<VerifyResult> {
  let defaultId: string | undefined;
  if (default_law) {
    const q = default_law.normalize("NFKC").trim();
    defaultId = LAW_ID_RE.test(q) ? q : dict.lookup(q)[0]?.lawId;
  }
  const all = extractCitations(text, dict, defaultId);
  const seen = new Set<string>();
  const cites = all.filter((c) => {
    const k = `${c.lawId ?? c.lawName ?? ""}|${c.article}|${c.paragraph ?? ""}|${c.item ?? ""}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, MAX_CITATIONS);

  const verdicts: Array<Verdict | undefined> = cites.map((c) => nameVerdict(c, dict, asof) ?? undefined);
  const jobs = new Map<number, Job>();
  cites.forEach((c, i) => {
    if (verdicts[i]) return;
    const meta = structure.meta(c.lawId!);
    const title = meta?.title ?? dict.titleOf(c.lawId!) ?? c.lawName ?? c.lawId!;
    const shape = asof || !meta ? undefined : structure.article(c.lawId!, c.article);
    if (shape === undefined) { jobs.set(i, { c, title, negative: true }); return; }
    const link = egovLawUrl(c.lawId!);
    const at = `（スナップショット ${structure.snapshot} 時点）`;
    let snap: Verdict;
    if (shape === null) {
      snap = { mark: "❌", code: "no_article", text: `${c.raw} → ${title}に${articleLabel(c.article)}はありません${at}` };
    } else {
      const bad = judge(c, title, { ...shape, caption: "" });
      snap = bad ? { ...bad, text: `${bad.text}${at}` }
        : meta!.active ? { mark: "✅", code: "ok", text: `${c.raw} → ${title} ${locate(c)}${at}` }
        : { mark: "⚠", code: "repealed", text: `${c.raw} → ${title} ${locate(c)}${repealText("Repeal")}${at}` };
    }
    jobs.set(i, { c, title, snap: withNotes(c, snap, title, meta!.lawNum, link), negative: snap.mark !== "✅" });
  });

  // API に回す順: スナップショットで「ない」・確かめられないもの → 「ある」もの（抜粋のため）。上限を超えた分はスナップショットの判定のまま
  const order = [...jobs.entries()].sort(([ia, a], [ib, b]) => Number(b.negative) - Number(a.negative) || ia - ib);
  const toApi = new Set(order.slice(0, maxApiCalls).map(([i]) => i));
  let apiCalls = 0;
  await Promise.all([...jobs.entries()].map(async ([i, job]) => {
    const { c, title, snap } = job;
    if (!toApi.has(i)) {
      verdicts[i] = snap ?? { mark: "⚠", code: "fetch_error", text: `${c.raw} → 確認できませんでした（1 回の確認で e-Gov に問い合わせる上限 ${maxApiCalls} 件を超えました。文章を分けて確かめてください）` };
      return;
    }
    apiCalls++;
    try {
      const data = await client.article(c.lawId!, c.article, asof);
      const t = data.revision_info.law_title || title;
      const { shape, paras } = apiShape(data);
      const bad = judge(c, t, shape);
      const repeal = repealText(data.revision_info.repeal_status);
      const v: Verdict = bad ?? {
        mark: repeal ? "⚠" : "✅", code: repeal ? "repealed" : "ok",
        text: `${c.raw} → ${t} ${locate(c)}${shape.caption}${repeal}「${excerptOf(c, paras)}」`,
      };
      verdicts[i] = withNotes(c, v, t, data.law_info.law_num, egovLawUrl(c.lawId!, data.revision_info.law_revision_id));
    } catch (e) {
      if (e instanceof EgovError && (e.code === "404004" || e.code === "400021")) {
        verdicts[i] = { mark: "❌", code: "no_article", text: `${c.raw} → ${title}に${articleLabel(c.article)}はありません${asof ? `（${asof} 時点）` : "（現行版）"}（NOT_FOUND）` };
      } else if (snap) {
        verdicts[i] = { ...snap, text: `${snap.text}\n   e-Gov に問い合わせられなかったため、スナップショットで判定しました（${(e as Error).message}）` };
      } else {
        verdicts[i] = { mark: "⚠", code: "fetch_error", text: `${c.raw} → 確認できませんでした（${(e as Error).message}）` };
      }
    }
  }));

  return { total: all.length, apiCalls, checked: cites.map((citation, i) => ({ citation, verdict: verdicts[i]! })) };
}

export function registerVerifyTools(server: McpServer, client: EgovClient, names: () => LawNames, structure: () => LawStructure): void {
  server.registerTool(
    "verify_citations",
    {
      title: "法令引用の実在確認",
      description:
        "文章に含まれる法令引用（例: 行政手続法第八条第一項、所得税法（昭和四十年法律第三十三号）第五十七条の二）を取り出し、" +
        "法令・条・項・号が実在するか確かめます。法令名の誤り、存在しない条、括弧内の法令番号と名称の食い違い、廃止された法令を知らせ、" +
        "照合用に条文の抜粋を付けます。AI が書いた回答や文書の引用を確認するときに使います。主張の内容が正しいかは判断しません。",
      inputSchema: {
        text: z.string().min(1).max(20000).describe("確認する文章"),
        asof: DATE.optional().describe(`この日に施行されていた版で確認（${ASOF_MIN} 以降）。省略で現行`),
        default_law: z.string().max(120).optional().describe("法令名のない「第N条」をどの法令として扱うか（法令名か法令ID）"),
      },
    },
    async ({ text, asof, default_law }) => {
      if (asof && asof < ASOF_MIN) {
        return { isError: true, content: [{ type: "text" as const, text: `時点指定は ${ASOF_MIN} 以降のみです。` }] };
      }
      const st = structure();
      const res = await verifyText(text, { client, names: names(), structure: st, asof, defaultLaw: default_law });
      if (res.checked.length === 0) {
        return { content: [{ type: "text" as const, text: "法令の条の引用（「第N条」）は見つかりませんでした。" }] };
      }
      const verdicts = res.checked.map((x) => x.verdict);
      const count = (m: Verdict["mark"]) => verdicts.filter((v) => v.mark === m).length;
      const head = `引用 ${verdicts.length} 件を確認${asof ? `（${asof} 時点）` : "（現行）"}: 実在 ${count("✅")}・存在しない ${count("❌")}・要確認 ${count("⚠")}・法令名なし ${count("ℹ")}` +
        (res.total > verdicts.length ? `（重複・上限 ${MAX_CITATIONS} 件を除く ${res.total - verdicts.length} 件は省略）` : "");
      const order = { "❌": 0, "⚠": 1, "ℹ": 2, "✅": 3 } as const;
      const body = verdicts.map((v, i) => ({ v, i })).sort((a, b) => order[a.v.mark] - order[b.v.mark] || a.i - b.i).map(({ v }) => `${v.mark} ${v.text}`);
      return {
        content: [{
          type: "text" as const,
          text: [
            head, "", ...body, "",
            `確認したのは法令・条・項・号の実在だけです。引用した主張が条文に合っているかは、抜粋と原文で確かめてください。` +
            `条・項・号の有無は e-Gov のスナップショット（${st.snapshot}）で調べ、そのうち最大 ${MAX_API_CALLS} 件を現行版で確かめて抜粋を付けています。出典: ${EGOV_SOURCE}`,
          ].join("\n"),
        }],
      };
    },
  );
}
