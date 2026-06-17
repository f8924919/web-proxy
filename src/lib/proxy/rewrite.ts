import { parse } from "node-html-parser";

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

function resolve(href: string, base: string): string {
  try {
    return new URL(href, base).href;
  } catch {
    return href;
  }
}

function browseUrl(href: string, base: string): string {
  return `${BASE_PATH}/browse?url=${encodeURIComponent(resolve(href, base))}`;
}

function assetUrl(href: string, base: string): string {
  return `${BASE_PATH}/api/proxy?url=${encodeURIComponent(resolve(href, base))}`;
}

const ADDRESS_BAR_HTML = (currentUrl: string) => `
<div id="proxy-addressbar" style="position:sticky;top:0;z-index:99999;background:#1e1e2e;padding:6px 12px;display:flex;gap:8px;align-items:center;font-family:sans-serif;box-shadow:0 2px 4px rgba(0,0,0,.4)">
  <form onsubmit="(function(e){e.preventDefault();var v=e.target.querySelector('input').value;if(!v)return;window.location.href='${BASE_PATH}/browse?url='+encodeURIComponent(v.startsWith('http')?v:'https://'+v)})(event)" style="display:flex;flex:1;gap:8px">
    <input value="${currentUrl.replace(/"/g, "&quot;")}" style="flex:1;padding:4px 10px;border:1px solid #555;border-radius:4px;background:#2a2a3e;color:#fff;font-size:14px" />
    <button type="submit" style="padding:4px 14px;background:#0070f3;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:14px">移動</button>
  </form>
  <a href="${BASE_PATH}/" style="color:#aaa;font-size:13px;text-decoration:none">ホーム</a>
</div>`.trim();

export function rewriteHtml(html: string, baseUrl: string): string {
  const root = parse(html);

  root.querySelectorAll("a[href]").forEach((el) => {
    const href = el.getAttribute("href");
    if (href && !href.startsWith("#") && !href.startsWith("javascript:")) {
      el.setAttribute("href", browseUrl(href, baseUrl));
    }
  });

  root.querySelectorAll("form[action]").forEach((el) => {
    const action = el.getAttribute("action");
    if (action) el.setAttribute("action", browseUrl(action, baseUrl));
  });

  for (const sel of ["img[src]", "source[src]", "script[src]"] as const) {
    root.querySelectorAll(sel).forEach((el) => {
      const src = el.getAttribute("src");
      if (src) el.setAttribute("src", assetUrl(src, baseUrl));
    });
  }

  root.querySelectorAll("link[href]").forEach((el) => {
    const href = el.getAttribute("href");
    if (href) el.setAttribute("href", assetUrl(href, baseUrl));
  });

  const rewritten = root.toString();
  const bar = ADDRESS_BAR_HTML(baseUrl);
  return rewritten.replace(/(<body[^>]*>)/i, `$1${bar}`);
}

export function rewriteCss(css: string, baseUrl: string): string {
  return css
    .replace(/url\((['"]?)([^'")\s]+)\1\)/g, (_, q, href) => {
      void q;
      return `url("${assetUrl(href, baseUrl)}")`;
    })
    .replace(/@import\s+(['"])([^'"]+)\1/g, (_, q, href) => {
      void q;
      return `@import "${assetUrl(href, baseUrl)}"`;
    });
}
