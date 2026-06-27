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

// 注入スクリプトは横取り時に capture フェーズで stopImmediatePropagation() を呼び（#93）、
// バブルフェーズの自前ハンドラ（SPA ルーター／アドレスバー onsubmit 相当）へ submit を渡さない。
// そこでバブルに probe を足し、submit がそこへ「到達しなかった」=横取りされた、と判定する。
// （横取り時は location.href へ proxy URL を代入するが、jsdom はナビゲーション未実装のため
//  到達観察の方が安定する。アドレスバー自前 onsubmit の遷移と混同しない利点もある。）
function interceptedByInjectedScript(form: HTMLFormElement): boolean {
  let reachedBubble = false;
  const probe = () => {
    reachedBubble = true;
  };
  document.addEventListener("submit", probe, false);
  try {
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true })
    );
  } catch {
    // jsdom はナビゲーション未実装で例外を投げ得るが、判定には影響しない
  }
  document.removeEventListener("submit", probe, false);
  return !reachedBubble;
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

  test("capture で submit を奪い SPA の自前 submit ハンドラ（バブル）へ渡さない（#93）", () => {
    // SPA（React 等）は GET 検索フォームの submit をバブルの自前ハンドラで横取りし、
    // location で実サイト（例 search.yahoo.co.jp）へ直接遷移させる。注入スクリプトは
    // capture で先に発火し stopImmediatePropagation で阻止するため、バブルのリスナ
    //（= SPA の自前 submit ハンドラ相当）には届かず、proxy 経由フルナビゲーションする。
    const form = document.createElement("form");
    form.setAttribute("method", "get");
    form.setAttribute(
      "action",
      "/proxy/3000/browse?url=" +
        encodeURIComponent("https://search.yahoo.co.jp/search")
    );
    document.body.appendChild(form);
    let spaHandlerRan = false;
    const spaHandler = () => {
      spaHandlerRan = true;
    };
    document.addEventListener("submit", spaHandler, false);
    try {
      expect(interceptedByInjectedScript(form)).toBe(true);
      expect(spaHandlerRan).toBe(false);
    } finally {
      document.removeEventListener("submit", spaHandler, false);
    }
  });
});

describe("Enter キー押下の横取りスクリプト（注入・#164）", () => {
  // 仕様: docs/spec/features/proxy.md §GET フォーム送信の横取り（Enter キー押下による遷移の捕捉）
  // submit イベントも form.submit() も介さず location.href 直接代入で実サイトへ遷移するサイト
  //（例 www.yahoo.co.jp トップ検索）を、keydown(Enter) のキャプチャ横取りで救済する。
  beforeEach(() => {
    injectInterceptor();
  });

  // input で Enter を発火し、横取りされたかを判定する。横取り時は capture フェーズで
  // preventDefault + stopImmediatePropagation するため、defaultPrevented になり、かつ
  // バブルの keydown probe へ到達しない。（jsdom はナビゲーション未実装のため到達観察で判定）
  function dispatchEnter(
    target: Element,
    init: KeyboardEventInit = {}
  ): { prevented: boolean; reachedBubble: boolean } {
    let reachedBubble = false;
    const probe = () => {
      reachedBubble = true;
    };
    document.addEventListener("keydown", probe, false);
    const evt = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
      ...init,
    });
    try {
      target.dispatchEvent(evt);
    } catch {
      // location.href 代入で jsdom が例外を投げ得るが、判定（preventDefault 済み）に影響しない
    }
    document.removeEventListener("keydown", probe, false);
    return { prevented: evt.defaultPrevented, reachedBubble };
  }

  function makeSearchForm(action: string, inputType = "search") {
    const form = document.createElement("form");
    form.setAttribute("method", "get");
    form.setAttribute("action", action);
    const input = document.createElement("input");
    input.setAttribute("type", inputType);
    input.setAttribute("name", "p");
    input.value = "hello";
    form.appendChild(input);
    document.body.appendChild(form);
    return { form, input };
  }

  test("絶対クロスオリジン action のフォームで input Enter を横取りする（yahoo 相当）", () => {
    const { input } = makeSearchForm("https://search.yahoo.co.jp/search");
    const r = dispatchEnter(input);
    expect(r.prevented).toBe(true);
    expect(r.reachedBubble).toBe(false);
  });

  test("パス反映 action のフォームでも input Enter を横取りする", () => {
    const { input } = makeSearchForm(
      "/proxy/3000/browse?url=" +
        encodeURIComponent("https://www.google.com/search")
    );
    const r = dispatchEnter(input);
    expect(r.prevented).toBe(true);
    expect(r.reachedBubble).toBe(false);
  });

  test("IME 変換確定中（isComposing）の Enter は横取りしない", () => {
    const { input } = makeSearchForm("https://search.yahoo.co.jp/search");
    const r = dispatchEnter(input, { isComposing: true });
    expect(r.prevented).toBe(false);
    expect(r.reachedBubble).toBe(true);
  });

  test("修飾キー併用（metaKey）の Enter は横取りしない", () => {
    const { input } = makeSearchForm("https://search.yahoo.co.jp/search");
    const r = dispatchEnter(input, { metaKey: true });
    expect(r.prevented).toBe(false);
    expect(r.reachedBubble).toBe(true);
  });

  test("textarea の Enter（改行入力）は横取りしない", () => {
    const form = document.createElement("form");
    form.setAttribute("method", "get");
    form.setAttribute("action", "https://search.yahoo.co.jp/search");
    const ta = document.createElement("textarea");
    ta.setAttribute("name", "p");
    form.appendChild(ta);
    document.body.appendChild(form);
    const r = dispatchEnter(ta);
    expect(r.prevented).toBe(false);
    expect(r.reachedBubble).toBe(true);
  });

  test("送信を伴わない input 型（checkbox）の Enter は横取りしない", () => {
    const { input } = makeSearchForm(
      "https://search.yahoo.co.jp/search",
      "checkbox"
    );
    const r = dispatchEnter(input);
    expect(r.prevented).toBe(false);
    expect(r.reachedBubble).toBe(true);
  });

  test("フォームに属さない input の Enter は横取りしない", () => {
    const input = document.createElement("input");
    input.setAttribute("type", "search");
    document.body.appendChild(input);
    const r = dispatchEnter(input);
    expect(r.prevented).toBe(false);
    expect(r.reachedBubble).toBe(true);
  });

  test("自前アドレスバーの input Enter は横取りしない", () => {
    const addrInput = document.querySelector(
      "#proxy-addressbar form input"
    ) as HTMLInputElement;
    expect(addrInput).not.toBeNull();
    const r = dispatchEnter(addrInput);
    expect(r.prevented).toBe(false);
    expect(r.reachedBubble).toBe(true);
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
