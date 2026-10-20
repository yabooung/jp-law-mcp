// Vercel 関数の入口: https://<デプロイ先>/api/mcp （vercel.json で /mcp にも割り当て）
// 本体は tsc でビルドした build/http.js。デプロイ時に `npm run build` が走る。
import { handleMcp } from "../build/http.js";

export default function handler(req, res) {
  return handleMcp(req, res);
}
