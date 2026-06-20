/** @jest-environment node */
// 仕様: docs/spec/features/proxy.md §ステータスコードの中継

import { isNullBodyStatus, relativeRedirect } from "@/lib/proxy/response";

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

describe("relativeRedirect", () => {
  test.each([
    ["BASE_PATH 無し", "/"],
    ["BASE_PATH 有り", "/proxy/3000/"],
  ])(
    "%s: Location に渡した相対パスをそのまま設定し、絶対 URL(オリジン)を含めない",
    (_label, location) => {
      const res = relativeRedirect(location);
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toBe(location);
      // 内部オリジン（localhost 等）が Location に焼き込まれていないこと
      expect(res.headers.get("location")).not.toMatch(/^[a-z]+:\/\//i);
    }
  );

  test("ステータスは引数で変更できる（既定は 307）", () => {
    expect(relativeRedirect("/", 308).status).toBe(308);
    expect(relativeRedirect("/").status).toBe(307);
  });
});
