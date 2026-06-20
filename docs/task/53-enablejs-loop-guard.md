# enablejs ナビゲーションループの検出＋グレースフル遮断

- 対応 Issue: #53（実装）/ 関連 #52（B: チャレンジ突破可否の feasibility 調査）
- ブランチ: `bugfix/53-enablejs-loop-guard`
- ステータス: 進行中

## 背景

proxy 経由 Google 検索の 429 は真因がレート制限ではなく、Google の「enable JavaScript」インタースティシャルの JS が `?…&sei=<毎回変化>` を付けて自分自身へ再ナビゲーションを繰り返す無限ループ。各遷移が SW を素通しして `/browse` を叩き、`pageRateLimiter`(60/IP/分) で 429 着地。meta refresh は noscript 内で無関係（#50 では直らない）。

## 方針（ユーザー確定）

- A: ループを検出してグレースフル遮断（本 Issue #53）。Google 検索自体を使えるようにはしない。
- B: チャレンジ突破の可否は別 Issue #52 で feasibility 調査（実装は別途判断）。
- 検出キーの正規化: **host+path で query を全無視（汎用）**。sei 以外の query 循環ループにも効く。

## 設計

- 新モジュール `src/lib/proxy/loopGuard.ts`: `NavigationLoopGuard`（`rateLimit.ts` と同方式のインメモリ・スライディングウィンドウ）。
  - キー: `${ip}\n${host}${pathname}`（クエリ無視）。既定: ウィンドウ 10 秒 / 閾値 6 回。
  - `check(ip, target: URL): boolean` — 超過で `true`（ループ）。
- `/browse`(GET/POST) で `pageRateLimiter.check` の後に `navigationLoopGuard.check` を呼び、`true` なら中継 HTML でなく**自動遷移を含まない静的案内ページ(200)**を返す。
- 閾値 6/10秒 ≪ 60/分 なので 429 より手前で発火する。

## docs

- spec: `docs/spec/features/proxy.md` §ナビゲーションループの検出（enablejs 対策）を新設。§meta refresh の制限記述を本節へのリンクに更新。
- arch: `docs/arch/proxy.md` GET フロー step3b 追加・`loopGuard.ts` モジュール節追加・モジュールツリー追記。

## テスト

- `tests/lib/proxy/loopGuard.test.ts`: キー正規化（query 差分で同一視 / host・path 差分で別キー）、閾値境界（直下で false / 直上で true）、ウィンドウ経過後リセット、IP 独立。
- `/browse` 検出時応答: 案内ページ(200) を返し中継 HTML・自動遷移を含まないこと。

## 受け入れ条件

Issue #53 のチェックリストに準拠。
