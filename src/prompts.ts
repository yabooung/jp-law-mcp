/**
 * よくある実務の手順をプロンプト（クライアントの「/」メニューなどから選べるひな形）として出す。
 * 中身はツールの使い方の指示だけで、サーバーは外部 API を呼ばない。
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const user = (text: string) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text } }] });

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "check_document",
    {
      title: "文書の法令引用を確認する",
      description: "通知文・答弁案・AI が書いた回答などの法令引用（条・項・号）が実在するかを確かめ、直すべき箇所を一覧にする",
      argsSchema: { text: z.string().describe("確認する文書") },
    },
    ({ text }) => user([
      "次の文書の法令引用を確かめてください。",
      "1. verify_citations に文書をそのまま渡す。文書が一つの法令についてのもので、法令名のない「第N条」が多ければ、default_law にその法令を指定する。",
      "2. ❌（存在しない）・⚠（要確認）の引用ごとに、何が問題か（存在しない条・項、法令名の誤り、法令番号の食い違い、改正前の版、推定した法令など）と、",
      "   直し方の候補を示す。直し方は推測で作らず、find_law・get_article で確かめた条文だけを使う。",
      "3. 「確かめていない引用（通達・判例・条例など）」があれば、確かめていないことを明記する。",
      "4. 最後に、直した後の文書の該当箇所を示す。",
      "",
      "文書:",
      text,
    ].join("\n")),
  );

  server.registerPrompt(
    "article_at_date",
    {
      title: "処分・申請の当時の条文を確かめる",
      description: "ある日に施行されていた条文（行為時法）と、その後の改正を確かめる",
      argsSchema: {
        law: z.string().describe("法令名・略称・法令ID"),
        article: z.string().describe("条番号。例: 8、第八条、36条の2"),
        date: z.string().describe("処分・申請などの日 YYYY-MM-DD（2017-04-01 以降）"),
      },
    },
    ({ law, article, date }) => user([
      `${law} ${article} について、${date} に施行されていた条文を確かめてください。`,
      `1. get_article で asof=${date} の条文を読む。`,
      `2. compare_article で ${date} と現行を比べ、変わった行があれば示す。`,
      "3. law_history で、その間の改正（施行日・改正法令）を示す。",
      "条文の文言はツールの結果から引用し、記憶で補わないでください。",
    ].join("\n")),
  );

  server.registerPrompt(
    "amendment_impact",
    {
      title: "改正の影響範囲を調べる",
      description: "ある条を改正・削除したときに、引用・準用している他の法令の条を洗い出す",
      argsSchema: {
        law: z.string().describe("法令名・略称・法令ID"),
        article: z.string().optional().describe("条番号（省略で法令全体）"),
      },
    },
    ({ law, article }) => user([
      `${law}${article ? ` ${article}` : ""} を改正するときの影響範囲を調べてください。`,
      "1. find_citing_provisions で、この条（法令）を引用・委任元として参照している条を法令ごとに挙げる（depth=2 で間接的な範囲の数も）。",
      "2. 影響が大きそうな参照先は get_article で原文を読み、どのような引用か（準用・読替え・要件の引用など）を一言で示す。",
      "3. 引用グラフは本則の条からの参照だけで、附則・通達・条例は含まないことを明記する。",
    ].join("\n")),
  );
}
