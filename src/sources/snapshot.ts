/**
 * 評価専用の「スナップショット・モード」: e-Gov 法令API の代わりに、jlawcite の検索DBから書き出した本文
 * （scripts/export_texts.py → work/eval_texts.json.gz）で答える EgovClient。
 *
 * 答えの評価（eval/answer_eval.mjs）で 50 問を回しても e-Gov に問い合わせないためのもの（CONTRIBUTING.md「外部 API の使い方」）。
 * スナップショットは月 1 回なので「現行」とは言えない。運用中のサーバー・npm パッケージでは使わない
 * （環境変数 JP_LAW_MCP_SNAPSHOT_TEXTS を指定したときだけ src/index.ts が使う）。
 *
 * できないこと: 時点指定（asof）、改正履歴（スナップショットの版 1 件だけを返す）、条の見出し（DB にない）、表・図。
 */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import {
  EgovClient, EgovError,
  type KeywordResponse, type LawDataResponse, type LawInfo, type LawsResponse, type RevisionInfo, type RevisionsResponse,
} from "./egov.js";

type Para = [number, string, Array<[string, string]>];
type Law = [string, string, string, string, string, Array<[string, Para[]]>];
interface Texts { snapshot: string; jlawcite: string; laws: Record<string, Law> }

const TYPE: Record<string, string> = {
  act: "Act", cabinet_order: "CabinetOrder", imperial_order: "ImperialOrder", ministerial: "MinisterialOrdinance", dajokan: "Misc",
};
const DIGIT = ["〇", "一", "二", "三", "四", "五", "六", "七", "八", "九"];

/** 1〜9999 を漢数字に（条名「第三十六条の二」用） */
export function toKanji(n: number): string {
  if (n === 0) return DIGIT[0];
  let out = "";
  for (const [unit, ch] of [[1000, "千"], [100, "百"], [10, "十"]] as const) {
    const d = Math.floor(n / unit);
    if (d) out += (d > 1 ? DIGIT[d] : "") + ch;
    n %= unit;
  }
  return out + (n ? DIGIT[n] : "");
}
const articleTitle = (art: string) => {
  const [head, ...rest] = art.split("_").map(Number);
  return `第${toKanji(head)}条${rest.map((r) => `の${toKanji(r)}`).join("")}`;
};

export class SnapshotEgovClient extends EgovClient {
  private readonly texts: Texts;

  constructor(path: string) {
    super({ fetchImpl: (async () => { throw new Error("スナップショット・モードでは e-Gov に問い合わせない"); }) as unknown as typeof fetch });
    this.texts = JSON.parse(gunzipSync(readFileSync(path)).toString("utf-8")) as Texts;
  }

  private law(lawId: string): Law {
    const l = this.texts.laws[lawId];
    if (!l) throw new EgovError("指定の法令はスナップショットにありません", "404004", 404);
    return l;
  }

  private info(lawId: string): { law_info: LawInfo; revision_info: RevisionInfo } {
    const [title, num, type, enf, rev] = this.law(lawId);
    return {
      law_info: { law_type: TYPE[type] ?? type, law_id: lawId, law_num: num, promulgation_date: "" },
      revision_info: {
        law_revision_id: rev ? `${lawId}_${rev}` : lawId, law_type: TYPE[type] ?? type, law_title: title,
        amendment_enforcement_date: enf ? `${enf.slice(0, 4)}-${enf.slice(4, 6)}-${enf.slice(6, 8)}` : null,
        amendment_enforcement_comment: `e-Gov スナップショット ${this.texts.snapshot}（評価モード）`,
        current_revision_status: "CurrentEnforced",
      },
    };
  }

  private articleJson(art: string, paras: Para[]): unknown {
    return {
      ArticleTitle: articleTitle(art),
      Paragraph: paras.map(([n, text, items]) => ({
        ParagraphNum: n > 1 ? String(n) : "",
        ParagraphSentence: text,
        ...(items.length ? { Item: items.map(([title, body]) => ({ ItemTitle: title, ItemSentence: body })) } : {}),
      })),
    };
  }

  override async searchLaws(title: string, opts: { asof?: string; limit?: number } = {}): Promise<LawsResponse> {
    const hits = Object.keys(this.texts.laws).filter((id) => this.texts.laws[id][0].includes(title));
    const limit = opts.limit ?? 20;
    return {
      total_count: hits.length, count: Math.min(hits.length, limit),
      laws: hits.slice(0, limit).map((id) => this.info(id)),
    };
  }

  override async revisions(lawId: string): Promise<RevisionsResponse> {
    const { law_info, revision_info } = this.info(lawId);
    return { law_info, revisions: [revision_info] };
  }

  override async article(lawId: string, articleNum: string, asof?: string): Promise<LawDataResponse> {
    if (asof) throw new EgovError("評価モード（スナップショット）では時点指定は使えません", "snapshot_asof");
    const found = this.law(lawId)[5].find(([art]) => art === articleNum);
    if (!found) throw new EgovError("指定のパラメータで取得できる法令本文ファイルは存在しません。", "404004", 404);
    return { ...this.info(lawId), law_full_text: { Article: this.articleJson(found[0], found[1]) } };
  }

  override async fullLaw(lawId: string, asof?: string): Promise<LawDataResponse> {
    if (asof) throw new EgovError("評価モード（スナップショット）では時点指定は使えません", "snapshot_asof");
    const arts = this.law(lawId)[5].map(([art, paras]) => this.articleJson(art, paras));
    return { ...this.info(lawId), law_full_text: { MainProvision: { Article: arts } } };
  }

  /** 本文の検索: 空白区切りの語をすべて含む項（号を含む）を法令ごとに。e-Gov と同じく語を <span> で囲む */
  override async keyword(keyword: string, opts: { lawType?: string; asof?: string; limit?: number; sentencesLimit?: number } = {}): Promise<KeywordResponse> {
    if (opts.asof) throw new EgovError("評価モード（スナップショット）では時点指定は使えません", "snapshot_asof");
    const words = keyword.split(/\s+/).filter(Boolean);
    const types = opts.lawType?.split(",");
    const items: KeywordResponse["items"] = [];
    let sentences = 0;
    for (const [id, law] of Object.entries(this.texts.laws)) {
      if (types && !types.includes(TYPE[law[2]] ?? law[2])) continue;
      const hits: Array<{ position: string; text: string }> = [];
      for (const [, paras] of law[5]) {
        for (const [, text, its] of paras) {
          const full = text + its.map(([t, b]) => t + b).join("");
          if (words.every((w) => full.includes(w))) {
            hits.push({ position: "mainprovision", text: words.reduce((s, w) => s.split(w).join(`<span>${w}</span>`), full).slice(0, 300) });
          }
        }
      }
      if (hits.length) {
        sentences += hits.length;
        items.push({ ...this.info(id), sentences: hits.slice(0, opts.sentencesLimit ?? 15) });
      }
    }
    items.sort((x, y) => y.sentences.length - x.sentences.length);
    return { total_count: sentences, sentence_count: sentences, items: items.slice(0, opts.limit ?? 5) };
  }
}
