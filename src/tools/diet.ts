import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { KOKKAI_SOURCE, KokkaiClient, KokkaiError, type SpeechRecord, type SpeechResult } from "../sources/kokkai.js";

const EXCERPT_RADIUS = 160;

/** 最初に見つかったキーワードの前後を切り出す。見つからなければ冒頭。 */
export function excerpt(speech: string, keywords: string[], radius = EXCERPT_RADIUS): string {
  const text = speech.replace(/\s+/g, " ").trim();
  let at = -1;
  for (const k of keywords) {
    const i = k ? text.indexOf(k) : -1;
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return text.length > radius * 2 ? text.slice(0, radius * 2) + "…" : text;
  const s = Math.max(0, at - radius);
  const e = Math.min(text.length, at + radius);
  return (s > 0 ? "…" : "") + text.slice(s, e) + (e < text.length ? "…" : "");
}

function speakerLine(r: SpeechRecord): string {
  const extra = [r.speakerGroup, r.speakerPosition, r.speakerRole].filter(Boolean).join("・");
  return extra ? `${r.speaker}（${extra}）` : r.speaker;
}

export function formatSpeeches(res: SpeechResult, keywords: string[]): string {
  if (res.numberOfRecords === 0 || res.speechRecord.length === 0) {
    return `該当する発言は見つかりませんでした（NOT_FOUND）。キーワードを減らす・期間を広げる・会議名を外すと見つかることがあります。\n出典: ${KOKKAI_SOURCE}`;
  }
  const lines = [`該当 ${res.numberOfRecords} 件中 ${res.startRecord}〜${res.startRecord + res.numberOfReturn - 1} 件目`];
  res.speechRecord.forEach((r, i) => {
    lines.push(
      "",
      `[${res.startRecord + i}] ${r.date} 第${r.session}回 ${r.nameOfHouse} ${r.nameOfMeeting} ${r.issue}`,
      `発言者: ${speakerLine(r)}`,
      excerpt(r.speech, keywords),
      `発言: ${r.speechURL}`,
    );
  });
  if (res.nextRecordPosition) {
    lines.push("", `続き: start=${res.nextRecordPosition} を指定してください。`);
  }
  lines.push("", `出典: ${KOKKAI_SOURCE}。発言の全文と正確な文言は各リンク先で確認してください。`);
  return lines.join("\n");
}

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD 形式");

export function registerDietTools(server: McpServer, client: KokkaiClient): void {
  server.registerTool(
    "search_diet_records",
    {
      title: "国会会議録の発言検索",
      description:
        "国会会議録（衆議院・参議院の本会議・委員会）の発言を検索します。法律の立法趣旨、政府答弁、条文の解釈についての国会での説明を確かめるときに使います。" +
        "結果は発言ごとの抜粋と国会会議録検索システムへのリンクです。条件を少なくとも 1 つ指定してください。",
      inputSchema: {
        keyword: z.string().max(200).optional().describe("発言内容のキーワード。空白区切りは AND。例: 「行政手続法 理由の提示」"),
        speaker: z.string().max(100).optional().describe("発言者名（部分一致）"),
        house: z.enum(["衆議院", "参議院", "両院"]).optional().describe("院"),
        meeting: z.string().max(100).optional().describe("会議名（部分一致）。例: 総務委員会"),
        from: DATE.optional().describe("開始日 YYYY-MM-DD"),
        until: DATE.optional().describe("終了日 YYYY-MM-DD"),
        limit: z.number().int().min(1).max(20).default(5).describe("件数（1〜20）"),
        start: z.number().int().min(1).default(1).describe("開始位置（続きを読むとき）"),
      },
    },
    async ({ keyword, speaker, house, meeting, from, until, limit, start }) => {
      if (!keyword && !speaker && !house && !meeting && !from && !until) {
        return { isError: true, content: [{ type: "text", text: "条件を少なくとも 1 つ指定してください（keyword・speaker・meeting など）。" }] };
      }
      try {
        const res = await client.searchSpeeches({
          any: keyword, speaker, nameOfHouse: house, nameOfMeeting: meeting, from, until,
          startRecord: start, maximumRecords: limit,
        });
        const keywords = (keyword ?? "").split(/\s+/).filter(Boolean);
        return { content: [{ type: "text", text: formatSpeeches(res, keywords) }] };
      } catch (e) {
        const msg = e instanceof KokkaiError
          ? [e.message, ...e.details].join(" / ")
          : `予期しないエラー: ${(e as Error).message}`;
        return { isError: true, content: [{ type: "text", text: `国会会議録の検索に失敗しました: ${msg}` }] };
      }
    },
  );
}
