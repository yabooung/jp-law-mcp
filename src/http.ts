/**
 * 遠隔コネクタ用の HTTP 入口（MCP Streamable HTTP, セッションなし）。
 * Vercel の関数（api/mcp.ts）とローカルの `node build/http.js` の両方から使う。
 *
 * セッションを持たない: 要求ごとに MCP サーバーを作って捨てる。関数が何台に増えても状態がずれない。
 * 外部 API のクライアント（待ち行列・キャッシュ）と引用グラフは関数インスタンスの中で使い回す。
 *
 * 公開の入口なので、送り元ごとに 1 分 RATE_PER_MIN 件まで・インスタンス全体で同時 MAX_INFLIGHT 件までにする
 * （e-Gov・国会会議録への負担を利用者 1 人が占めないように。CONTRIBUTING.md「外部 API の使い方」）。数はインスタンスごと。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createHttpServer } from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { createServer } from "./server.js";
import { EgovClient } from "./sources/egov.js";
import { KokkaiClient } from "./sources/kokkai.js";

const shared = { egov: new EgovClient(), kokkai: new KokkaiClient() };
const MAX_BODY = 1_000_000;
export const RATE_PER_MIN = Number(process.env.JP_LAW_MCP_RATE_PER_MIN ?? 60);
export const MAX_INFLIGHT = Number(process.env.JP_LAW_MCP_MAX_INFLIGHT ?? 20);
const hits = new Map<string, number[]>();
let inflight = 0;

function clientKey(req: IncomingMessage): string {
  const h = req.headers;
  const real = Array.isArray(h["x-real-ip"]) ? h["x-real-ip"][0] : h["x-real-ip"];
  const fwd = (Array.isArray(h["x-forwarded-for"]) ? h["x-forwarded-for"][0] : h["x-forwarded-for"])?.split(",")[0]?.trim();
  return real || fwd || req.socket?.remoteAddress || "unknown";
}

/** 直近 1 分の件数が上限に達していれば false。古い記録は捨てる */
export function allow(key: string, now = Date.now()): boolean {
  const list = (hits.get(key) ?? []).filter((t) => now - t < 60_000);
  if (list.length >= RATE_PER_MIN) {
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
  if (!allow(clientKey(req))) {
    res.setHeader("retry-after", "60");
    sendError(res, 429, `rate limit: ${RATE_PER_MIN} requests per minute`);
    return;
  }
  if (inflight >= MAX_INFLIGHT) {
    res.setHeader("retry-after", "10");
    sendError(res, 503, "server busy, retry shortly");
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
