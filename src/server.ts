import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { EgovClient } from "./sources/egov.js";
import { CitationGraph, defaultGraph } from "./sources/graph.js";
import { KokkaiClient } from "./sources/kokkai.js";
import { LawNames, defaultNames } from "./sources/names.js";
import { LawStructure, defaultStructure } from "./sources/structure.js";
import { NoticeIndex, defaultNotices } from "./sources/tsutatsu.js";
import { registerPrompts } from "./prompts.js";
import { registerDietTools } from "./tools/diet.js";
import { registerGraphTools } from "./tools/graph.js";
import { registerLawTools } from "./tools/law.js";
import { registerSearchTools } from "./tools/search.js";
import { registerVerifyTools } from "./tools/verify.js";
import { VERSION } from "./version.js";

export interface ServerDeps {
  kokkai?: KokkaiClient;
  egov?: EgovClient;
  graph?: () => CitationGraph;
  names?: () => LawNames;
  structure?: () => LawStructure;
  notices?: () => NoticeIndex | undefined;
  today?: () => string;
}

/**
 * クライアント（AI）に渡す使い方。答えに存在しない条を残さないこと（幻覚の除去）がこのサーバーの目的なので、
 * 法令を挙げて答えるときは最後に verify_citations で確かめるよう求める。
 */
export const INSTRUCTIONS = [
  "日本の法令（e-Gov 法令検索）と国会会議録を確かめるためのツールです。",
  "法令の条・項・号を挙げて答えるときは、答えを返す前に、挙げた引用をまとめて verify_citations に渡してください。",
  "❌（存在しない）と出た引用は直すか取り除き、⚠ の引用は理由（法令名の推定・改正前の版など）を確かめてから使ってください。",
  "条文の中身に触れた答えでは detail=true にして、返ってきた条文の抜粋と答えの内容が合っているかも確かめてください。",
  "条文の中身を述べるときは、get_article で原文を読んでから書いてください（覚えている内容と違うことがあります）。",
  "このツールが返すのは法令と国会会議録だけです。通達・判例・条例などに触れるときは、このツールでは確かめていないと答えに書いてください。",
].join("");

/** 通信方式（stdio・HTTP）に依存しないサーバー本体。 */
export function createServer(deps: ServerDeps = {}): McpServer {
  const server = new McpServer({ name: "jp-law-mcp", version: VERSION }, { instructions: INSTRUCTIONS });
  const egov = deps.egov ?? new EgovClient();
  const names = deps.names ?? defaultNames;
  registerLawTools(server, egov, deps.today, names, deps.graph ?? defaultGraph);
  registerSearchTools(server, egov);
  registerVerifyTools(server, egov, names, deps.structure ?? defaultStructure, deps.notices ?? defaultNotices);
  registerGraphTools(server, deps.graph ?? defaultGraph, egov, names);
  registerDietTools(server, deps.kokkai ?? new KokkaiClient());
  registerPrompts(server);
  return server;
}
