/** @jest-environment node */
// 仕様: docs/spec/features/proxy.md §サイト間 Cookie アイソレーション / §サイト間アイソレーションの構造的制約

import {
  CookieJar,
  SESSION_COOKIE_NAME,
  newSessionId,
  buildSessionCookie,
  resolveSession,
  parseSetCookie,
} from "@/lib/proxy/cookieJar";

const ORIGIN_A = "https://a.example";
const ORIGIN_B = "https://b.example";

describe("newSessionId", () => {
  test("不透明な ID を返し、呼び出しごとに異なる", () => {
    const a = newSessionId();
    const b = newSessionId();
    expect(a).toMatch(/[0-9a-f-]{36}/i);
    expect(a).not.toBe(b);
  });
});

describe("buildSessionCookie", () => {
  test("HttpOnly / SameSite=Lax / Path を付け、Secure は付けない", () => {
    expect(buildSessionCookie("sid123", "")).toBe(
      `${SESSION_COOKIE_NAME}=sid123; HttpOnly; SameSite=Lax; Path=/`
    );
  });

  test("BASE_PATH があれば Path に反映する", () => {
    expect(buildSessionCookie("sid123", "/proxy/3000")).toBe(
      `${SESSION_COOKIE_NAME}=sid123; HttpOnly; SameSite=Lax; Path=/proxy/3000`
    );
  });
});

describe("resolveSession", () => {
  test("受信 Cookie に __pxy_sid があれば既存セッションとして返す", () => {
    expect(
      resolveSession(`theme=dark; ${SESSION_COOKIE_NAME}=existing`)
    ).toEqual({ id: "existing", isNew: false });
  });

  test("__pxy_sid が無ければ新規セッションを発行する", () => {
    const ref = resolveSession("theme=dark");
    expect(ref.isNew).toBe(true);
    expect(ref.id).toMatch(/[0-9a-f-]{36}/i);
  });

  test("Cookie ヘッダーが null なら新規セッションを発行する", () => {
    expect(resolveSession(null).isNew).toBe(true);
  });
});

describe("parseSetCookie", () => {
  test("name=value を取り出し、属性が無ければ expiresAt は null（セッション cookie）", () => {
    expect(parseSetCookie("sid=abc; Path=/; Domain=example.com", 1000)).toEqual(
      {
        name: "sid",
        value: "abc",
        expiresAt: null,
        deleted: false,
      }
    );
  });

  test("Max-Age を相対秒として now からの絶対時刻に変換する", () => {
    expect(parseSetCookie("sid=abc; Max-Age=100", 1000)).toEqual({
      name: "sid",
      value: "abc",
      expiresAt: 1000 + 100 * 1000,
      deleted: false,
    });
  });

  test("Max-Age<=0 は削除指示として deleted=true", () => {
    expect(parseSetCookie("sid=abc; Max-Age=0", 1000)?.deleted).toBe(true);
  });

  test("過去の Expires は削除指示として deleted=true", () => {
    const past = "Thu, 01 Jan 1970 00:00:00 GMT";
    expect(parseSetCookie(`sid=abc; Expires=${past}`, 1000)?.deleted).toBe(
      true
    );
  });

  test("Max-Age は Expires より優先する（RFC 6265）", () => {
    const past = "Thu, 01 Jan 1970 00:00:00 GMT";
    const parsed = parseSetCookie(
      `sid=abc; Expires=${past}; Max-Age=100`,
      1000
    );
    expect(parsed?.deleted).toBe(false);
    expect(parsed?.expiresAt).toBe(1000 + 100 * 1000);
  });

  test("name=value の形でなければ null", () => {
    expect(parseSetCookie("Secure; HttpOnly", 1000)).toBeNull();
  });
});

describe("CookieJar", () => {
  test("store した Cookie を同一セッション・同一 origin で復元する", () => {
    const jar = new CookieJar();
    jar.store("s1", ORIGIN_A, ["sid=aaa; Path=/"], 0);
    expect(jar.cookieHeader("s1", ORIGIN_A, 0)).toBe("sid=aaa");
  });

  test("複数 Cookie を name=value で連結して返す", () => {
    const jar = new CookieJar();
    jar.store("s1", ORIGIN_A, ["a=1", "b=2"], 0);
    expect(jar.cookieHeader("s1", ORIGIN_A, 0)).toBe("a=1; b=2");
  });

  test("origin が異なれば混在しない", () => {
    const jar = new CookieJar();
    jar.store("s1", ORIGIN_A, ["sid=aaa"], 0);
    jar.store("s1", ORIGIN_B, ["sid=bbb"], 0);
    expect(jar.cookieHeader("s1", ORIGIN_A, 0)).toBe("sid=aaa");
    expect(jar.cookieHeader("s1", ORIGIN_B, 0)).toBe("sid=bbb");
  });

  test("セッションが異なれば他セッションの Cookie は見えない", () => {
    const jar = new CookieJar();
    jar.store("s1", ORIGIN_A, ["sid=aaa"], 0);
    expect(jar.cookieHeader("s2", ORIGIN_A, 0)).toBe("");
  });

  test("未知のセッション・origin は空文字を返す", () => {
    const jar = new CookieJar();
    expect(jar.cookieHeader("none", ORIGIN_A, 0)).toBe("");
  });

  test("同名 Cookie は後勝ちで上書きする", () => {
    const jar = new CookieJar();
    jar.store("s1", ORIGIN_A, ["sid=old"], 0);
    jar.store("s1", ORIGIN_A, ["sid=new"], 0);
    expect(jar.cookieHeader("s1", ORIGIN_A, 0)).toBe("sid=new");
  });

  test("削除指示（Max-Age=0）で当該 Cookie を取り除く", () => {
    const jar = new CookieJar();
    jar.store("s1", ORIGIN_A, ["sid=aaa"], 0);
    jar.store("s1", ORIGIN_A, ["sid=x; Max-Age=0"], 0);
    expect(jar.cookieHeader("s1", ORIGIN_A, 0)).toBe("");
  });

  test("失効した Cookie は復元時に返さない", () => {
    const jar = new CookieJar();
    jar.store("s1", ORIGIN_A, ["sid=aaa; Max-Age=100"], 0);
    expect(jar.cookieHeader("s1", ORIGIN_A, 50_000)).toBe("sid=aaa");
    expect(jar.cookieHeader("s1", ORIGIN_A, 100_001)).toBe("");
  });

  test("最終アクセスから TTL を過ぎたセッションは GC で回収する", () => {
    const jar = new CookieJar();
    jar.store("s1", ORIGIN_A, ["sid=aaa"], 0);
    // TTL（30分）+ GC 間隔を十分に超える時刻で別セッションを store すると GC が走る。
    const farFuture = 60 * 60 * 1000;
    jar.store("s2", ORIGIN_B, ["sid=bbb"], farFuture);
    expect(jar.cookieHeader("s1", ORIGIN_A, farFuture)).toBe("");
    expect(jar.cookieHeader("s2", ORIGIN_B, farFuture)).toBe("sid=bbb");
  });
});
