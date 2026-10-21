import { describe, expect, it } from "vitest";

import { claimThresholds, missingQuantities, normalizeNumbers, quantities, sentenceAt } from "../src/lib/quantities.js";
import { EgovClient } from "../src/sources/egov.js";
import { LawNames } from "../src/sources/names.js";
import { LawStructure } from "../src/sources/structure.js";
import { verifyText } from "../src/tools/verify.js";

const ART = "居住用財産を譲渡した場合には、三千万円を控除する。所有期間が五年を超えるもの。六月以内に。百分の五に相当する金額";

describe("quantities", () => {
  it("reads kanji amounts, rates, years and months as values", () => {
    expect(quantities(normalizeNumbers(ART)).map((q) => q.raw)).toEqual(["3000万円", "100分の5", "5年を超え", "6月"]);
    expect(quantities(normalizeNumbers("令和7年に2024年の")).length).toBe(0); // 年号・西暦の年は期間ではない
  });

  it("only takes amounts written as requirements", () => {
    expect(claimThresholds("3,000万円を控除。例えば500万円×5%=25万円").map((q) => q.raw)).toEqual([]);
    expect(claimThresholds("5,000万円を超える場合、5年以内").map((q) => q.raw)).toEqual(["5000万円", "5年以内"]);
  });

  it("flags a requirement that differs from the same kind of number in the article, not one the article never mentions", () => {
    expect(missingQuantities("3,000万円を超える部分、5年を超える、6か月以内、5%相当額", ART)).toEqual([]);
    expect(missingQuantities("5,000万円を超える部分、10年を超える", ART).map((q) => q.raw)).toEqual(["5000万円", "10年を超え"]);
    expect(missingQuantities("100万円以下", "期間は五年とする")).toEqual([]); // 条文に金額がなければ別の所の数値とみなす
  });

  it("cuts the sentence around a position", () => {
    expect(sentenceAt("前の文。ここに第3条がある。次の文。", 8)).toBe("ここに第3条がある。");
  });
});

describe("verify_citations detail: numbers in the claim", () => {
  it("adds a note when the claimed threshold differs from the article", async () => {
    const names = new LawNames([["租税特別措置法", "332AC0000000026", "canonical"]]);
    const structure = new LawStructure({ snapshot: "2026-10-20", laws: { "332AC0000000026": ["租税特別措置法", "昭和三十二年法律第二十六号", 1, "35:1::"] } });
    const client = new EgovClient({
      minIntervalMs: 0,
      fetchImpl: (async () => new Response(JSON.stringify({
        law_info: { law_id: "332AC0000000026", law_num: "昭和三十二年法律第二十六号" },
        revision_info: { law_title: "租税特別措置法", law_revision_id: "332AC0000000026_x" },
        law_full_text: { Article: { ArticleTitle: "第三十五条", Paragraph: [{ ParagraphNum: "", ParagraphSentence: ART }] } },
      }), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
    });
    const bad = await verifyText("租税特別措置法第35条により5,000万円を超える部分に課税されない。", { client, names, structure, excerpt: 600 });
    expect(bad.checked[0].verdict.text).toContain("数値の確認（参考）: 「5000万円」");
    const good = await verifyText("租税特別措置法第35条により3,000万円を超える部分に課税される。", { client, names, structure, excerpt: 600 });
    expect(good.checked[0].verdict.text).not.toContain("数値の確認");
    const plain = await verifyText("租税特別措置法第35条により5,000万円を超える部分に課税されない。", { client, names, structure });
    expect(plain.checked[0].verdict.text).not.toContain("数値の確認"); // detail でなければ付けない
  });
});
