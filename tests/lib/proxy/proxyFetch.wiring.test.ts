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
// 失敗して connect.lookup が呼ばれず、SsrfBlockedError ではなく FetchTimeoutError に
// なるため、このテストが red になる。
//
// 外部ネットワークへは出ない。`localhost` は hosts ファイルで 127.0.0.1 に解決され、
// かつ接続は connect.lookup の遮断により確立されない。

// 事前検査（assertSsrfAllowed）だけを差し替える。TEST-NET-3（RFC 5737）の
// 203.0.113.1 はブロックリスト外なので事前検査を通過する。
jest.mock("dns/promises", () => ({
  __esModule: true,
  default: {
    lookup: jest.fn(async () => [{ address: "203.0.113.1", family: 4 }]),
  },
}));

import { proxyFetch } from "@/lib/proxy/fetch";

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
    expect.assertions(2);
    try {
      await proxyFetch("http://localhost:8181/");
    } catch (err) {
      const chain = flattenCauses(err);
      // connect.lookup フックが実際に呼ばれた証拠。dispatcher が受理されていなければ
      // フックは呼ばれず、この文字列は現れない（#236 の undici 8 では
      // "invalid onRequestStart method" になる）。
      expect(chain).toContain("Blocked SSRF target");
      expect(chain).not.toContain("onRequestStart");
    }
  }, 20000);
});
