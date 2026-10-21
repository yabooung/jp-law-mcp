import { describe, expect, it } from "vitest";

import { extractCitations } from "../src/lib/citations.js";
import { otherCitations } from "../src/lib/others.js";
import { LawNames } from "../src/sources/names.js";

describe("citations that are not national laws", () => {
  it("finds 通達, 判例, 条例 and 告示", () => {
    const t = "所得税基本通達9-4-8、措置法通達31の4-1、法人税基本通達（9−4−8）を参照。最判平成5年3月11日、最三小判令和2.3.24、" +
      "東京地判平成30年1月1日、最高裁判所第二小法廷令和2年3月24日判決。東京都迷惑防止条例と市町村条例。財務省告示第123号。";
    expect(otherCitations(t).map((o) => `${o.kind}:${o.raw}`)).toEqual([
      "通達:所得税基本通達9-4-8", "通達:措置法通達31の4-1", "通達:法人税基本通達（9−4−8）",
      "判例:最判平成5年3月11日", "判例:最三小判令和2.3.24", "判例:東京地判平成30年1月1日",
      "判例:最高裁判所第二小法廷令和2年3月24日判決", "条例:東京都迷惑防止条例", "告示:財務省告示第123号",
    ]);
  });

  it("marks an ordinance article as out of scope instead of a suspicious law name", () => {
    const names = new LawNames([["行政手続法", "405AC0000000088", "canonical"]]);
    const [c] = extractCitations("東京都迷惑防止条例第5条", names);
    expect(c.issues).toEqual(["out_of_scope"]);
    expect(extractCitations("地方行政手続法第3条", names)[0].issues).toEqual(["unknown_law"]);
  });
});

describe("prompts", () => {
  it("lists the practitioner prompts and fills in the arguments", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { createServer } = await import("../src/server.js");
    const server = createServer();
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    expect((await client.listPrompts()).prompts.map((p) => p.name)).toEqual(["check_document", "article_at_date", "amendment_impact"]);
    const p = await client.getPrompt({ name: "article_at_date", arguments: { law: "行政手続法", article: "8", date: "2018-04-01" } });
    expect((p.messages[0].content as { text: string }).text).toContain("asof=2018-04-01");
    expect(client.getInstructions()).toContain("verify_citations");
  });
});

describe("subordinate provisions", () => {
  it("lists the 施行令・施行規則 articles that cite an act's article", async () => {
    const { CitationGraph } = await import("../src/sources/graph.js");
    const { subordinateCiting } = await import("../src/lib/subordinate.js");
    const g = CitationGraph.load();
    const s = subordinateCiting(g, "340AC0000000033", "9")!;
    expect(s.startsWith("所得税法施行令 ")).toBe(true);
    expect(s).toContain("第30条");
    expect(s).toContain("所得税法施行規則 ");
    expect(subordinateCiting(g, "405AC0000000088", "8")).toBeUndefined();
  });
});

describe("tax abbreviations in the bundled dictionary", () => {
  it("reads 措法・所令・消法 and keeps unknown words ending in them as unknown", async () => {
    const names = (await import("../src/sources/names.js")).LawNames.load();
    const law = (t: string) => extractCitations(t, names).map((c) => c.lawId ?? c.issues[0]);
    expect(law("措法第37条の5、所令第30条、消法第30条")).toEqual(["332AC0000000026", "340CO0000000096", "363AC0000000108"]);
    expect(law("研究所法第3条")).toEqual(["unknown_law"]);
    expect(extractCitations("関係法令第3条", names)[0].lawId).toBeUndefined(); // 「法令」を法人税法施行令と読まない
  });
});

describe("basic NTA notices", () => {
  it("checks a notice number against the index, leaving other notices unchecked", async () => {
    const { NoticeIndex } = await import("../src/sources/tsutatsu.js");
    const { checkNotices } = await import("../src/tools/verify.js");
    const idx = new NoticeIndex({
      meta: { source: "test", fetched: "2026-10-22" },
      notices: { 所得税基本通達: { url: "https://www.nta.go.jp/law/tsutatsu/kihon/shotoku/01.htm", items: { "33-1の2": "(少額重要資産の範囲)", "181~223共-6": "" } } },
    });
    const found = otherCitations("所基通33-1の2、所得税基本通達33−99、所得税基本通達181〜223共-6、措置法通達31の4-1".normalize("NFKC"));
    const r = checkNotices(found, idx);
    expect([r.ok, r.missing]).toEqual([2, 1]);
    expect(r.lines.find((l) => l.startsWith("❌"))).toContain("所得税基本通達に 33-99 は見つかりません");
    expect(r.rest.map((o) => o.raw)).toEqual(["措置法通達31の4-1"]);
  });
});
