/** @jest-environment node */
// 仕様: docs/spec/features/proxy.md §ヒューリスティック自動ティア昇格（崩れ/チャレンジ検出）

import {
  autoPromoteEnabledFromEnv,
  shouldPromoteToBrowser,
  PromotionGuard,
  promotionGuard,
} from "@/lib/proxy/promotion";

const HTML = "text/html; charset=utf-8";

describe("autoPromoteEnabledFromEnv", () => {
  test("未設定なら無効（既定 OFF）", () => {
    expect(autoPromoteEnabledFromEnv({})).toBe(false);
  });

  test.each([
    ["true", true],
    ["1", true],
    ["on", true],
    ["TRUE", true],
    ["On", true],
    ["false", false],
    ["0", false],
    ["", false],
    ["yes", false],
    ["bogus", false],
  ])("PROXY_BROWSER_AUTO_PROMOTE=%p → %p", (raw, expected) => {
    expect(autoPromoteEnabledFromEnv({ PROXY_BROWSER_AUTO_PROMOTE: raw })).toBe(
      expected
    );
  });
});

describe("shouldPromoteToBrowser", () => {
  test("通常の text/html 200 応答は昇格しない", () => {
    const html =
      "<html><body><h1>ようこそ</h1><p>これは通常のコンテンツです。十分な本文があります。</p></body></html>";
    expect(shouldPromoteToBrowser(html, 200, HTML)).toBe(false);
  });

  test("空 body 単独は判定材料にしない（昇格しない）", () => {
    const html = "<html><head></head><body></body></html>";
    expect(shouldPromoteToBrowser(html, 200, HTML)).toBe(false);
  });

  test.each([
    [
      "enable javascript（英語チャレンジ）",
      "Please enable JavaScript to continue.",
    ],
    ["enablejs マーカー", "<div id=enablejs>...</div>"],
    [
      "checking your browser（Cloudflare）",
      "Checking your browser before accessing.",
    ],
    ["recaptcha", "<div class='g-recaptcha'></div>"],
  ])("チャレンジ語句 %s を含むと昇格する", (_label, body) => {
    const html = `<html><body>${body}</body></html>`;
    expect(shouldPromoteToBrowser(html, 200, HTML)).toBe(true);
  });

  test("<noscript> 主体（外側の可視テキストが極小）は昇格する", () => {
    const html =
      "<html><head><title>x</title></head><body>" +
      "<noscript>コンテンツを表示できません。設定を確認してください。</noscript>" +
      "<div id=root></div></body></html>";
    expect(shouldPromoteToBrowser(html, 200, HTML)).toBe(true);
  });

  test("<noscript> はあるが本文が十分にある場合は昇格しない", () => {
    const body = "実際の記事本文がここに十分な分量で存在しています。".repeat(8);
    const html =
      "<html><body><noscript>表示できません</noscript>" +
      `<article>${body}</article></body></html>`;
    expect(shouldPromoteToBrowser(html, 200, HTML)).toBe(false);
  });

  test.each([403, 503])(
    "bot ブロック相当ステータス %i は昇格する",
    (status) => {
      const html = "<html><body><p>Forbidden</p></body></html>";
      expect(shouldPromoteToBrowser(html, status, HTML)).toBe(true);
    }
  );

  test("非 HTML 応答はチャレンジ語句を含んでも昇格しない", () => {
    const body = "enable javascript checking your browser";
    expect(shouldPromoteToBrowser(body, 200, "application/json")).toBe(false);
  });

  test("非 HTML 応答は 403 でも昇格しない", () => {
    expect(shouldPromoteToBrowser("forbidden", 403, "text/plain")).toBe(false);
  });

  describe("空 SPA シェル（#160）", () => {
    // マウント先 + 外部 script + 可視テキスト極小 の 3 条件 AND。
    test("空 SPA シェル（Dailymotion 相当: 空枠 div + script + 可視テキスト無し）は昇格する", () => {
      const html =
        "<html><head><title>Dailymotion</title></head><body>" +
        '<div id="root"><div class="Root__app___xbuTD desktop"></div></div>' +
        '<script src="/api/proxy/https/static.example.com/app.js"></script>' +
        "</body></html>";
      expect(shouldPromoteToBrowser(html, 200, HTML)).toBe(true);
    });

    test.each([
      ['id="root"', '<div id="root"></div>'],
      ['id="__next"', '<div id="__next"></div>'],
      ['id="app"', "<main id=app></main>"],
      ['id="app-root"', '<div id="app-root"></div>'],
    ])(
      "マウント先 %s + script + 可視テキスト極小は昇格する",
      (_label, root) => {
        const html = `<html><body>${root}<script src="/a.js"></script></body></html>`;
        expect(shouldPromoteToBrowser(html, 200, HTML)).toBe(true);
      }
    );

    test("マウント先はあるが外部 script が無ければ昇格しない", () => {
      const html = '<html><body><div id="root"></div></body></html>';
      expect(shouldPromoteToBrowser(html, 200, HTML)).toBe(false);
    });

    test("マウント先 + script でも可視テキストが十分（SSR 済み）なら昇格しない", () => {
      const body =
        "実際の記事本文がここに十分な分量で描画されています。".repeat(8);
      const html =
        `<html><body><div id="app"><article>${body}</article></div>` +
        '<script src="/a.js"></script></body></html>';
      expect(shouldPromoteToBrowser(html, 200, HTML)).toBe(false);
    });

    test("script + 可視テキスト極小でもマウント先が無ければ昇格しない", () => {
      const html =
        '<html><body><div id="content"></div><script src="/a.js"></script></body></html>';
      expect(shouldPromoteToBrowser(html, 200, HTML)).toBe(false);
    });

    test('id の前方一致（id="application"）はマウント先として扱わない（昇格しない）', () => {
      const html =
        '<html><body><div id="application"></div><script src="/a.js"></script></body></html>';
      expect(shouldPromoteToBrowser(html, 200, HTML)).toBe(false);
    });

    test("インライン script のみ（外部 src 無し）は昇格しない", () => {
      const html =
        '<html><body><div id="root"></div><script>var a=1;</script></body></html>';
      expect(shouldPromoteToBrowser(html, 200, HTML)).toBe(false);
    });

    test("data-src 等の別属性は外部 script src と誤認しない（昇格しない）", () => {
      const html =
        '<html><body><div id="root"></div><script data-src="/lazy.js"></script></body></html>';
      expect(shouldPromoteToBrowser(html, 200, HTML)).toBe(false);
    });
  });
});

describe("PromotionGuard", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("初回は昇格可（true）、ウィンドウ内の同一 URL 再昇格は抑止（false）", () => {
    const guard = new PromotionGuard(60_000);
    const target = new URL("https://example.com/page");
    expect(guard.tryPromote(target)).toBe(true);
    expect(guard.tryPromote(target)).toBe(false);
  });

  test("クエリが異なっても host+path が同じなら再昇格を抑止する", () => {
    const guard = new PromotionGuard(60_000);
    expect(guard.tryPromote(new URL("https://example.com/s?q=a&sei=1"))).toBe(
      true
    );
    expect(guard.tryPromote(new URL("https://example.com/s?q=a&sei=2"))).toBe(
      false
    );
  });

  test.each([
    ["host が異なる", "https://other.com/page"],
    ["path が異なる", "https://example.com/another"],
  ])("%s 場合は独立に昇格できる", (_label, otherUrl) => {
    const guard = new PromotionGuard(60_000);
    expect(guard.tryPromote(new URL("https://example.com/page"))).toBe(true);
    expect(guard.tryPromote(new URL(otherUrl))).toBe(true);
  });

  test("ウィンドウ経過後は再び昇格できる", () => {
    const guard = new PromotionGuard(60_000);
    const target = new URL("https://example.com/page");
    expect(guard.tryPromote(target)).toBe(true);
    jest.advanceTimersByTime(61_000);
    expect(guard.tryPromote(target)).toBe(true);
  });

  test("共有インスタンス promotionGuard が再昇格を抑止する", () => {
    const target = new URL("https://shared-instance.example/p");
    expect(promotionGuard.tryPromote(target)).toBe(true);
    expect(promotionGuard.tryPromote(target)).toBe(false);
  });
});
