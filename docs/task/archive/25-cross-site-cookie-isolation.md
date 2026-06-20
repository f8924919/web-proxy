# #25 サイト間 Cookie アイソレーション

- **Issue**: [#25](https://github.com/f8924919/web-proxy/issues/25) feat(v2): サイト間 Cookie アイソレーション
- **ブランチ**: `feature/25-cross-site-cookie-isolation`
- **ステータス**: 完了（PR #61 マージ済み）
- **関連**: 由来 #20 / #21、リダイレクト漏えい対策 #26

## 目的

URL 書き換え方式のため全ターゲットが単一のプロキシ origin から配信され、Cookie もプロキシ origin に集約される。アイソレーションが無く、あるサイトの Cookie が別サイトの中継リクエストにも送出され得る（クレデンシャル混在・漏えい）。これを解消する。

## 方式（ユーザー確定: Cookie 名スコープ方式・ステートレス）

サーバー側 Cookie ストアを持たず、`headers.ts` の純粋関数でスコープ化する。

- **スコープ鍵**: `cookieScopeKey(origin)` = `base64url(origin)`（`URL.origin` は ASCII。Cookie 名 token に使える文字のみ）。区切りは base64url が使わない `.`。名前形式 `__pxy.<key>.<元の名前>`。粒度は origin（`scheme://host:port`）単位（#26 の同一オリジン判定と整合）。
- **復路（Set-Cookie）**: Domain 除去（既存）に加え Cookie 名を `finalUrl` origin でスコープ化。`Path`/`Secure`/`SameSite` は維持。
- **往路（Cookie）**: 現ターゲット origin に一致する `__pxy.<key>.` 接頭辞の Cookie だけを抽出・接頭辞除去して転送。別 origin・非スコープは送らない。
- **`stripInfraCookies` 削除**: scope フィルタが「自 origin 一致の scoped cookie だけ」を通すため、プロキシ自身のインフラ認証 cookie（非スコープ）は自動除外される。役目が包摂されるため削除し docs を更新。

## 受け入れ条件（Issue より）

- [ ] ターゲット origin ごとに Cookie を分離して保持・送出する仕組みを設計する
- [ ] あるターゲットの Cookie が別ターゲットの中継リクエストに乗らないことを検証する
- [ ] `Set-Cookie` の往路（Domain 除去）と整合させる
- [ ] spec / arch を更新し、v2 課題から外す

## 既知の制約（範囲外・回帰なし）

- 元 Cookie の `Path` を維持するため、`Path=/` 以外のパス限定 Cookie がプロキシパスへ送り返されない既存の限界は据え置き。
- デプロイ前から残る非スコープ cookie は転送されず再ログインが必要。
