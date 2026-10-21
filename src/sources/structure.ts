/**
 * 条・項・号の形（scripts/export_structure.py が e-Gov スナップショットから作る data/structure.json.gz）。
 *
 * verify_citations は実在の確認をこれで済ませ、e-Gov API を呼ぶ回数を抑える（CONTRIBUTING.md「外部 API の使い方」）。
 * 法令ごとの文字列は、その法令を初めて引いたときに読み解く。
 */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

export interface ArticleShape {
  paragraphs: number;     // 項の数（項番号のない条は 0）
  items: number[];        // items[i] = 第 i+1 項の号の数
  tables: Set<number>;    // 表の形の項
}

export interface LawMeta { title: string; lawNum: string; active: boolean }

type Raw = { snapshot: string; laws: Record<string, [string, string, 0 | 1, string]> };

export class LawStructure {
  readonly snapshot: string;
  private readonly laws: Raw["laws"];
  private readonly parsed = new Map<string, Map<string, ArticleShape>>();

  constructor(raw: Raw) {
    this.snapshot = raw.snapshot;
    this.laws = raw.laws;
  }

  static load(url: URL = new URL("../../data/structure.json.gz", import.meta.url)): LawStructure {
    return new LawStructure(JSON.parse(gunzipSync(readFileSync(url)).toString("utf-8")) as Raw);
  }

  meta(lawId: string): LawMeta | undefined {
    const l = this.laws[lawId];
    return l && { title: l[0], lawNum: l[1], active: l[2] === 1 };
  }

  /** 法令がスナップショットにないとき undefined、法令はあるが条がないとき null */
  article(lawId: string, article: string): ArticleShape | null | undefined {
    const l = this.laws[lawId];
    if (!l) return undefined;
    let arts = this.parsed.get(lawId);
    if (!arts) {
      arts = new Map();
      for (const part of l[3] ? l[3].split(";") : []) {
        const [art, p, its, tbl] = part.split(":");
        arts.set(art, {
          paragraphs: Number(p),
          items: its ? its.split(",").map(Number) : [],
          tables: new Set(tbl ? tbl.split(",").map(Number) : []),
        });
      }
      if (this.parsed.size >= 200) this.parsed.delete(this.parsed.keys().next().value as string);
      this.parsed.set(lawId, arts);
    }
    return arts.get(article) ?? null;
  }

  /** 本則の最後の条（"372"・"36_2"）。「第N条まで」と知らせるため。条番号を数として比べる */
  lastArticle(lawId: string): string | undefined {
    if (this.article(lawId, "") === undefined) return undefined;
    const key = (a: string) => a.split("_").map(Number);
    let best: string | undefined;
    for (const a of this.parsed.get(lawId)!.keys()) {
      if (a === "0") continue;
      const [x, y] = [key(a), best ? key(best) : [-1]];
      const cmp = x.map((v, i) => v - (y[i] ?? -1)).find((d) => d !== 0) ?? x.length - y.length;
      if (cmp > 0) best = a;
    }
    return best;
  }
}

let cached: LawStructure | undefined;
export function defaultStructure(): LawStructure {
  cached ??= LawStructure.load();
  return cached;
}
