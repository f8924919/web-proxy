/** @jest-environment node */
// 仕様: docs/spec/features/proxy.md §SSRF 対策

import { isSsrfBlocked } from "@/lib/proxy/fetch";

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
