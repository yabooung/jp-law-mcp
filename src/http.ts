/**
 * 遠隔コネクタ用の HTTP 入口（MCP Streamable HTTP, セッションなし）。
 * Vercel の関数（api/mcp.ts）とローカルの `node build/http.js` の両方から使う。
 *
 * セッションを持たない: 要求ごとに MCP サーバーを作って捨てる。関数が何台に増えても状態がずれない。
 * 外部 API のクライアント（待ち行列・キャッシュ）と引用グラフは関数インスタンスの中で使い回す。
 *
 * 公開の入口なので、利用者ごとに 1 分 RATE_PER_MIN 件まで・送り元 IP ごとに 1 分 IP_RATE_PER_MIN 件まで・
 * インスタンス全体で同時 MAX_INFLIGHT 件までにする（e-Gov・国会会議録への負担を利用者 1 人が占めないように。
 * CONTRIBUTING.md「外部 API の使い方」）。数はインスタンスごと。
 * 利用者は「送り元 IP + 接続 URL の ?u=（任意の文字列）」で分ける。claude.ai のように運営側のサーバーから呼ぶ
 * クライアントでは利用者全員の IP が同じになるので、?u= を付ければその中で 1 人ずつ数える。
 * 要求ごとに 1 行の記録（JSON）をログに出す。IP は前半（IPv4 /24・IPv6 /48）だけ。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createHttpServer } from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { createServer } from "./server.js";
import { EgovClient } from "./sources/egov.js";
import { KokkaiClient } from "./sources/kokkai.js";

// Vercel では e-Gov への問い合わせを中継（src/egov-proxy.ts, CDN が応答を保存）に通す。合言葉がなければ直接
const proxyUrl = process.env.JP_LAW_MCP_EGOV_PROXY
  ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}/api/egov` : undefined);
const proxyKey = process.env.JP_LAW_MCP_INTERNAL_KEY;
const shared = {
  egov: new EgovClient(proxyUrl && proxyKey ? { proxy: { url: proxyUrl, key: proxyKey } } : {}),
  kokkai: new KokkaiClient(),
};
const MAX_BODY = 1_000_000;
export const RATE_PER_MIN = Number(process.env.JP_LAW_MCP_RATE_PER_MIN ?? 60);
export const IP_RATE_PER_MIN = Number(process.env.JP_LAW_MCP_IP_RATE_PER_MIN ?? 600);
export const MAX_INFLIGHT = Number(process.env.JP_LAW_MCP_MAX_INFLIGHT ?? 20);
const hits = new Map<string, number[]>();
let inflight = 0;

function clientIp(req: IncomingMessage): string {
  const h = req.headers;
  const real = Array.isArray(h["x-real-ip"]) ? h["x-real-ip"][0] : h["x-real-ip"];
  const fwd = (Array.isArray(h["x-forwarded-for"]) ? h["x-forwarded-for"][0] : h["x-forwarded-for"])?.split(",")[0]?.trim();
  return real || fwd || req.socket?.remoteAddress || "unknown";
}

/** 接続 URL の ?u=。英数字・_・- の 64 字まで、それ以外は無視 */
export function userTag(url: string | undefined): string {
  const u = new URL(url ?? "/", "http://x").searchParams.get("u") ?? "";
  return /^[A-Za-z0-9_-]{1,64}$/.test(u) ? u : "";
}

/** ログ用に IP の前半だけ残す */
export function ipPrefix(ip: string): string {
  if (ip.includes(".")) return ip.split(".").slice(0, 3).join(".") + ".0/24";
  if (ip.includes(":")) return ip.split(":").slice(0, 3).join(":") + "::/48";
  return ip;
}

/** 直近 1 分の件数が上限に達していれば false。古い記録は捨てる */
export function allow(key: string, now = Date.now(), limit = RATE_PER_MIN): boolean {
  const list = (hits.get(key) ?? []).filter((t) => now - t < 60_000);
  if (list.length >= limit) {
    hits.set(key, list);
    return false;
  }
  list.push(now);
  hits.set(key, list);
  if (hits.size > 10_000) for (const [k, v] of hits) if (!v.some((t) => now - t < 60_000)) hits.delete(k);
  return true;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf-8")) : undefined;
}

function sendError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    // セッションなしなので GET（サーバーからの通知ストリーム）と DELETE は使わない
    res.writeHead(405, { allow: "POST" }).end();
    return;
  }
  const ip = clientIp(req);
  const user = userTag(req.url);
  const started = Date.now();
  const log = (status: number, call?: string) => console.log(JSON.stringify({
    t: "mcp", ip: ipPrefix(ip), u: user ? 1 : 0, ua: String(req.headers["user-agent"] ?? "").slice(0, 80), call, status, ms: Date.now() - started,
  }));
  // 利用者ごと（IP + ?u=）と IP ごとの両方で数える。利用者の枠を先に見て、超えた要求は IP の枠を減らさない
  if (!allow(`${ip}|${user}`, started) || !allow(ip, started, IP_RATE_PER_MIN)) {
    res.setHeader("retry-after", "60");
    sendError(res, 429, `rate limit: ${RATE_PER_MIN} requests per minute per user（共有の接続元からは接続 URL に ?u=任意の文字列 を付けると利用者ごとに数えます）`);
    log(429);
    return;
  }
  if (inflight >= MAX_INFLIGHT) {
    res.setHeader("retry-after", "10");
    sendError(res, 503, "server busy, retry shortly");
    log(503);
    return;
  }
  inflight++;
  res.on("close", () => { inflight--; });
  let body: unknown;
  try {
    // Vercel の Node 関数は本文を先に解析して req.body に置くことがある。あればそれを使う
    const pre = (req as IncomingMessage & { body?: unknown }).body;
    body = pre !== undefined ? (typeof pre === "string" ? JSON.parse(pre) : pre) : await readJson(req);
  } catch (e) {
    sendError(res, 400, `invalid request body: ${(e as Error).message}`);
    return;
  }
  const rpc = body as { method?: string; params?: { name?: string } } | undefined;
  const call = rpc?.method === "tools/call" ? `tool:${rpc.params?.name}` : rpc?.method;
  res.on("finish", () => log(res.statusCode, call));
  const server = createServer(shared);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (e) {
    if (!res.headersSent) sendError(res, 500, (e as Error).message);
  }
}

/** ローカル確認用: PORT=8787 node build/http.js → http://127.0.0.1:8787/mcp */
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/").replace(/^(?=[A-Za-z]:)/, "/")}`) {
  const port = Number(process.env.PORT ?? 8787);
  createHttpServer((req, res) => {
    if (req.url?.split("?")[0] === "/mcp") void handleMcp(req, res);
    else res.writeHead(404).end();
  }).listen(port, "127.0.0.1", () => console.error(`jp-law-mcp HTTP: http://127.0.0.1:${port}/mcp`));
}
