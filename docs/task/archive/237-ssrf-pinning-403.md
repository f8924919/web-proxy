# #237 IP ピン留め由来の SSRF 遮断が 403 でなく 502 で返る（前提が誤りと判明）

対応 Issue: [#237](https://github.com/f8924919/web-proxy/issues/237)

## 背景

[#236](236-undici-major-regression.md) の回帰検知テストを書く過程で「`connect.lookup` が投げた `SsrfBlockedError` が undici にプレーンな `Error` へ包み直され、`findSsrfCause` の `instanceof` 判定が捕捉できない」ことが観測され、**実運用でもピン留め由来の遮断が 403 でなく 502 になる**という見立てで起票された。

## 調査結果: 前提が成り立たない

着手時の実測により、この見立てが**誤り**であることが判明した。包み直しは `callback` へ渡す例外が**別 realm のオブジェクトだった場合にだけ**起きる。

`undici` の `Agent` + `connect.lookup` から Error を投げ、Node 組み込み `fetch` で受ける経路を、投げる Error の realm だけ変えて比較した結果:

| 条件                                   | cause 連鎖                        | `instanceof` | カスタムプロパティ |
| -------------------------------------- | --------------------------------- | ------------ | ------------------ |
| 同一 realm の Error サブクラス（本番） | `TypeError` → `SsrfBlockedError`  | 成立         | 保持               |
| 別 realm（`vm.createContext`）（Jest） | `TypeError` → `Error`（文字列化） | 不成立       | 消失               |

`jest-environment-node` はテストコードを vm context で実行するため後者に該当する。**Jest 上でのみ** `findSsrfCause` が捕捉に失敗し、`FetchTimeoutError`（502）に丸められる。

### 包み直しの機構（実測だけでなくコードで確定）

- `node_modules/undici/lib/web/fetch/response.js:386-392` — `makeNetworkError(reason)` は `isErrorLike(reason)` が偽のとき `new Error(reason ? String(reason) : reason)` へ置き換える
- `node_modules/undici/lib/web/fetch/util.js:105-109` — `isErrorLike(object)` は `object instanceof Error || object?.constructor?.name === "Error" || === "DOMException"`

同一 realm の `Error` サブクラスは `instanceof Error` が真になるため**置換されえない**。「置換は cross-realm のときにだけ起きる」は経験則ではなく機構上の帰結。

### 本番が単一 realm であることの裏取り

- リポジトリに edge runtime の指定は無い（`export const runtime` は 0 件）。`proxyFetch` に到達する 4 ルート（`src/app/browse/route.ts` / `src/app/browse/[...slug]/route.ts` は `relayBrowse` 経由、`src/app/api/proxy/route.ts` / `src/app/api/proxy/[...slug]/route.ts` は `relayAsset` 経由）はすべて Node runtime
- Next.js の fetch パッチは fetch 由来のエラーを `.catch((error) => { ...; throw error })` でそのまま再スローし、包み直さない（`node_modules/next/dist/server/lib/patch-fetch.js:706-708`）

### 検証の限界

実サーバーに対する end-to-end 検証はしていない。事前検査を通過して接続段階でだけ弾かれる状況を作るには実際の DNS リバインディングが必要で、ローカルでは再現できないため。上記は「同一 realm では包み直しが起きない」＋「本番は単一 realm」からの推論。

### 当初の修正方針が機能しないこと

Issue が提案していた「`SsrfBlockedError` に判別可能なプロパティを持たせ、cause 連鎖でそれを探す」方式は、**cross-realm ではプロパティごと失われるため Jest でも機能しない**（実測で `ownKeys=[]`）。cross-realm で残るのは message 文字列だけで、それは Issue が明示的に避けたいとしていた手段。

## 方針

本番コード（`src/lib/proxy/fetch.ts`）は変更せず、**事実と異なる docs の訂正**に絞る。

- `docs/spec/features/proxy.md` §DNS リバインディング / TOCTOU 対策 の「既知の乖離」注記を削除（本番では仕様どおり 403）
- `docs/arch/proxy.md` 同章の注記を、realm 由来のテスト環境固有現象である旨の記述へ差し替え
- `docs/arch/proxy.md` エラー型表から「`connect.lookup` 由来の遮断は現状 502」を削除
- `docs/task/archive/236-undici-major-regression.md` の「実運用でも 502」という見立てに後日の訂正を追記
- `tests/lib/proxy/proxyFetch.wiring.test.ts` に、Jest では realm 差により `instanceof` 判定できないこと（＝メッセージ文字列で検証している理由）をコメントで明示

### 対象外

- `src/lib/proxy/fetch.ts` の変更（本番では正しく動作しているため）
- message パターン照合による cross-realm 対応（本番で到達しない経路のために本番コードへ文字列マッチを入れることになるため）
- `browseRelay` / `relayAsset` のステータス分岐テスト。検出側（`findSsrfCause`）は既存テスト（`tests/lib/proxy/fetch.test.ts` §`findSsrfCause（403 伝播・#129）`）で担保済みで、残る未テスト部分は `if (err instanceof SsrfBlockedError) return 403` の分岐のみ。両モジュールにはテストファイルが 1 本も無く、レートリミッタ・同時実行制限・cookie jar・認証のシングルトンを通す新規テスト基盤が必要になるため、docs 訂正の本タスクからは分離する

将来 edge runtime を採用する場合は realm が分かれるため、その時点で再検討が必要。

## 関連 docs

- spec: [docs/spec/features/proxy.md](../../spec/features/proxy.md) §SSRF 対策 / §DNS リバインディング / TOCTOU 対策（IP ピン留め）
- arch: [docs/arch/proxy.md](../../arch/proxy.md) §DNS リバインディング / TOCTOU 対策（IP ピン留め・undici `Agent`）/ §エラー型
- 発見元: [#236](236-undici-major-regression.md)
- ピン留めの経緯: [#129](129-ssrf-dns-rebinding-ip-pinning.md)
