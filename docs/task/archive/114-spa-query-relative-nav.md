# #114 SPA のクエリ相対リンク(?q=…)クリックで url= が落ちプロキシが外れる

- **Issue**: [#114](https://github.com/f8924919/web-proxy/issues/114)
- **ブランチ**: `bugfix/114-spa-query-relative-nav`
- **ステータス**: 進行中
- **種別**: バグ修正（クライアント側ナビ横取りの判定不足）
- **関連**: #58 / #82（クリック横取り）/ フォローアップ #115（ナビタブの url= パラメータ衝突・別原因）
- **着手日**: 2026-06-22

---

## 現象

DuckDuckGo 検索結果ページ（`…/browse?url=https://duckduckgo.com/?ia=web&q=test`）で「Searches related to」のリンクをクリックするとプロキシが外れ、案内ページ（「移動／ホーム」）が表示される。

## 根本原因（実機で確定）

「Searches related to」リンクは DDG の React がハイドレーション後に**クエリのみの相対 href**（`?q=test%20my%20speed`）として描画する。

`buildClickNavDestination`（[rewrite.ts](../../src/lib/proxy/rewrite.ts)）:

1. ブラウザが現在ページ `…/proxy/3000/browse?url=<DDG>` 基準で解決 → `…/proxy/3000/browse?q=test%20my%20speed`
2. `dest.origin === page.origin` かつ `dest.pathname === page.pathname` に一致 → 「書き換え済み browse リンク」とみなして `dest.pathname + dest.search` を素通し
3. 戻り値に **`url=` が無い** → browse が案内ページ表示 → プロキシ離脱

判定 `dest.pathname === page.pathname` だけでは、ターゲット側のクエリ相対リンク（`?q=…`）も同じ browse パスに着地して誤って素通し対象に入るのが原因。

## 修正

素通し条件に **`dest.searchParams.has("url")`** を追加。`url=` を持たない同一パス着地（`?q=…` 等）は、現ターゲット（`url=`）を base に解決し直す既存分岐へ流す。

## 検証（実機）

修正後、「test my speed」クリックで `page.url()` が `…/browse?url=https://duckduckgo.com/?q=test%20my%20speed` になり、案内ページではなく DDG 検索結果（All/Images/Videos…）が表示されることを Playwright で確認。

## 受け入れ条件

1. [x] `buildClickNavDestination`: 同一 browse パス素通しは `url=` 付きのみ。`url=` 無しは target 基準解決へ
2. [x] 既存の `url=` 付き browse リンク素通し挙動を維持
3. [x] `rewrite.test.ts` に回帰テスト追加（`?q=…` が url= 保持・退行ガード）
4. [x] spec の判定条件を `url=` 付きに明確化
5. [x] lint/型/テスト green

## スコープ外（別 Issue #115）

ナビタブ（All/Images 等）の `/?url=<target>&ia=images` 化は、`?url=` ナビスキームと DDG client が `location.search` を読むことによる**パラメータ名衝突**が原因で、クリック横取りでは直せない。#115 で別途扱う。

## 進捗

- [x] 実機デバッグ（root cause 確定）
- [x] docs 先行（spec 更新）
- [x] テスト先行 → 実装 green
- [x] 実機再検証
- [ ] verify-gate
