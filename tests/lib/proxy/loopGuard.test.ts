/** @jest-environment node */
// 仕様: docs/spec/features/proxy.md §ナビゲーションループの検出（enablejs 対策）

import {
  NavigationLoopGuard,
  navigationLoopGuard,
  loopGuidanceHtml,
} from "@/lib/proxy/loopGuard";

describe("NavigationLoopGuard", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("閾値以内は false、閾値を超えた遷移で true（境界）", () => {
    const guard = new NavigationLoopGuard(6, 10_000);
    const target = new URL("https://www.google.com/search?q=x");
    for (let i = 0; i < 6; i++) {
      expect(guard.check("1.2.3.4", target)).toBe(false);
    }
    // 7 回目（= 閾値 6 を超える）でループ判定
    expect(guard.check("1.2.3.4", target)).toBe(true);
  });

  test("クエリが毎回変わっても host+path が同じならループ検出（sei 差分）", () => {
    const guard = new NavigationLoopGuard(6, 10_000);
    let last = false;
    for (let i = 0; i < 7; i++) {
      last = guard.check(
        "1.2.3.4",
        new URL(`https://www.google.com/search?q=x&sei=${i}`)
      );
    }
    expect(last).toBe(true);
  });

  test.each([
    ["host が異なる", "https://www.bing.com/search?q=x"],
    ["path が異なる", "https://www.google.com/maps?q=x"],
  ])("%s 場合は別キーとして扱いループ検出しない", (_label, otherUrl) => {
    const guard = new NavigationLoopGuard(6, 10_000);
    const base = new URL("https://www.google.com/search?q=x");
    for (let i = 0; i < 6; i++) guard.check("1.2.3.4", base);
    // 別 host/path への 1 回目は閾値に達しない
    expect(guard.check("1.2.3.4", new URL(otherUrl))).toBe(false);
  });

  test("ウィンドウ経過後はカウントがリセットされ false に戻る", () => {
    const guard = new NavigationLoopGuard(6, 10_000);
    const target = new URL("https://www.google.com/search?q=x");
    for (let i = 0; i < 6; i++) guard.check("1.2.3.4", target);

    jest.advanceTimersByTime(11_000);

    expect(guard.check("1.2.3.4", target)).toBe(false);
  });

  test("IP ごとにカウントが独立している", () => {
    const guard = new NavigationLoopGuard(6, 10_000);
    const target = new URL("https://www.google.com/search?q=x");
    for (let i = 0; i < 7; i++) guard.check("1.2.3.4", target);
    // 別 IP は影響を受けない
    expect(guard.check("5.6.7.8", target)).toBe(false);
  });

  test("既定の navigationLoopGuard は 6 回超過（7 回目）で発火する", () => {
    const target = new URL("https://example.com/loop");
    let last = false;
    for (let i = 0; i < 7; i++)
      last = navigationLoopGuard.check("guard-ip", target);
    expect(last).toBe(true);
  });
});

describe("loopGuidanceHtml", () => {
  test("案内ページは『ホームへ戻る』リンクを含み、自動遷移を一切含まない", () => {
    const html = loopGuidanceHtml();
    // ホームへ戻る導線がある
    expect(html).toMatch(/ホームへ戻る/);
    expect(html).toMatch(/href="\//);
    // ループを再発させる自動遷移を含まない
    expect(html).not.toMatch(/http-equiv=["']?refresh/i);
    expect(html).not.toMatch(/location\.(href|replace|assign)/i);
    expect(html).not.toMatch(/<script/i);
  });
});
