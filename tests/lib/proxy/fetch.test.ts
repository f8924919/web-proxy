/** @jest-environment node */
// 仕様: docs/spec/features/proxy.md §SSRF 対策 / §POST 中継

import { isSsrfBlocked, buildProxyRequestInit } from "@/lib/proxy/fetch";

describe("isSsrfBlocked", () => {
  test.each([
    ["127.0.0.1", "loopback"],
    ["127.0.0.2", "loopback range"],
    ["10.0.0.1", "private class A"],
    ["10.255.255.255", "private class A upper"],
    ["172.16.0.1", "private class B lower"],
    ["172.31.255.255", "private class B upper"],
    ["192.168.0.1", "private class C"],
    ["192.168.255.255", "private class C upper"],
    ["169.254.169.254", "cloud metadata"],
    ["169.254.0.1", "link-local"],
    ["0.0.0.0", "unspecified"],
  ])("returns true for %s (%s)", (ip) => {
    expect(isSsrfBlocked(ip)).toBe(true);
  });

  test.each([
    ["1.1.1.1", "public DNS"],
    ["8.8.8.8", "Google DNS"],
    ["93.184.216.34", "example.com"],
    ["172.15.255.255", "just below private class B"],
    ["172.32.0.0", "just above private class B"],
    ["11.0.0.0", "just above private class A"],
    ["192.169.0.0", "just above private class C"],
  ])("returns false for %s (%s)", (ip) => {
    expect(isSsrfBlocked(ip)).toBe(false);
  });
});

describe("buildProxyRequestInit", () => {
  test("defaults_to_get_without_body_and_keeps_base_headers", () => {
    const init = buildProxyRequestInit();
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(init.duplex).toBeUndefined();
    const headers = init.headers as Record<string, string>;
    expect(headers["User-Agent"]).toContain("web-proxy");
    expect(headers["Accept-Encoding"]).toBe("identity");
  });

  test("forwards_post_method_with_stream_body_and_sets_duplex_half", () => {
    const body = new ReadableStream();
    const init = buildProxyRequestInit({ method: "POST", body });
    expect(init.method).toBe("POST");
    expect(init.body).toBe(body);
    // ReadableStream ボディには duplex: "half" が必須
    expect(init.duplex).toBe("half");
  });

  test("forwards_request_content_type_header_merged_over_base_headers", () => {
    const init = buildProxyRequestInit({
      method: "POST",
      body: "a=1",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    const headers = init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/x-www-form-urlencoded");
    // 既定ヘッダーは維持される
    expect(headers["Accept-Encoding"]).toBe("identity");
  });

  test("omits_duplex_for_non_stream_body", () => {
    const init = buildProxyRequestInit({ method: "POST", body: "a=1" });
    expect(init.body).toBe("a=1");
    expect(init.duplex).toBeUndefined();
  });

  test("drops_body_for_get_even_if_provided", () => {
    const init = buildProxyRequestInit({ method: "GET", body: "a=1" });
    expect(init.body).toBeUndefined();
    expect(init.duplex).toBeUndefined();
  });
});
