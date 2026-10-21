export const VERSION = "0.2.0";
/** 外部 API に送る User-Agent。送り手が分かるように付ける（環境変数 JP_LAW_MCP_UA で上書き） */
export const USER_AGENT = process.env.JP_LAW_MCP_UA ?? `jp-law-mcp/${VERSION}`;
