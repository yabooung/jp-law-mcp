import { describe, expect, it } from "vitest";

import { IP_RATE_PER_MIN, RATE_PER_MIN, allow, ipPrefix, toolCalls, userTag } from "../src/http.js";

describe("rate limit per client", () => {
  it("allows RATE_PER_MIN requests a minute per client, then refuses until the window passes", () => {
    const t = 1_000_000;
    for (let i = 0; i < RATE_PER_MIN; i++) expect(allow("1.2.3.4", t + i)).toBe(true);
    expect(allow("1.2.3.4", t + 100)).toBe(false);
    expect(allow("5.6.7.8", t + 100)).toBe(true); // 別の送り元は数えない
    expect(allow("1.2.3.4", t + 60_001)).toBe(true);
  });
});

describe("users behind one IP", () => {
  it("reads ?u= as the user tag and ignores anything unsafe", () => {
    expect(userTag("/mcp?u=alice_01")).toBe("alice_01");
    expect(userTag("/mcp")).toBe("");
    expect(userTag("/mcp?u=<script>")).toBe("");
    expect(userTag(`/mcp?u=${"a".repeat(65)}`)).toBe("");
  });

  it("counts each user separately under the larger per-IP cap", () => {
    const t = 2_000_000;
    for (let i = 0; i < RATE_PER_MIN; i++) expect(allow("9.9.9.9|a", t + i)).toBe(true);
    expect(allow("9.9.9.9|a", t + 100)).toBe(false);
    expect(allow("9.9.9.9|b", t + 100)).toBe(true);
    for (let i = 0; i < IP_RATE_PER_MIN; i++) allow("9.9.9.9", t + i, IP_RATE_PER_MIN);
    expect(allow("9.9.9.9", t + 200, IP_RATE_PER_MIN)).toBe(false);
  });

  it("logs only the front of an IP", () => {
    expect(ipPrefix("160.79.104.10")).toBe("160.79.104.0/24");
    expect(ipPrefix("2607:6bc0:1:2::5")).toBe("2607:6bc0:1::/48");
  });
});

describe("what the rate limit counts", () => {
  it("counts tool calls only, one by one in a batch", () => {
    expect(toolCalls({ jsonrpc: "2.0", id: 1, method: "initialize" })).toBe(0);
    expect(toolCalls({ jsonrpc: "2.0", method: "notifications/initialized" })).toBe(0);
    expect(toolCalls({ jsonrpc: "2.0", id: 2, method: "tools/list" })).toBe(0);
    expect(toolCalls({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "find_law" } })).toBe(1);
    expect(toolCalls([{ method: "tools/call" }, { method: "tools/call" }, { method: "ping" }])).toBe(2);
    expect(toolCalls(undefined)).toBe(0);
  });
});
