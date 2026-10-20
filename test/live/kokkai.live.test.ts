/** 実API 1 件だけの疎通確認。LIVE=1 のときだけ走る（npm run test:live）。ビルド済み build/index.js を stdio で起動する。 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

describe.runIf(process.env.LIVE === "1")("live: 国会会議録", () => {
  it("finds speeches over stdio", async () => {
    const client = new Client({ name: "live", version: "0" });
    await client.connect(new StdioClientTransport({ command: "node", args: ["build/index.js"] }));
    const t0 = performance.now();
    const r = await client.callTool({
      name: "search_diet_records",
      arguments: { keyword: "行政手続法 理由の提示", from: "2010-01-01", limit: 3 },
    });
    const text = (r.content as Array<{ text: string }>)[0].text;
    console.log(`${(performance.now() - t0).toFixed(0)}ms\n${text}`);
    expect(r.isError).toBeFalsy();
    expect(text).toMatch(/該当 \d+ 件中/);
    expect(text).toContain("https://kokkai.ndl.go.jp/");
    await client.close();
  }, 60_000);
});

describe.runIf(process.env.LIVE === "1")("live: e-Gov 法令API v2", () => {
  it("reads a past version, compares it and lists history", async () => {
    const client = new Client({ name: "live", version: "0" });
    await client.connect(new StdioClientTransport({ command: "node", args: ["build/index.js"] }));
    const call = async (name: string, args: Record<string, unknown>) => {
      const t0 = performance.now();
      const r = await client.callTool({ name, arguments: args });
      const text = (r.content as Array<{ text: string }>)[0].text;
      console.log(`--- ${name} ${(performance.now() - t0).toFixed(0)}ms\n${text}`);
      return { isError: Boolean(r.isError), text };
    };
    const a = await call("get_article", { law: "行政手続法", article: "第八条", asof: "2018-01-01" });
    expect(a.isError).toBe(false);
    expect(a.text).toContain("（理由の提示）");
    const c = await call("compare_article", { law: "行政手続法", article: "8", from: "2018-01-01" });
    expect(c.isError).toBe(false);
    const h = await call("law_history", { law: "行手法", limit: 5 });
    expect(h.text).toContain("改正履歴");
    const f = await call("find_law", { title: "個人情報の保護に関する法律", limit: 3 });
    expect(f.text).toContain("法令ID");
    await client.close();
  }, 120_000);
});
