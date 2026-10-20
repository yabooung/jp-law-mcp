import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { createServer } from "../src/server.js";
import { EgovClient } from "../src/sources/egov.js";
import { CitationGraph } from "../src/sources/graph.js";
import { KokkaiClient } from "../src/sources/kokkai.js";

// 小さな架空グラフ: A法 第8条 を B規則 第10条・第9条・第28条の2 と A法 第9条 が引用。B規則 第3条 は B規則 第10条 を引用（2 段目）
const LAWS: Array<[string, string]> = [
  ["405AC0000000001", "甲法"],
  ["405M50000000002", "乙規則"],
  ["405CO0000000003", "甲法施行令"],
];
const ARTS: Array<[number, string]> = [
  [0, "a8"],    // 0 甲法 第8条
  [0, "a9"],    // 1 甲法 第9条
  [1, "a10"],   // 2 乙規則 第10条
  [1, "a9"],    // 3 乙規則 第9条
  [1, "a28-2"], // 4 乙規則 第28条の2
  [1, "a3"],    // 5 乙規則 第3条
  [0, "a57-2"], // 6 甲法 第57条の2
];
const RAW = {
  meta: { source: "テスト", license: "CC BY 4.0", egov_snapshot: "2026-09-27", scope: "本則", counts: {} },
  laws: LAWS,
  arts: ARTS,
  e: [
    [2, 0, 0, 2], [3, 0, 0, 1], [4, 0, 0, 1], [1, 0, 0, 1], // → 甲法 第8条
    [5, 2, 0, 1],                                          // 乙規則 第3条 → 乙規則 第10条
    [6, 2, 0, 1],                                          // 甲法 第57条の2 → 乙規則 第10条
  ],
  l: [
    [6, 2, 1, 3],  // 甲法 第57条の2 → 甲法施行令（委任）
    [5, 0, 0, 1],  // 乙規則 第3条 → 甲法（条を特定しない参照）
  ],
} as const;

async function connect() {
  const graph = new CitationGraph(structuredClone(RAW) as never);
  const egovCalls: string[] = [];
  const egov = new EgovClient({ fetchImpl: (async (u: string) => { egovCalls.push(String(u)); return new Response("{}", { status: 500 }); }) as never, minIntervalMs: 0 });
  const server = createServer({ graph: () => graph, egov, kokkai: new KokkaiClient({ minIntervalMs: 0 }) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    return { isError: Boolean(r.isError), text: (r.content as Array<{ text: string }>)[0].text };
  };
  return { call, egovCalls };
}

describe("find_citing_provisions", () => {
  it("lists other laws' provisions in article order and hides same-law ones by default", async () => {
    const { call, egovCalls } = await connect();
    const r = await call("find_citing_provisions", { law: "甲法", article: "第八条" });
    expect(r.text).toContain("他の法令から: 3 条（1 法令）｜同じ法令内: 1 条（非表示）");
    expect(r.text).toContain("- 乙規則（405M50000000002）: 第9条・第10条・第28条の2");
    expect(r.text).not.toContain("甲法（405AC0000000001）: 第9条");
    expect(egovCalls).toHaveLength(0); // exact title resolved from the graph
  });

  it("includes same-law provisions on request", async () => {
    const { call } = await connect();
    const r = await call("find_citing_provisions", { law: "405AC0000000001", article: "8", include_same_law: true });
    expect(r.text).toContain("- 甲法（405AC0000000001）: 第9条");
  });

  it("counts the second hop without repeating direct citers", async () => {
    const { call } = await connect();
    const r = await call("find_citing_provisions", { law: "甲法", article: "8", depth: 2 });
    expect(r.text).toContain("間接に関わりうる範囲（上の 3 条を参照している条文）: 2 条（2 法令）");
    expect(r.text).toContain("乙規則（405M50000000002）: 第3条");
    expect(r.text).toContain("甲法（405AC0000000001）: 第57条の2");
  });

  it("for a whole law, adds references that name only the law", async () => {
    const { call } = await connect();
    const r = await call("find_citing_provisions", { law: "甲法" });
    expect(r.text).toContain("甲法（法令全体）");
    expect(r.text).toContain("第3条"); // 乙規則 第3条 refers to 甲法 without an article
  });

  it("says NOT_FOUND for an article nobody cites", async () => {
    const { call } = await connect();
    const r = await call("find_citing_provisions", { law: "甲法", article: "57の2" });
    expect(r.text).toContain("NOT_FOUND");
  });

  it("states scope and source", async () => {
    const { call } = await connect();
    const r = await call("find_citing_provisions", { law: "甲法", article: "8" });
    expect(r.text).toContain("2026-09-27 時点");
    expect(r.text).toContain("附則からの参照は含まない");
  });
});

describe("find_cited_provisions", () => {
  it("separates citations and delegations", async () => {
    const { call } = await connect();
    const r = await call("find_cited_provisions", { law: "甲法", article: "57条の2" });
    expect(r.text).toContain("引用している条: 1 条");
    expect(r.text).toContain("- 乙規則（405M50000000002）: 第10条");
    expect(r.text).toContain("委任先:\n- 甲法施行令（405CO0000000003）");
  });

  it("lists law-only references separately", async () => {
    const { call } = await connect();
    const r = await call("find_cited_provisions", { law: "乙規則", article: "3" });
    expect(r.text).toContain("条を特定しない法令への参照:\n- 甲法（405AC0000000001）");
  });
});
