# #27 CORS ハードニング（非 GET 転送ヘッダー制限・許可オリジン制限）

- **Issue**: [#27](https://github.com/f8924919/web-proxy/issues/27) feat(v2): CORS ハードニング
- **ブランチ**: `feature/27-cors-hardening`
- **ステータス**: 完了（PR #63 マージ済み）
- **関連**: 由来 #21、Cookie アイソレーション #25

## 目的

#21 で CORS プリフライトを同一オリジン化で消したが、ハードニング面で 2 点残存。

1. **非 GET 中継の広めヘッダー転送**: `relayRequestHeaders` は拒否リスト方式で、`origin` / `referer` 等プロキシ自身の文脈を漏らすヘッダーまでターゲットへ転送し得る。
2. **OPTIONS / 中継レスポンスの Origin 無検証エコー**: 要求 `Origin` を無検証でエコー＋`Allow-Credentials: true`（`*` フォールバックあり）。

## 方式（ユーザー確定）

- **課題② 同一オリジン照合**: 純粋関数 `allowedCorsOrigin(origin, host)` を追加。要求 `Origin` の host が `/api/proxy` リクエスト自身の `Host` と一致する場合のみ許可。`buildCorsPreflightHeaders` は検証済み origin（null 可）を受け取り、非 null 時のみ `Allow-Origin` エコー＋`Allow-Credentials`（`*` フォールバック廃止）。route.ts の OPTIONS / 中継レスポンス両方で `allowedCorsOrigin` を用いる。env 設定不要・リバプロ親和。
- **課題① origin/referer 除外＋Auth 維持**: `RELAY_BLOCKED_REQUEST_HEADERS` に `origin` / `referer` を追加。`Authorization` は `Set-Cookie` のようなサーバー側往復機構が無くスコープ化が効かないため、クライアントが当該リクエストに明示設定した値のみ転送する現挙動を維持し spec に制約明記。

## 受け入れ条件（Issue より）

- [x] 非 GET 中継の転送ヘッダーに対する制限方針を設計する（origin/referer 除外）
- [x] `OPTIONS` / CORS 応答の許可オリジンを制限する方針を決める（同一オリジン照合）
- [x] 既存の正常系（SW 経由の同一オリジン中継）に回帰が無いことを確認する（同一オリジンは許可・全テスト green）
- [x] spec / arch を更新し、v2 課題から外す

## 変更ファイル

- `src/lib/proxy/headers.ts`: `allowedCorsOrigin` 追加、`RELAY_BLOCKED_REQUEST_HEADERS` に origin/referer 追加、`buildCorsPreflightHeaders` を検証済み origin ベースに変更。
- `src/app/api/proxy/route.ts`: OPTIONS / 中継レスポンスで `allowedCorsOrigin` 照合。
- `tests/lib/proxy/headers.test.ts`: `allowedCorsOrigin`・origin/referer 除外・null origin 時の挙動を追加。
- `docs/spec/features/proxy.md` / `docs/arch/proxy.md`: §CORS プリフライト対応を更新。

## 既知の制約（範囲外）

- `Authorization` のサイト別アイソレーションは対象外（サーバー側スコープ機構が無いため）。spec §セキュリティ上の制約に明記。
