import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { parseArticleNumber, renderArticle } from "../src/lib/article.js";
import { SnapshotEgovClient, toKanji } from "../src/sources/snapshot.js";

const file = join(mkdtempSync(join(tmpdir(), "snap-")), "t.json.gz");
writeFileSync(file, gzipSync(JSON.stringify({
  snapshot: "2026-10-20", jlawcite: "2.5.0",
  laws: {
    "405AC0000000088": ["行政手続法", "平成五年法律第八十八号", "act", "20260724", "20260724_508AC0000000066", [
      ["2", [[1, "この法律において…", [["一", "法令　法律…をいう。"]]]]],
      ["8", [[1, "行政庁は、…理由を示さなければならない。", []], [2, "前項本文に規定する処分を書面でするときは、…", []]]],
    ]],
  },
})));

describe("snapshot mode (evaluation only)", () => {
  it("writes article numbers the article parser reads back", () => {
    for (const n of ["8", "36_2", "110", "1000", "2019", "127_3_2"]) {
      const [head, ...rest] = n.split("_").map(Number);
      expect(parseArticleNumber(`第${toKanji(head)}条${rest.map((r) => `の${toKanji(r)}`).join("")}`)).toBe(n);
    }
  });

  it("answers article, search and law lookup from the file, refuses asof, never calls e-Gov", async () => {
    const c = new SnapshotEgovClient(file);
    const art = await c.article("405AC0000000088", "8");
    expect(renderArticle(art.law_full_text)).toEqual(["第八条", "行政庁は、…理由を示さなければならない。", "2　前項本文に規定する処分を書面でするときは、…"]);
    expect(renderArticle((await c.article("405AC0000000088", "2")).law_full_text)[2]).toBe("　一　法令　法律…をいう。");
    await expect(c.article("405AC0000000088", "999")).rejects.toMatchObject({ code: "404004" });
    await expect(c.article("405AC0000000088", "8", "2018-04-01")).rejects.toMatchObject({ code: "snapshot_asof" });
    expect((await c.searchLaws("行政手続")).laws[0].law_info.law_id).toBe("405AC0000000088");
    const k = await c.keyword("処分 書面");
    expect(k.items[0].sentences[0].text).toContain("<span>書面</span>");
    await expect(c.revisions("405AC0000000088")).resolves.toMatchObject({ revisions: [{ current_revision_status: "CurrentEnforced" }] });
  });
});
