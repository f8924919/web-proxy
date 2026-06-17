# project-bootstrap — プロジェクト初期構築

## 背景・ゴール

web-proxy プロジェクトの最小起動可能状態（"Hello, World" 相当が動く状態）を構築する。Next.js + TypeScript + npm を基盤として、開発環境で `npm run dev` が成功しブラウザで初期ページが表示されるところまでを完了条件とする。

## 完了条件

- [x] `npm install` で依存パッケージがインストールされる
- [x] `npm run dev` でローカルサーバー（`http://localhost:3000`）が起動する
- [x] トップページ（URL 入力フォーム）が表示される
- [x] `npm run lint` / `npm run format` / `npm run typecheck` がエラーなく通る
- [x] `npm test` が実行できる（テストなしの場合も pass）
- [x] `npm run build` が成功する

## 対象ファイル / 関連仕様

- [docs/spec/overview.md](../spec/overview.md)
- [docs/spec/screens/](../spec/screens/)

## 進捗メモ

- 2026-06-17: キックオフ完了。初期構築タスク登録。
- 2026-06-17: 全完了条件を確認。lint/typecheck/test/build green・dev サーバーでトップページ表示を確認。
