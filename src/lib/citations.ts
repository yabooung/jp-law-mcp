/**
 * 文章の中の法令引用（「行政手続法（平成五年法律第八十八号）第八条第一項」など）を取り出す。
 *
 * 法令名は「第N条」の直前の文字列の末尾に一致する最も長い辞書の名前で決める（推測で名前を作らない）。
 * 文章の中で定めた略称（「…法律（以下「整備法」という。）」）は、その文章の中だけの名前として使う。
 * 括弧内の法令番号があれば辞書と照合し、名前と合わなければ知らせる（ありがちな誤り）。
 */
import { kanjiToNumber } from "./article.js";
import type { LawNames, NameHit } from "../sources/names.js";

const N = "[0-9〇一二三四五六七八九十百千]+";
// 枝番の後ろに桁区切りや数字が続くものは枝番ではない（「第33条の4の5,000万円」は第33条の4）
const REF = new RegExp(`(同条)|第(${N})条((?:の${N}(?![0-9,，]))*)`, "g");
// 号は「第12号の8」のような枝番も読む（枝番の号は数え方が違うので、号の実在までは確かめない）
const TAIL = new RegExp(`^(?:第(${N})項)?(?:第?(${N})号((?:の${N})*))?`);
// 辞書にない法令らしい名前。文の区切り（読点・助詞など）より後ろだけを名前とみなす
const LAWISH = /([一-龥ぁ-んァ-ヶー・]{1,60}(?:法|法律|政令|省令|府令|規則|条例|規程|令))$/;
const LAWISH_CUT = /^.*(?:[、。「」『』]|は|が|を|で|と|も|により|による|に規定する|に掲げる|に定める|及び|並びに|又は|若しくは|とみなして|について|場合の|ときの)/;
// 「同法」「同令」「同規則」は、その種類で最後に出た法令を指す
const SAME = /同(法|令|規則)$/;
// 文章の中の略称の定め:「…（以下「整備法」という。）」「…（昭和四十年法律第三十三号。以下「法」という。）」
const DEFINE = /[（(。、]以下「([^」]{1,20})」と(?:いう|いいます)/g;
// 法令名のない「第N条」が直前の引用と区切り（、・及び・並びに・又は・若しくは・から・まで・〜）と項・号だけで
// つながっていれば、直前の引用と同じ法令とみなす（「所得税法第33条、第34条」）。直前の引用の法令が分からなければ、
// 分からないことも引き継ぐ（その前の別の法令に結び付けない）。改行をまたぐときは引き継がない
const ENUM_GAP = /^(?:[、,，・ 　〜～~]|及び|並びに|又は|若しくは|から|まで|第?\d+[項号](?:の\d+)*|[イロハニホヘトチリヌルヲワカヨタレソツネナラム]|[（(]\d+[）)])*$/;
// 直前の引用から引き継ぐ、法令についての状態
const LAW_ISSUES: CitationIssue[] = ["no_law_name", "unknown_law", "ambiguous_law", "old_version", "suppl_provision"];
// 法令名の直前に付いても法令名の一部ではない語（「上記民法第…」）。これ以外の漢字が直前に付くと、
// 辞書の名前は実は別の（存在しないかもしれない）法令名の末尾かもしれない（「地方行政手続法」→「行政手続法」と誤認しない）
const PREFIX_OK = new Set(["上記", "前記", "後記", "当該", "現行", "改正後", "改正前", "新", "旧", "同", "本", "各", "前掲", "前述", "右記", "左記", "関係", "特に", "例"]);
const KANJI_END = /[一-龥ァ-ヶー]$/;

/** old_version: 「旧所得税法」「改正前の民法」— 現行版ではなく改正前の版の条。suppl_provision: 附則の条 */
export type CitationIssue = "no_law_name" | "unknown_law" | "ambiguous_law" | "promulgation_mismatch" | "old_version" | "suppl_provision";

export interface Citation {
  raw: string;
  lawName?: string;
  lawId?: string;
  nameKind?: NameHit["kind"];
  /** 括弧内の法令番号（あれば） */
  promulgation?: string;
  article: string; // "8"・"36_2"
  paragraph?: number;
  item?: number;
  issues: CitationIssue[];
  candidates?: string[];
}

const toHalf = (s: string) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
// PDF から写した文章の「第21 条の２」のような数字まわりの空白を詰める
const tighten = (s: string) => s.replace(/(\d)[ 　]+(?=[条項号の])/g, "$1").replace(/([条項号の])[ 　]+(?=\d)/g, "$1");

/** 文章の中で定めた略称 → law_id。定めの直前の名前が辞書で 1 つに決まるものだけ */
function definedNames(text: string, names: LawNames): Map<string, string> {
  const out = new Map<string, string>();
  for (const d of text.matchAll(DEFINE)) {
    const at = d.index ?? 0;
    const open = text[at] === "（" || text[at] === "(" ? at : Math.max(text.lastIndexOf("（", at), text.lastIndexOf("(", at));
    if (open < 0) continue;
    const before = text.slice(Math.max(0, open - 200), open).replace(/[（(][^（）()]{1,60}号[）)]$/, "");
    const hit = names.longestSuffix(before);
    const ids = hit ? [...new Set(hit.hits.map((h) => h.lawId))] : [];
    if (ids.length === 1) out.set(d[1], ids[0]);
  }
  return out;
}

/** w の末尾に一致する最も長い文章内の略称。1 文字の略称（「法」「令」）は直前が漢字でないときだけ */
function localSuffix(w: string, local: Map<string, string>): { name: string; lawId: string } | undefined {
  let best: { name: string; lawId: string } | undefined;
  for (const [name, lawId] of local) {
    if (!w.endsWith(name) || (best && best.name.length >= name.length)) continue;
    if (name.length === 1 && KANJI_END.test(w.slice(0, -1))) continue;
    best = { name, lawId };
  }
  return best;
}

function guessName(w: string): string | undefined {
  const g = LAWISH.exec(w)?.[1].replace(LAWISH_CUT, "");
  return g && g.length >= 2 ? g : undefined;
}

export function extractCitations(input: string, names: LawNames, defaultLawId?: string): Citation[] {
  const text = tighten(toHalf(input));
  const local = definedNames(text, names);
  const out: Citation[] = [];
  const last: Partial<Record<"法" | "令" | "規則", { lawId: string; lawName?: string }>> = {};
  let prev: Citation | undefined;
  let prevEnd = -1;

  for (const m of text.matchAll(REF)) {
    const p = m.index ?? 0;
    const tail = TAIL.exec(text.slice(p + m[0].length))!;
    const end = p + m[0].length + tail[0].length;
    const paragraph = tail[1] ? kanjiToNumber(tail[1]) ?? undefined : undefined;
    const item = tail[2] && !tail[3] ? kanjiToNumber(tail[2]) ?? undefined : undefined;
    const raw = text.slice(p, end);
    const push = (c: Citation) => {
      out.push(c);
      prev = c;
      prevEnd = end;
      if (c.lawId) {
        const t = names.titleOf(c.lawId) ?? c.lawName ?? "";
        last[/規則$/.test(t) ? "規則" : /令$/.test(t) ? "令" : "法"] = { lawId: c.lawId, lawName: c.lawName };
      }
    };

    if (m[1]) { // 同条
      if (prev) push({ ...prev, raw, paragraph, item, issues: [...prev.issues] });
      continue;
    }
    const nums = [m[2], ...(m[3] ? m[3].split("の").filter(Boolean) : [])].map((x) => kanjiToNumber(x));
    if (nums.some((x) => !x)) continue;
    const article = nums.join("_");

    let w = text.slice(Math.max(0, p - 120), p).replace(/\s+$/, "");
    let promulgation: string | undefined;
    const paren = /[（(]([^（）()]{1,60})[）)]$/.exec(w);
    if (paren) {
      // 「（昭和四十年法律第三十三号）」「（昭和四十年法律第三十三号。以下「法」という。）」
      promulgation = /^(.+?号)(?:$|[。、])/.exec(paren[1])?.[1];
      w = w.slice(0, paren.index);
    }
    w = w.replace(/の$/, "");
    const c: Citation = { raw, article, paragraph, item, issues: [], promulgation };

    const same = SAME.exec(w);
    if (same) { // 名前の種類（略称など）は前の引用の話なので引き継がない
      const t = last[same[1] as "法" | "令" | "規則"];
      c.raw = `同${same[1]}${raw}`;
      if (t) Object.assign(c, t);
      else c.issues.push("no_law_name");
      push(c);
      continue;
    }
    if (/附則$/.test(w)) {
      c.raw = `附則${raw}`;
      c.issues.push("suppl_provision");
      push(c);
      continue;
    }

    // 括弧の中が法令番号でなく正式な名前のとき（「…を定める法務省令（…に関する規則）第1条」）はその名前を使う
    const inParen = paren && !promulgation ? names.lookup(paren[1]) : [];
    let hit = inParen.length ? { name: paren![1], hits: inParen } : names.longestSuffix(w);
    const loc = localSuffix(w, local);
    if (loc && (!hit || inParen.length === 0 && loc.name.length > hit.name.length)) {
      c.lawId = loc.lawId;
      c.lawName = loc.name;
      c.nameKind = "abbrev";
      c.raw = `${loc.name}${raw}`;
      push(c);
      continue;
    }
    const before = hit && !inParen.length ? w.slice(0, w.length - hit.name.length) : "";
    const run = before ? /[一-龥ァ-ヶー]+$/.exec(before)?.[0] : undefined;
    if (hit && run && !PREFIX_OK.has(run) && !PREFIX_OK.has(run.slice(-2))) {
      c.lawName = `${run}${hit.name}`;
      c.raw = `${run}${hit.name}${paren ? paren[0] : ""}${raw}`;
      c.issues.push("unknown_law");
      c.candidates = [...new Set(hit.hits.map((h) => h.lawId))];
      hit = null;
      push(c);
      continue;
    }
    if (hit) {
      const ids = [...new Set(hit.hits.map((h) => h.lawId))];
      c.lawName = hit.name;
      c.raw = inParen.length ? `${hit.name}${raw}` : `${hit.name}${paren ? paren[0] : ""}${raw}`;
      const byNum = promulgation ? names.byPromulgation(promulgation) : null;
      const pick = ids.length === 1 ? ids[0] : ids.find((id) => byNum?.includes(id));
      if (pick) {
        c.lawId = pick;
        c.nameKind = hit.hits.find((h) => h.lawId === pick)!.kind;
      } else {
        c.issues.push("ambiguous_law");
        c.candidates = ids;
      }
      // 法令番号として読めて、その番号の法令がこの名前の法令でない（または存在しない）とき
      if (c.lawId && byNum && !byNum.includes(c.lawId)) c.issues.push("promulgation_mismatch");
      if (run === "旧" || /改正前の?$/.test(before)) c.issues.push("old_version");
    } else if (prev && ENUM_GAP.test(text.slice(prevEnd, p))) {
      c.lawId = prev.lawId;
      c.lawName = prev.lawName;
      c.candidates = prev.candidates;
      c.issues.push(...prev.issues.filter((x) => LAW_ISSUES.includes(x)));
    } else {
      const guess = guessName(w);
      if (guess) {
        c.lawName = guess;
        c.raw = `${guess}${paren ? paren[0] : ""}${raw}`;
        c.issues.push("unknown_law");
      } else if (defaultLawId) {
        c.lawId = defaultLawId;
      } else {
        c.issues.push("no_law_name");
      }
    }
    push(c);
  }
  return out;
}
