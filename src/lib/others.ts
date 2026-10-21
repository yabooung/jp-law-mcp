/**
 * 法令（国の法律・政令・府省令など）以外の引用（通達・判例・条例・告示）を見つける。
 *
 * verify_citations はこれらの実在を確かめない。黙って飛ばすと「全部確かめた」と読まれるので、
 * 見つけたものは「確かめていない引用」として数と一覧を返す（幻覚がそこに混ざっていても素通りしたことが分かるように）。
 */
export type OtherKind = "通達" | "判例" | "条例" | "告示";
export interface OtherCitation { kind: OtherKind; raw: string }

const NUM = "[0-9０-９]+";
const DATE = `(?:昭和|平成|令和|昭|平|令)\\s*(?:${NUM}|元)\\s*[年.．・]\\s*${NUM}\\s*[月.．・]\\s*${NUM}\\s*日?`;
const PATTERNS: Array<[OtherKind, RegExp]> = [
  // 「所得税基本通達9-4-8」「措置法通達31の4-1」「法人税基本通達（9-4-8）」
  ["通達", new RegExp(`[一-龥ァ-ヶー]{1,30}通達(?:\\s*[（(]?${NUM}(?:\\s*[-−－―‐ー〜の]\\s*${NUM})*[）)]?)?`, "g")],
  // 「最判平成5年3月11日」「最三小判令和2.3.24」「東京地判平成30年1月1日」「最高裁判所第二小法廷令和2年3月24日判決」
  ["判例", new RegExp(`(?:最大判|最大決|最[一二三]小[判決]|最判|最決|[一-龥]{1,3}(?:高|地|家)[判決])\\s*${DATE}`, "g")],
  ["判例", new RegExp(`(?:最高裁判所|最高裁|[一-龥]{1,4}(?:高等|地方|家庭)裁判所)(?:[一-龥]{0,4}支部)?(?:第[一二三]小法廷|大法廷)?\\s*${DATE}\\s*(?:判決|決定)`, "g")],
  // 「東京都迷惑防止条例」「横浜市個人情報保護条例」
  ["条例", /[一-龥ァ-ヶー]{1,12}(?:都|道|府|県|市|区|町|村)[一-龥ァ-ヶー・]{0,40}条例/g],
  // 「財務省告示第123号」「厚生労働省告示」
  ["告示", new RegExp(`[一-龥ァ-ヶー]{1,20}(?:省|庁|府|委員会|大臣)告示(?:第${NUM}号)?`, "g")],
];

export function otherCitations(text: string): OtherCitation[] {
  const out: OtherCitation[] = [];
  const seen = new Set<string>();
  for (const [kind, re] of PATTERNS) {
    for (const m of text.matchAll(re)) {
      const raw = m[0].replace(/\s+/g, "");
      // 「市町村条例」「都道府県条例」のような一般名は特定の条例ではない
      if (raw.length < 3 || seen.has(raw) || /^(?:市町村|都道府県|地方公共団体)/.test(raw)) continue;
      seen.add(raw);
      out.push({ kind, raw });
    }
  }
  return out;
}
