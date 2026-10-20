import { describe, expect, it } from "vitest";

import { RATE_PER_MIN, allow } from "../src/http.js";

describe("rate limit per client", () => {
  it("allows RATE_PER_MIN requests a minute per client, then refuses until the window passes", () => {
    const t = 1_000_000;
    for (let i = 0; i < RATE_PER_MIN; i++) expect(allow("1.2.3.4", t + i)).toBe(true);
    expect(allow("1.2.3.4", t + 100)).toBe(false);
    expect(allow("5.6.7.8", t + 100)).toBe(true); // 別の送り元は数えない
    expect(allow("1.2.3.4", t + 60_001)).toBe(true);
  });
});
