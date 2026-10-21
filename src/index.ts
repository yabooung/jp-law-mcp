#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createServer } from "./server.js";
import { KokkaiClient } from "./sources/kokkai.js";
import { SnapshotEgovClient } from "./sources/snapshot.js";

// 評価専用: JP_LAW_MCP_SNAPSHOT_TEXTS があれば e-Gov・国会会議録に問い合わせず、スナップショットの本文で答える（src/sources/snapshot.ts）
const texts = process.env.JP_LAW_MCP_SNAPSHOT_TEXTS;
const offline = (async () => { throw new Error("評価モードでは国会会議録に問い合わせない"); }) as unknown as typeof fetch;
const server = texts
  ? createServer({ egov: new SnapshotEgovClient(texts), kokkai: new KokkaiClient({ fetchImpl: offline }) })
  : createServer();
await server.connect(new StdioServerTransport());
