/** @jest-environment node */
// 仕様: docs/spec/features/proxy.md §クライアント IP の特定（信頼ヘッダーの明示設定・#132）

import { getClientIp, clientIpConfigFromEnv } from "@/lib/proxy/clientIp";

// 代表的な詐称ヘッダーを全部盛りにした受信ヘッダー（信頼設定により採用結果が変わる）。
const spoofable = () =>
  new Headers({
    "cf-connecting-ip": "203.0.113.9",
    "x-forwarded-for": "198.51.100.1, 10.0.0.1, 172.16.0.1",
    "x-real-ip": "192.0.2.5",
  });

describe("clientIpConfigFromEnv", () => {
  test("PROXY_TRUSTED_IP_HEADER 未設定なら trustedHeader は null", () => {
    expect(clientIpConfigFromEnv({}).trustedHeader).toBeNull();
  });

  test("空文字・空白のみなら null（信頼しない）", () => {
    expect(
      clientIpConfigFromEnv({ PROXY_TRUSTED_IP_HEADER: "" }).trustedHeader
    ).toBeNull();
    expect(
      clientIpConfigFromEnv({ PROXY_TRUSTED_IP_HEADER: "   " }).trustedHeader
    ).toBeNull();
  });

  test("設定値は小文字化・トリムして返す（ヘッダー名はケース非依存）", () => {
    expect(
      clientIpConfigFromEnv({ PROXY_TRUSTED_IP_HEADER: " CF-Connecting-IP " })
        .trustedHeader
    ).toBe("cf-connecting-ip");
  });
});

describe("getClientIp", () => {
  test("信頼ヘッダー未設定なら詐称ヘッダーがあっても fail-safe の 'unknown'", () => {
    expect(getClientIp(spoofable(), { trustedHeader: null })).toBe("unknown");
  });

  test("信頼ヘッダーに cf-connecting-ip を設定するとその値を採用する", () => {
    expect(
      getClientIp(spoofable(), { trustedHeader: "cf-connecting-ip" })
    ).toBe("203.0.113.9");
  });

  test("信頼ヘッダーに x-real-ip を設定するとその値を採用する", () => {
    expect(getClientIp(spoofable(), { trustedHeader: "x-real-ip" })).toBe(
      "192.0.2.5"
    );
  });

  test("x-forwarded-for は詐称可能な最左ではなく信頼プロキシ付与の最右値を採用する", () => {
    expect(getClientIp(spoofable(), { trustedHeader: "x-forwarded-for" })).toBe(
      "172.16.0.1"
    );
  });

  test("単一値の x-forwarded-for はその値を採用する", () => {
    const headers = new Headers({ "x-forwarded-for": "198.51.100.1" });
    expect(getClientIp(headers, { trustedHeader: "x-forwarded-for" })).toBe(
      "198.51.100.1"
    );
  });

  test("信頼ヘッダーを設定しても当該ヘッダーが無ければ 'unknown'", () => {
    const headers = new Headers({ "x-real-ip": "192.0.2.5" });
    expect(getClientIp(headers, { trustedHeader: "cf-connecting-ip" })).toBe(
      "unknown"
    );
  });

  test("信頼ヘッダーの値が空・空白のみなら 'unknown'", () => {
    const headers = new Headers({ "cf-connecting-ip": "   " });
    expect(getClientIp(headers, { trustedHeader: "cf-connecting-ip" })).toBe(
      "unknown"
    );
  });

  test("config 省略時は env を解決する（未設定環境では 'unknown'）", () => {
    const saved = process.env.PROXY_TRUSTED_IP_HEADER;
    delete process.env.PROXY_TRUSTED_IP_HEADER;
    try {
      expect(getClientIp(spoofable())).toBe("unknown");
    } finally {
      if (saved === undefined) delete process.env.PROXY_TRUSTED_IP_HEADER;
      else process.env.PROXY_TRUSTED_IP_HEADER = saved;
    }
  });
});
