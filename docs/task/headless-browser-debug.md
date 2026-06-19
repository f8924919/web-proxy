# ヘッドレスブラウザ（Playwright）によるプロキシ表示デバッグ環境の導入

対応 Issue: [#32](https://github.com/f8924919/web-proxy/issues/32)

## 背景 / ゴール

code-server（linuxserver 系）コンテナ内で開発しているため、Claude（コンテナ内・ヘッドレス）が proxy の **描画後の状態**を確認する手段が無い。`node-html-parser` ベースの静的解析では JS 実行後にしか再現しない不具合（例: Google 検索の enablejs 無限リダイレクト → 429）を追えない。

Playwright + headless chromium を導入し、プロキシ経由ページの **スクリーンショット / console ログ / network 記録 / 描画後 HTML** を取得できるデバッグスクリプトを用意する。

## デバッグ経路の整理（2 系統）

| 経路              | 利用者               | 概要                                                                                     | 状態                                                               |
| ----------------- | -------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 方式A: 実ブラウザ | 人間                 | code-server のポート転送 `/proxy/3000/` を実ブラウザで開き、F12 DevTools でデバッグ      | 既存（[setup.md §5](../setup.md) の `NEXT_PUBLIC_BASE_PATH` 前提） |
| 方式B: ヘッドレス | Claude（コンテナ内） | Playwright headless chromium で `http://localhost:3000` 経由ページを開き、各種記録を取得 | **本タスクで追加**                                                 |

## 完了条件（受け入れ条件）

Issue #32 の受け入れ条件に準拠。

- `playwright` を devDependency 追加 + chromium インストール手順を docs 記載
- `npm run debug:browser -- <url>` で起動（`<url>` は http(s) フル URL もしくは dev サーバ上のパス）
- 内部で `http://localhost:3000` の dev サーバ経由でページを開く（dev サーバ起動済み前提）
- 出力: スクリーンショット(PNG) / console ログ / network 記録 / 描画後 HTML
- 出力先を gitignore
- `docs/setup.md` に方式B の手順追記

## 設計メモ

- **スクリプト形式**: Node ESM（`.mjs`）。`tsx` / `ts-node` 未導入のため、ビルド不要で `node` 単体実行できる `.mjs` を採用する。
- **対象 URL の解釈**: 引数が `http://` / `https://` で始まる場合はそのフル URL をプロキシ対象とみなし `http://localhost:3000/browse?url=<encoded>` を開く。`/` で始まる場合は dev サーバ上のパスとしてそのまま `http://localhost:3000<path>` を開く（`/` トップや `/browse?url=...` を直接指定する用途）。
- **出力先**: `scripts/.debug-out/`（gitignore）。1 回の実行ごとにタイムスタンプ付きで `screenshot.png` / `console.log` / `network.json` / `page.html` を出力する。
- **dev サーバ**: 起動済み前提（方式A と同じ運用）。未起動時は接続エラーを分かりやすく出して終了する。

## テスト方針

[docs/testing/policy.md](../testing/policy.md) より、E2E/UI スモーク・外部ネットワーク I/O・エントリーポイントはいずれもテスト対象外。本スクリプトはこれら全てに該当する **開発専用ツール**のため、テスト先行ゲートの対象外とする（ユニットテストは追加しない）。

## docs 反映方針

製品機能・プロキシモジュールの変更ではなく開発ツールの追加のため、spec / arch は更新せず [docs/setup.md](../setup.md) を正本とする。
