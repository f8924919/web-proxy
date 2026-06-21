/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://host.example/proxy/3000/browse?url=https%3A%2F%2Fwww.google.com%2F"}
 */
// 仕様: docs/spec/features/proxy.md §GET フォーム送信の横取り
// 注入スクリプト（GET_FORM_INTERCEPT_HTML）のランタイム挙動を jsdom で検証する。
// 純粋ロジック（buildGetFormDestination）の検証は rewrite.test.ts（node 環境）が担当。

import { rewriteHtml } from "@/lib/proxy/rewrite";

function injectInterceptor() {
  const out = rewriteHtml(
    `<html><body><p>hi</p></body></html>`,
    "https://www.google.com/"
  );
  document.body.innerHTML = out
    .replace(/^[\s\S]*?<body[^>]*>/i, "")
    .replace(/<\/body>[\s\S]*$/i, "");
  document.querySelectorAll("script").forEach((s) => {
    if (s.textContent && s.textContent.includes("addEventListener('submit'")) {
      // 注入スクリプトを実行し、document への submit 委任を登録する
      // eslint-disable-next-line no-eval
      eval(s.textContent);
    }
  });
}

// 注入スクリプトのリスナは capture で先に走る。その「後」に走る capture リスナを足し、
// その時点の defaultPrevented を見れば、注入スクリプトが横取り（preventDefault）したか判定できる。
function interceptedByInjectedScript(form: HTMLFormElement): boolean {
  let intercepted = false;
  const probe = (e: Event) => {
    intercepted = e.defaultPrevented;
  };
  document.addEventListener("submit", probe, true);
  try {
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true })
    );
  } catch {
    // jsdom はナビゲーション未実装で例外を投げ得るが、判定には影響しない
  }
  document.removeEventListener("submit", probe, true);
  return intercepted;
}

describe("GET フォーム横取りスクリプト（注入）", () => {
  beforeEach(() => {
    injectInterceptor();
  });

  test("自前のアドレスバー（#proxy-addressbar）のフォームは横取りしない", () => {
    const addr = document.querySelector(
      "#proxy-addressbar form"
    ) as HTMLFormElement;
    expect(addr).not.toBeNull();
    expect(interceptedByInjectedScript(addr)).toBe(false);
  });

  test("ターゲットページの GET フォームは横取りする", () => {
    const form = document.createElement("form");
    form.setAttribute("method", "get");
    form.setAttribute(
      "action",
      "/proxy/3000/browse?url=" +
        encodeURIComponent("https://www.google.com/search")
    );
    document.body.appendChild(form);
    expect(interceptedByInjectedScript(form)).toBe(true);
  });

  test("ターゲットページの POST フォームは横取りしない", () => {
    const form = document.createElement("form");
    form.setAttribute("method", "post");
    form.setAttribute(
      "action",
      "/proxy/3000/browse?url=" +
        encodeURIComponent("https://www.google.com/search")
    );
    document.body.appendChild(form);
    expect(interceptedByInjectedScript(form)).toBe(false);
  });
});

describe("クリックナビ横取りスクリプト（注入）", () => {
  // 仕様: docs/spec/features/proxy.md §クライアント側ナビゲーションの横取り
  // 注入スクリプト（CLICK_NAV_INTERCEPT_HTML）のランタイム挙動を jsdom で検証する。
  // 純粋ロジック（buildClickNavDestination）の検証は rewrite.test.ts（node 環境）が担当。
  function injectClickInterceptor() {
    const out = rewriteHtml(
      `<html><body><p>hi</p></body></html>`,
      "https://www.yahoo.co.jp/"
    );
    document.body.innerHTML = out
      .replace(/^[\s\S]*?<body[^>]*>/i, "")
      .replace(/<\/body>[\s\S]*$/i, "");
    document.querySelectorAll("script").forEach((s) => {
      if (s.textContent && s.textContent.includes("addEventListener('click'")) {
        // eslint-disable-next-line no-eval
        eval(s.textContent);
      }
    });
  }

  // 注入スクリプトが横取りすると location.href = dest を呼び出す。jsdom はナビゲーション
  // 未実装のため console.error("Not implemented: navigation ...") が発火する。
  // 注入スクリプトは stopImmediatePropagation() を呼ぶため後続 capture リスナでは
  // defaultPrevented を観察できないので、console.error をスパイして検出する。
  function interceptedClick(
    target: Element,
    init: MouseEventInit = {}
  ): boolean {
    let navigated = false;
    const origError = console.error.bind(console);
    console.error = (...args: unknown[]) => {
      const msg = args[0];
      // jsdom の navigation エラーは Error-like オブジェクト（instanceof Error が
      // 異なる VM コンテキストのため false になり得る）として渡される。
      // .message プロパティか文字列化で検出する。
      const text =
        msg != null &&
        typeof (msg as { message?: unknown }).message === "string"
          ? (msg as { message: string }).message
          : typeof msg === "string"
            ? msg
            : String(msg);
      if (text.includes("Not implemented: navigation")) {
        navigated = true;
      }
      origError(...args);
    };
    try {
      target.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, ...init })
      );
    } catch {
      // jsdom はナビゲーション未実装で例外を投げ得るが、判定には影響しない
    }
    console.error = origError;
    return navigated;
  }

  function anchor(href: string, target?: string): HTMLAnchorElement {
    const a = document.createElement("a");
    a.setAttribute("href", href);
    if (target) a.setAttribute("target", target);
    document.body.appendChild(a);
    return a;
  }

  beforeEach(() => {
    injectClickInterceptor();
  });

  test("動的描画された http(s) 絶対 URL の <a> クリックを横取りする", () => {
    const a = anchor("https://news.yahoo.co.jp/articles/abc");
    expect(interceptedClick(a)).toBe(true);
  });

  test("<a> 内の子要素クリックでも横取りする（closest）", () => {
    const a = anchor("https://news.yahoo.co.jp/articles/abc");
    const span = document.createElement("span");
    a.appendChild(span);
    expect(interceptedClick(span)).toBe(true);
  });

  test("修飾キー付きクリック（Ctrl/Meta）は横取りしない", () => {
    const a = anchor("https://news.yahoo.co.jp/articles/abc");
    expect(interceptedClick(a, { ctrlKey: true })).toBe(false);
    expect(interceptedClick(a, { metaKey: true })).toBe(false);
  });

  test("中クリック（補助ボタン）は横取りしない", () => {
    const a = anchor("https://news.yahoo.co.jp/articles/abc");
    expect(interceptedClick(a, { button: 1 })).toBe(false);
  });

  test('target="_blank" は横取りしない', () => {
    const a = anchor("https://news.yahoo.co.jp/articles/abc", "_blank");
    expect(interceptedClick(a)).toBe(false);
  });

  test("書き換え済みの /browse?url= リンクはフルナビゲーションのために横取りする（#82）", () => {
    // SPA ルーターに奪われる前にフルナビゲーションさせるため、
    // 同一パス（browse）へのリンクも interceptedClick が true を返す。
    const wrapped = anchor(
      "/proxy/3000/browse?url=" +
        encodeURIComponent("https://news.yahoo.co.jp/articles/abc")
    );
    expect(interceptedClick(wrapped)).toBe(true);
  });

  test("# アンカーは横取りしない", () => {
    const hash = anchor("#section");
    expect(interceptedClick(hash)).toBe(false);
  });

  test("自前 UI（#proxy-addressbar 内のホームリンク）は横取りしない（#82）", () => {
    const home = document.querySelector(
      "#proxy-addressbar a"
    ) as HTMLElement | null;
    expect(home).not.toBeNull();
    expect(interceptedClick(home as HTMLElement)).toBe(false);
  });

  test("capture でクリックを奪い SPA ルーター（バブル onClick）へ渡さない（#82）", () => {
    // SPA（React 等）の onClick はバブルで発火し history.pushState で離脱する。
    // 注入スクリプトは capture で先に発火し stopImmediatePropagation で阻止するため、
    // バブルのリスナ（= SPA ルーター相当）には届かず、proxy がフルナビゲーションする。
    const a = anchor("https://news.yahoo.co.jp/articles/abc");
    let spaRouterRan = false;
    const spaRouter = () => {
      spaRouterRan = true;
    };
    document.addEventListener("click", spaRouter, false);
    try {
      expect(interceptedClick(a)).toBe(true);
      expect(spaRouterRan).toBe(false);
    } finally {
      document.removeEventListener("click", spaRouter, false);
    }
  });
});

describe("document.domain ドメインガード無効化シム（注入実行）", () => {
  // 仕様: docs/spec/features/proxy.md §document.domain ドメインガードの無効化
  // Document.prototype を書き換えるため、前後でディスクリプタを復元する。
  let original: PropertyDescriptor | undefined;
  beforeEach(() => {
    original = Object.getOwnPropertyDescriptor(Document.prototype, "domain");
  });
  afterEach(() => {
    if (original) {
      Object.defineProperty(Document.prototype, "domain", original);
    }
  });

  function evalDomainShim(baseUrl: string): void {
    const out = rewriteHtml(`<html><head></head><body></body></html>`, baseUrl);
    const m = out.match(
      /<script>((?:(?!<\/script>)[\s\S])*Document\.prototype(?:(?!<\/script>)[\s\S])*)<\/script>/
    );
    expect(m).not.toBeNull();
    // eslint-disable-next-line no-eval
    eval(m![1]);
  }

  test("シム実行後、document.domain がターゲットのホスト名を返す", () => {
    evalDomainShim("https://news.yahoo.co.jp/categories/science");
    expect(document.domain).toBe("news.yahoo.co.jp");
  });

  test("Yahoo のドメインガード正規表現にマッチする値を返す", () => {
    evalDomainShim("https://news.yahoo.co.jp/categories/science");
    expect(document.domain).toMatch(/^(.+\.)?yahoo(\.co|-labs)?\.jp$/);
  });
});
