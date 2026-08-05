# #253 自動ティア昇格で中継ティアとブラウザティアが混在した応答を返す

対応 Issue: [#253](https://github.com/f8924919/web-proxy/issues/253)

## 背景

[#250](250-ssrf-status-mapping-tests.md)（PR #252）でステータス写像のテストを整備する過程で発見。

`src/lib/proxy/browseRelay.ts` の自動ティア昇格ブロックは `res` / `finalUrl` / `outHeaders` を**先に上書きしてから** `html` を読み直す。最後の `readTextWithLimit` が投げると catch がログのみで続行するため、**`html` は中継ティア・それ以外はブラウザティア**という混在状態のまま後続へ進む。

「昇格は best-effort。失敗時は初回の中継ティア応答をそのまま使う」というコメントの意図に反し、**初回応答をそのまま使えていない**。

## 影響

- 中継ティアの HTML を**ブラウザティアの `finalUrl` 基準**で書き換えるため、相対 URL の解決基準がずれる
- **ステータス・ヘッダーが本文と対応しない**（中継ティアが 403 でブラウザティアが 200 なら 403 の本文が 200 で返る）
- `BodyTooLargeError` が握り潰され、本文上限超過が 200 相当になる

発生条件は「自動昇格が有効（`PROXY_BROWSER_AUTO_PROMOTE`）かつ昇格が発火し、昇格後の本文読み取りだけが失敗する」ため頻度は低いが、上限超過は攻撃者が誘発しうる。

## 方針

`fetchTarget`（`browseRelay.ts:139-156`）と**同じパターンに揃える**。昇格結果はいったんローカル変数へ受け、本文読み取りまで成功して初めてまとめて差し替える。`fetchTarget` は `browserFetch` を `await` して成功時のみ呼び出し元へ返すため部分的な代入が起きない構造になっており、リポジトリ内に前例がある。

### 起票時の条件からの変更: `BodyTooLargeError` も 413 にせず巻き戻す

起票時は「`BodyTooLargeError` は握り潰さず 413（`fetchTarget` の #144 と対称）」としていたが**撤回**した。

#144 が「フォールバックさせない」根拠は「上限超過の中継先を**別経路で再取得**することになり挙動が揃わない」こと。しかし昇格ブロックでは**中継ティアの HTML を既に読み終えている**ため再取得は発生せず、この根拠が当てはまらない。413 を返すと、任意機能である自動昇格を有効にしただけで**それまで見えていたページが見えなくなる退行**になる。

メモリ面のリスクも増えない。ブラウザティアの本文量は `browserFetch` が `page.content()` の**前**に DOM サイズを概算して同じ上限で打ち切る（#144）ため既に守られている。

### 巻き戻さないもの

| 対象                              | 理由                                                                                                                                   |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `cookieJar` への書き込み          | `browserFetch` 自体は成功しており Cookie はターゲットが正当に発行したもの。Cookie セッションウォーミングはブラウザティアの意図した機能 |
| `promotionGuard` の抑止ウィンドウ | 解放系メソッドが無く、同じ失敗が繰り返される URL でブラウザティアを起動し直すコストのほうが問題                                        |

## 実装上の注意（調査で判明）

- `sanitizeHeaders` は `new Headers()` を返す純粋関数で引数を破壊しない。一方 **`issueSessionCookie` は引数の `Headers` を破壊的に変更する**（`append`）ため、コミット順序を誤ると `Set-Cookie`（`__pxy_sid`）が二重発行されうる
- **`readTextWithLimit` が現実に失敗する余地は狭い**。`browserFetch` が返すのは文字列から構築したインメモリ `Response` でソケットに紐づかず、`Content-Length` も付かないため早期判定も効かない。実質「DOM 概算 vs `page.content()` 実バイト数の誤差でわずかに上限を超える」場合にほぼ限られる。テストは人工的なモック前提で設計する
- **テストで中継ティアとブラウザティアの上限を作り分ける**: `PROXY_MAX_BUFFER_BYTES` を極小にすると中継ティア側の初回読み取りが先に落ちる。**モックした `browserFetch` の応答にだけ `content-length: 999999` を付ける**と、実物の `readTextWithLimit` の早期判定で確実に落ちて上限値をいじらずに済む
- **昇格の発火は「中継ティア 403」が最も安価**（`shouldPromoteToBrowser` は 403/503 で真）。ブラウザティアを 200 にすれば混在検出の assert（ステータス差）もそのまま成立する
- **昇格が発火しなかったのに green になる偽陽性を潰す**ため、各テストで `expect(browserFetch).toHaveBeenCalledTimes(1)` も assert する
- **`promotionGuard` はシングルトンでリセット API が無い**。テストは互いに異なる host+path の URL を使わないと、2 件目以降で `tryPromote` が `false` を返して**昇格が発火せずテストが何も検証しないまま green になる**
- 昇格を発火させるには `PROXY_BROWSER_AUTO_PROMOTE` の一時設定と、`shouldPromoteToBrowser` を真にする HTML（`enable javascript` 等のチャレンジ語句、またはステータス 403/503）が必要

## design-review で判明した補強

- **「413 にしない」は新しい非対称ではなく既存動作の追認**。昇格ブロックは `fetchTarget` を経由せず `browserFetch` を直接呼ぶため、`fetchTarget` の「`SsrfBlockedError` / `BodyTooLargeError` は再 throw」ルールは元から適用されていない。`browserFetch` の DOM 概算超過（#144）は現行コードでも巻き戻されており、今回は `readTextWithLimit` 由来を同じ扱いに揃えるだけ
- **413 にしても資源は守れない**。`browserFetch` は既に完了しており `readTextWithLimit` は上限到達時に `reader.cancel()` する。セキュリティ上の利得ゼロで UX 退行のみ
- **`promotionGuard` を解放しない根拠は「コスト」ではなく「#70 の不変条件」**。解放すると常に失敗する URL に対してリクエストごとにブラウザを起動でき、「URL あたり高々 1 回 / ウィンドウ」という増幅防止が崩れる。抑止キーは `host + path` のみなので、失敗した昇格は同一 URL を見る全ユーザーに 60 秒間影響する
- **`SsrfBlockedError` も巻き戻す**（ユーザー判断）。`browserFetch` は昇格時にも `assertSsrfAllowed` を実行するため DNS の変化で投げうるが、返す中継ティアの本文は検査済み経路で取得したもので開示リスクはない。「SSRF は常に 403」の明示的な例外として spec / arch に記載
- **ヘルパー関数へ切り出す**（ユーザー判断）。成功時のみ 4 値を返す形にして部分代入を型レベルで不可能にする
- **`Set-Cookie` は二重発行より欠落のほうが危険**。コミット時に候補ヘッダーへ `issueSessionCookie` を適用し忘れると `__pxy_sid` が発行されず、リクエストごとに新セッションが切られて jar が機能しなくなる（#151 Phase 1 の破壊）。正常系・巻き戻し系の双方で「ちょうど 1 個」を固定する
- **Cookie を残すトレードオフ**: `cookieJar.store` は名前単位の後勝ち upsert なので、巻き戻し時は「中継ティアの HTML を返しながら以降は別セッションの Cookie で飛ぶ」ずれが起きうる。影響は次回ナビゲーション以降に限られ到達確率も低いため許容する

## 別途検討が必要な発見（本タスクのスコープ外）

`browserFetch` は `context.cookies()` の**全 Cookie**（サブリソース＝第三者 origin が設定したものを含む）を `Domain` 無しの `Set-Cookie` 化し、呼び出し側がそれを**ナビゲーション最終 URL の origin 一括**で jar に入れる。第三者 Cookie がターゲット origin の Cookie として保存され、以後ターゲットへ送出される。

## evaluator で判明した実装バグ（修正済み）

**`storeRelayCookies` を `readTextWithLimit` の後に呼んでいた**ため、巻き戻し時に Cookie が保存されず、「Cookie は巻き戻さない」という決定と docs に反していた。本文読み取りより**前**へ移した。

この不一致を検出できなかった直接の原因は、**巻き戻し時に jar へ Cookie が残ることを固定するテストが無かった**こと。回帰テストを追加し、変異検査（`storeRelayCookies` を後ろへ戻す）で red になることを確認した。

あわせて `__pxy_sid` の 2 ケースに `expect(browserFetch).toHaveBeenCalledTimes(1)` が無く、昇格が発火しなくても green になる状態だった（変異検査で実証）。追加した。

## 混在の検出方法（テスト）

「ステータスが 200 であること」だけでは混在を検出できないため、次の 2 点を assert する。

1. **`res.status`** が中継ティア側のモック値と一致し、ブラウザティア側のモック値と**異なる**こと
2. **書き換え後の本文中のリンク先ホスト**が中継ティアの `finalUrl` を基点に解決されていること。`rewriteHtml(html, finalUrl)` の `finalUrl` は相対リンクの解決基点で、`browseUrl` → `buildBrowsePath` により絶対 URL のホストがパスへ埋め込まれるため外形的に判別できる

## 関連 docs

- spec: [docs/spec/features/proxy.md](../../spec/features/proxy.md) §ヒューリスティック自動ティア昇格
- arch: [docs/arch/proxy.md](../../arch/proxy.md) §昇格失敗時の巻き戻し（#253）
- 発見元: [#250](250-ssrf-status-mapping-tests.md)
- 自動ティア昇格の初出: [#70](70-heuristic-auto-tier-promotion.md)
