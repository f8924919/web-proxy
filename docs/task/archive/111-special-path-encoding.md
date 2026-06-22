# #111 %2F・非 ASCII を含む特殊パスの回帰テスト追加と spec 整合

- **Issue**: [#111](https://github.com/f8924919/web-proxy/issues/111)
- **ブランチ**: `bugfix/111-special-path-encoding`
- **ステータス**: 進行中
- **種別**: 防御（回帰テスト追加）＋ docs 整合（挙動変更なし）
- **関連**: #100（パス反映スキーム導入）
- **着手日**: 2026-06-22

---

## 背景・調査結果（裏取り済み）

`%2F`（エンコード済みスラッシュ）・非 ASCII（日本語等）を含む特殊パスの扱いを、実 Next.js 15.5 dev サーバ上でエンドツーエンド検証した。

| 検証ケース                              | 経路                        | 上流への転送結果                         | 判定 |
| --------------------------------------- | --------------------------- | ---------------------------------------- | ---- |
| `…/anything/a%2Fb/c`                    | アセット中継 `/api/proxy/…` | `https://httpbingo.org/anything/a%2Fb/c` | 保持 |
| `…/anything/日本`(`%E6%97%A5%E6%9C%AC`) | アセット中継                | `…/anything/%E6%97%A5%E6%9C%AC`          | 保持 |
| `?q=a%2Fb`                              | アセット中継                | `…?q=a%2Fb`                              | 保持 |
| `%2F` を含む target                     | ページ遷移 `/browse?url=`   | `…/anything/a%2Fb/c`                     | 保持 |
| 非 ASCII を含む target                  | ページ遷移 `/browse?url=`   | `…/anything/%E6%97%A5%E6%9C%AC`          | 保持 |

**結論: 現状すでに正しく保持・転送されており、挙動変更は不要。**

### なぜ壊れないか

- `buildProxyPath`（[proxyPath.ts:12-17](../../src/lib/proxy/proxyPath.ts)）は WHATWG `URL` の `pathname`（`%2F` を `/` に正規化しない）を用いる。
- 復元側 `targetFromProxyPath`（同 22-46）はデコード済み catch-all params ではなく**生の `req.nextUrl.pathname` を文字列処理**で扱う（[route.ts:10](../../src/app/api/proxy/[...slug]/route.ts)）。Next.js 15.5 の `NextURL` は `%2F`・非 ASCII を `pathname` に保持することを直接確認済み。
- `/browse?url=` 経由は `encodeURIComponent` で一重エンコード → `searchParams.get` が自動デコードして整合。

## 残ギャップ（本タスクの対象）

1. 上記の正しい挙動を固定する**回帰テストが無い**。`proxyPath.ts` には「percent-encoding を保つため生 pathname を渡せ」という明示的な脆さの警告があるのに未固定で、将来 `params.slug`（デコード済み）等へ切り替えるとサイレントに壊れる。
2. `docs/spec/features/proxy.md` の HTML 書き換えルール表が旧 `?url=` 形式のままで、同ファイル §プロキシ URL スキーム節と矛盾していた。

## 受け入れ条件

1. `tests/lib/proxy/proxyPath.test.ts` に `%2F`・非 ASCII の round-trip（`buildProxyPath` ↔ `targetFromProxyPath`）回帰テストを追加。`%2F` が `/` に潰れず、非 ASCII が percent-encoding のまま保持されることを固定する。
2. `docs/spec/features/proxy.md` の HTML 書き換えルール表をパス反映形式へ更新し、`%2F`・非 ASCII の percent-encoding 保持仕様を明記する。
3. 既存テスト・lint・型チェックが green。

## 進捗

- [x] エンドツーエンド検証（dev サーバ + httpbingo で実証）
- [x] spec 更新（§スキームに percent-encoding 保持を明記・書き換えルール表をパス反映形式へ）
- [x] 回帰テスト追加（`proxyPath.test.ts` に `%2F`・非 ASCII の round-trip 8 件・全 green）
- [x] verify-gate（verify green / docs-check 反映済み / evaluator 実施）
