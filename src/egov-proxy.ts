/**
 * e-Gov 法令API の読み取り専用の中継（Vercel の /api/egov?p=<e-Gov のパス>&<問い合わせ>）。
 *
 * 遠隔コネクタの MCP 関数（src/http.ts）は e-Gov を直接呼ばずにここを通す。応答に Cache-Control: s-maxage を付けるので、
 * Vercel の CDN が同じ問い合わせへの応答をまとめて返し、関数が何台に増えても、利用者が何人いても、e-Gov に届くのは
 * 問い合わせの種類ごとに保存期間内 1 回になる（CONTRIBUTING.md「外部 API の使い方」）。e-Gov への送り方
 * （同時 2 本・間隔 500ms・制限を検知したら 10 分送らない）は EgovClient と同じ。
 *
 * 保存期間: 過去の時点（asof が今日より前）の本文は変わらないので 30 日、それ以外（現行・改正履歴・検索）は 1 時間。
 * 制限中・接続失敗は保存しない。
 *
 * 内部用: 合言葉（環境変数 JP_LAW_MCP_INTERNAL_KEY、ヘッダー x-jp-law-mcp-key）のない要求は断る。
 * CDN に残った応答はだれでも読めるが、中身は e-Gov の公開データ。
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import { EgovClient } from "./sources/egov.js";

// パスごとに通す問い合わせの名前（それ以外は捨てる。CDN の保存の鍵が無駄に増えないように）
const ROUTES: Array<[RegExp, string[]]> = [
  [/^\/laws$/, ["law_title", "asof", "limit"]],
  [/^\/law_revisions\/[0-9A-Z]{10,20}$/, []],
  [/^\/law_data\/[0-9A-Z]{10,20}$/, ["elm", "json_format", "asof", "omit_amendment_suppl_provision"]],
  [/^\/keyword$/, ["keyword", "law_type", "asof", "limit", "sentences_limit"]],
];
export const LONG_SECONDS = 30 * 24 * 3600;
export const SHORT_SECONDS = 3600;

let shared: EgovClient | undefined;

/** ?p=パス&… を検査して e-Gov 向けの「パス?問い合わせ」に。通さないものは null */
export function egovTarget(search: URLSearchParams): string | null {
  const path = search.get("p") ?? "";
  const route = ROUTES.find(([re]) => re.test(path));
  if (!route) return null;
  const q = new URLSearchParams();
  for (const name of [...route[1]].sort()) {
    const v = search.get(name);
    if (v) q.set(name, v);
  }
  q.set("response_format", "json");
  return `${path}?${q.toString()}`;
}

/** CDN に保存する秒数。0 は保存しない */
export function cacheSeconds(target: string, status: number, today: string): number {
  if (status !== 200 && status !== 404) return 0; // 404 は「その条はない」「0 件」の答え
  const asof = new URLSearchParams(target.split("?")[1]).get("asof");
  return asof && asof < today ? LONG_SECONDS : SHORT_SECONDS;
}

export async function handleEgovProxy(req: IncomingMessage, res: ServerResponse, client?: EgovClient): Promise<void> {
  const key = process.env.JP_LAW_MCP_INTERNAL_KEY;
  const send = (status: number, body: string, seconds = 0) => {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": seconds ? `public, max-age=0, s-maxage=${seconds}` : "no-store",
    });
    res.end(body);
  };
  if (req.method !== "GET") return void res.writeHead(405, { allow: "GET" }).end();
  if (!key) return send(503, JSON.stringify({ message: "proxy not configured" }));
  if (req.headers["x-jp-law-mcp-key"] !== key) return send(403, JSON.stringify({ message: "internal endpoint" }));
  const target = egovTarget(new URL(req.url ?? "/", "http://x").searchParams);
  if (!target) return send(400, JSON.stringify({ message: "unsupported e-Gov path or parameters" }));
  shared ??= new EgovClient();
  const started = Date.now();
  const r = await (client ?? shared).passthrough(target);
  const seconds = cacheSeconds(target, r.status, new Date().toISOString().slice(0, 10));
  send(r.status, r.body, seconds);
  // CDN が保存した応答を返すときはここに来ないので、この行の数が e-Gov に届いた件数になる
  console.log(JSON.stringify({ t: "egov", path: target.split("?")[0], status: r.status, cache: seconds, ms: Date.now() - started }));
}
