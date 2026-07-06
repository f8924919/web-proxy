/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://host.example/proxy/3000/browse/https/www.google.com/"}
 */
// 仕様: docs/spec/screens/browse.md §コンテンツエリア（自己修復・#201）
// アドレスバー注入スクリプト（高さ同期＋自己修復）のランタイム挙動を jsdom で検証する。
// App Router サイトの React 全体 hydration が注入ノードを removeChild で削除するケースを
// 模擬し、保持された同一ノードが document.body 先頭へ再挿入されることを確認する。
// MutationObserver がテスト間で残留するため、他の注入スクリプトの dom テスト
// （rewrite.dom.test.ts）とはファイルを分離している。

import { rewriteHtml } from "@/lib/proxy/rewrite";

// アドレスバーを含む書き換え済み HTML を body へ展開し、アドレスバーの
// IIFE スクリプト（高さ同期＋自己修復）だけを実行する。
function injectAddressBar() {
  const out = rewriteHtml(
    `<html><body><p>content</p></body></html>`,
    "https://www.google.com/"
  );
  document.body.innerHTML = out
    .replace(/^[\s\S]*?<body[^>]*>/i, "")
    .replace(/<\/body>[\s\S]*$/i, "");
  let found = false;
  document.querySelectorAll("script").forEach((s) => {
    if (s.textContent && s.textContent.includes("proxy-addressbar-spacer")) {
      found = true;
      // eslint-disable-next-line no-eval
      eval(s.textContent);
    }
  });
  return found;
}

// MO コールバック（microtask）を流す
const flushMo = () => new Promise((r) => setTimeout(r, 0));

describe("アドレスバー自己修復スクリプト（#201）", () => {
  // 注入（スクリプト実行）は 1 回だけ行い、全テストで同一ノードを共有する。
  // 本番でもスクリプトはページロードごとに 1 回しか実行されず、テストごとに再 eval すると
  // 旧テストの Observer（旧ノード参照を保持）が先に再挿入して同一性検証が壊れるため。
  // 各テストは自己修復によって「バー・スペーサーが body 先頭に復元された状態」で終わる。
  beforeAll(() => {
    expect(injectAddressBar()).toBe(true);
  });

  test("removeChild で削除されたバー・スペーサーが body 先頭へ再挿入される", async () => {
    const bar = document.getElementById("proxy-addressbar") as HTMLElement;
    const spacer = document.getElementById(
      "proxy-addressbar-spacer"
    ) as HTMLElement;
    expect(bar).not.toBeNull();
    expect(spacer).not.toBeNull();

    bar.remove();
    spacer.remove();
    expect(document.getElementById("proxy-addressbar")).toBeNull();

    await flushMo();
    // 同一ノードが body 先頭（バー→スペーサーの順）へ戻る
    expect(document.getElementById("proxy-addressbar")).toBe(bar);
    expect(document.getElementById("proxy-addressbar-spacer")).toBe(spacer);
    expect(document.body.firstElementChild).toBe(bar);
    expect(bar.nextElementSibling).toBe(spacer);
  });

  test("複数回の削除サイクル後もバー・スペーサーは各 1 個のみ（重複生成なし）", async () => {
    for (let i = 0; i < 3; i++) {
      document.getElementById("proxy-addressbar")?.remove();
      document.getElementById("proxy-addressbar-spacer")?.remove();
      await flushMo();
    }
    expect(document.querySelectorAll("#proxy-addressbar")).toHaveLength(1);
    expect(document.querySelectorAll("#proxy-addressbar-spacer")).toHaveLength(
      1
    );
  });

  test("再挿入直後に resize イベントなしでスペーサー高さがバー実高と一致する（#108 整合）", async () => {
    const bar = document.getElementById("proxy-addressbar") as HTMLElement;
    const spacer = document.getElementById(
      "proxy-addressbar-spacer"
    ) as HTMLElement;
    // 事前に不一致の値を仕込み、再挿入時の同期で上書きされることを観測する
    spacer.style.height = "999px";
    bar.remove();
    spacer.remove();
    await flushMo();
    expect(
      (document.getElementById("proxy-addressbar-spacer") as HTMLElement).style
        .height
    ).toBe(`${bar.offsetHeight}px`);
  });

  test("再挿入後も入力中の URL 値が保持される（同一ノード再挿入）", async () => {
    const input = document.querySelector(
      "#proxy-addressbar input"
    ) as HTMLInputElement;
    expect(input).not.toBeNull();
    input.value = "https://typing-in-progress.example/";

    (document.getElementById("proxy-addressbar") as HTMLElement).remove();
    await flushMo();

    const restored = document.querySelector(
      "#proxy-addressbar input"
    ) as HTMLInputElement;
    expect(restored).toBe(input);
    expect(restored.value).toBe("https://typing-in-progress.example/");
  });

  test("body ごと差し替えられてもバー・スペーサーが新しい body へ再挿入される", async () => {
    const bar = document.getElementById("proxy-addressbar") as HTMLElement;
    const spacer = document.getElementById(
      "proxy-addressbar-spacer"
    ) as HTMLElement;

    // React の再レンダリングによる body 差し替えを模擬する
    const newBody = document.createElement("body");
    newBody.innerHTML = "<div>fresh render</div>";
    document.documentElement.replaceChild(newBody, document.body);
    expect(document.getElementById("proxy-addressbar")).toBeNull();

    await flushMo();
    expect(document.getElementById("proxy-addressbar")).toBe(bar);
    expect(document.getElementById("proxy-addressbar-spacer")).toBe(spacer);
    expect(document.body.firstElementChild).toBe(bar);
  });

  test("スペーサーだけが削除された場合もバー直後へ再挿入される", async () => {
    const bar = document.getElementById("proxy-addressbar") as HTMLElement;
    const spacer = document.getElementById(
      "proxy-addressbar-spacer"
    ) as HTMLElement;
    spacer.remove();
    await flushMo();
    expect(document.getElementById("proxy-addressbar-spacer")).toBe(spacer);
    expect(bar.nextElementSibling).toBe(spacer);
  });
});
