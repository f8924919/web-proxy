/** @jest-environment node */
// 仕様: docs/spec/features/proxy.md §認証 / 接続元許可制（任意・#148）

import {
  AUTH_COOKIE_NAME,
  proxyAuthConfigFromEnv,
  tokensMatch,
  parseCookieValue,
  presentedToken,
  isAuthorized,
  buildAuthCookie,
  safeRedirectPath,
  unlockHtml,
} from "@/lib/proxy/auth";

describe("proxyAuthConfigFromEnv", () => {
  test("PROXY_AUTH_TOKEN 未設定なら null（認証無効・オープン）", () => {
    expect(proxyAuthConfigFromEnv({})).toBeNull();
  });

  test("空文字・空白のみは null（無効）", () => {
    expect(proxyAuthConfigFromEnv({ PROXY_AUTH_TOKEN: "" })).toBeNull();
    expect(proxyAuthConfigFromEnv({ PROXY_AUTH_TOKEN: "   " })).toBeNull();
  });

  test("値があれば trim して { token } を返す", () => {
    expect(proxyAuthConfigFromEnv({ PROXY_AUTH_TOKEN: "  s3cret  " })).toEqual({
      token: "s3cret",
    });
  });
});

describe("tokensMatch（定数時間比較）", () => {
  test("一致で true", () => {
    expect(tokensMatch("abc123", "abc123")).toBe(true);
  });

  test("不一致で false", () => {
    expect(tokensMatch("abc123", "abc124")).toBe(false);
  });

  test("長さ違いで false（早期 return せず比較）", () => {
    expect(tokensMatch("abc", "abc123")).toBe(false);
    expect(tokensMatch("abc123", "abc")).toBe(false);
  });

  test("presented が null なら false", () => {
    expect(tokensMatch(null, "abc123")).toBe(false);
  });

  test("空同士は true（呼び出し側が空 token を無効化する前提）", () => {
    expect(tokensMatch("", "")).toBe(true);
  });
});

describe("parseCookieValue", () => {
  test("指定名の Cookie 値を取り出す", () => {
    expect(parseCookieValue("a=1; __pxy_auth=tok; b=2", "__pxy_auth")).toBe(
      "tok"
    );
  });

  test("前後の空白を無視する", () => {
    expect(parseCookieValue("  __pxy_auth = tok ", "__pxy_auth")).toBe("tok");
  });

  test("該当なし・null は null", () => {
    expect(parseCookieValue("a=1; b=2", "__pxy_auth")).toBeNull();
    expect(parseCookieValue(null, "__pxy_auth")).toBeNull();
    expect(parseCookieValue("", "__pxy_auth")).toBeNull();
  });

  test("値に = を含んでも先頭の = で分割する", () => {
    expect(parseCookieValue("__pxy_auth=a=b=c", "__pxy_auth")).toBe("a=b=c");
  });
});

describe("presentedToken（ヘッダー優先・Cookie フォールバック）", () => {
  test("ヘッダーがあればヘッダーを優先", () => {
    expect(presentedToken("hdr", `${AUTH_COOKIE_NAME}=cke`)).toBe("hdr");
  });

  test("ヘッダー無しなら Cookie", () => {
    expect(presentedToken(null, `${AUTH_COOKIE_NAME}=cke`)).toBe("cke");
  });

  test("どちらも無ければ null", () => {
    expect(presentedToken(null, null)).toBeNull();
    expect(presentedToken("", "a=1")).toBeNull();
  });
});

describe("isAuthorized", () => {
  test("config が null（無効）なら常に true", () => {
    expect(isAuthorized(null, null, null)).toBe(true);
    expect(isAuthorized("anything", null, null)).toBe(true);
  });

  test("有効時はヘッダー一致で true", () => {
    expect(isAuthorized("tok", null, { token: "tok" })).toBe(true);
  });

  test("有効時は Cookie 一致で true", () => {
    expect(
      isAuthorized(null, `${AUTH_COOKIE_NAME}=tok`, { token: "tok" })
    ).toBe(true);
  });

  test("有効時に不一致・未提示なら false", () => {
    expect(isAuthorized("bad", null, { token: "tok" })).toBe(false);
    expect(isAuthorized(null, null, { token: "tok" })).toBe(false);
  });
});

describe("buildAuthCookie", () => {
  test("HttpOnly / SameSite=Lax / Path を含む", () => {
    const c = buildAuthCookie("tok", "");
    expect(c).toContain(`${AUTH_COOKIE_NAME}=tok`);
    expect(c).toContain("HttpOnly");
    expect(c).toContain("SameSite=Lax");
    expect(c).toContain("Path=/");
  });

  test("BASE_PATH 指定時は Path をそれに合わせる", () => {
    expect(buildAuthCookie("tok", "/proxy/3000")).toContain("Path=/proxy/3000");
  });
});

describe("safeRedirectPath（オープンリダイレクト防止）", () => {
  test("アプリ相対パスはそのまま通す", () => {
    expect(safeRedirectPath("/browse/https/example.com/", "")).toBe(
      "/browse/https/example.com/"
    );
  });

  test("プロトコル相対 // は弾く", () => {
    expect(safeRedirectPath("//evil.example", "")).toBe("/");
  });

  test("バックスラッシュ始まり（ブラウザ正規化で // 相当）は弾く", () => {
    expect(safeRedirectPath("/\\evil.example", "")).toBe("/");
    expect(safeRedirectPath("/\\/evil.example", "")).toBe("/");
  });

  test("絶対 URL は弾く", () => {
    expect(safeRedirectPath("https://evil.example", "")).toBe("/");
  });

  test("/ 始まりでない・null はフォールバック（BASE_PATH 考慮）", () => {
    expect(safeRedirectPath("browse", "")).toBe("/");
    expect(safeRedirectPath(null, "/proxy/3000")).toBe("/proxy/3000/");
  });
});

describe("unlockHtml", () => {
  test("フォーム action は BASE_PATH 込みの /unlock", () => {
    expect(unlockHtml("/browse/https/e/", "/proxy/3000")).toContain(
      'action="/proxy/3000/unlock"'
    );
  });

  test("隠しフィールドに redirect を持つ", () => {
    expect(unlockHtml("/browse/https/e/", "")).toContain(
      'name="redirect" value="/browse/https/e/"'
    );
  });

  test("error 指定でエラーメッセージを表示", () => {
    expect(unlockHtml("/", "", { error: true })).toMatch(/トークン/);
    expect(unlockHtml("/", "", { error: true })).not.toBe(unlockHtml("/", ""));
  });
});
