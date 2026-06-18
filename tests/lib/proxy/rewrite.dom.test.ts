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
