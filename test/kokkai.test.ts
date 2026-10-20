import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { createServer } from "../src/server.js";
import { KokkaiClient, KokkaiError, type SpeechResult } from "../src/sources/kokkai.js";
import { excerpt, formatSpeeches } from "../src/tools/diet.js";

const RECORD = {
  speechID: "121705254X01020230411_012", issueID: "121705254X01020230411", session: 211,
  nameOfHouse: "参議院", nameOfMeeting: "総務委員会", issue: "第10号", date: "2023-04-11",
  speechOrder: 12, speaker: "山田太郎", speakerGroup: "自由民主党", speakerPosition: null, speakerRole: null,
  speech: "○山田太郎君　".padEnd(400, "あ") + "行政手続法の理由の提示について伺います。" + "い".repeat(400),
  speechURL: "https://kokkai.ndl.go.jp/txt/121705254X01020230411/12",
  meetingURL: "https://kokkai.ndl.go.jp/txt/121705254X01020230411",
};
const OK: SpeechResult = { numberOfRecords: 42, numberOfReturn: 1, startRecord: 1, nextRecordPosition: 2, speechRecord: [RECORD] };

function fakeFetch(responses: Array<{ status?: number; body: unknown }>, log: string[] = []) {
  let i = 0;
  return (async (url: string | URL) => {
    log.push(String(url));
    const r = responses[Math.min(i++, responses.length - 1)];
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
}

/** 仮想時計: sleep が時間を進める */
function fakeClock() {
  let t = 1_000_000;
  const sleeps: number[] = [];
  return { now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; }, sleeps, advance: (ms: number) => { t += ms; } };
}

describe("KokkaiClient", () => {
  it("builds a JSON query and drops empty conditions", () => {
    const c = new KokkaiClient();
    const url = c.buildUrl("speech", { any: "理由の提示", speaker: "", nameOfHouse: "参議院", maximumRecords: 5 });
    const u = new URL(url);
    expect(u.pathname).toBe("/api/speech");
    expect(u.searchParams.get("any")).toBe("理由の提示");
    expect(u.searchParams.has("speaker")).toBe(false);
    expect(u.searchParams.get("recordPacking")).toBe("json");
  });

  it("refuses queries over 2,000 bytes before sending", () => {
    const c = new KokkaiClient();
    expect(() => c.buildUrl("speech", { any: "あ".repeat(700) })).toThrow(KokkaiError);
  });

  it("sends requests one at a time with the minimum gap after each response", async () => {
    const clock = fakeClock();
    const log: string[] = [];
    const c = new KokkaiClient({ fetchImpl: fakeFetch([{ body: OK }], log), minIntervalMs: 3000, now: clock.now, sleep: clock.sleep });
    await Promise.all([c.searchSpeeches({ any: "a" }), c.searchSpeeches({ any: "b" }), c.searchSpeeches({ any: "c" })]);
    expect(log.map((u) => new URL(u).searchParams.get("any"))).toEqual(["a", "b", "c"]); // in order
    expect(clock.sleeps).toEqual([3000, 3000]); // first goes at once, then a full gap each time
  });

  it("keeps the queue moving after a failed request", async () => {
    const clock = fakeClock();
    const c = new KokkaiClient({
      fetchImpl: fakeFetch([{ status: 400, body: { message: "検索条件の入力に誤りがあります。", details: ["from"] } }, { body: OK }]),
      now: clock.now, sleep: clock.sleep,
    });
    const first = c.searchSpeeches({ from: "2023-02-30" });
    const second = c.searchSpeeches({ any: "x" });
    await expect(first).rejects.toMatchObject({ message: "検索条件の入力に誤りがあります。", details: ["from"] });
    await expect(second).resolves.toMatchObject({ numberOfRecords: 42 });
  });

  it("answers a repeated search from the saved result without sending again", async () => {
    const log: string[] = [];
    const c = new KokkaiClient({ fetchImpl: fakeFetch([{ body: OK }], log), minIntervalMs: 0 });
    await c.searchSpeeches({ any: "同じ" });
    await expect(c.searchSpeeches({ any: "同じ" })).resolves.toMatchObject({ numberOfRecords: 42 });
    expect(log).toHaveLength(1);
  });

  it("does not save a failed search", async () => {
    const log: string[] = [];
    const c = new KokkaiClient({ fetchImpl: fakeFetch([{ status: 500, body: { message: "x" } }, { body: OK }], log), minIntervalMs: 0 });
    await expect(c.searchSpeeches({ any: "再" })).rejects.toBeInstanceOf(KokkaiError);
    await expect(c.searchSpeeches({ any: "再" })).resolves.toMatchObject({ numberOfRecords: 42 });
    expect(log).toHaveLength(2);
  });

  it("refuses instead of queueing when too many requests are waiting", async () => {
    const clock = fakeClock();
    const log: string[] = [];
    const c = new KokkaiClient({ fetchImpl: fakeFetch([{ body: OK }], log), now: clock.now, sleep: clock.sleep, maxQueue: 2 });
    const p = [c.searchSpeeches({ any: "1" }), c.searchSpeeches({ any: "2" }), c.searchSpeeches({ any: "3" })];
    await expect(p[2]).rejects.toThrow(/混み合っています/);
    await Promise.all(p.slice(0, 2));
    expect(log).toHaveLength(2);
    await expect(c.searchSpeeches({ any: "4" })).resolves.toBeTruthy(); // 空けば受け付ける
  });

  it("stops sending for a while after a 429 or a redirect", async () => {
    const clock = fakeClock();
    const log: string[] = [];
    const c = new KokkaiClient({ fetchImpl: fakeFetch([{ status: 429, body: {} }, { body: OK }], log), minIntervalMs: 0, blockedMs: 60_000, now: clock.now, sleep: clock.sleep });
    await expect(c.searchSpeeches({ any: "a" })).rejects.toThrow(/制限/);
    await expect(c.searchSpeeches({ any: "b" })).rejects.toThrow(/制限/);
    expect(log).toHaveLength(1);
    clock.advance(61_000);
    await expect(c.searchSpeeches({ any: "c" })).resolves.toMatchObject({ numberOfRecords: 42 });
  });

  it("identifies itself with a User-Agent", async () => {
    let ua: string | null = null;
    const f = (async (_u: string, init?: RequestInit) => {
      ua = new Headers(init?.headers).get("user-agent");
      return new Response(JSON.stringify(OK));
    }) as unknown as typeof fetch;
    await new KokkaiClient({ fetchImpl: f, minIntervalMs: 0, userAgent: "jp-law-mcp/test" }).searchSpeeches({ any: "x" });
    expect(ua).toBe("jp-law-mcp/test");
  });

  it("treats a 200 response carrying an error message as an error", async () => {
    const c = new KokkaiClient({ fetchImpl: fakeFetch([{ body: { message: "サーバーが混み合っています" } }]), minIntervalMs: 0 });
    await expect(c.searchSpeeches({ any: "x" })).rejects.toBeInstanceOf(KokkaiError);
  });

  it("does not wait when the previous request ended long ago", async () => {
    const clock = fakeClock();
    const c = new KokkaiClient({ fetchImpl: fakeFetch([{ body: OK }]), now: clock.now, sleep: clock.sleep });
    await c.searchSpeeches({ any: "a" });
    clock.advance(10_000);
    await c.searchSpeeches({ any: "b" });
    expect(clock.sleeps).toEqual([]);
  });
});

describe("formatting", () => {
  it("cuts around the first keyword hit", () => {
    const ex = excerpt(RECORD.speech, ["理由の提示"]);
    expect(ex).toContain("行政手続法の理由の提示");
    expect(ex.startsWith("…")).toBe(true);
    expect(ex.length).toBeLessThan(340);
  });

  it("lists hits with links, paging hint and source", () => {
    const out = formatSpeeches(OK, ["理由の提示"]);
    expect(out).toContain("該当 42 件中 1〜1 件目");
    expect(out).toContain("2023-04-11 第211回 参議院 総務委員会 第10号");
    expect(out).toContain("山田太郎（自由民主党）");
    expect(out).toContain(RECORD.speechURL);
    expect(out).toContain("start=2");
    expect(out).toContain("出典: 国会会議録検索システム（国立国会図書館）");
  });

  it("says NOT_FOUND plainly", () => {
    const out = formatSpeeches({ numberOfRecords: 0, numberOfReturn: 0, startRecord: 1, speechRecord: [] }, []);
    expect(out).toContain("NOT_FOUND");
  });
});

describe("MCP tool", () => {
  async function connect(fetchImpl: typeof fetch) {
    const server = createServer({ kokkai: new KokkaiClient({ fetchImpl, minIntervalMs: 0 }) });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    return client;
  }

  it("is listed and returns formatted results", async () => {
    const log: string[] = [];
    const client = await connect(fakeFetch([{ body: OK }], log));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("search_diet_records");
    const r = await client.callTool({ name: "search_diet_records", arguments: { keyword: "理由の提示", house: "参議院" } });
    expect(r.isError).toBeFalsy();
    expect((r.content as Array<{ text: string }>)[0].text).toContain("山田太郎");
    const sent = new URL(log[0]).searchParams;
    expect(sent.get("nameOfHouse")).toBe("参議院");
    expect(sent.get("maximumRecords")).toBe("5"); // default limit
  });

  it("asks for a condition instead of calling the API", async () => {
    const log: string[] = [];
    const client = await connect(fakeFetch([{ body: OK }], log));
    const r = await client.callTool({ name: "search_diet_records", arguments: {} });
    expect(r.isError).toBe(true);
    expect(log).toHaveLength(0);
  });

  it("reports API errors as tool errors", async () => {
    const client = await connect(fakeFetch([{ status: 400, body: { message: "検索条件の入力に誤りがあります。", details: ["until"] } }]));
    const r = await client.callTool({ name: "search_diet_records", arguments: { keyword: "x", until: "2023-01-01" } });
    expect(r.isError).toBe(true);
    expect((r.content as Array<{ text: string }>)[0].text).toContain("until");
  });
});
