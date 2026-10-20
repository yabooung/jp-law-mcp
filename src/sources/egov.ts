/**
 * e-Gov 法令API Version 2 クライアント (https://laws.e-gov.go.jp/api/2, 仕様 lawapi-v2.yaml 2.1.139)
 *
 * - 時点指定（asof）は 2017-04-01 以降のみ（API エラー 400044, 2026-10-19 確認）
 * - 回数制限は公開されていない（仕様書は大量取得に XML 一括ダウンロードを案内）。ただし 2026-10-20、
 *   約 4 件/秒を 40 秒ほど続けたところで、この PC からの /law_data だけがエラーページ（/sorry/404-notfound.html）
 *   への転送になった（別の回線からは同じ URL が正常）。そこで:
 *   - 同時 2 本まで・送り始めの間隔を minIntervalMs（既定 500ms, 1 インスタンスあたり 2 件/秒以下）空ける
 *   - 同じ問い合わせは 10 分キャッシュ
 *   - エラーページへの転送・429・503・HTML の応答は「制限中」とし、blockedMs（既定 10 分）は送らずにすぐ断る
 *   上限を上げる変更は CONTRIBUTING.md「外部 API の使い方」に従う
 */

import { USER_AGENT } from "../version.js";

export const EGOV_API = "https://laws.e-gov.go.jp/api/2";
export const EGOV_SITE = "https://laws.e-gov.go.jp";
export const EGOV_SOURCE = "e-Gov 法令検索（デジタル庁）";
export const ASOF_MIN = "2017-04-01";

export interface LawInfo {
  law_type: string;
  law_id: string;
  law_num: string;
  promulgation_date: string;
}

export interface RevisionInfo {
  law_revision_id: string;
  law_type: string;
  law_title: string;
  abbrev?: string | null;
  category?: string | null;
  amendment_promulgate_date?: string | null;
  amendment_enforcement_date?: string | null;
  amendment_scheduled_enforcement_date?: string | null;
  amendment_enforcement_comment?: string | null;
  amendment_law_id?: string | null;
  amendment_law_title?: string | null;
  amendment_law_num?: string | null;
  repeal_status?: string | null;
  repeal_date?: string | null;
  current_revision_status?: "CurrentEnforced" | "PreviousEnforced" | "UnEnforced" | string;
}

export interface LawsResponse {
  total_count: number;
  count: number;
  laws: Array<{ law_info: LawInfo; revision_info: RevisionInfo; current_revision_info?: RevisionInfo }>;
}

export interface RevisionsResponse {
  law_info: LawInfo;
  revisions: RevisionInfo[];
}

export interface LawDataResponse {
  law_info: LawInfo;
  revision_info: RevisionInfo;
  law_full_text: unknown;
}

export interface KeywordResponse {
  total_count: number;
  sentence_count: number;
  next_offset?: number;
  items: Array<{ law_info: LawInfo; revision_info: RevisionInfo; sentences: Array<{ position: string; text: string }> }>;
}

export class EgovError extends Error {
  constructor(message: string, readonly code?: string, readonly status?: number) {
    super(message);
    this.name = "EgovError";
  }
}

export interface EgovClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  maxConcurrent?: number;
  cacheTtlMs?: number;
  cacheMax?: number;
  timeoutMs?: number;
  minIntervalMs?: number;
  blockedMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const BLOCKED_MESSAGE = "e-Gov 法令APIが応答を制限しているか停止中です（エラーページに転送されました）。しばらくしてからやり直してください";

export class EgovClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxConcurrent: number;
  private readonly cacheTtlMs: number;
  private readonly cacheMax: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly minIntervalMs: number;
  private readonly blockedMs: number;
  private nextSlot = -Infinity;
  private blockedUntil = -Infinity;
  private active = 0;
  private waiters: Array<() => void> = [];
  private cache = new Map<string, { at: number; value: Promise<unknown> }>();

  constructor(opts: EgovClientOptions = {}) {
    this.baseUrl = opts.baseUrl ?? EGOV_API;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.maxConcurrent = opts.maxConcurrent ?? 2;
    this.cacheTtlMs = opts.cacheTtlMs ?? 10 * 60_000;
    this.cacheMax = opts.cacheMax ?? 300;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((res) => setTimeout(res, ms)));
    this.minIntervalMs = opts.minIntervalMs ?? 500;
    this.blockedMs = opts.blockedMs ?? 10 * 60_000;
  }

  searchLaws(title: string, opts: { asof?: string; limit?: number } = {}): Promise<LawsResponse> {
    return this.get("/laws", { law_title: title, asof: opts.asof, limit: String(opts.limit ?? 20) });
  }

  revisions(lawId: string): Promise<RevisionsResponse> {
    return this.get(`/law_revisions/${encodeURIComponent(lawId)}`, {});
  }

  /** 本文の全文検索。0 件のとき API は 404 を返すので空の結果にする。 */
  async keyword(keyword: string, opts: { lawType?: string; asof?: string; limit?: number; sentencesLimit?: number } = {}): Promise<KeywordResponse> {
    try {
      return await this.get<KeywordResponse>("/keyword", {
        keyword, law_type: opts.lawType, asof: opts.asof, limit: String(opts.limit ?? 5),
        sentences_limit: String(opts.sentencesLimit ?? 15),
      });
    } catch (e) {
      if (e instanceof EgovError && e.status === 404) return { total_count: 0, sentence_count: 0, items: [] };
      throw e;
    }
  }

  /** 法令の全文（簡易版 JSON）。大きい（租税特別措置法で約 700 万字）ので結果を保存しない。 */
  fullLaw(lawId: string, asof?: string): Promise<LawDataResponse> {
    const u = new URL(`${this.baseUrl}/law_data/${encodeURIComponent(lawId)}`);
    u.searchParams.set("json_format", "light");
    u.searchParams.set("omit_amendment_suppl_provision", "true");
    if (asof) u.searchParams.set("asof", asof);
    u.searchParams.set("response_format", "json");
    return this.limited(() => this.fetchJson<LawDataResponse>(u.toString()));
  }

  /** 条単位の本文。articleNum は "8" や "36_2"。asof 省略時は現行。 */
  article(lawId: string, articleNum: string, asof?: string): Promise<LawDataResponse> {
    return this.get(`/law_data/${encodeURIComponent(lawId)}`, {
      elm: `MainProvision-Article_${articleNum}`, json_format: "light", asof,
    });
  }

  private get<T>(path: string, params: Record<string, string | undefined>): Promise<T> {
    const u = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
    u.searchParams.set("response_format", "json");
    const key = u.toString();
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < this.cacheTtlMs) return hit.value as Promise<T>;
    const value = this.limited(() => this.fetchJson<T>(key));
    this.cache.set(key, { at: this.now(), value });
    value.catch(() => this.cache.delete(key)); // 失敗はキャッシュしない
    if (this.cache.size > this.cacheMax) this.cache.delete(this.cache.keys().next().value as string);
    return value;
  }

  private async limited<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxConcurrent) await new Promise<void>((r) => this.waiters.push(r));
    this.active++;
    try {
      // 送り始めの時刻を minIntervalMs ずつずらす（同時 2 本でも毎秒の件数が上限に収まる）
      const slot = Math.max(this.now(), this.nextSlot + this.minIntervalMs);
      this.nextSlot = slot;
      if (slot > this.now()) await this.sleep(slot - this.now());
      return await task();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }

  private async fetchJson<T>(url: string): Promise<T> {
    if (this.now() < this.blockedUntil) throw new EgovError(BLOCKED_MESSAGE, "blocked");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, { signal: ctrl.signal, headers: { Accept: "application/json", "User-Agent": USER_AGENT }, redirect: "manual" });
    } catch (e) {
      throw new EgovError(ctrl.signal.aborted ? `e-Gov 法令APIが ${this.timeoutMs / 1000} 秒以内に応答しませんでした`
        : `e-Gov 法令APIに接続できませんでした: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
    const type = res.headers.get("content-type") ?? "";
    if ((res.status >= 300 && res.status < 400) || res.status === 429 || res.status === 503 || /text\/html/i.test(type)) {
      // 回数制限・保守のときはエラーページへ転送される。しばらく送らない
      this.blockedUntil = this.now() + this.blockedMs;
      throw new EgovError(BLOCKED_MESSAGE, "blocked", res.status);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new EgovError(`e-Gov 法令APIの応答を読めませんでした（HTTP ${res.status}）`, undefined, res.status);
    }
    if (!res.ok) {
      const e = body as { code?: string; message?: string };
      throw new EgovError(e.message ?? `HTTP ${res.status}`, e.code, res.status);
    }
    return body as T;
  }
}

/** e-Gov 法令検索の閲覧ページ。改正版 ID があればその版のページ。 */
export function egovLawUrl(lawId: string, revisionId?: string): string {
  if (revisionId && revisionId.startsWith(`${lawId}_`)) {
    return `${EGOV_SITE}/law/${lawId}/${revisionId.slice(lawId.length + 1)}`;
  }
  return `${EGOV_SITE}/law/${lawId}`;
}

export const LAW_ID_RE = /^\d{3}[A-Z]{1,2}[0-9A-Z]{8,12}$/;
