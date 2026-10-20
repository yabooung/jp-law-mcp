/**
 * 条単位の引用・委任グラフ（scripts/export_graph.py が jlawcite から作る data/graph.json.gz）。
 * 逆引き（この条を引用しているのは誰か）を一瞬で返せるよう、読み込み時に正引き・逆引きの表を作る。
 */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

export const REL_CITES = 0;
export const REL_DELEGATES = 1;

export interface GraphMeta {
  source: string;
  license: string;
  egov_snapshot: string;
  scope: string;
  counts: Record<string, number>;
}

interface Raw {
  meta: GraphMeta;
  laws: Array<[string, string]>;
  arts: Array<[number, string]>;
  e: Array<[number, number, number, number]>;
  l: Array<[number, number, number, number]>;
}

export interface Edge { art: number; rel: number; n: number }
export interface LawEdge { law: number; rel: number; n: number }

/** 隣接表（CSR）: idx[start[i]..start[i+1]] が i の辺の番号。メモリを食わないよう数の配列だけで持つ */
interface Csr { start: Int32Array; idx: Int32Array }
function csr(count: number, key: Int32Array): Csr {
  const start = new Int32Array(count + 1);
  for (let j = 0; j < key.length; j++) start[key[j] + 1]++;
  for (let i = 0; i < count; i++) start[i + 1] += start[i];
  const pos = start.slice(0, count);
  const idx = new Int32Array(key.length);
  for (let j = 0; j < key.length; j++) idx[pos[key[j]]++] = j;
  return { start, idx };
}

export class CitationGraph {
  readonly meta: GraphMeta;
  readonly laws: Array<[string, string]>;
  private readonly artLaw: Int32Array;
  private readonly artPath: string[];
  private readonly artIndex = new Map<string, number>();
  private readonly lawIndex = new Map<string, number>();
  private readonly titleIndex = new Map<string, number[]>();
  private readonly lawArts: number[][];
  private readonly eSrc: Int32Array;
  private readonly eDst: Int32Array;
  private readonly eRel: Int8Array;
  private readonly eN: Int32Array;
  private readonly out: Csr;
  private readonly inc: Csr;
  private readonly outLaw: LawEdge[][];
  private readonly incLaw: Array<Array<{ art: number; rel: number; n: number }>>;

  constructor(raw: Raw) {
    this.meta = raw.meta;
    this.laws = raw.laws;
    raw.laws.forEach(([id, title], i) => {
      this.lawIndex.set(id, i);
      const list = this.titleIndex.get(title) ?? [];
      list.push(i);
      this.titleIndex.set(title, list);
    });
    const n = raw.arts.length;
    this.artLaw = new Int32Array(n);
    this.artPath = new Array<string>(n);
    this.lawArts = raw.laws.map(() => []);
    raw.arts.forEach(([law, path], i) => {
      this.artLaw[i] = law;
      this.artPath[i] = path;
      this.artIndex.set(`${raw.laws[law][0]}_${path}`, i);
      this.lawArts[law].push(i);
    });
    const m = raw.e.length;
    this.eSrc = new Int32Array(m);
    this.eDst = new Int32Array(m);
    this.eRel = new Int8Array(m);
    this.eN = new Int32Array(m);
    raw.e.forEach(([s, d, r, c], j) => { this.eSrc[j] = s; this.eDst[j] = d; this.eRel[j] = r; this.eN[j] = c; });
    this.out = csr(n, this.eSrc);
    this.inc = csr(n, this.eDst);
    this.outLaw = Array.from({ length: n }, () => [] as LawEdge[]);
    this.incLaw = raw.laws.map(() => []);
    for (const [s, law, r, c] of raw.l) {
      this.outLaw[s].push({ law, rel: r, n: c });
      this.incLaw[law].push({ art: s, rel: r, n: c });
    }
  }

  static load(url: URL = new URL("../../data/graph.json.gz", import.meta.url)): CitationGraph {
    return new CitationGraph(JSON.parse(gunzipSync(readFileSync(url)).toString("utf-8")) as Raw);
  }

  lawOf(art: number): number { return this.artLaw[art]; }
  pathOf(art: number): string { return this.artPath[art]; }
  lawId(law: number): string { return this.laws[law][0]; }
  lawTitle(law: number): string { return this.laws[law][1]; }
  findLaw(lawId: string): number | undefined { return this.lawIndex.get(lawId); }
  findLawsByTitle(title: string): number[] { return this.titleIndex.get(title) ?? []; }
  /** "57_2" → 条の番号 */
  findArticle(lawId: string, num: string): number | undefined { return this.artIndex.get(`${lawId}_a${num.replace(/_/g, "-")}`); }
  articlesOfLaw(law: number): number[] { return this.lawArts[law] ?? []; }

  private edges(c: Csr, art: number, other: Int32Array): Edge[] {
    const out: Edge[] = [];
    for (let k = c.start[art]; k < c.start[art + 1]; k++) {
      const j = c.idx[k];
      out.push({ art: other[j], rel: this.eRel[j], n: this.eN[j] });
    }
    return out;
  }

  citing(art: number): Edge[] { return this.edges(this.inc, art, this.eSrc); }
  cited(art: number): Edge[] { return this.edges(this.out, art, this.eDst); }
  citedLaws(art: number): LawEdge[] { return this.outLaw[art]; }
  /** 条を特定しない参照（「同法」・委任の「政令で定める」など）で法令ごと指している条 */
  citingLaw(law: number): Array<{ art: number; rel: number; n: number }> { return this.incLaw[law] ?? []; }
}

let cached: CitationGraph | undefined;
/** 初回だけ読む（他のツールの起動を遅くしない） */
export function defaultGraph(): CitationGraph {
  cached ??= CitationGraph.load();
  return cached;
}
