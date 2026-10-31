import { describe, expect, it } from "vitest";
import { allowed, MemoryLimiter, TokenBucket } from "../../src/worker/ratelimit";

describe("MemoryLimiter", () => {
  it("allows up to the limit per key in each window", async () => {
    let now = 0;
    const limiter = new MemoryLimiter({ limit: 3, period: 10 }, () => now);
    const results = [];
    for (let i = 0; i < 4; i++) results.push((await limiter.limit({ key: "a" })).success);
    expect(results).toEqual([true, true, true, false]);
    expect((await limiter.limit({ key: "b" })).success).toBe(true);
    now = 10_000;
    expect((await limiter.limit({ key: "a" })).success).toBe(true);
  });

  it("stays bounded in memory when many clients appear", async () => {
    let now = 0;
    const limiter = new MemoryLimiter({ limit: 1, period: 60 }, () => now, 100);
    for (let i = 0; i < 500; i++) await limiter.limit({ key: `ip-${i}` });
    expect((limiter as unknown as { windows: Map<string, unknown> }).windows.size).toBeLessThanOrEqual(100);
    now = 61_000;
    expect((await limiter.limit({ key: "ip-499" })).success).toBe(true);
  });
});

describe("allowed", () => {
  it("lets requests through if the limiter itself fails", async () => {
    const broken = { limit: async () => Promise.reject(new Error("unavailable")) };
    expect(await allowed(broken, "x")).toBe(true);
    expect(await allowed({ limit: async () => ({ success: false }) }, "x")).toBe(false);
  });
});

describe("TokenBucket", () => {
  it("allows a burst, then refills at the steady rate", () => {
    const bucket = new TokenBucket({ burst: 3, perSecond: 2 }, 0);
    expect([bucket.take(0), bucket.take(0), bucket.take(0), bucket.take(0)]).toEqual([true, true, true, false]);
    expect(bucket.dropped).toBe(1);
    expect(bucket.take(499)).toBe(false);
    expect(bucket.dropped).toBe(2);
    expect(bucket.take(1000)).toBe(true);
    expect(bucket.dropped).toBe(0);
    // A long pause refills only up to the burst size.
    const results = [];
    for (let i = 0; i < 5; i++) results.push(bucket.take(60_000));
    expect(results).toEqual([true, true, true, false, false]);
  });
});
