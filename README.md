# web-proxy

[proxyium.com](https://proxyium.com/ja/) を参考にした Web ベースのプロキシサービスです。ブラウザから URL を入力するだけで、アクセス制限のある環境から外部サイトを閲覧できます。

## 主な機能

- URL 入力フォームからターゲットサイトへのプロキシ中継
- HTML コンテンツの書き換え（リンク・フォームのプロキシ経由 URL への変換）

## 動作環境

| 項目       | 要件                    |
| ---------- | ----------------------- |
| OS         | Linux / macOS / Windows |
| ランタイム | Node.js 18 以上         |

## 開発環境のセットアップと起動

```bash
npm install
npm run dev
```

## ビルド

```bash
npm run build
```

## 詳細ドキュメント

| ドキュメント                                 | 内容                                      |
| -------------------------------------------- | ----------------------------------------- |
| [docs/spec/](docs/spec/)                     | 動作仕様                                  |
| [docs/arch/](docs/arch/)                     | モジュール実装の詳細                      |
| [docs/git-workflow.md](docs/git-workflow.md) | ブランチ運用・Issue ベース開発・PR ルール |
| [docs/testing/](docs/testing/)               | テスト方針・実行コマンド                  |
