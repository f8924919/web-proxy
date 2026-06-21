# #71 本番ブラウザ実行基盤の決定（バックエンド差し替え）

- **Issue**: [#71](https://github.com/f8924919/web-proxy/issues/71)
- **ブランチ**: `feature/71-production-browser-backend`
- **ステータス**: 進行中
- **関連**: 本体 #69（ブラウザバック中継）、egress IP/アンチボット #73

## 決定（ユーザー確認済み）

- **方針**: プラグイン（外部 CDP）と自前 Chromium を **env で選択可能**にする。既定は自前 Chromium 同梱（インプロセス `launch`）、`PROXY_BROWSER_CDP_URL` 設定時は `connectOverCDP` で外部サービスへ接続。
- **予算**: 小額可（egress IP も直るなら外部有料サービスの価値あり）。
- **デプロイ先**: コンテナ（VPS/クラウド）→ 自前 Chromium 同梱が可能。
- **egress IP（#73）**: 自前 Chromium は egress IP 不変で #73 未解決。クリーン IP を持つ外部 CDP に切り替えた場合のみ #73 にも効く。

## 受け入れ条件（Issue より）

- [ ] 比較（コスト・運用・stealth・IP・レイテンシ）を docs にまとめ採用方針を決定 → setup.md §9.1
- [ ] `browserFetch` の背後を差し替え（インターフェース契約は #69 のまま不変） → `getBrowser()` を launch/CDP 切替
- [ ] 同時実行数・タイムアウト・プール/再利用・リーク防止を本番想定値で設定 → セマフォ既定 + 切断時再接続
- [ ] デプロイ手順（依存・バイナリ・env・シークレット）を setup.md に追記 → §9 + Dockerfile

## 実装メモ

- `src/lib/proxy/browserFetch.ts`: 純粋関数 `browserBackendFromEnv(env)` を追加（`PROXY_BROWSER_CDP_URL` で `{mode:"cdp"|"launch"}`）。`getBrowser()` を分岐 + `disconnected` で共有参照リセット（再接続）。
- `package.json`: `playwright` を devDependencies → dependencies へ昇格。
- `Dockerfile` / `.dockerignore`: Playwright 公式イメージ（Chromium 同梱）で本番イメージ。
- テスト: `tests/lib/proxy/browserFetch.test.ts` に `browserBackendFromEnv` の単体テスト追加（ブラウザ I/O はテスト対象外）。
