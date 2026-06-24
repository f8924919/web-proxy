/** @jest-environment node */
// 仕様: docs/spec/features/proxy.md §プロキシ UI レスポンスのクリックジャッキング防止（#131）

import nextConfig from "../next.config.mjs";

describe("next.config headers()（#131）", () => {
  test("ホーム / に X-Frame-Options: DENY を付与する", async () => {
    const rules = await nextConfig.headers!();
    const home = rules.find((r: { source: string }) => r.source === "/");
    expect(home).toBeDefined();
    expect(home!.headers).toEqual(
      expect.arrayContaining([{ key: "X-Frame-Options", value: "DENY" }])
    );
  });

  test("中継パス（/browse・/api/proxy）には付与しない", async () => {
    const rules = await nextConfig.headers!();
    const sources = rules.map((r: { source: string }) => r.source);
    // 中継レスポンスを iframe 埋め込み中継のために枠埋め込み可能なままにする。
    expect(sources.every((s: string) => !s.startsWith("/browse"))).toBe(true);
    expect(sources.every((s: string) => !s.startsWith("/api/proxy"))).toBe(
      true
    );
  });
});
