/** @jest-environment node */
// 仕様: docs/spec/features/proxy.md §DNS リバインディング / TOCTOU 対策（IP ピン留め）
// 実装意図: docs/arch/proxy.md §DNS リバインディング / TOCTOU 対策（IP ピン留め・undici `Agent`）
//
// proxyFetch の「dispatcher 配線」が実行時に生きていることを検証する（#236 / #129）。
//
// SSRF ガードがループバックをブロックするため、proxyFetch をローカルサーバーへ接続
// させることはできない（本番コードに seam を入れない方針。docs/testing/policy.md §1.1）。
// そこで事前検査（dns/promises を使う assertSsrfAllowed）だけをモックで通過させ、
// connect.lookup フック（node:dns を使う。別 specifier のためモックの影響を受けない）
// が実際に呼ばれて SsrfBlockedError を投げ、それが fetch の cause 連鎖を通って
// proxyFetch まで伝播することを確認する。
//
// この経路は undici の Agent が Node 組み込み fetch の dispatcher として受理されて
// 初めて成立する。受理されない場合（#236 の undici 8 系）は dispatch 検証の段階で
// 失敗して connect.lookup が呼ばれず、cause 連鎖のメッセージが "Blocked SSRF target"
// から "invalid onRequestStart method" に変わるため、このテストが red になる
// （投げられる例外の型はどちらの場合も FetchTimeoutError で、型では区別できない）。
//
// 外部ネットワークへは出ない。`localhost` は hosts ファイルで 127.0.0.1 に解決され、
// かつ接続は connect.lookup の遮断により確立されない。
//
// なぜ instanceof でなくメッセージ文字列で検証するか（#237）:
// `connect.lookup` の callback へ渡した例外は、それが **呼び出し元と別 realm の
// オブジェクトだった場合にだけ** undici / Node 内部でプレーンな `Error`（message が
// "SsrfBlockedError: ..." へ文字列化されたもの）に置き換えられ、クラス情報も
// カスタムプロパティも失われる。jest-environment-node はテストコードを vm context で
// 実行するため常にこの状況になり、ここで捕捉する err は `SsrfBlockedError` ではなく
// `FetchTimeoutError`（cause 連鎖の奥に文字列化された Error を持つ）になる。
// これはテスト環境固有の現象で、単一 realm で動く実運用では `SsrfBlockedError` が
// cause 連鎖にそのまま残り、`findSsrfCause` の instanceof 判定が成立して 403 が返る
// （検出ロジック自体は fetch.test.ts の findSsrfCause テストで担保）。
// 実装意図: docs/arch/proxy.md §DNS リバインディング / TOCTOU 対策（テスト環境固有の realm 差）

// 事前検査（assertSsrfAllowed）だけを差し替える。TEST-NET-3（RFC 5737）の
// 203.0.113.1 はブロックリスト外なので事前検査を通過する。
jest.mock("dns/promises", () => ({
  __esModule: true,
  default: {
    lookup: jest.fn(async () => [{ address: "203.0.113.1", family: 4 }]),
  },
}));

import { proxyFetch, SsrfBlockedError } from "@/lib/proxy/fetch";

// cause 連鎖を平坦化して 1 本の文字列にする（redact はしないテスト専用ヘルパー）。
function flattenCauses(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 8 && cur; i++) {
    const e = cur as Error & { cause?: unknown };
    parts.push(`${e.name}: ${e.message}`);
    cur = e.cause;
  }
  return parts.join(" <- ");
}

describe("proxyFetch の dispatcher 配線（IP ピン留め）", () => {
  test("invokes_connect_lookup_hook_and_blocks_loopback", async () => {
    // 事前検査は 203.0.113.1（モック）で通過するが、connect.lookup は実 DNS で
    // localhost を 127.0.0.1 / ::1 に解決するため、接続前にピン留め検査で遮断される。
    // ポートは fetch のブロック対象外（"bad port" 以外）であればよく、待受は不要。
    expect.assertions(3);
    try {
      await proxyFetch("http://localhost:8181/");
    } catch (err) {
      const chain = flattenCauses(err);
      // connect.lookup フックが実際に呼ばれた証拠。dispatcher が受理されていなければ
      // フックは呼ばれず、この文字列は現れない（#236 の undici 8 では
      // "invalid onRequestStart method" になる）。
      expect(chain).toContain("Blocked SSRF target");
      expect(chain).not.toContain("onRequestStart");
      // 上のコメントで説明した realm 差を明示的に固定する（#237）。この期待値は
      // **Jest 環境限定**であり、実運用の期待挙動ではない（実運用では instanceof が
      // 成立して 403 になる）。もしここが red になったら realm 差が解消したという
      // ことなので、メッセージ文字列でなく instanceof で検証する形へ強化してよい。
      expect(err).not.toBeInstanceOf(SsrfBlockedError);
    }
  }, 20000);
});
