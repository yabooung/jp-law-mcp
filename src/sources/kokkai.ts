/**
 * 国会会議録検索システム 検索用API クライアント (https://kokkai.ndl.go.jp/api.html)
 *
 * 利用上の注意（同ページ, 2026-10-19 確認）を守るための作り:
 * - 多重リクエストをしない → すべてのリクエストを 1 本の待ち行列で直列に送る
 * - 取得し終えてから数秒空けて次のリクエスト → 前の応答を受け終えてから minIntervalMs 待つ
 * - 検索条件は合計 2,000 バイトまで → 送る前に検査する
 * - 「短時間での大量アクセス等」はご遠慮ください → 同じ検索の結果を保存して送り直さない（既定 24 時間）。
 *   待ち行列が長いとき（既定 4 件超）は並ばせずに「混雑」と返す。待ち行列は 1 インスタンスの中でしか効かないので、
 *   遠隔コネクタでインスタンスが増えても 1 台あたりの送信はこの間隔に収まる、という上限の作り（全体の直列化ではない）。
 * - 送り手が分かるように User-Agent を付ける
 * - 転送・429・503・HTML の応答は遮断や保守のしるしとみなし、blockedMs（既定 10 分）は送らずにすぐ断る
 */
import { USER_AGENT } from "../version.js";

export const KOKKAI_BASE = "https://kokkai.ndl.go.jp/api";
export const KOKKAI_SOURCE = "国会会議録検索システム（国立国会図書館）";

export type House = "衆議院" | "参議院" | "両院";

export interface SpeechQuery {
  any?: string;            // 発言内容のキーワード（部分一致・空白区切りは AND）
  speaker?: string;        // 発言者名（部分一致・空白区切りは OR）
  nameOfHouse?: House;
  nameOfMeeting?: string;  // 会議名（部分一致・空白区切りは OR）
  from?: string;           // YYYY-MM-DD
  until?: string;          // YYYY-MM-DD
  startRecord?: number;    // 1 から
  maximumRecords?: number; // 1–100
}

export interface SpeechRecord {
  speechID: string;
  issueID: string;
  session: number;
  nameOfHouse: string;
  nameOfMeeting: string;
  issue: string;
  date: string;
  speechOrder: number;
  speaker: string;
  speakerYomi?: string | null;
  speakerGroup?: string | null;
  speakerPosition?: string | null;
  speakerRole?: string | null;
  speech: string;
  speechURL: string;
  meetingURL: string;
  pdfURL?: string | null;
}

export interface SpeechResult {
  numberOfRecords: number;
  numberOfReturn: number;
  startRecord: number;
  nextRecordPosition?: number | null;
  speechRecord: SpeechRecord[];
}

export class KokkaiError extends Error {
  constructor(message: string, readonly details: string[] = [], readonly status?: number) {
    super(message);
    this.name = "KokkaiError";
  }
}

export interface KokkaiClientOptions {
  baseUrl?: string;
  minIntervalMs?: number; // 前の応答を受け終えてから次を送るまでの間隔
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  cacheTtlMs?: number; // 同じ検索の結果を使い回す時間
  cacheMax?: number;
  maxQueue?: number;   // 待っている要求がこれを超えたら送らずに断る
  userAgent?: string;
  blockedMs?: number;
}

export const KOKKAI_BLOCKED = "国会会議録APIが応答を制限しているか停止中です。しばらくしてからやり直してください";

const MAX_QUERY_BYTES = 2000;


export class KokkaiClient {
  private readonly baseUrl: string;
  private readonly minIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly cacheTtlMs: number;
  private readonly cacheMax: number;
  private readonly maxQueue: number;
  private readonly userAgent: string;
  private readonly blockedMs: number;
  private blockedUntil = -Infinity;
  private queue: Promise<unknown> = Promise.resolve();
  private lastFinishedAt = -Infinity;
  private waiting = 0;
  private cache = new Map<string, { at: number; value: Promise<unknown> }>();

  constructor(opts: KokkaiClientOptions = {}) {
    this.baseUrl = opts.baseUrl ?? KOKKAI_BASE;
    this.minIntervalMs = opts.minIntervalMs ?? 3000;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? (() => Date.now());
    this.cacheTtlMs = opts.cacheTtlMs ?? 24 * 3600_000;
    this.cacheMax = opts.cacheMax ?? 200;
    this.maxQueue = opts.maxQueue ?? 4;
    this.userAgent = opts.userAgent ?? USER_AGENT;
    this.blockedMs = opts.blockedMs ?? 10 * 60_000;
  }

  searchSpeeches(q: SpeechQuery): Promise<SpeechResult> {
    const url = this.buildUrl("speech", q);
    const hit = this.cache.get(url);
    if (hit && this.now() - hit.at < this.cacheTtlMs) return hit.value as Promise<SpeechResult>;
    if (this.waiting >= this.maxQueue) {
      return Promise.reject(new KokkaiError("国会会議録APIへの問い合わせが混み合っています。少し時間をおいてやり直してください"));
    }
    const value = this.enqueue(() => this.get<SpeechResult>(url));
    this.cache.set(url, { at: this.now(), value });
    value.catch(() => this.cache.delete(url)); // 失敗は保存しない
    if (this.cache.size > this.cacheMax) this.cache.delete(this.cache.keys().next().value as string);
    return value;
  }

  /** 送信を 1 本の待ち行列に並べる。前の要求が失敗しても行列は止めない。 */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    this.waiting++;
    const run = this.queue.then(async () => {
      const wait = this.lastFinishedAt + this.minIntervalMs - this.now();
      if (wait > 0) await this.sleep(wait);
      try {
        return await task();
      } finally {
        this.lastFinishedAt = this.now();
        this.waiting--;
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  buildUrl(endpoint: "speech", q: SpeechQuery): string {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) {
      if (v === undefined || v === null || v === "") continue;
      params.set(k, String(v));
    }
    params.set("recordPacking", "json");
    const qs = params.toString();
    if (new TextEncoder().encode(qs).length > MAX_QUERY_BYTES) {
      throw new KokkaiError(`検索条件が長すぎます（合計 ${MAX_QUERY_BYTES} バイトまで）`);
    }
    return `${this.baseUrl}/${endpoint}?${qs}`;
  }

  private async get<T>(url: string): Promise<T> {
    if (this.now() < this.blockedUntil) throw new KokkaiError(KOKKAI_BLOCKED);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, { signal: ctrl.signal, headers: { Accept: "application/json", "User-Agent": this.userAgent }, redirect: "manual" });
    } catch (e) {
      throw new KokkaiError(ctrl.signal.aborted ? `国会会議録APIが ${this.timeoutMs / 1000} 秒以内に応答しませんでした`
        : `国会会議録APIに接続できませんでした: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
    if ((res.status >= 300 && res.status < 400) || res.status === 429 || res.status === 503 || /text\/html/i.test(res.headers.get("content-type") ?? "")) {
      this.blockedUntil = this.now() + this.blockedMs;
      throw new KokkaiError(KOKKAI_BLOCKED, [], res.status);
    }
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new KokkaiError(`国会会議録APIの応答を読めませんでした（HTTP ${res.status}）`, [], res.status);
    }
    const err = body as { message?: string; details?: string[] };
    if (!res.ok || typeof err.message === "string") {
      throw new KokkaiError(err.message ?? `HTTP ${res.status}`, err.details ?? [], res.status);
    }
    return body as T;
  }
}
