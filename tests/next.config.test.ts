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

describe("next.config agentRules", () => {
  // next dev は既定で CLAUDE.md の末尾に英語の agent rules ブロックを書き込む。
  // CLAUDE.md は日本語の運用ルールの正本なので、書き込みを止める。
  // 背景: docs/setup.md §3 開発サーバーの起動
  test("agentRules を false にして CLAUDE.md への自動書き込みを止める", () => {
    expect((nextConfig as { agentRules?: boolean }).agentRules).toBe(false);
  });
});
