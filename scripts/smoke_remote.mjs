/**
 * 接続先が data/SOURCE.json のスナップショットで動いているかを確かめる（毎日の更新で push したあとに使う）。
 * find_citing_provisions は同梱の引用グラフだけを使い、外部 API を呼ばない。
 *
 *   node scripts/smoke_remote.mjs [--url https://jp-law-mcp.vercel.app/mcp] [--wait 900]
 *
 * --wait 秒のあいだ 30 秒おきに確かめ、出力の「YYYY-MM-DD 時点」が SOURCE.json の snapshot になったら、
 * 最後に get_article を 1 回だけ呼んで e-Gov が答えるか（遠隔コネクタの送り元が制限されていないか）を見る。
 * 制限されていたら終了コード 2（毎日の Actions が失敗を知らせる）。
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const { values: a } = parseArgs({
  options: { url: { type: "string", default: "https://jp-law-mcp.vercel.app/mcp" }, wait: { type: "string", default: "0" } },
});
const want = JSON.parse(readFileSync("data/SOURCE.json", "utf-8")).snapshot;
const deadline = Date.now() + Number(a.wait) * 1000;

async function check() {
  const c = new Client({ name: "jp-law-mcp-smoke", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(a.url)));
  try {
    const tools = (await c.listTools()).tools.length;
    const r = await c.callTool({ name: "find_citing_provisions", arguments: { law: "行政手続法", article: "8" } });
    const text = r.content.map((x) => x.text).join("\n");
    return { tools, text, ok: text.includes(`${want} 時点`) };
  } finally {
    await c.close();
  }
}

for (;;) {
  let res;
  try {
    res = await check();
  } catch (e) {
    res = { ok: false, text: String(e) };
  }
  if (res.ok) {
    console.log(`ok: ツール ${res.tools} 個、${want} 時点のグラフ`);
    const c = new Client({ name: "jp-law-mcp-smoke", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(a.url)));
    const r = await c.callTool({ name: "get_article", arguments: { law: "行政手続法", article: "8" } });
    await c.close();
    const text = r.content.map((x) => x.text).join("\n");
    if (r.isError) {
      console.error(`e-Gov を使う get_article が失敗:\n${text.slice(0, 300)}`);
      process.exit(2);
    }
    console.log(`ok: get_article（${text.split("\n")[0]}）`);
    process.exit(0);
  }
  if (Date.now() >= deadline) {
    console.error(`接続先がまだ ${want} 時点ではない:\n${res.text.split("\n").slice(0, 8).join("\n")}`);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 30_000));
}
