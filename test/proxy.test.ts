import type { IncomingMessage, ServerResponse } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { LONG_SECONDS, SHORT_SECONDS, cacheSeconds, egovTarget, handleEgovProxy } from "../src/egov-proxy.js";
import { EgovClient } from "../src/sources/egov.js";

const ok = (body: unknown, status = 200, type = "application/json") =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": type } });

function fakeRes() {
  const out = { status: 0, headers: {} as Record<string, string>, body: "" };
  const res = {
    writeHead(status: number, headers: Record<string, string> = {}) { out.status = status; out.headers = headers; return res; },
    end(body = "") { out.body = String(body); return res; },
  };
  return { res: res as unknown as ServerResponse, out };
}
const req = (url: string, key?: string) =>
  ({ method: "GET", url, headers: key ? { "x-jp-law-mcp-key": key } : {} }) as unknown as IncomingMessage;

describe("e-Gov proxy", () => {
  afterEach(() => { delete process.env.JP_LAW_MCP_INTERNAL_KEY; });

  it("passes only known e-Gov paths and parameters, in a fixed order", () => {
    expect(egovTarget(new URLSearchParams("p=/law_data/405AC0000000088&json_format=light&elm=MainProvision-Article_8&x=1")))
      .toBe("/law_data/405AC0000000088?elm=MainProvision-Article_8&json_format=light&response_format=json");
    expect(egovTarget(new URLSearchParams("p=/laws&law_title=行政手続法&limit=20"))).toContain("/laws?law_title=");
    expect(egovTarget(new URLSearchParams("p=/law_data/../../etc"))).toBeNull();
    expect(egovTarget(new URLSearchParams("p=https://example.com/"))).toBeNull();
  });

  it("keeps past-date text 30 days, everything else 1 hour, failures not at all", () => {
    expect(cacheSeconds("/law_data/X?asof=2018-04-01", 200, "2026-10-21")).toBe(LONG_SECONDS);
    expect(cacheSeconds("/law_data/X?elm=a", 200, "2026-10-21")).toBe(SHORT_SECONDS);
    expect(cacheSeconds("/law_data/X?asof=2026-10-21", 200, "2026-10-21")).toBe(SHORT_SECONDS);
    expect(cacheSeconds("/law_data/X", 404, "2026-10-21")).toBe(SHORT_SECONDS);
    expect(cacheSeconds("/law_data/X", 503, "2026-10-21")).toBe(0);
  });

  it("refuses requests without the internal key", async () => {
    process.env.JP_LAW_MCP_INTERNAL_KEY = "k";
    const { res, out } = fakeRes();
    await handleEgovProxy(req("/api/egov?p=/laws&law_title=a"), res, new EgovClient({ fetchImpl: (async () => ok({})) as typeof fetch }));
    expect(out.status).toBe(403);
  });

  it("relays e-Gov with a CDN cache header, and answers 503 blocked without calling e-Gov again", async () => {
    process.env.JP_LAW_MCP_INTERNAL_KEY = "k";
    const calls: string[] = [];
    let block = false;
    const client = new EgovClient({
      minIntervalMs: 0,
      fetchImpl: (async (u: string) => { calls.push(String(u)); return block ? ok("<html>", 200, "text/html") : ok({ laws: [] }); }) as typeof fetch,
    });
    const a = fakeRes();
    await handleEgovProxy(req("/api/egov?p=/laws&law_title=a", "k"), a.res, client);
    expect(a.out.status).toBe(200);
    expect(a.out.headers["cache-control"]).toBe(`public, max-age=0, s-maxage=${SHORT_SECONDS}`);
    expect(calls[0]).toBe("https://laws.e-gov.go.jp/api/2/laws?law_title=a&response_format=json");
    block = true;
    const b = fakeRes();
    await handleEgovProxy(req("/api/egov?p=/laws&law_title=b", "k"), b.res, client);
    expect(b.out.status).toBe(503);
    expect(b.out.headers["cache-control"]).toBe("no-store");
    const c = fakeRes();
    await handleEgovProxy(req("/api/egov?p=/laws&law_title=c", "k"), c.res, client);
    expect(c.out.status).toBe(503);
    expect(calls).toHaveLength(2); // 制限中は送らない
  });

  it("client sends to the proxy with ?p= and the key, and treats its 503 as blocked", async () => {
    const seen: Array<{ url: string; key?: string }> = [];
    const client = new EgovClient({
      minIntervalMs: 0,
      proxy: { url: "https://example.test/api/egov", key: "k" },
      fetchImpl: (async (u: string, init: RequestInit) => {
        seen.push({ url: String(u), key: (init.headers as Record<string, string>)["x-jp-law-mcp-key"] });
        return ok({ code: "blocked" }, 503);
      }) as typeof fetch,
    });
    await expect(client.revisions("405AC0000000088")).rejects.toThrow(/制限/);
    expect(seen[0]).toEqual({ url: "https://example.test/api/egov?p=%2Flaw_revisions%2F405AC0000000088&response_format=json", key: "k" });
  });
});
