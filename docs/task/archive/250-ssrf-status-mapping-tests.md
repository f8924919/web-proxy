# #250 SSRF 遮断のステータス写像を守るテストが無い

対応 Issue: [#250](https://github.com/f8924919/web-proxy/issues/250)

## 背景

[#237](237-ssrf-pinning-403.md) で「実運用ではピン留め由来の SSRF 遮断も 403 で返る」と結論づけたが、**その結論自体が自動テストで守られていない**ことが判明した。

- `findSsrfCause` のテスト（`tests/lib/proxy/fetch.test.ts`）は**手組みの** cause 連鎖に対するもので、実際の `fetch` が作る連鎖では検証していない
- `tests/lib/proxy/proxyFetch.wiring.test.ts` は Jest の realm 差により `instanceof` が成立せず、403 になることを検証できない（むしろ `not.toBeInstanceOf` で逆の期待値を固定している）
- `browseRelay.ts` / `relayAsset.ts` の**カバレッジは 0%**（全行未到達）。ステータス写像そのものを守るテストが存在しない

undici の `isErrorLike` / `makeNetworkError` の実装が変われば単一 realm でも置換が起こりえて、403 → 502 に退行しても**現行 CI は全 green のまま通る**。[#236](236-undici-major-regression.md)（undici 8 系で全経路 502・全ゲート green のままマージ）と同じ検出漏れの構図。

## 方針

### A. relay 層のステータス写像テスト（Jest）

`jest.mock("@/lib/proxy/fetch")` の**部分モック**（`jest.requireActual` で他 export を温存し `proxyFetch` だけ差し替え）で `relayAsset` / `relayBrowse` を直接呼び、ステータス写像を検証する。

**エラークラスはモックしない**。モックしたクラスでは `instanceof` 判定が成立せず、検証したい写像そのものが壊れる。

### B. 本番 realm での SSRF 写像 smoke（`node --test` 別レーン）

`node --test` + 型ストリップ + `node:module` の `register()` で `dns/promises` をスタブに差し替え、**単一 realm で実際の `proxyFetch` を走らせて** `instanceof SsrfBlockedError` で捕捉できることを検証する。着手時に実現可能性を実証済み。

成立の条件（確認済み）:

- `src/lib/proxy/fetch.ts` の import は `dns/promises` / `node:dns` / `node:net` / `undici` だけで、`@/` エイリアスを使っていない
- 型注釈のみで `enum` / `namespace` を使っておらず型ストリップが通る
- `register()` によるスタブ差し替えで、**本番コードに seam を入れずに**事前検査だけ通過させられる

**採らなかった代替**: (b) Jest から `child_process` で素の Node を起動する案（終了コード越しで失敗理由が読めない）、(c) B 自体の見送り。

### C. docs の整理

- `docs/spec/features/proxy.md` に §中継失敗時のステータス を新設し、**写像の正本を spec に置く**（従来 403 は spec、502 は 3 箇所に散在、413 は arch にしか無かった）
- `docs/testing/policy.md` に §1.2 を新設（§1.1 とは目的も条件も別カテゴリ）
- `docs/arch/proxy.md`: §エラー型 に実装とテストの対応を追加。`fetch.ts` 節に realm レーンとの結合を明記。`retry.ts` 節の「relayAsset 本体はテスト対象外」を訂正

## design-review で判明した要対応

- **false green の経路**（最重要）: `dns/promises` スタブが効かなかった場合、事前検査（`assertSsrfAllowed`）が自分でループバックを弾いて**同じ例外クラス**を投げるため、`connect.lookup` を一度も通らずに緑になる。#250 が防ごうとしている失敗様式そのもの。**スタブ呼び出し回数**と**例外 message 中のループバックアドレス**を assert して塞ぐ
- **0 件でも緑になる**: npm script はテストファイルを明示指定する（ディレクトリ指定＋ランナーの既定パターン任せにしない）
- **`.mts` は型検査の穴**: ルート `tsconfig.json` の `include` は `**/*.ts` で `.mts` にマッチしない。`tests/realm/tsconfig.json` を分けて `typecheck` を 2 プロジェクト実行にする（`allowImportingTsExtensions` の緩みを realm レーンに閉じ込めるため、ルート tsconfig の拡張は採らない）
- **`testPathIgnorePatterns` の既定上書き**: 設定すると既定値 `["/node_modules/"]` が置き換わる。`testMatch` が `*.test.ts` で `.mts` に元々マッチしないため、設定自体を省く
- **§1.2 のブレーキ**: 「原則 1 ファイル」の免除だけを引き継ぐと濫用余地が生まれるため、「追加時は本ポリシー更新を伴う」と「smoke に留める」スコープ条件を残す

## evaluator で判明した誤り（修正済み）

- **spec 表の写像を間違えていた**: `/api/proxy` の本文上限超過を 502 と書いたが、実際は **413**。`relayAsset` には catch が 2 つあり（① `proxyFetch` の catch ② 本文展開の catch）、①だけを見て「SSRF 以外は一律 502」と一般化したのが原因。②の `relayAsset.ts` は `BodyTooLargeError` を名指し判定して 413 を返す。`proxyFetch` は `BodyTooLargeError` を投げないため、①に届くことは本番では起きない
- **IP 分離が無効だった**: `getClientIp` は `PROXY_TRUSTED_IP_HEADER` 未設定だと転送ヘッダーを一切信頼せず全リクエストが同一バケットになる。`x-forwarded-for` を変えるだけでは分離できていなかった。テスト中だけ信頼ヘッダーを設定して実効化した（前後復元）
- **到達不能ケースを固定していた**: `BodyTooLargeError → 502` のテストは本番で起きない仮想シナリオで、上記の誤った一般化を補強していた。削除し、実経路（`PROXY_MAX_BUFFER_BYTES` を極小にして実物の `readTextWithLimit` に投げさせる）の 413 テストに差し替えた
- **docs がテストの実態を過大に記述していた**: 「この写像は自動テストで固定している」と書いたが、同時接続（503/429）とレート制限（429）の行は relay 層での写像が未固定だった。文言を実態へ限定し、`browseRelay` の②413 はテストを追加して固定した

## 別途検討が必要な発見（本タスクのスコープ外）

`browseRelay.ts` の**自動ティア昇格経路**（#70）で、昇格後の `readTextWithLimit` が `BodyTooLargeError` を投げると catch が握り潰し、`html` は中継ティア・`res` / `finalUrl` / `outHeaders` は昇格後という**混在状態で 200 を返す**。spec の「本文上限超過 → 413」から見ると例外的挙動。本タスク以前からの既存実装のため触っていない。

## 残るギャップ（意図的に埋めない）

Jest 側は `proxyFetch` をモックするため境界の手前まで、realm レーンは `proxyFetch` の境界までしか守らない。`relayAsset.ts` / `browseRelay.ts` は `@/` エイリアスを使うため realm レーンからは読めず、**「実際の `connect.lookup` 由来の例外が 403 になる」を端から端まで通す検証は存在しない**。この限界は `docs/arch/proxy.md` §ステータス写像のテスト に明記した。

## 関連 docs

- spec: [docs/spec/features/proxy.md](../../spec/features/proxy.md) §中継失敗時のステータス / §SSRF 対策
- arch: [docs/arch/proxy.md](../../arch/proxy.md) §エラー型 / §`src/lib/proxy/fetch.ts`
- テスト方針: [docs/testing/policy.md](../../testing/policy.md) §1.2
- 発見元: [#237](237-ssrf-pinning-403.md)
- 同種の検出漏れ: [#236](236-undici-major-regression.md)
