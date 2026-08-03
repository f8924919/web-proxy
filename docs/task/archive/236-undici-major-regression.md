# 236 undici 8 系への更新でプロキシ中継が全滅する回帰の修正

- Issue: [#236](https://github.com/f8924919/web-proxy/issues/236)
- ブランチ: `bugfix/236-undici-major-regression`
- ステータス: 完了（PR #238 マージ済み）

## 背景

Dependabot PR [#232](https://github.com/f8924919/web-proxy/pull/232) で `undici` を 7.29.0 → 8.9.0 に更新した結果、`/browse` / `/api/proxy` の全経路が 502 Bad Gateway になった。lint / 型 / テスト / build はすべて green のまま `main` にマージされ、実際に dev サーバーを起動して中継を試すまで検出できなかった。

## 原因

`src/lib/proxy/fetch.ts` は SSRF の IP ピン留め（[#129](https://github.com/f8924919/web-proxy/issues/129)）のため npm の `undici` から `Agent` を生成し、**Node 組み込みの `fetch()`** へ per-request の `dispatcher` として渡している。組み込み `fetch()` の実体は Node にバンドルされた undici であり、npm 側とは別インスタンス。undici 8 系で dispatcher のハンドラ interface が刷新され（`onRequestStart` 等）、両者が非互換になった。

最小再現（Node v24.14.1）:

```js
import { Agent } from "undici";
await fetch("https://example.com/", { dispatcher: new Agent() });
// undici 8.9.0 → TypeError: fetch failed / cause: invalid onRequestStart method (UND_ERR_INVALID_ARG)
// undici 7.29.0 → 200
```

Node のバージョンが undici 8 の要求（>= 22.19.0）を満たしていても再現するため、Node 側の問題ではない。

## 検出できなかった理由

- `tests/lib/proxy/fetch.test.ts` は `isSsrfBlocked` 等の純粋関数のみ検証しており、`proxyFetch` 自体を通すテストが無い。リポジトリ全体でも HTTP スタックを通すテストが存在しない
- `src/lib/proxy/fetch.ts` の catch が SSRF 由来以外の例外を一律 `FetchTimeoutError` に丸め、`cause` も保持していないため、根本原因が応答にもログにも現れない

## 方針

undici を `^7.29.0` に固定する。undici 8 の CVE 修正を取り込めない点は、実際の HTTP リクエストを処理しているのが Node 組み込みの undici であり npm 側は `Agent` 生成にしか使われていないため影響が限定的。Node 本体のバンドル undici が 8 系に上がった時点で再検討する。

## 決定事項

- **バージョン指定はレンジ（`^7.29.0`）**。7 系内のマイナー/パッチは受け入れ、メジャーだけを Dependabot の `ignore` で止める。厳密固定はセキュリティパッチの取りこぼしにつながるため採らない
- **テストポリシーを拡張する**（[testing/policy.md](../testing/policy.md) §1.1 を新設）。この回帰はモックでは原理的に検出できず、実際に HTTP スタックを通す必要がある。外部ネットワーク I/O を対象外とする原則は維持し、`127.0.0.1` の動的ポートに閉じた結合テストのみを許容範囲として明記する
- **エラーのステータスコードは変えない**。`browseRelay.ts` / `relayAsset.ts` はどちらも最終的に 502 に収束しており、分類を変えても外部から見た挙動は変わらない。`FetchTimeoutError` に `cause` を持たせて可観測性だけ上げる
- **`engines` の追加・CI の Node パッチ固定はスコープ外**。今回の原因が Node バージョンではないことを確認済みのため、再発防止として過剰

## 設計レビューで判明した制約

**`proxyFetch` はローカル HTTP サーバーへ接続できない。** `assertSsrfAllowed` の事前検査と `connect.lookup` フックの二重でループバックがブロックされ、ブロック対象外のローカル待受アドレスは存在しない（RFC1918・CGNAT・リンクローカルもすべてブロック範囲）。当初想定していた「ローカルサーバーへ `proxyFetch` を通して 200 を得る」テストは、本番コードに seam を入れない限り書けない。

SSRF 設計の攻撃面を広げないため本番コードは変更せず、**2 本立て**で回帰を捉える方針に変更した。

## テスト方式と red の確認（受け入れ条件）

undici 8.9.0 を一時的に入れて両テストが red になることを確認済み。

| テスト                                      | 目的                                                                                                                                                                          | undici 8 での red の理由                                                                                                                                                  |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/lib/proxy/undici-dispatcher.test.ts` | `Agent` を Node 組み込み `fetch` の dispatcher として渡せるという契約を、`127.0.0.1` の動的ポートに立てた `node:http` サーバーへの実 HTTP で検証                              | `InvalidArgumentError: invalid onRequestStart method` で fetch が失敗                                                                                                     |
| `tests/lib/proxy/proxyFetch.wiring.test.ts` | `dns/promises` のみモックして事前検査を通過させ、`connect.lookup` が実際に呼ばれて `Blocked SSRF target` が cause 連鎖に現れることを検証（#129 のピン留め回帰テストも兼ねる） | dispatch 検証段階で落ちて `connect.lookup` が呼ばれず、cause 連鎖が `... <- TypeError: fetch failed <- Error: InvalidArgumentError: invalid onRequestStart method` になる |

実装中に判明した細かい点:

- `http://localhost:9/` は fetch が "bad port" として拒否するため使えない。ポートは 8181 を使用（待受は不要）
- `connect.lookup` が投げた `SsrfBlockedError` は undici によってプレーンな `Error`（message に元のクラス名と文言を含む）へ包み直されるため、`instanceof` では捕捉できない。テストは cause 連鎖の文字列で判定している

## 別途対応が必要な発見（本 Issue のスコープ外）

上記のとおり `connect.lookup` 由来の `SsrfBlockedError` が `Error` へ包み直されるため、`findSsrfCause`（`instanceof` で判定）が機能せず、**IP ピン留めによる遮断が 403 ではなく 502 になっている**。遮断自体は成立しており安全側だが、[arch/proxy.md](../arch/proxy.md) および [spec/features/proxy.md](../spec/features/proxy.md) の「SSRF ブロックは 403」という記述と乖離する。undici 7 系で再現し、本 Issue の変更とは独立した既存の不具合。

[#237](https://github.com/f8924919/web-proxy/issues/237) として起票済み。本 PR では docs 側に「現状 502・#237 で追跡」の注記を入れるに留め、修正は #237 で行う。

## 進捗

- [x] 原因特定・最小再現の確立
- [x] Issue #236 起票
- [x] docs 先行（testing/policy.md §1.1、arch/proxy.md の undici バージョン制約・エラー可観測性、spec のエラーログ節）
- [x] 設計レビュー（design-review）— テスト方式・ログ方針を修正
- [x] テスト先行（dispatcher 契約テスト / 配線テスト / `formatError` の cause 連鎖テスト）
- [x] 実装（undici 固定 / `FetchTimeoutError` の cause 保持 / `formatError` の連鎖展開 / 呼び出し側のログ追加 / dependabot ignore）
- [x] 検証ゲート（verify / docs-check / evaluator）

## 検証結果

| 項目                                                 | 結果                                      |
| ---------------------------------------------------- | ----------------------------------------- |
| `npm run lint` / `format:check` / `typecheck`        | pass                                      |
| `npm test`                                           | pass（24 suites / 815 tests）             |
| `npm run build`                                      | pass（Next 16.2.12）                      |
| `GET /browse/https/example.com/`（`npm run dev`）    | **200**（書き換え済み HTML 30,134 bytes） |
| `GET /api/proxy/https/example.com/`（`npm run dev`） | **200**                                   |

evaluator の指摘に対応した内容:

- Issue #236 本文の受け入れ条件を、実際に採用した 2 本立てへ書き換え（当初の書き換えスクリプトが失敗し反映されていなかった）
- ピン留め由来の SSRF 遮断が 502 になる既存不具合を [#237](https://github.com/f8924919/web-proxy/issues/237) として起票し、arch / spec に「現状 502・#237 で追跡」の注記を追加
- `src/lib/logger.ts` のコメント「`findSsrfCause` と揃える」を訂正（走査ノード数が 1 ずれていた）
- `formatError` で cause が `Error` でない場合に連鎖を打ち切る仕様をテストで固定
- `docs/testing/policy.md` §1.1 の許容条件 1 を「実際に接続を行うテストが対象」とスコープ限定し、配線テストの除外を条件表の中で読めるよう修正
- `docs/arch/dependencies.md`（依存バージョン固定方針の正本）に undici の 7 系固定と「dependabot の PR を CI green だけで信用しない」教訓を追記

## 同梱する変更

Next 16 への更新（[#234](https://github.com/f8924919/web-proxy/pull/234)）に伴い `next build` が `tsconfig.json`（`jsx: react-jsx` は必須変更）と `next-env.d.ts` を自動で書き換える。放置すると誰がビルドしても差分が出るため、本 PR に同梱する。
