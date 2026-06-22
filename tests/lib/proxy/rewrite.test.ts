/** @jest-environment node */
// 仕様: docs/spec/features/proxy.md §HTML 書き換え / §CSS URL 書き換え / §url 未指定時の案内ページ

import {
  rewriteHtml,
  rewriteCss,
  rewriteSrcset,
  buildGetFormDestination,
  buildClickNavDestination,
  noUrlBrowseHtml,
} from "@/lib/proxy/rewrite";

const BASE = "https://example.com";

// パス反映形式（/api/proxy/<scheme>/<host>/<path>）の独立オラクル（#100）。
// 実装 buildProxyPath とは別に組み立て、書き換え結果を検証する。
const asset = (urlOrPath: string): string => {
  const u = new URL(urlOrPath, BASE);
  return `/api/proxy/${u.protocol.replace(/:$/, "")}/${u.host}${u.pathname}${u.search}${u.hash}`;
};

describe("rewriteHtml", () => {
  describe("<a href> → /browse", () => {
    test("絶対 URL をそのまま /browse に書き換える", () => {
      const html = `<a href="https://example.com/about">link</a>`;
      const result = rewriteHtml(html, BASE);
      expect(result).toContain(
        `href="/browse?url=${encodeURIComponent("https://example.com/about")}"`
      );
    });

    test("相対パスをベース URL で解決して /browse に書き換える", () => {
      const html = `<a href="/contact">link</a>`;
      const result = rewriteHtml(html, BASE);
      expect(result).toContain(
        `href="/browse?url=${encodeURIComponent("https://example.com/contact")}"`
      );
    });
  });

  describe("<form action> → /browse", () => {
    test("フォームの action を /browse に書き換える", () => {
      const html = `<form action="/search"></form>`;
      const result = rewriteHtml(html, BASE);
      expect(result).toContain(
        `action="/browse?url=${encodeURIComponent("https://example.com/search")}"`
      );
    });
  });

  describe("<meta http-equiv=refresh> → /browse", () => {
    // 仕様: docs/spec/features/proxy.md §meta refresh の書き換え
    test("ルート相対 url を baseUrl 基準で解決し /browse に書き換える（遅延は保持）", () => {
      const html = `<meta http-equiv="refresh" content="0;url=/httpservice/retry/enablejs?sei=x">`;
      const result = rewriteHtml(html, BASE);
      expect(result).toContain(
        `content="0;url=/browse?url=${encodeURIComponent("https://example.com/httpservice/retry/enablejs?sei=x")}"`
      );
    });

    test("絶対 url をそのまま /browse に書き換える（遅延を保持）", () => {
      const html = `<meta http-equiv="refresh" content="5; url=https://other.example/next">`;
      const result = rewriteHtml(html, BASE);
      expect(result).toContain(
        `/browse?url=${encodeURIComponent("https://other.example/next")}`
      );
      expect(result).toMatch(/content="5;\s*url=\/browse\?url=/);
    });

    test("http-equiv の大文字小文字を無視して書き換える", () => {
      const html = `<meta http-equiv="REFRESH" content="0;URL=/foo">`;
      const result = rewriteHtml(html, BASE);
      expect(result).toContain(encodeURIComponent("https://example.com/foo"));
    });

    test("シングルクォート付き url も書き換える", () => {
      const html = `<meta http-equiv="refresh" content="0; url='/bar'">`;
      const result = rewriteHtml(html, BASE);
      expect(result).toContain(
        `/browse?url=${encodeURIComponent("https://example.com/bar")}`
      );
    });

    test("url を持たない純粋な遅延 refresh は書き換えない", () => {
      const html = `<meta http-equiv="refresh" content="5">`;
      const result = rewriteHtml(html, BASE);
      expect(result).toContain(`content="5"`);
      expect(result).not.toContain("/browse?url=");
    });

    test("http(s) に解決されない url（mailto 等）は書き換えない", () => {
      const html = `<meta http-equiv="refresh" content="0;url=mailto:a@example.com">`;
      const result = rewriteHtml(html, BASE);
      expect(result).toContain("mailto:a@example.com");
      expect(result).not.toContain("/browse?url=");
    });

    test("refresh 以外の http-equiv は対象外", () => {
      const html = `<meta http-equiv="content-type" content="text/html;url=/x">`;
      const result = rewriteHtml(html, BASE);
      expect(result).not.toContain("/browse?url=");
    });
  });

  describe("静的アセット → /api/proxy", () => {
    test.each([
      ["<img src>", `<img src="/logo.png">`, "src", "/logo.png"],
      [
        "<link rel=stylesheet href>",
        `<link rel="stylesheet" href="/style.css">`,
        "href",
        "/style.css",
      ],
      ["<script src>", `<script src="/app.js"></script>`, "src", "/app.js"],
    ])("%s を /api/proxy に書き換える", (_label, html, attr, path) => {
      const result = rewriteHtml(html, BASE);
      const expected = asset(path);
      expect(result).toContain(`${attr}="${expected}"`);
    });
  });

  describe("srcset の書き換え（#98）", () => {
    const proxied = (path: string) => asset(path);

    test("<img srcset> の各候補を書き換え記述子を保持する", () => {
      const result = rewriteHtml(`<img srcset="/a.png 1x, /b.png 2x">`, BASE);
      expect(result).toContain(
        `srcset="${proxied("/a.png")} 1x, ${proxied("/b.png")} 2x"`
      );
    });

    test("<source srcset> の幅記述子（w）を保持する", () => {
      const result = rewriteHtml(
        `<picture><source srcset="/a.png 640w, /b.png 1280w"></picture>`,
        BASE
      );
      expect(result).toContain(
        `srcset="${proxied("/a.png")} 640w, ${proxied("/b.png")} 1280w"`
      );
    });

    test("Next.js <Image> の /_next/image?url= を /api/proxy 経由へ振り向ける（400 回避）", () => {
      const inner = "https://s.yimg.jp/i/kids/x.png";
      const nextSrc = `/_next/image?url=${encodeURIComponent(inner)}&w=256&q=75`;
      const result = rewriteHtml(`<img srcset="${nextSrc} 1x">`, BASE);
      // proxy origin 直下の /_next/image ではなく、上流の最適化 URL を中継する
      expect(result).toContain(proxied(nextSrc));
      expect(result).not.toMatch(/srcset="\/_next\/image/);
    });
  });

  describe("SRI 属性の除去（A1）", () => {
    // 仕様: docs/spec/features/proxy.md §サブリソース整合性（SRI）属性の除去
    test("src を書き換える script から integrity / crossorigin を除去する", () => {
      const html = `<script src="/app.js" integrity="sha256-abc" crossorigin="anonymous"></script>`;
      const result = rewriteHtml(html, BASE);
      expect(result).toContain(`src="${asset("/app.js")}"`);
      expect(result).not.toContain("integrity");
      expect(result).not.toContain("crossorigin");
    });

    test("integrity を持たない script は src のみ書き換え従来どおり", () => {
      const html = `<script src="/app.js"></script>`;
      const result = rewriteHtml(html, BASE);
      expect(result).toContain(`src="${asset("/app.js")}"`);
      expect(result).not.toContain("integrity");
    });

    test("src を持たないインライン script の中身・属性は触らない", () => {
      const html = `<script integrity="sha256-keep">var a = 1;</script>`;
      const result = rewriteHtml(html, BASE);
      expect(result).toContain("var a = 1;");
      expect(result).toContain(`integrity="sha256-keep"`);
    });
  });

  describe("inline meta CSP の除去（A2）", () => {
    // 仕様: docs/spec/features/proxy.md §inline CSP（meta）の除去
    test("http-equiv=Content-Security-Policy の meta を除去する", () => {
      const html = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'">`;
      const result = rewriteHtml(html, BASE);
      expect(result).not.toContain("Content-Security-Policy");
      expect(result).not.toContain("default-src");
    });

    test("http-equiv の大文字小文字を無視して除去する", () => {
      const html = `<meta http-equiv="CONTENT-SECURITY-POLICY" content="default-src 'self'">`;
      const result = rewriteHtml(html, BASE);
      expect(result).not.toContain("default-src");
    });

    test("Content-Security-Policy-Report-Only は素通しする", () => {
      const html = `<meta http-equiv="Content-Security-Policy-Report-Only" content="default-src 'self'">`;
      const result = rewriteHtml(html, BASE);
      expect(result).toContain("Content-Security-Policy-Report-Only");
      expect(result).toContain("default-src 'self'");
    });

    test("CSP 以外の meta（refresh）は影響を受けない", () => {
      const html = `<meta http-equiv="refresh" content="0;url=/foo">`;
      const result = rewriteHtml(html, BASE);
      expect(result).toContain(
        `/browse?url=${encodeURIComponent("https://example.com/foo")}`
      );
    });
  });

  test("アドレスバー HTML スニペットを <body> 直後に注入する", () => {
    const html = `<html><body><p>hello</p></body></html>`;
    const result = rewriteHtml(html, BASE);
    const bodyIdx = result.indexOf("<body>");
    const barIdx = result.indexOf('id="proxy-addressbar"');
    expect(barIdx).toBeGreaterThan(bodyIdx);
  });

  test("GET フォーム送信横取りスクリプトを <body> 直後に注入する", () => {
    const html = `<html><body><p>hello</p></body></html>`;
    const result = rewriteHtml(html, BASE);
    const bodyIdx = result.indexOf("<body>");
    const scriptIdx = result.indexOf("addEventListener('submit'");
    expect(scriptIdx).toBeGreaterThan(bodyIdx);
  });

  test("クリック横取りは capture・stopImmediatePropagation・#proxy-addressbar 除外を含む（#82）", () => {
    const html = `<html><body><p>hello</p></body></html>`;
    const result = rewriteHtml(html, BASE);
    // capture フェーズ委任（SPA の onClick より先に発火）
    expect(result).toContain("addEventListener('click'");
    // SPA ルーターの onClick 横取りを阻止
    expect(result).toContain("stopImmediatePropagation");
    // 自前 UI（アドレスバー）内は除外
    expect(result).toContain("proxy-addressbar");
  });

  describe("document.domain ドメインガード無効化シム", () => {
    // 仕様: docs/spec/features/proxy.md §document.domain ドメインガードの無効化
    const YAHOO = "https://news.yahoo.co.jp/categories/science";

    test("シムを <head> 最先頭（既存 head 要素より前）に注入する", () => {
      const html = `<html><head><title>t</title></head><body><p>hi</p></body></html>`;
      const result = rewriteHtml(html, YAHOO);
      const headIdx = result.indexOf("<head>");
      const shimIdx = result.indexOf("Document.prototype");
      const titleIdx = result.indexOf("<title>");
      expect(shimIdx).toBeGreaterThan(headIdx);
      expect(shimIdx).toBeLessThan(titleIdx);
    });

    test("ターゲット URL のホスト名（パス・スキーム抜き）を見せかける", () => {
      const result = rewriteHtml(
        `<html><head></head><body></body></html>`,
        YAHOO
      );
      expect(result).toContain('return "news.yahoo.co.jp"');
    });

    test("シムは <body> 直後の既存注入より前に位置する（先に実行される）", () => {
      const html = `<html><head></head><body><p>hi</p></body></html>`;
      const result = rewriteHtml(html, BASE);
      const shimIdx = result.indexOf("Document.prototype");
      const barIdx = result.indexOf('id="proxy-addressbar"');
      expect(shimIdx).toBeGreaterThan(-1);
      expect(shimIdx).toBeLessThan(barIdx);
    });

    test("<head> が無ければ <html> 直後にフォールバック注入する", () => {
      const html = `<html><body><p>hi</p></body></html>`;
      const result = rewriteHtml(html, BASE);
      const htmlIdx = result.indexOf("<html>");
      const shimIdx = result.indexOf("Document.prototype");
      const bodyIdx = result.indexOf("<body>");
      expect(shimIdx).toBeGreaterThan(htmlIdx);
      expect(shimIdx).toBeLessThan(bodyIdx);
    });

    test("<head> も <html> も無ければ文書先頭に注入する", () => {
      const result = rewriteHtml(`<p>hi</p>`, BASE);
      expect(result.trimStart().startsWith("<script>")).toBe(true);
      expect(result).toContain("Document.prototype");
    });

    test("baseUrl が不正でホスト名を導出できない場合はシムを注入しない", () => {
      const result = rewriteHtml(
        `<html><head></head><body></body></html>`,
        "not a url"
      );
      expect(result).not.toContain("Document.prototype");
    });
  });
});

describe("buildGetFormDestination", () => {
  // 仕様: docs/spec/features/proxy.md §GET フォーム送信の横取り
  const PAGE = `https://proxy.test/browse?url=${encodeURIComponent("https://example.com")}`;

  test("GET フォーム: ターゲットのクエリをフォーム項目で置き換えて /browse へ遷移", () => {
    const action = `/browse?url=${encodeURIComponent("https://example.com/search")}`;
    const dest = buildGetFormDestination("get", action, PAGE, [
      ["q", "hello world"],
    ]);
    expect(dest).toBe(
      `/browse?url=${encodeURIComponent("https://example.com/search?q=hello+world")}`
    );
  });

  test("method 未指定は GET 扱いで横取りする", () => {
    const action = `/browse?url=${encodeURIComponent("https://example.com/search")}`;
    const dest = buildGetFormDestination("", action, PAGE, [["q", "x"]]);
    expect(dest).toBe(
      `/browse?url=${encodeURIComponent("https://example.com/search?q=x")}`
    );
  });

  test("BASE_PATH（リバースプロキシのパスプレフィックス）を遷移先で保持する", () => {
    const action = `/proxy/3000/browse?url=${encodeURIComponent("https://example.com/search")}`;
    const page = `https://proxy.test/proxy/3000/browse?url=${encodeURIComponent("https://example.com")}`;
    const dest = buildGetFormDestination("get", action, page, [["q", "x"]]);
    expect(dest).toBe(
      `/proxy/3000/browse?url=${encodeURIComponent("https://example.com/search?q=x")}`
    );
  });

  test("Google 検索相当: BASE_PATH 付き action＋複数項目を /browse?url= に復元する（#78）", () => {
    // form.submit() オーバーライド経路でも本関数を共用する。action には ?url=<target> が残る。
    const action = `/proxy/3000/browse?url=${encodeURIComponent("https://www.google.com/search")}`;
    const page = `https://proxy.test/proxy/3000/browse?url=${encodeURIComponent("https://www.google.com")}`;
    const dest = buildGetFormDestination("get", action, page, [
      ["q", "playwright test"],
      ["hl", "ja"],
    ]);
    expect(dest).toBe(
      `/proxy/3000/browse?url=${encodeURIComponent("https://www.google.com/search?q=playwright+test&hl=ja")}`
    );
  });

  test("POST フォームは横取りしない（null を返す）", () => {
    const action = `/browse?url=${encodeURIComponent("https://example.com/search")}`;
    expect(
      buildGetFormDestination("post", action, PAGE, [["q", "x"]])
    ).toBeNull();
  });

  test("action 属性なし: 閲覧ページの url パラメータをターゲットにフォールバックする", () => {
    const page = `https://proxy.test/browse?url=${encodeURIComponent("https://example.com/page")}`;
    const dest = buildGetFormDestination("get", "", page, [["q", "x"]]);
    expect(dest).toBe(
      `/browse?url=${encodeURIComponent("https://example.com/page?q=x")}`
    );
  });

  test("ターゲットを復元できない場合は null を返す", () => {
    // url パラメータが無く、ページ側にも無い
    expect(
      buildGetFormDestination("get", "/browse", "https://proxy.test/", [
        ["q", "x"],
      ])
    ).toBeNull();
  });
});

describe("buildClickNavDestination", () => {
  // 仕様: docs/spec/features/proxy.md §クライアント側ナビゲーションの横取り
  const TARGET = "https://www.yahoo.co.jp/";
  const PAGE = `https://proxy.test/browse?url=${encodeURIComponent(TARGET)}`;

  test("外部オリジンの http(s) 絶対 URL: 閲覧ページのパスを再利用して /browse へ", () => {
    const href = "https://news.yahoo.co.jp/articles/abc";
    expect(buildClickNavDestination(href, PAGE)).toBe(
      `/browse?url=${encodeURIComponent(href)}`
    );
  });

  test("http の絶対 URL も対象", () => {
    const href = "http://example.com/p";
    expect(buildClickNavDestination(href, PAGE)).toBe(
      `/browse?url=${encodeURIComponent(href)}`
    );
  });

  test("BASE_PATH（リバースプロキシのパスプレフィックス）を遷移先で保持する", () => {
    const href = "https://news.yahoo.co.jp/articles/abc";
    const page = `https://proxy.test/proxy/3000/browse?url=${encodeURIComponent(TARGET)}`;
    expect(buildClickNavDestination(href, page)).toBe(
      `/proxy/3000/browse?url=${encodeURIComponent(href)}`
    );
  });

  test("ルート相対 URL は現ターゲット origin で解決して /browse へ（#82）", () => {
    expect(buildClickNavDestination("/articles/abc", PAGE)).toBe(
      `/browse?url=${encodeURIComponent("https://www.yahoo.co.jp/articles/abc")}`
    );
  });

  test("相対 URL は現ターゲットを base に解決して /browse へ（#82）", () => {
    const page = `https://proxy.test/browse?url=${encodeURIComponent("https://www.yahoo.co.jp/news/")}`;
    expect(buildClickNavDestination("article/x", page)).toBe(
      `/browse?url=${encodeURIComponent("https://www.yahoo.co.jp/news/article/x")}`
    );
  });

  test("プロトコル相対 URL は外部絶対として /browse へ（#82）", () => {
    expect(buildClickNavDestination("//news.yahoo.co.jp/x", PAGE)).toBe(
      `/browse?url=${encodeURIComponent("https://news.yahoo.co.jp/x")}`
    );
  });

  test("既に書き換え済みの proxy browse リンクはそのままフルナビゲーションさせる（#82）", () => {
    const self = `/browse?url=${encodeURIComponent("https://news.yahoo.co.jp/articles/abc")}`;
    expect(buildClickNavDestination(self, PAGE)).toBe(self);
  });

  test("BASE_PATH 付きの書き換え済み browse リンクもそのまま返す（#82）", () => {
    const page = `https://proxy.test/proxy/3000/browse?url=${encodeURIComponent(TARGET)}`;
    const self = `/proxy/3000/browse?url=${encodeURIComponent("https://news.yahoo.co.jp/x")}`;
    expect(buildClickNavDestination(self, page)).toBe(self);
  });

  test("# 同一ページアンカーは対象外（null）", () => {
    expect(buildClickNavDestination("#section", PAGE)).toBeNull();
  });

  test.each([
    ["javascript:void(0)"],
    ["mailto:a@b.com"],
    ["tel:0123"],
    ["data:text/plain,hi"],
  ])("非 http スキーム %s は対象外（null）", (href) => {
    expect(buildClickNavDestination(href, PAGE)).toBeNull();
  });

  test("閲覧ページに url= が無い場合の相対リンクは対象外（null）", () => {
    expect(
      buildClickNavDestination("/articles/abc", "https://proxy.test/browse")
    ).toBeNull();
  });

  test("pageUrl が不正なら null", () => {
    expect(
      buildClickNavDestination("https://news.yahoo.co.jp/x", "not a url")
    ).toBeNull();
  });
});

describe("rewriteSrcset", () => {
  const proxied = (path: string) => asset(path);

  test("密度記述子（1x/2x）付きの複数候補を書き換える", () => {
    expect(rewriteSrcset("/a.png 1x, /b.png 2x", BASE)).toBe(
      `${proxied("/a.png")} 1x, ${proxied("/b.png")} 2x`
    );
  });

  test("幅記述子（w）付きの複数候補を書き換える", () => {
    expect(rewriteSrcset("/a.png 640w, /b.png 1280w", BASE)).toBe(
      `${proxied("/a.png")} 640w, ${proxied("/b.png")} 1280w`
    );
  });

  test("記述子なしの単一候補も書き換える", () => {
    expect(rewriteSrcset("/a.png", BASE)).toBe(proxied("/a.png"));
  });

  test("不揃いな空白を正規化して書き換える", () => {
    expect(rewriteSrcset("  /a.png   1x ,  /b.png   2x  ", BASE)).toBe(
      `${proxied("/a.png")} 1x, ${proxied("/b.png")} 2x`
    );
  });

  test("data: URL 内のカンマで誤分割しない", () => {
    const data = "data:image/png;base64,AAAAC, ";
    // data: は http(s) に解決されないため assetUrl はそのまま返す（記述子 1x は保持）
    const src = "data:image/png;base64,AAAAC";
    expect(rewriteSrcset(`${src} 1x`, BASE)).toBe(`${src} 1x`);
    void data;
  });

  test("絶対 URL も書き換える", () => {
    const abs = "https://cdn.example.org/a.png";
    expect(rewriteSrcset(`${abs} 2x`, BASE)).toBe(`${asset(abs)} 2x`);
  });
});

describe("rewriteCss", () => {
  test("url() を /api/proxy に書き換える", () => {
    const css = `body { background: url('/bg.png'); }`;
    const result = rewriteCss(css, BASE);
    expect(result).toContain(asset("/bg.png"));
  });

  test("url() 内の引用符なし表記も書き換える", () => {
    const css = `body { background: url(/bg.png); }`;
    const result = rewriteCss(css, BASE);
    expect(result).toContain(asset("/bg.png"));
  });

  test("@import を /api/proxy に書き換える", () => {
    const css = `@import '/fonts.css';`;
    const result = rewriteCss(css, BASE);
    expect(result).toContain(asset("/fonts.css"));
  });

  test("既に絶対 URL の url() も書き換える", () => {
    const css = `body { background: url('https://cdn.example.com/bg.png'); }`;
    const result = rewriteCss(css, BASE);
    expect(result).toContain(asset("https://cdn.example.com/bg.png"));
  });
});

describe("noUrlBrowseHtml", () => {
  test("アドレスバーを含む 200 用の HTML を返す", () => {
    const html = noUrlBrowseHtml();
    expect(html).toContain('id="proxy-addressbar"');
  });

  test("アドレスバーのフォームが /browse?url= への導線を持つ", () => {
    expect(noUrlBrowseHtml()).toContain("/browse?url=");
  });

  test("自動遷移（meta refresh）を含まない", () => {
    expect(noUrlBrowseHtml().toLowerCase()).not.toContain(
      'http-equiv="refresh"'
    );
  });
});
