/** @jest-environment node */
// 仕様: docs/spec/features/proxy.md §HTML 書き換え / §CSS URL 書き換え

import { rewriteHtml, rewriteCss } from "@/lib/proxy/rewrite";

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
      ["<link href>", `<link href="/style.css">`, "href", "/style.css"],
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
