import { describe, expect, it } from "vitest";

import { EgovClient } from "../src/sources/egov.js";
import { LawNames } from "../src/sources/names.js";
import { LawStructure } from "../src/sources/structure.js";
import { resolveLaw } from "../src/tools/law.js";
import { verifyText } from "../src/tools/verify.js";

const GIJ = "428AC0000000089";
const names = new LawNames([
  ["外国人の技能実習の適正な実施及び技能実習生の保護に関する法律", GIJ, "canonical"],
  ["技能実習法", GIJ, "abbrev"],
  ["外国人の育成就労の適正な実施及び育成就労外国人の保護に関する法律", GIJ, "new_name", "2027-04-01"],
  ["行政手続法", "405AC0000000088", "canonical"],
  ["旧行政手続法", "405AC0000000088", "old_name"],
]);
const structure = new LawStructure({
  snapshot: "2026-10-20",
  laws: { [GIJ]: ["外国人の技能実習の適正な実施及び技能実習生の保護に関する法律", "平成二十八年法律第八十九号", 1, "1:1::;2:1::"] },
});
const offline = new EgovClient({ fetchImpl: (async () => { throw new Error("呼ばない"); }) as unknown as typeof fetch });

describe("renamed laws", () => {
  it("knows the title a law will take and when", () => {
    expect(names.renameOf(GIJ)).toEqual({ title: "外国人の育成就労の適正な実施及び育成就労外国人の保護に関する法律", date: "2027-04-01" });
    expect(names.renameOf("405AC0000000088")).toBeUndefined();
  });

  it("finds a law by its old or upcoming title without asking e-Gov, and says so", async () => {
    const byNew = await resolveLaw(offline, "外国人の育成就労の適正な実施及び育成就労外国人の保護に関する法律", names);
    expect(byNew.lawId).toBe(GIJ);
    expect(byNew.note).toContain("2027-04-01 に施行される改正の後の題名");
    const byOld = await resolveLaw(offline, "旧行政手続法", names);
    expect(byOld).toMatchObject({ lawId: "405AC0000000088", note: "「旧行政手続法」は旧題名です（現在は行政手続法）。" });
    expect((await resolveLaw(offline, "技能実習法", names)).note).toContain("2027-04-01 から「外国人の育成就労");
  });

  it("checks a citation under the upcoming title and warns about the coming rename", async () => {
    const r = await verifyText("外国人の育成就労の適正な実施及び育成就労外国人の保護に関する法律第2条。技能実習法第1条", {
      client: offline, names, structure, maxApiCalls: 0,
    });
    const [a, b] = r.checked.map((x) => x.verdict);
    expect(a.mark).toBe("✅");
    expect(a.text).toContain("2027-04-01 に施行される改正の後の題名です");
    expect(b.mark).toBe("✅");
    expect(b.text).toContain("2027-04-01 から「外国人の育成就労の適正な実施及び育成就労外国人の保護に関する法律」に題名が変わります");
  });
});
