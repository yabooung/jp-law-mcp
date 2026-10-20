import { readFileSync } from "node:fs";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { diffLines, kanjiToNumber, parseArticleNumber, renderArticle } from "../src/lib/article.js";
import { createServer } from "../src/server.js";
import { EgovClient, egovLawUrl } from "../src/sources/egov.js";
import { KokkaiClient } from "../src/sources/kokkai.js";

// 2026-10-19 に e-Gov 法令API v2 から取った実応答
const fx = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf-8"));
const A2 = fx("gyotetsu_a2_current.json");
const A8_2018 = fx("gyotetsu_a8_2018.json");
const REVS = fx("gyotetsu_revisions.json");
const LAWS = fx("laws_gyotetsu.json");

type Route = (u: URL) => { status?: number; body: unknown } | undefined;

function routedFetch(route: Route, log: URL[] = []) {
  return (async (url: string | URL) => {
    const u = new URL(String(url));
    log.push(u);
    const r = route(u) ?? { status: 404, body: { code: "404004", message: "指定のパラメータで取得できる法令本文ファイルは存在しません。" } };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
}

const defaultRoute: Route = (u) => {
  if (u.pathname.endsWith("/laws")) return { body: LAWS };
  if (u.pathname.includes("/law_revisions/")) return { body: REVS };
  if (u.pathname.includes("/law_data/")) {
    const elm = u.searchParams.get("elm");
    if (elm === "MainProvision-Article_2") return { body: A2 };
    if (elm === "MainProvision-Article_8" && u.searchParams.get("asof") === "2018-01-01") return { body: A8_2018 };
  }
  return undefined;
};

async function connect(route: Route = defaultRoute, log: URL[] = []) {
  const server = createServer({
    egov: new EgovClient({ fetchImpl: routedFetch(route, log), minIntervalMs: 0 }),
    kokkai: new KokkaiClient({ fetchImpl: routedFetch(() => undefined), minIntervalMs: 0 }),
    today: () => "2026-10-19",
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    return { isError: Boolean(r.isError), text: (r.content as Array<{ text: string }>)[0].text };
  };
  return { client, call };
}

describe("article numbers", () => {
  it.each([
    ["8", "8"], ["第8条", "8"], ["第八条", "8"], ["８条", "8"], ["36条の2", "36_2"], ["第三十六条の二", "36_2"],
    ["36-2", "36_2"], ["第百二十七条の三の二", "127_3_2"], ["第千条", "1000"],
  ])("%s → %s", (input, want) => expect(parseArticleNumber(input)).toBe(want));

  it.each(["", "附則", "第〇条", "abc"])("rejects %s", (input) => expect(parseArticleNumber(input)).toBeNull());

  it("reads kanji numerals", () => {
    expect(kanjiToNumber("三十六")).toBe(36);
    expect(kanjiToNumber("百")).toBe(100);
    expect(kanjiToNumber("二千十九")).toBe(2019);
  });
});

describe("rendering", () => {
  it("renders items and sub-items with indentation", () => {
    const lines = renderArticle(A2.law_full_text);
    expect(lines[0]).toBe("第二条（定義）");
    expect(lines).toContain("　一　法令　法律、法律に基づく命令（告示を含む。）、条例及び地方公共団体の執行機関の規則（規程を含む。以下「規則」という。）をいう。");
    expect(lines.some((l) => l.startsWith("　　イ　事実上の行為"))).toBe(true);
  });

  it("diffs lines", () => {
    expect(diffLines(["a", "b", "c"], ["a", "x", "c"])).toEqual(["  a", "- b", "+ x", "  c"]);
  });

  it("links a revision page", () => {
    expect(egovLawUrl("405AC0000000088", "405AC0000000088_20170401_429AC0000000004"))
      .toBe("https://laws.e-gov.go.jp/law/405AC0000000088/20170401_429AC0000000004");
  });
});

describe("tools", () => {
  it("find_law lists candidates with ids", async () => {
    const { call } = await connect();
    const r = await call("find_law", { title: "行政手続法" });
    expect(r.text).toContain("行政手続法（略称: 行手法）｜平成五年法律第八十八号｜法令ID 405AC0000000088｜現行");
  });

  it("get_article at a past date names the version in force and the next amendment", async () => {
    const log: URL[] = [];
    const { call } = await connect(defaultRoute, log);
    const r = await call("get_article", { law: "行政手続法", article: "第八条", asof: "2018-01-01" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("行政手続法 第8条");
    expect(r.text).toContain("版: 2017-04-01 施行・所得税法等の一部を改正する等の法律（平成二十九年法律第四号）による改正［過去の版］（2018-01-01 時点で施行されていた版）");
    expect(r.text).toContain("第八条（理由の提示）");
    expect(r.text).toContain("この版の次の改正: 2018-04-01 施行");
    expect(r.text).toContain("https://laws.e-gov.go.jp/law/405AC0000000088/20170401_429AC0000000004");
    expect(r.text).not.toContain("施行予定の改正"); // past date: no pending warning
    const sent = log.find((u) => u.pathname.includes("/law_data/"))!;
    expect(sent.searchParams.get("elm")).toBe("MainProvision-Article_8");
    expect(sent.searchParams.get("asof")).toBe("2018-01-01");
  });

  it("get_article today warns about scheduled amendments", async () => {
    const { call } = await connect();
    const r = await call("get_article", { law: "405AC0000000088", article: "2" });
    expect(r.text).toContain("⚠ 施行予定の改正: 2028-12-23 施行");
    expect(r.text).toContain("［未施行］");
  });

  it("refuses dates before 2017-04-01 without calling the API", async () => {
    const log: URL[] = [];
    const { call } = await connect(defaultRoute, log);
    const r = await call("get_article", { law: "405AC0000000088", article: "8", asof: "2015-01-01" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("2017-04-01 以降のみ");
    expect(log.filter((u) => u.pathname.includes("/law_data/"))).toHaveLength(0);
  });

  it("says NOT_FOUND for a missing article", async () => {
    const { call } = await connect();
    const r = await call("get_article", { law: "405AC0000000088", article: "999" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("NOT_FOUND");
  });

  it("asks to choose when a name is ambiguous", async () => {
    const { call } = await connect();
    const r = await call("get_article", { law: "行政手続", article: "8" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("3 件あります");
    expect(r.text).toContain("行政手続法施行令（406CO0000000265）");
  });

  it("law_history lists revisions newest first with status", async () => {
    const { call } = await connect();
    const r = await call("law_history", { law: "行手法" });
    expect(r.text).toContain("改正履歴 11 件");
    const first = r.text.split("\n")[1];
    expect(first).toContain("2028-12-23 施行");
    expect(first).toContain("［未施行］");
  });

  it("compare_article shows changed lines and says when nothing changed", async () => {
    const changed = structuredClone(A8_2018);
    changed.law_full_text.Article.Paragraph[1].ParagraphSentence.Sentence = ["前項本文に規定する処分を書面又は電磁的記録でするときは、同項の理由は、書面又は電磁的記録により示さなければならない。"];
    changed.revision_info = { ...changed.revision_info, law_revision_id: "405AC0000000088_20260724_508AC0000000066", amendment_enforcement_date: "2026-07-24", current_revision_status: "CurrentEnforced" };
    const route: Route = (u) => {
      if (u.pathname.includes("/law_data/") && !u.searchParams.get("asof")) return { body: changed };
      return defaultRoute(u);
    };
    const { call } = await connect(route);
    const r = await call("compare_article", { law: "405AC0000000088", article: "8", from: "2018-01-01" });
    expect(r.text).toContain("- ２　前項本文に規定する処分を書面でするときは");
    expect(r.text).toContain("+ ２　前項本文に規定する処分を書面又は電磁的記録でするときは");
    expect(r.text).toContain("  第八条（理由の提示）");

    const same = await connect((u) => (u.pathname.includes("/law_data/") ? { body: A8_2018 } : defaultRoute(u)));
    const r2 = await same.call("compare_article", { law: "405AC0000000088", article: "8", from: "2018-01-01", to: "2019-01-01" });
    expect(r2.text).toContain("差分なし");
  });
});

describe("repealed laws", () => {
  it("shows the repeal once, in Japanese, with its date", async () => {
    const repealed = structuredClone(LAWS);
    const r0 = repealed.laws[0];
    for (const info of [r0.revision_info, r0.current_revision_info]) Object.assign(info, { current_revision_status: "Repeal", repeal_status: "Repeal", repeal_date: "2022-04-01" });
    const { call } = await connect((u) => (u.pathname.endsWith("/laws") ? { body: repealed } : defaultRoute(u)));
    const r = await call("find_law", { title: "行政手続法" });
    expect(r.text).toContain("法令ID 405AC0000000088｜廃止（2022-04-01）");
    expect(r.text).not.toContain("Repeal");
  });
});

describe("EgovClient", () => {
  it("caches identical requests and never runs more than 2 at once", async () => {
    let inflight = 0;
    let peak = 0;
    let calls = 0;
    const slow = (async () => {
      calls++;
      inflight++;
      peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 5));
      inflight--;
      return new Response(JSON.stringify(REVS));
    }) as unknown as typeof fetch;
    const c = new EgovClient({ fetchImpl: slow, minIntervalMs: 0 });
    await Promise.all(["A", "B", "C", "D", "A", "A"].map((id) => c.revisions(`40${id}`)));
    expect(calls).toBe(4); // A requested 3 times, fetched once
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("spaces out request starts by the minimum interval", async () => {
    let t = 0;
    const starts: number[] = [];
    const f = (async () => { starts.push(t); return new Response(JSON.stringify(REVS)); }) as unknown as typeof fetch;
    const c = new EgovClient({ fetchImpl: f, minIntervalMs: 500, now: () => t, sleep: async (ms) => { t += ms; } });
    await Promise.all(["A", "B", "C"].map((id) => c.revisions(`40${id}`)));
    expect(starts).toEqual([0, 500, 1000]);
  });

  it("treats a redirect to the error page as blocked and stops sending for a while", async () => {
    let t = 0;
    let calls = 0;
    const f = (async () => {
      calls++;
      return new Response(null, { status: 301, headers: { location: "https://laws.e-gov.go.jp/sorry/404-notfound.html" } });
    }) as unknown as typeof fetch;
    const c = new EgovClient({ fetchImpl: f, minIntervalMs: 0, blockedMs: 60_000, now: () => t });
    await expect(c.revisions("40A")).rejects.toMatchObject({ code: "blocked" });
    await expect(c.revisions("40B")).rejects.toMatchObject({ code: "blocked" });
    expect(calls).toBe(1); // 2 件目は送らない
    t += 61_000;
    await expect(c.revisions("40C")).rejects.toMatchObject({ code: "blocked" });
    expect(calls).toBe(2); // 時間が過ぎたらまた試す
  });

  it("treats 429 and 503 as blocked", async () => {
    for (const status of [429, 503]) {
      const f = (async () => new Response("{}", { status })) as unknown as typeof fetch;
      await expect(new EgovClient({ fetchImpl: f, minIntervalMs: 0 }).revisions("40A")).rejects.toMatchObject({ code: "blocked" });
    }
  });

  it("treats an HTML page with status 200 as blocked, not as data", async () => {
    const f = (async () => new Response("<!DOCTYPE html><html></html>", { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    await expect(new EgovClient({ fetchImpl: f, minIntervalMs: 0 }).revisions("40A")).rejects.toMatchObject({ code: "blocked" });
  });
});
