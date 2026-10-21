// e-Gov 法令API の内部用中継: https://<デプロイ先>/api/egov?p=<e-Gov のパス>&… （本体は build/egov-proxy.js）
import { handleEgovProxy } from "../build/egov-proxy.js";

export default function handler(req, res) {
  return handleEgovProxy(req, res);
}
