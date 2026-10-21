/**
 * 国税庁の基本通達の番号と見出し（scripts/export_tsutatsu.py が国税庁ホームページから作る data/tsutatsu.json.gz）。
 * verify_citations が「所得税基本通達36-1」のような通達番号の実在を確かめるのに使う。ファイルがなければ確かめない。
 */
import { existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

type Raw = { meta: { source: string; fetched: string }; notices: Record<string, { url: string; items: Record<string, string> }> };

/** 書き方の揺れ・略称 → data の通達名 */
const ALIASES: Record<string, string> = {
  所得税基本通達: "所得税基本通達", 所得税法基本通達: "所得税基本通達", 所基通: "所得税基本通達",
  法人税基本通達: "法人税基本通達", 法人税法基本通達: "法人税基本通達", 法基通: "法人税基本通達",
  消費税法基本通達: "消費税法基本通達", 消費税基本通達: "消費税法基本通達", 消基通: "消費税法基本通達",
  相続税法基本通達: "相続税法基本通達", 相続税基本通達: "相続税法基本通達", 相基通: "相続税法基本通達",
  財産評価基本通達: "財産評価基本通達", 評価基本通達: "財産評価基本通達", 評価通達: "財産評価基本通達", 評基通: "財産評価基本通達",
};

export const normalizeNoticeNumber = (s: string) =>
  s.normalize("NFKC").replace(/[‐‑‒–—―−－ー]/g, "-").replace(/[～〜]/g, "~").replace(/\s+/g, "")
    .replace(/[（(]\d+[）)]$/, "").replace(/^[（(]|[）)]$/g, "");

export class NoticeIndex {
  constructor(private readonly raw: Raw) {}

  static load(url: URL = new URL("../../data/tsutatsu.json.gz", import.meta.url)): NoticeIndex | undefined {
    if (!existsSync(url)) return undefined;
    return new NoticeIndex(JSON.parse(gunzipSync(readFileSync(url)).toString("utf-8")) as Raw);
  }

  get fetched(): string { return this.raw.meta.fetched; }

  /** 引用に書かれた通達名を、確かめられる通達名に。確かめられないものは undefined */
  resolve(name: string): string | undefined {
    const key = ALIASES[name.normalize("NFKC")];
    return key && this.raw.notices[key] ? key : undefined;
  }

  /** 番号があれば見出し（空文字のこともある）、なければ undefined */
  item(notice: string, num: string): string | undefined {
    return this.raw.notices[notice]?.items[normalizeNoticeNumber(num)];
  }

  url(notice: string): string | undefined { return this.raw.notices[notice]?.url; }
}

let cached: NoticeIndex | undefined | null;
export function defaultNotices(): NoticeIndex | undefined {
  if (cached === undefined) cached = NoticeIndex.load() ?? null;
  return cached ?? undefined;
}
