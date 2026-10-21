import { readFileSync } from "node:fs";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { extractCitations } from "../src/lib/citations.js";
import { createServer } from "../src/server.js";
import { EgovClient } from "../src/sources/egov.js";
import { KokkaiClient } from "../src/sources/kokkai.js";
import { LawNames } from "../src/sources/names.js";
import { LawStructure } from "../src/sources/structure.js";
import { collectArticles } from "../src/tools/search.js";

const GYO = "405AC0000000088";
const SHO = "340AC0000000033";
const MIN = "129AC0000000089";
const SHO_REI = "340CO0000000096";
const SOCHI = "332AC0000000026";
const SOCHI_REI = "332CO0000000043";
const names = new LawNames([
  ["行政手続法", GYO, "canonical"], ["行手法", GYO, "abbrev"], ["平成5年法律第88号", GYO, "promulgation"],
  ["所得税法", SHO, "canonical"], ["昭和40年法律第33号", SHO, "promulgation"],
  ["民法", "129AC0000000089", "canonical"],
  ["所得税法施行令", "340CO0000000096", "canonical"],
  ["租税特別措置法", "332AC0000000026", "canonical"], ["措置法", "332AC0000000026", "alias"],
  ["租税特別措置法施行令", "332CO0000000043", "canonical"],
  ["旧題名法", "999AC0000000001", "old_name"], ["新題名法", "999AC0000000001", "canonical"],
  ["同名法", "111AC0000000001", "canonical"], ["同名法", "222AC0000000002", "canonical"],
  ["平成10年法律第2号", "222AC0000000002", "promulgation"],
  ["昭和二十二年法律第百七十五号（災害被害者に対する租税の減免、徴収猶予等に関する法律）", "322AC0000000175", "canonical"],
]);

describe("extractCitations", () => {
  it("reads 施行令 written without the act's full name", () => {
    const law = (t: string) => one(t).map((c) => (c.issues.includes("inferred_law") ? `~${c.lawId}` : c.lawId ?? c.issues[0]));
    expect(law("所得税法第9条第1項第18号、同法施行令第30条")).toEqual([SHO, SHO_REI]);
    expect(law("租税特別措置法第33条第1項および同施行令第22条第6項")).toEqual([SOCHI, SOCHI_REI]);
    expect(law("措置法施行令第40条の6・第40条の7")).toEqual([SOCHI_REI, SOCHI_REI]);
    expect(law("租税特別措置法第33条を見ます。施行令第22条第11項")).toEqual([SOCHI, `~${SOCHI_REI}`]);
    expect(law("施行令第22条")).toEqual(["no_law_name"]); // 前に法律がなければ決めない
    expect(law("民法第5条、同法施行令第3条")).toEqual([MIN, "no_law_name"]); // 辞書に「民法施行令」はない
  });

  const one = (t: string, d?: string) => extractCitations(t, names, d);

  it("reads law, article, paragraph and item", () => {
    const [c] = one("行政手続法第八条第一項");
    expect(c).toMatchObject({ lawId: GYO, article: "8", paragraph: 1, issues: [] });
    expect(one("所得税法第五十七条の二第一項第三号")[0]).toMatchObject({ lawId: SHO, article: "57_2", paragraph: 1, item: 3 });
    expect(one("所得税法第５７条の２")[0]).toMatchObject({ article: "57_2" }); // 全角数字
  });

  it("checks the promulgation number in parentheses", () => {
    expect(one("行政手続法（平成五年法律第八十八号）第八条")[0].issues).toEqual([]);
    expect(one("行政手続法（平成六年法律第八十八号）第八条")[0].issues).toContain("promulgation_mismatch");
    expect(one("同名法（平成十年法律第二号）第三条")[0]).toMatchObject({ lawId: "222AC0000000002", issues: [] }); // number disambiguates
  });

  it("does not mistake a made-up name for a real one it ends with", () => {
    const [c] = one("地方行政手続法第三条");
    expect(c.lawId).toBeUndefined();
    expect(c.issues).toContain("unknown_law");
    expect(c.lawName).toBe("地方行政手続法");
    expect(one("上記民法第七百九条")[0]).toMatchObject({ lawName: "民法", issues: [] }); // ordinary prefix
  });

  it("flags an unknown law-like name and law-less references", () => {
    expect(one("架空手続法第三条")[0].issues).toContain("unknown_law");
    expect(one("なお第五条を見よ")[0].issues).toEqual(["no_law_name"]);
    expect(one("なお第五条を見よ", GYO)[0]).toMatchObject({ lawId: GYO, issues: [] });
  });

  it("follows 同法 and 同条", () => {
    const cs = one("行手法第十四条、同法第三十六条の二。同条第二項も");
    expect(cs.map((c) => [c.lawId, c.article, c.paragraph])).toEqual([[GYO, "14", undefined], [GYO, "36_2", undefined], [GYO, "36_2", 2]]);
    expect(cs[0].nameKind).toBe("abbrev");
    expect(cs[1].nameKind).toBeUndefined();
  });

  it("marks ambiguous names unless the number decides", () => {
    expect(one("同名法第三条")[0].issues).toContain("ambiguous_law");
  });

  it("carries the law over an enumeration, but not over other words or a line break", () => {
    // 「~」付きは推定（同じ段落で直前に名前を書いた法令とみなしたもの）
    const law = (t: string) => one(t).map((c) => (c.issues.includes("inferred_law") ? `~${c.lawId}` : c.lawId ?? c.issues[0]));
    expect(law("所得税法第33条、第34条第1項、第6項及び第35条")).toEqual([SHO, SHO, SHO]);
    expect(law("所得税法第9条から第11条まで")).toEqual([SHO, SHO]);
    expect(law("民法第901条第1項ただし書、第900条第4号")).toEqual([MIN, MIN]);
    expect(law("所得税法第33条の規定により、第5条")).toEqual([SHO, `~${SHO}`]);
    expect(law("所得税法第33条\n第34条")).toEqual([SHO, `~${SHO}`]);
    expect(law("所得税法第33条。\n\nなお、第34条")).toEqual([SHO, "no_law_name"]); // 段落が変わったら推定しない
    expect(law("所得税法第33条、地方行政手続法第3条。第5条")).toEqual([SHO, "unknown_law", "no_law_name"]); // 分からない引用を飛び越えない
    expect(law("所得税法第33条、民法第5条、第6条")).toEqual([SHO, "129AC0000000089", "129AC0000000089"]);
  });

  it("carries over not knowing the law instead of reaching back to an earlier one", () => {
    const cs = one("所得税法第161条、架空特例省令第2条、第9条");
    expect(cs.map((c) => [c.lawId, c.issues])).toEqual([[SHO, []], [undefined, ["unknown_law"]], [undefined, ["unknown_law"]]]);
    expect(cs[2].lawName).toBe("架空特例省令");
    expect(one("所得税法第30条、改正法附則第51条、第52条").map((c) => [c.lawId, c.issues]))
      .toEqual([[SHO, []], [undefined, ["suppl_provision"]], [undefined, ["suppl_provision"]]]);
  });

  it("keeps the enumeration going past branch items, letters and ranges", () => {
    const law = (t: string) => one(t).map((c) => c.lawId ?? c.issues[0]);
    expect(law("所得税法第2条第29号の2ロ、第4条第1項")).toEqual([SHO, SHO]);
    expect(law("所得税法第57条第1項〜第3項、第58条第1項")).toEqual([SHO, SHO]);
    expect(one("所得税法第2条第12号の8")[0]).toMatchObject({ article: "2", item: undefined }); // 枝番の号は号の実在を確かめない
  });

  it("uses abbreviations defined in the text, only inside that text", () => {
    const cs = one("所得税法（昭和四十年法律第三十三号。以下「法」という。）第2条、法第3条、民法第5条");
    expect(cs.map((c) => [c.lawId, c.nameKind])).toEqual([[SHO, "canonical"], [SHO, "abbrev"], ["129AC0000000089", "canonical"]]);
    expect(one("行政手続法（以下「手続法」という。）の趣旨。手続法第5条")[0]).toMatchObject({ lawId: GYO, lawName: "手続法", nameKind: "abbrev" });
    expect(one("手続法第5条")[0].issues).toEqual(["unknown_law"]); // 定めのない文章では使わない
  });

  it("resolves 同法 and 同令 to the last law of that kind, and says so when there is none", () => {
    const cs = one("所得税法第2条、民法施行令第3条、同法第4条、同令第5条", undefined);
    expect(cs[2].lawId).toBe(SHO);
    expect(one("その資産に係る権利変換により同法第91条")[0]).toMatchObject({ raw: "同法第91条", issues: ["no_law_name"] });
  });

  it("does not read a following amount as a branch number", () => {
    expect(one("所得税法第33条の4の5,000万円控除")[0].article).toBe("33_4");
    expect(one("所得税法第33条の4の5")[0].article).toBe("33_4_5");
  });

  it("guesses unknown names only from the part after particles and commas", () => {
    expect(one("有価証券その他これに準ずるもので架空令第28条")[0]).toMatchObject({ lawName: "架空令", issues: ["unknown_law"] });
    expect(one("これに準ずるもので令第28条")[0].issues).toEqual(["no_law_name"]); // 1 文字は名前とみなさない
  });

  it("joins numbers split by spaces (text copied from PDF)", () => {
    expect(one("所得税法第21 条の２第１項")[0]).toMatchObject({ lawId: SHO, article: "21_2", paragraph: 1 });
  });

  it("marks 旧 and 改正前 as the pre-amendment version, also for the carried-over law", () => {
    const cs = one("旧所得税法第9条の2、第10条");
    expect(cs.map((c) => [c.lawId, c.issues])).toEqual([[SHO, ["old_version"]], [SHO, ["old_version"]]]);
    expect(one("所得税法第9条")[0].issues).toEqual([]);
    expect(one("（令和7年法律第13号）による改正前の所得税法第63条")[0].issues).toEqual(["old_version"]);
  });

  it("finds an untitled law by the name in its parentheses", () => {
    expect(one("災害被害者に対する租税の減免、徴収猶予等に関する法律第3条")[0]).toMatchObject({ lawId: "322AC0000000175", issues: [] });
  });
});

// ---- tools with a fake e-Gov ----------------------------------------------------

const A8 = JSON.parse(readFileSync(new URL("./fixtures/gyotetsu_a8_2018.json", import.meta.url), "utf-8"));

function egovFake(log: URL[] = []) {
  return new EgovClient({
    fetchImpl: (async (url: string) => {
      const u = new URL(url);
      log.push(u);
      const elm = u.searchParams.get("elm");
      const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s });
      if (u.pathname.endsWith("/keyword")) {
        if (u.searchParams.get("keyword") === "存在しない語") return json({ code: "404001", message: "取得結果が０件です。" }, 404);
        return json({
          total_count: 1, sentence_count: 1, items: [{
            law_info: A8.law_info, revision_info: { ...A8.revision_info, law_type: "Act" },
            sentences: [{ position: "mainprovision", text: "前項本文に規定する処分を書面でするときは、同項の<span>理由</span>は、書面により示さなければならない。" },
                        { position: "mainprovision", text: "途中で切れた<span>理由</spa" }],
          }],
        });
      }
      if (u.pathname.includes("/law_data/") && !elm) {
        return json({ ...A8, law_full_text: { Law: { LawBody: { MainProvision: { Chapter: [{ Article: [A8.law_full_text.Article] }] }, SupplProvision: [{ Article: [{ ArticleTitle: "第一条", Paragraph: [] }] }] } } } });
      }
      if (elm === "MainProvision-Article_8") return json(A8);
      return json({ code: "404004", message: "指定のパラメータで取得できる法令本文ファイルは存在しません。" }, 404);
    }) as never,
    minIntervalMs: 0,
  });
}

/** スナップショットの代わり: 行政手続法は第1〜15条（第8条は 2 項）、所得税法は第1条だけ */
const gyoArts = Array.from({ length: 15 }, (_, i) => `${i + 1}:${i === 7 ? 2 : 1}::`).join(";");
const STRUCTURE = new LawStructure({ snapshot: "2026-09-27", laws: {
  [GYO]: ["行政手続法", "平成五年法律第八十八号", 1, gyoArts],
  [SHO]: ["所得税法", "昭和四十年法律第三十三号", 1, "1:1::"],
} });

async function connect(log: URL[] = [], egov: EgovClient = egovFake(log), structure: LawStructure = STRUCTURE) {
  const server = createServer({ egov, names: () => names, structure: () => structure, kokkai: new KokkaiClient({ minIntervalMs: 0 }) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    return { isError: Boolean(r.isError), text: (r.content as Array<{ text: string }>)[0].text };
  };
}

describe("verify_citations", () => {
  it("separates real, missing, wrong-paragraph and suspicious citations, worst first", async () => {
    const call = await connect();
    const r = await call("verify_citations", {
      text: "行政手続法第八条第一項。同条第二項。行政手続法第八条第五項。行政手続法第九十九条。行政手続法（平成六年法律第八十八号）第八条。地方行政手続法第三条。第五条。",
    });
    expect(r.text).toContain("引用 7 件を確認（現行）: 実在 2・存在しない 2・要確認 2・法令名なし 1");
    const lines = r.text.split("\n").filter((l) => /^[✅❌⚠ℹ]/u.test(l));
    expect(lines[0].startsWith("❌")).toBe(true);
    expect(r.text).toContain("第2項までです（第5項は存在しません）");
    expect(r.text).toContain("行政手続法に第99条はありません");
    expect(r.text).toContain("括弧内の法令番号「平成六年法律第八十八号」は行政手続法（平成五年法律第八十八号）と一致しません");
    expect(r.text).toContain("「地方行政手続法」に当たる法令が見つかりません（似た名前: 行政手続法）");
    expect(r.text).toContain("「行政庁は、申請により求められた許認可等を拒否する処分");
  });

  it("returns a longer excerpt with detail=true so the claim can be compared with the text", async () => {
    const call = await connect();
    const short = await call("verify_citations", { text: "行政手続法第八条第一項" });
    const long = await call("verify_citations", { text: "行政手続法第八条第一項", detail: true });
    expect(short.text).not.toContain("これを示せば足りる");
    expect(long.text).toContain("これを示せば足りる");
  });

  it("asks e-Gov at most 10 times per call, missing ones first, and judges the rest by the snapshot", async () => {
    const log: URL[] = [];
    const call = await connect(log);
    const text = Array.from({ length: 12 }, (_, i) => `行政手続法第${i + 1}条`).join("、") + "。所得税法第5条";
    const r = await call("verify_citations", { text });
    const sent = log.filter((u) => u.pathname.includes("/law_data/"));
    expect(sent).toHaveLength(10);
    expect(sent.some((u) => u.pathname.includes(SHO))).toBe(true); // スナップショットで「ない」所得税法第5条は後ろにあっても現行版で確かめる
    expect(r.text.split("\n").filter((l) => l.includes("（スナップショット 2026-09-27 時点）"))).toHaveLength(3);
  });

  it("falls back to the snapshot when e-Gov is blocked", async () => {
    const blocked = new EgovClient({
      fetchImpl: (async () => new Response(null, { status: 301, headers: { location: "https://laws.e-gov.go.jp/sorry/404-notfound.html" } })) as never,
      minIntervalMs: 0,
    });
    const call = await connect([], blocked);
    const r = await call("verify_citations", { text: "行政手続法第八条第一項。行政手続法第八条第五項。行政手続法第九十九条。" });
    expect(r.text).toContain("実在 1・存在しない 2");
    expect(r.text).toContain("e-Gov に問い合わせられなかったため、スナップショットで判定しました");
  });

  it("trusts the current version over the snapshot when they differ", async () => {
    const old = new LawStructure({ snapshot: "2026-09-27", laws: { [GYO]: ["行政手続法", "平成五年法律第八十八号", 1, "1:1::"] } });
    const call = await connect([], egovFake(), old);
    const r = await call("verify_citations", { text: "行政手続法第八条第一項" }); // スナップショットにない条が現行版にはある
    expect(r.text).toContain("実在 1");
    expect(r.text).toContain("「行政庁は、申請により求められた許認可等を拒否する処分");
  });

  it("deduplicates and only calls e-Gov for resolvable citations", async () => {
    const log: URL[] = [];
    const call = await connect(log);
    await call("verify_citations", { text: "行政手続法第八条。行政手続法第八条。架空法第一条。第三条。" });
    expect(log.filter((u) => u.pathname.includes("/law_data/"))).toHaveLength(1);
  });
});

describe("search_law_text", () => {
  it("returns hits with the article located and cut tags cleaned", async () => {
    const call = await connect();
    const r = await call("search_law_text", { keyword: "理由" });
    expect(r.text).toContain("■ 行政手続法（法律・平成五年法律第八十八号・法令ID 405AC0000000088）");
    expect(r.text).toContain("- [第8条] 前項本文に規定する処分を書面でするときは、同項の【理由】は");
    expect(r.text).toContain("途中で切れた【理由】…");
    expect(r.text).not.toContain("</spa");
  });

  it("treats the API's 404 for zero hits as NOT_FOUND", async () => {
    const call = await connect();
    const r = await call("search_law_text", { keyword: "存在しない語" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("NOT_FOUND");
  });

  it("collects main-provision articles only", () => {
    const arts = collectArticles({ Law: { LawBody: { MainProvision: { Chapter: [{ Section: [{ Article: [{ ArticleTitle: "第三条の二", Paragraph: [] }] }] }] }, SupplProvision: { Article: [{ ArticleTitle: "第一条" }] } } } });
    expect(arts.map((a) => a.num)).toEqual(["3_2"]);
  });
});
