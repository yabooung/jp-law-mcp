/** 法令名の辞書（scripts/export_names.py が jlawcite から作る data/law_names.json.gz）。 */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import { kanjiToNumber } from "../lib/article.js";

/** new_name: 施行予定の改正で変わる題名（data/law_names.json.gz では 4 つ目に施行日） */
export type NameKind = "canonical" | "abbrev" | "alias" | "old_name" | "promulgation" | "new_name";
export interface NameHit { lawId: string; kind: NameKind; date?: string }

export class LawNames {
  private readonly byName = new Map<string, NameHit[]>();
  private readonly canonical = new Map<string, string>();
  private readonly renames = new Map<string, { title: string; date: string }>();
  readonly maxLen: number;

  constructor(names: Array<[string, string, NameKind] | [string, string, NameKind, string]>) {
    let max = 0;
    for (const [name, lawId, kind, date] of names) {
      const list = this.byName.get(name) ?? [];
      list.push(date ? { lawId, kind, date } : { lawId, kind });
      this.byName.set(name, list);
      if (kind === "canonical") this.canonical.set(lawId, name);
      if (kind === "new_name" && date && (this.renames.get(lawId)?.date ?? "9999") > date) this.renames.set(lawId, { title: name, date });
      if (kind !== "promulgation") max = Math.max(max, name.length);
    }
    // 題名のない法令は「昭和二十二年法律第百七十五号（災害被害者に対する…法律）」の形で入っている。括弧の中の名前でも引けるようにする
    for (const [lawId, title] of this.canonical) {
      const m = /^[^（]+号（(.+)）$/.exec(title);
      if (!m || this.byName.get(m[1])?.some((h) => h.lawId === lawId)) continue;
      const list = this.byName.get(m[1]) ?? [];
      list.push({ lawId, kind: "canonical" });
      this.byName.set(m[1], list);
      max = Math.max(max, m[1].length);
    }
    this.maxLen = max;
  }

  static load(url: URL = new URL("../../data/law_names.json.gz", import.meta.url)): LawNames {
    const raw = JSON.parse(gunzipSync(readFileSync(url)).toString("utf-8")) as { names: Array<[string, string, NameKind, string]> };
    return new LawNames(raw.names);
  }

  lookup(name: string): NameHit[] {
    return (this.byName.get(name) ?? []).filter((h) => h.kind !== "promulgation");
  }

  titleOf(lawId: string): string | undefined {
    return this.canonical.get(lawId);
  }

  /** 施行予定の改正で題名が変わるなら、その題名と施行日（いちばん早いもの） */
  renameOf(lawId: string): { title: string; date: string } | undefined {
    return this.renames.get(lawId);
  }

  /** 文字列の末尾に一致する最も長い法令名 */
  longestSuffix(s: string): { name: string; hits: NameHit[] } | null {
    for (let len = Math.min(this.maxLen, s.length); len >= 2; len--) {
      const name = s.slice(s.length - len);
      const hits = this.lookup(name);
      if (hits.length) return { name, hits };
    }
    return null;
  }

  /** 「平成五年法律第八十八号」→ 該当する law_id（辞書は算用数字で持つ）。法令番号として読めなければ null */
  byPromulgation(text: string): string[] | null {
    const m = /(明治|大正|昭和|平成|令和)([元〇一二三四五六七八九十百千0-9]+)年(.+?)第([〇一二三四五六七八九十百千0-9]+)号/.exec(text);
    if (!m) return null;
    const year = m[2] === "元" ? 1 : kanjiToNumber(m[2]);
    const num = kanjiToNumber(m[4]);
    if (!year || !num) return null;
    const key = `${m[1]}${year}年${m[3]}第${num}号`;
    return (this.byName.get(key) ?? []).filter((h) => h.kind === "promulgation").map((h) => h.lawId);
  }
}

let cached: LawNames | undefined;
export function defaultNames(): LawNames {
  cached ??= LawNames.load();
  return cached;
}
