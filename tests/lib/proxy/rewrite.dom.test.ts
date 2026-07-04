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

  // 注入スクリプトは history.pushState/replaceState も上書きする（#172）。テスト間へ
  // 上書きが波及しないよう、注入前のネイティブ実装を保存し afterEach で復元する。
  let origPush: typeof history.pushState;
  let origReplace: typeof history.replaceState;

  beforeEach(() => {
    origPush = history.pushState;
    origReplace = history.replaceState;
    injectClickInterceptor();
  });

  afterEach(() => {
    history.pushState = origPush;
    history.replaceState = origReplace;
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

describe("history.pushState/replaceState 横取りシム（注入実行・#172）", () => {
  // 仕様: docs/spec/features/proxy.md §history.pushState / replaceState の横取り
  // CLICK_NAV_INTERCEPT_HTML が history.pushState/replaceState を上書きし、第 3 引数 url を
  // パス反映ナビ形式へ書き換える。純粋ロジック（buildClickNavDestination）は rewrite.test.ts。
  // jsdom の location は …/proxy/3000/browse?url=https://www.google.com/（ファイル冒頭の url）。
  let origPush: typeof history.pushState;
  let origReplace: typeof history.replaceState;
  let origHref: string;

  function injectClickInterceptor() {
    const out = rewriteHtml(
      `<html><body><p>hi</p></body></html>`,
      "https://www.google.com/"
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

  beforeEach(() => {
    origPush = history.pushState;
    origReplace = history.replaceState;
    origHref = location.href;
    injectClickInterceptor();
  });

  afterEach(() => {
    // 上書きを戻し、元実装で URL を元の閲覧ページへ復元する（他テストへ波及させない）。
    history.pushState = origPush;
    history.replaceState = origReplace;
    origReplace.call(history, null, "", origHref);
  });

  // 振り向け先は browseNavPrefix が逆プロキシ前置（jsdom URL の /proxy/3000）を保持するため
  // /proxy/3000/browse/<scheme>/<host>/<path> になる（BASE_PATH 相当の保持。GET フォーム横取りと同方式）。
  test("ルート相対 URL の pushState をパス反映ナビ形式へ書き換える", () => {
    history.pushState({ a: 1 }, "", "/search?q=foo");
    expect(location.pathname).toBe(
      "/proxy/3000/browse/https/www.google.com/search"
    );
    expect(location.search).toBe("?q=foo");
  });

  test("外部オリジン絶対 URL の replaceState をパス反映ナビ形式へ書き換える", () => {
    history.replaceState(null, "", "https://www.google.com/foo/bar");
    expect(location.pathname).toBe(
      "/proxy/3000/browse/https/www.google.com/foo/bar"
    );
  });

  test("url 省略（null/undefined）時は現在の URL を維持する", () => {
    const before = location.href;
    history.pushState({ a: 1 }, "");
    expect(location.href).toBe(before);
  });

  test("state / title は元の値のまま委譲される", () => {
    history.pushState({ k: "v" }, "", "/x");
    expect(history.state).toEqual({ k: "v" });
    expect(location.pathname).toBe("/proxy/3000/browse/https/www.google.com/x");
  });

  test("既にパス反映ナビ形式の url は二重書き換えしない（冪等）", () => {
    history.pushState(
      null,
      "",
      "/proxy/3000/browse/https/www.google.com/watch?v=1"
    );
    expect(location.pathname).toBe(
      "/proxy/3000/browse/https/www.google.com/watch"
    );
    expect(location.search).toBe("?v=1");
  });

  test("# 同一ページアンカーは書き換えず素通しする", () => {
    history.pushState(null, "", "#frag");
    // 書き換えられず、閲覧ページのパスは変わらない（hash のみ付与）。
    expect(location.hash).toBe("#frag");
    expect(location.pathname).toBe("/proxy/3000/browse");
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

describe("実行時リクエスト横取りシム: navigator.sendBeacon（注入実行・#168）", () => {
  // 仕様: docs/spec/features/proxy.md §実行時リクエスト横取りシム（SW 非依存・#124）
  // 純粋ロジック（buildRequestInterceptUrl）の網羅は rewrite.test.ts（node 環境）が担当。
  // ここでは注入シムが navigator.sendBeacon を上書きし、第 1 引数 URL を書き換えて
  // 元実装へ委譲する「配線」を検証する。元 sendBeacon をスタブし、渡る URL を観測する。
  // jsdom は navigator.sendBeacon を実装しないため、テストで定義・後始末する（境界での I/O）。
  let original: PropertyDescriptor | undefined;
  let calls: Array<[string, unknown]>;
  let stub: (url: string, data?: unknown) => boolean;
  // evalBeaconShim はシム IIFE 全体を実行するため fetch / XHR.open も上書きされる。
  // 他テストへ波及しないよう、これらも前後で復元する（グローバル状態の復元・テスト方針）。
  let originalFetch: typeof window.fetch;
  let originalXhrOpen: typeof XMLHttpRequest.prototype.open;

  beforeEach(() => {
    original = Object.getOwnPropertyDescriptor(window.navigator, "sendBeacon");
    originalFetch = window.fetch;
    originalXhrOpen = XMLHttpRequest.prototype.open;
    calls = [];
    stub = (url: string, data?: unknown) => {
      calls.push([url, data]);
      return true;
    };
    Object.defineProperty(window.navigator, "sendBeacon", {
      value: stub,
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    if (original) {
      Object.defineProperty(window.navigator, "sendBeacon", original);
    } else {
      // 元々無かった（jsdom）ので削除して状態を復元する
      delete (window.navigator as { sendBeacon?: unknown }).sendBeacon;
    }
    window.fetch = originalFetch;
    XMLHttpRequest.prototype.open = originalXhrOpen;
  });

  // シム本体（navigator.sendBeacon を上書きする <script>）を注入実行する。
  // ページ URL は jsdom の location（…/browse?url=https://www.google.com/）。
  function evalBeaconShim(): void {
    const out = rewriteHtml(
      `<html><head></head><body></body></html>`,
      "https://www.google.com/"
    );
    const m = out.match(
      /<script>((?:(?!<\/script>)[\s\S])*navigator\.sendBeacon=(?:(?!<\/script>)[\s\S])*)<\/script>/
    );
    expect(m).not.toBeNull();
    // eslint-disable-next-line no-eval
    eval(m![1]);
  }

  test("ルート相対 beacon（/gen_204）はターゲット origin に解決して /api/proxy へ書き換える", () => {
    evalBeaconShim();
    const ret = window.navigator.sendBeacon("/gen_204?x=1", "payload");
    expect(calls).toEqual([
      ["/api/proxy/https/www.google.com/gen_204?x=1", "payload"],
    ]);
    // 元実装の戻り値（送信キュー投入可否）をそのまま返す
    expect(ret).toBe(true);
  });

  test("自前ルート（/api/proxy）は書き換えず元の URL のまま委譲する", () => {
    evalBeaconShim();
    window.navigator.sendBeacon("/api/proxy/https/x.com/y");
    expect(calls).toEqual([["/api/proxy/https/x.com/y", undefined]]);
  });
});

describe("動的挿入要素の src 横取りシム（注入実行・#174）", () => {
  // 仕様: docs/spec/features/proxy.md §動的挿入要素の src 横取り
  // REQUEST_INTERCEPT_HTML（buildElementSrcRewrite を含む head シム）を eval して代表配線を検証する。
  // 純粋ロジック（buildElementSrcRewrite）の網羅検証は rewrite.test.ts（node）が担当。
  // jsdom location は …/browse?url=https://www.google.com/（ファイル冒頭）。
  // シムは Node/Element prototype・各要素 ctor の src/href/srcset・fetch/XHR/sendBeacon を
  // グローバルに上書きするため、注入前に控えて afterEach で復元する（他テストへ波及させない）。
  const NODE_METHODS = ["appendChild", "insertBefore", "replaceChild"] as const;
  const EL_METHODS = [
    "append",
    "prepend",
    "before",
    "after",
    "replaceWith",
    "insertAdjacentElement",
    "insertAdjacentHTML",
    "setAttribute",
  ] as const;
  const CTOR_PROPS: [string, string][] = [
    ["HTMLScriptElement", "src"],
    ["HTMLImageElement", "src"],
    ["HTMLImageElement", "srcset"],
    ["HTMLMediaElement", "src"],
    ["HTMLSourceElement", "src"],
    ["HTMLLinkElement", "href"],
    ["HTMLIFrameElement", "src"],
    // パーサ挿入の事前書き換え（#180）が defineProperty で上書きする descriptor
    ["Element", "innerHTML"],
    ["Element", "outerHTML"],
    // <video poster> の書き換え（#183）が defineProperty で上書きする descriptor
    ["HTMLVideoElement", "poster"],
  ];

  let savedNode: Record<string, unknown>;
  let savedEl: Record<string, unknown>;
  let savedDesc: Array<[string, string, PropertyDescriptor | undefined]>;
  let savedFetch: typeof window.fetch;
  let savedOpen: typeof XMLHttpRequest.prototype.open;
  let savedBeacon: typeof navigator.sendBeacon | undefined;

  function injectElementShim() {
    const out = rewriteHtml(
      `<html><head></head><body></body></html>`,
      "https://www.google.com/"
    );
    const m = out.match(
      /<script>((?:(?!<\/script>)[\s\S])*buildElementSrcRewrite[\s\S]*?)<\/script>/
    );
    expect(m).not.toBeNull();
    // eslint-disable-next-line no-eval
    eval((m as RegExpMatchArray)[1]);
  }

  beforeEach(() => {
    savedNode = {};
    for (const n of NODE_METHODS)
      savedNode[n] = (Node.prototype as unknown as Record<string, unknown>)[n];
    savedEl = {};
    for (const n of EL_METHODS)
      savedEl[n] = (Element.prototype as unknown as Record<string, unknown>)[n];
    savedDesc = CTOR_PROPS.map(([c, p]) => [
      c,
      p,
      Object.getOwnPropertyDescriptor(
        (window as unknown as Record<string, { prototype: object }>)[c]
          .prototype,
        p
      ),
    ]);
    savedFetch = window.fetch;
    savedOpen = XMLHttpRequest.prototype.open;
    savedBeacon = navigator.sendBeacon;
    injectElementShim();
  });

  afterEach(() => {
    for (const n of NODE_METHODS)
      (Node.prototype as unknown as Record<string, unknown>)[n] = savedNode[n];
    for (const n of EL_METHODS)
      (Element.prototype as unknown as Record<string, unknown>)[n] = savedEl[n];
    for (const [c, p, d] of savedDesc) {
      if (d)
        Object.defineProperty(
          (window as unknown as Record<string, { prototype: object }>)[c]
            .prototype,
          p,
          d
        );
    }
    window.fetch = savedFetch;
    XMLHttpRequest.prototype.open = savedOpen;
    if (savedBeacon) navigator.sendBeacon = savedBeacon;
  });

  test("innerHTML 生成 + appendChild の <script> を /api/proxy へ書き換え、SRI 属性を除去する（主経路）", () => {
    // innerHTML は parser が src を設定する（setAttribute/setter を経由しない）。
    // appendChild フックが委譲前に書き換える。
    const tmp = document.createElement("div");
    tmp.innerHTML =
      '<script src="/s/player/base.js" integrity="sha256-x" crossorigin="anonymous"></script>';
    const script = tmp.firstChild as HTMLScriptElement;
    document.head.appendChild(script);
    expect(script.getAttribute("src")).toBe(
      "/api/proxy/https/www.google.com/s/player/base.js"
    );
    expect(script.hasAttribute("integrity")).toBe(false);
    expect(script.hasAttribute("crossorigin")).toBe(false);
  });

  test("img.src プロパティ代入を /api/proxy へ書き換える", () => {
    const img = document.createElement("img");
    img.src = "/logo.png";
    expect(img.getAttribute("src")).toBe(
      "/api/proxy/https/www.google.com/logo.png"
    );
  });

  test("link[rel=stylesheet].setAttribute('href') を /api/proxy へ書き換える", () => {
    const link = document.createElement("link");
    link.setAttribute("rel", "stylesheet");
    link.setAttribute("href", "/s/player/www-player.css");
    expect(link.getAttribute("href")).toBe(
      "/api/proxy/https/www.google.com/s/player/www-player.css"
    );
  });

  test("link[rel=stylesheet].setAttribute('href') で integrity / crossorigin を除去する（#188）", () => {
    const link = document.createElement("link");
    link.setAttribute("rel", "stylesheet");
    link.setAttribute("integrity", "sha512-x");
    link.setAttribute("crossorigin", "anonymous");
    link.setAttribute("href", "https://cdn.example.net/fa.css");
    expect(link.getAttribute("href")).toBe(
      "/api/proxy/https/cdn.example.net/fa.css"
    );
    expect(link.hasAttribute("integrity")).toBe(false);
    expect(link.hasAttribute("crossorigin")).toBe(false);
  });

  test("link.href プロパティ代入で integrity / crossorigin を除去する（#188）", () => {
    const link = document.createElement("link");
    link.setAttribute("rel", "stylesheet");
    link.setAttribute("integrity", "sha512-x");
    link.setAttribute("crossorigin", "anonymous");
    link.href = "/theme.css";
    expect(link.getAttribute("href")).toBe(
      "/api/proxy/https/www.google.com/theme.css"
    );
    expect(link.hasAttribute("integrity")).toBe(false);
    expect(link.hasAttribute("crossorigin")).toBe(false);
  });

  test("innerHTML 直挿入の link[integrity] も挿入時点で除去する（#188）", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    host.innerHTML =
      '<link rel="stylesheet" href="https://cdn.example.net/fa.css" integrity="sha512-x" crossorigin="anonymous">';
    const link = host.querySelector("link");
    expect(link?.getAttribute("href")).toBe(
      "/api/proxy/https/cdn.example.net/fa.css"
    );
    expect(link?.hasAttribute("integrity")).toBe(false);
    expect(link?.hasAttribute("crossorigin")).toBe(false);
  });

  test("非リソース rel（canonical）の link[href] は書き換えない", () => {
    const link = document.createElement("link");
    link.setAttribute("rel", "canonical");
    link.setAttribute("href", "/canon");
    expect(link.getAttribute("href")).toBe("/canon");
  });

  test("video.poster プロパティ代入を /api/proxy へ書き換える（#183）", () => {
    const v = document.createElement("video");
    v.poster = "/thumb.jpg";
    expect(v.getAttribute("poster")).toBe(
      "/api/proxy/https/www.google.com/thumb.jpg"
    );
  });

  test("video.setAttribute('poster') を /api/proxy へ書き換える（#183）", () => {
    const v = document.createElement("video");
    v.setAttribute("poster", "//cdn.example.net/t.jpg");
    expect(v.getAttribute("poster")).toBe(
      "/api/proxy/https/cdn.example.net/t.jpg"
    );
  });

  test("innerHTML 生成 + appendChild の <video poster> を書き換える（#183）", () => {
    const tmp = document.createElement("div");
    tmp.innerHTML = '<video poster="/p.jpg" src="/m.mp4"></video>';
    const video = tmp.firstChild as HTMLVideoElement;
    document.body.appendChild(video);
    expect(video.getAttribute("poster")).toBe(
      "/api/proxy/https/www.google.com/p.jpg"
    );
    expect(video.getAttribute("src")).toBe(
      "/api/proxy/https/www.google.com/m.mp4"
    );
  });

  test("iframe.src はナビ扱いで /browse 形式へ書き換える", () => {
    const f = document.createElement("iframe");
    f.setAttribute("src", "/embed/abc");
    const got = f.getAttribute("src") ?? "";
    expect(got).not.toBe("/embed/abc");
    expect(got).toContain("/browse/https/www.google.com/embed/abc");
  });

  test("innerHTML 直挿入は挿入時点（同期）で書き換わる（#180）", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    host.innerHTML =
      '<link rel="stylesheet" href="https://cdn.example.net/a.css"><img src="/b.png" srcset="/b-2x.png 2x">';
    // MutationObserver を待たず、setter 委譲の時点で書き換え済み（SW ギャップ中の離脱防止）。
    expect(host.querySelector("link")?.getAttribute("href")).toBe(
      "/api/proxy/https/cdn.example.net/a.css"
    );
    expect(host.querySelector("img")?.getAttribute("src")).toBe(
      "/api/proxy/https/www.google.com/b.png"
    );
    expect(host.querySelector("img")?.getAttribute("srcset")).toBe(
      "/api/proxy/https/www.google.com/b-2x.png 2x"
    );
  });

  test("insertAdjacentHTML は挿入時点（同期）で書き換わる（#180）", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    host.insertAdjacentHTML(
      "beforeend",
      '<script src="https://cdn.example.net/c.js" integrity="sha256-x"></script>'
    );
    const script = host.querySelector("script");
    expect(script?.getAttribute("src")).toBe(
      "/api/proxy/https/cdn.example.net/c.js"
    );
    expect(script?.hasAttribute("integrity")).toBe(false);
  });

  test("insertAdjacentElement で挿入した要素を書き換える（#180）", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const doc = document.implementation.createHTMLDocument("");
    doc.body.innerHTML = '<img src="https://cdn.example.net/d.png">';
    const img = document.importNode(
      doc.body.firstChild as HTMLImageElement,
      true
    );
    host.insertAdjacentElement("beforeend", img);
    expect(img.getAttribute("src")).toBe(
      "/api/proxy/https/cdn.example.net/d.png"
    );
  });

  test("リソース要素を含まない HTML はそのまま挿入される（#180）", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    host.innerHTML = '<p class="keep">plain <b>text</b></p>';
    expect(host.querySelector("p.keep b")?.textContent).toBe("text");
  });

  test("MutationObserver が未フック経路の直挿入を事後に書き換える（バックストップ）", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host); // 接続（div は src を持たず append 時は no-op）
    // #180 の innerHTML フックを経由しない挿入（document.write 等の未フック経路の模擬）は、
    // 注入前に控えた元 descriptor の setter で行い、MO バックストップだけが観測する状態を作る。
    const orig = savedDesc.find(
      ([c, p]) => c === "Element" && p === "innerHTML"
    );
    (orig?.[2]?.set as (v: string) => void).call(host, '<img src="/mo.png">');
    await new Promise((r) => setTimeout(r, 0)); // MO コールバック（microtask）を流す
    const img = host.querySelector("img") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe(
      "/api/proxy/https/www.google.com/mo.png"
    );
  });
});
