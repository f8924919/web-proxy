/** @jest-environment node */
// 仕様: docs/spec/features/proxy.md §HTML 書き換え / §CSS URL 書き換え

import {
  rewriteHtml,
  rewriteCss,
  buildGetFormDestination,
} from "@/lib/proxy/rewrite";

const BASE = "https://example.com";

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
      const expected = `/api/proxy?url=${encodeURIComponent(`https://example.com${path}`)}`;
      expect(result).toContain(`${attr}="${expected}"`);
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

describe("rewriteCss", () => {
  test("url() を /api/proxy に書き換える", () => {
    const css = `body { background: url('/bg.png'); }`;
    const result = rewriteCss(css, BASE);
    expect(result).toContain(
      `/api/proxy?url=${encodeURIComponent("https://example.com/bg.png")}`
    );
  });

  test("url() 内の引用符なし表記も書き換える", () => {
    const css = `body { background: url(/bg.png); }`;
    const result = rewriteCss(css, BASE);
    expect(result).toContain(
      `/api/proxy?url=${encodeURIComponent("https://example.com/bg.png")}`
    );
  });

  test("@import を /api/proxy に書き換える", () => {
    const css = `@import '/fonts.css';`;
    const result = rewriteCss(css, BASE);
    expect(result).toContain(
      `/api/proxy?url=${encodeURIComponent("https://example.com/fonts.css")}`
    );
  });

  test("既に絶対 URL の url() も書き換える", () => {
    const css = `body { background: url('https://cdn.example.com/bg.png'); }`;
    const result = rewriteCss(css, BASE);
    expect(result).toContain(
      `/api/proxy?url=${encodeURIComponent("https://cdn.example.com/bg.png")}`
    );
  });
});
