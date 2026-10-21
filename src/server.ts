import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { EgovClient } from "./sources/egov.js";
import { CitationGraph, defaultGraph } from "./sources/graph.js";
import { KokkaiClient } from "./sources/kokkai.js";
import { LawNames, defaultNames } from "./sources/names.js";
import { LawStructure, defaultStructure } from "./sources/structure.js";
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
  today?: () => string;
}

/** 通信方式（stdio・HTTP）に依存しないサーバー本体。 */
export function createServer(deps: ServerDeps = {}): McpServer {
  const server = new McpServer({ name: "jp-law-mcp", version: VERSION });
  const egov = deps.egov ?? new EgovClient();
  const names = deps.names ?? defaultNames;
  registerLawTools(server, egov, deps.today, names);
  registerSearchTools(server, egov);
  registerVerifyTools(server, egov, names, deps.structure ?? defaultStructure);
  registerGraphTools(server, deps.graph ?? defaultGraph, egov, names);
  registerDietTools(server, deps.kokkai ?? new KokkaiClient());
  return server;
}
