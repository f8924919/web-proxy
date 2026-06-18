/** @jest-environment node */
// 仕様: docs/spec/features/proxy.md §ステータスコードの中継

import { isNullBodyStatus } from "@/lib/proxy/response";

describe("isNullBodyStatus", () => {
  test.each([
    [101, "switching protocols"],
    [204, "no content"],
    [205, "reset content"],
    [304, "not modified"],
  ])("ボディを持てない %d (%s) では true", (status) => {
    expect(isNullBodyStatus(status)).toBe(true);
  });

  test.each([
    [200, "ok"],
    [206, "partial content"],
    [301, "moved permanently"],
    [404, "not found"],
    [500, "internal server error"],
  ])("ボディを持てる %d (%s) では false", (status) => {
    expect(isNullBodyStatus(status)).toBe(false);
  });
});
