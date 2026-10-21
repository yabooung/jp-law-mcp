/**
 * 答えの評価: このサーバーを付けた AI の「答え」が、正しい条を挙げているか・存在しない条を挙げていないかを測る
 * （npm run build の後に実行）。verify_eval.mjs がツール単体を測るのに対し、こちらは AI が書いた最終的な答えを測る。
 *
 * 資料: 国税庁 質疑応答事例（jlawcite の eval/v2/nta_gold.jsonl）の「照会要旨」を質問に、「関係法令」から作った
 *       条単位の正解（gold_articles）を答えに使う。verify_eval.mjs と同じハッシュの dev 側からだけ選ぶ（test は使わない）。
 *
 * 比べる 2 条件（同じモデル・同じ指示・同じ質問）:
 *   mcp  : このサーバーを付ける（スナップショット・モード。e-Gov・国会会議録には問い合わせない — src/sources/snapshot.ts）
 *   none : ツールなし（モデルの知識だけ）
 * AI は Claude Code の非対話モード（claude -p）で動かす。組み込みのツール（Web 検索・ファイル）は外し、
 * 設定・記憶を読まない空のフォルダで動かし、システムプロンプトは下の SYSTEM に置き換える。
 *
 * 採点（答えの文章から verify_citations と同じ抽出で法令の引用を取り出し、同梱の data/structure.json.gz で判定）:
 *   gold_recall  : 正解の条のうち答えが挙げた割合（条単位。項・号は問わない）
 *   any_gold     : 正解の条を 1 つ以上挙げた問の割合
 *   nonexistent  : 答えが挙げた引用のうち、存在しない条・項・号・法令名・番号違いの割合（いわゆる幻覚の引用）
 *   conclusion   : 結論が国税庁の回答と合うか（一致・一部一致・不一致・判断不能）。別の claude -p（ツールなし）が、質問・国税庁の
 *                  回答・AI の答えだけを見て判定する。どちらの条件の答えかは判定役に見せない
 * 正解は関係法令欄の条だけなので、正解にない条を挙げても誤りとはしない（数だけ記録する）。
 * 国税庁の回答は通達など法令以外にもよる。このサーバーは法令だけを返すので、条文を文字どおり読むと実務の結論と
 * ずれることがある（2026-10-21 の試行 joto_05_07: 措法31条の4 を「長期譲渡所得だけ」と読み、短期にも使えるとする回答と逆）。
 * 抽出はこのツール自身のもの（文の中の引用では法令名なしが 13.6% — README）なので、両条件に同じだけ効く。
 *
 *   node eval/answer_eval.mjs --gold <nta_gold.jsonl> --texts work/eval_texts.json.gz --n 50 [--model sonnet] [--jobs 2]
 *
 * 答えは eval/.cache/answer_<条件>.jsonl に 1 問ずつ足していく（途中で止めても、もう一度実行すれば続きから）。
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";

import { LawNames } from "../build/sources/names.js";
import { LawStructure } from "../build/sources/structure.js";
import { verifyText } from "../build/tools/verify.js";

const { values: a } = parseArgs({
  options: {
    gold: { type: "string" },
    texts: { type: "string", default: "work/eval_texts.json.gz" },
    n: { type: "string", default: "50" },
    model: { type: "string", default: "sonnet" },
    jobs: { type: "string", default: "2" },
    conds: { type: "string", default: "mcp,none" },
    timeout: { type: "string", default: "300" },
  },
});
if (!a.gold) throw new Error("--gold が必要です");

const SALT = "jp-law-mcp/verify-eval/2026-10-20"; // verify_eval.mjs と同じ分け方
const splitOf = (id) => (createHash("sha256").update(`${SALT}:${id}`).digest()[0] < 128 ? "dev" : "test");
const order = (id) => createHash("sha256").update(`jp-law-mcp/answer-eval/2026-10-21:${id}`).digest("hex");
const cases = readFileSync(a.gold, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  .filter((c) => c.gold_articles.length && splitOf(c.id) === "dev")
  .sort((x, y) => order(x.id).localeCompare(order(y.id)))
  .slice(0, Number(a.n));

const SYSTEM = "あなたは日本の行政・税務の実務者の質問に答えるアシスタントです。日本語で、簡潔に答えてください。";
const prompt = (c) => `次の質問に答えてください。答えの根拠となる法令の条項を「○○法第N条第M項」のように法令名と条番号で挙げてください。\n\n質問: ${c.query}`;

// ---- AI に答えさせる ----
const work = join(tmpdir(), "jp-law-mcp-answer-eval"); // 設定・CLAUDE.md・記憶のない空のフォルダ
mkdirSync(work, { recursive: true });
const mcpConfig = join(work, "mcp.json");
writeFileSync(mcpConfig, JSON.stringify({
  mcpServers: { "jp-law": { command: process.execPath, args: [resolve("build/index.js")], env: { JP_LAW_MCP_SNAPSHOT_TEXTS: resolve(a.texts) } } },
}));
// Windows の claude.cmd は shell なしでは起動できない（引数の改行が崩れる）ので、中の claude.exe を直接使う。JP_LAW_MCP_CLAUDE で上書き
const CLAUDE = process.env.JP_LAW_MCP_CLAUDE ?? (process.platform === "win32" && process.env.APPDATA
  ? join(process.env.APPDATA, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe") : "claude");

function ask(c, cond) {
  const args = ["-p", prompt(c), "--model", a.model, "--output-format", "stream-json", "--verbose", "--no-session-persistence",
    "--system-prompt", SYSTEM, "--tools", "", "--strict-mcp-config"];
  if (cond === "mcp") args.push("--mcp-config", mcpConfig, "--allowedTools", "mcp__jp-law");
  return run(args).then(({ events, code, err }) => {
    const tools = [];
    let result = null;
    for (const ev of events) {
      if (ev.type === "assistant") for (const b of ev.message?.content ?? []) if (b.type === "tool_use") tools.push(b.name.replace(/^mcp__jp-law__/, ""));
      if (ev.type === "result") result = ev;
    }
    return {
      id: c.id, cond, model: a.model, answer: result?.result ?? null, error: result?.is_error || code ? (err || result?.result || `exit ${code}`).slice(0, 300) : null,
      tools, turns: result?.num_turns ?? null, ms: result?.duration_ms ?? null,
    };
  });
}

const JUDGE = "あなたは日本の税務の専門家として、AI の答えの結論が国税庁の回答の結論と合っているかだけを判定します。" +
  "根拠条文の書き方や詳しさは問いません。次の JSON だけを出力してください: " +
  '{"verdict": "一致" | "一部一致" | "不一致" | "判断不能", "reason": "一文"}';
function judge(c, answer) {
  const text = `質問:\n${c.query}\n\n国税庁の回答:\n${c.answer}\n\nAI の答え:\n${answer}`;
  return run(["-p", text, "--model", a.model, "--output-format", "stream-json", "--verbose", "--no-session-persistence",
    "--system-prompt", JUDGE, "--tools", "", "--strict-mcp-config"]).then(({ events }) => {
    const out = events.find((e) => e.type === "result")?.result ?? "";
    const m = /\{[\s\S]*\}/.exec(out);
    try { return JSON.parse(m?.[0] ?? ""); } catch { return { verdict: "判定失敗", reason: out.slice(0, 200) }; }
  });
}

function run(args) {
  return new Promise((done) => {
    const p = spawn(CLAUDE, args, { cwd: work, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => p.kill(), Number(a.timeout) * 1000);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => {
      clearTimeout(timer);
      const events = [];
      for (const line of out.split("\n")) {
        if (!line.trim()) continue;
        try { events.push(JSON.parse(line)); } catch { /* 途中の行 */ }
      }
      done({ events, code, err });
    });
  });
}

mkdirSync("eval/.cache", { recursive: true });
const conds = a.conds.split(",");
for (const cond of conds) {
  const file = `eval/.cache/answer_${cond}.jsonl`;
  const have = new Set(existsSync(file) ? readFileSync(file, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.answer).map((r) => r.id) : []);
  const todo = cases.filter((c) => !have.has(c.id));
  let next = 0;
  await Promise.all(Array.from({ length: Number(a.jobs) }, async () => {
    while (next < todo.length) {
      const c = todo[next++];
      const r = await ask(c, cond);
      appendFileSync(file, JSON.stringify(r) + "\n");
      console.error(`[${cond}] ${have.size + next}/${cases.length} ${c.id} ${r.error ? "ERROR " + r.error.slice(0, 80) : `tools=${r.tools.length}`}`);
    }
  }));
}

// ---- 結論の判定（条件を伏せ、問ごとに順番も混ぜる）----
const judgeFile = "eval/.cache/answer_judge.jsonl";
const judged = new Map(existsSync(judgeFile) ? readFileSync(judgeFile, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((r) => [`${r.id}|${r.cond}`, r]) : []);
const toJudge = [];
for (const cond of conds) {
  for (const l of readFileSync(`eval/.cache/answer_${cond}.jsonl`, "utf-8").split("\n").filter(Boolean)) {
    const r = JSON.parse(l);
    const c = cases.find((x) => x.id === r.id);
    if (c && r.answer && !judged.has(`${r.id}|${cond}`)) toJudge.push({ c, cond, answer: r.answer });
  }
}
toJudge.sort((x, y) => order(`${x.c.id}|${x.cond}`).localeCompare(order(`${y.c.id}|${y.cond}`)));
let nj = 0;
await Promise.all(Array.from({ length: Number(a.jobs) }, async () => {
  while (nj < toJudge.length) {
    const t = toJudge[nj++];
    const v = await judge(t.c, t.answer);
    const row = { id: t.c.id, cond: t.cond, ...v };
    judged.set(`${t.c.id}|${t.cond}`, row);
    appendFileSync(judgeFile, JSON.stringify(row) + "\n");
    console.error(`[judge] ${nj}/${toJudge.length} ${t.c.id} ${v.verdict}`);
  }
}));

// ---- 採点 ----
const raw = JSON.parse(gunzipSync(readFileSync("data/structure.json.gz")).toString("utf-8"));
const st = new LawStructure(raw);
const names = LawNames.load();
const client = { async article() { throw new Error("採点では e-Gov を呼ばない"); } };
const NONEXISTENT = new Set(["no_article", "no_paragraph", "no_item", "unknown_law", "promulgation_mismatch"]);
const goldKey = (lawId, article) => `${lawId}_a${article.replace(/_/g, "-")}`;
const byId = new Map(cases.map((c) => [c.id, c]));
const summary = { date: new Date().toISOString().slice(0, 10), model: a.model, cases: cases.length, snapshot: raw.snapshot, conds: {} };
const detail = {};
for (const cond of conds) {
  const rows = new Map();
  for (const l of readFileSync(`eval/.cache/answer_${cond}.jsonl`, "utf-8").split("\n").filter(Boolean)) {
    const r = JSON.parse(l);
    if (byId.has(r.id) && r.answer) rows.set(r.id, r);
  }
  let goldN = 0, goldHit = 0, any = 0, cites = 0, resolved = 0, bad = 0, extra = 0, usedTools = 0, toolCalls = 0;
  const verdicts = {};
  const per = [];
  for (const c of cases) {
    const r = rows.get(c.id);
    if (!r) continue;
    const res = await verifyText(r.answer, { client, names, structure: st, maxApiCalls: 0 });
    const gold = new Set(c.gold_articles);
    const found = new Set();
    const wrong = [];
    for (const { citation, verdict } of res.checked) {
      cites++;
      if (NONEXISTENT.has(verdict.code)) { bad++; wrong.push(`${citation.raw}: ${verdict.code}`); }
      if (!citation.lawId) continue;
      resolved++;
      const k = goldKey(citation.lawId, citation.article);
      if (gold.has(k)) found.add(k); else if (!NONEXISTENT.has(verdict.code)) extra++;
    }
    goldN += gold.size; goldHit += found.size; any += found.size > 0 ? 1 : 0;
    usedTools += r.tools.length ? 1 : 0; toolCalls += r.tools.length;
    const j = judged.get(`${c.id}|${cond}`);
    verdicts[j?.verdict ?? "未判定"] = (verdicts[j?.verdict ?? "未判定"] ?? 0) + 1;
    per.push({ id: c.id, gold: [...gold], found: [...found], citations: res.checked.length, nonexistent: wrong, tools: r.tools, conclusion: j });
  }
  const answered = per.length;
  const rate = (k, n) => ({ k, n, rate: n ? Math.round((k / n) * 10000) / 10000 : null });
  summary.conds[cond] = {
    answered, gold_recall: rate(goldHit, goldN), any_gold: rate(any, answered), citations: cites, citations_with_law: resolved,
    nonexistent: rate(bad, cites), not_in_gold_existing: extra, used_tools: rate(usedTools, answered), tool_calls: toolCalls,
    conclusion: verdicts, conclusion_agree: rate(verdicts["一致"] ?? 0, answered),
  };
  detail[cond] = per;
}
mkdirSync("eval/results", { recursive: true });
writeFileSync("eval/results/answer_eval.json", JSON.stringify(summary, null, 1));
writeFileSync("eval/.cache/answer_eval_detail.json", JSON.stringify(detail, null, 1));
console.log(JSON.stringify(summary, null, 1));
