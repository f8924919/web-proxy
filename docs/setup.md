# 環境構築ガイド

このプロジェクトを開発環境で動かすまでの手順を記載します。

---

## 1. 前提条件

| ツール  | 必要バージョン      | 確認コマンド     |
| ------- | ------------------- | ---------------- |
| Node.js | 18 以上（推奨: 22） | `node --version` |
| npm     | 9 以上              | `npm --version`  |
| Git     | 任意                | `git --version`  |

Node.js は [nodejs.org](https://nodejs.org/) または [nvm](https://github.com/nvm-sh/nvm) でインストールしてください。

---

## 2. リポジトリのセットアップ

```bash
# リポジトリをクローン（GitHub リモート設定後）
git clone <リポジトリ URL>
cd web-proxy

# 依存パッケージをインストール
npm install
```

---

## 3. 開発サーバーの起動

```bash
npm run dev
```

起動後、ブラウザで [http://localhost:3000](http://localhost:3000) を開くとトップページが表示されます。

---

## 4. 主要コマンド一覧

| コマンド                 | 内容                                    |
| ------------------------ | --------------------------------------- |
| `npm run dev`            | 開発サーバー起動（ホットリロード有効）  |
| `npm run build`          | 本番向けビルド（`.next/` に出力）       |
| `npm start`              | ビルド済みアプリをサーバーモードで起動  |
| `npm run lint`           | ESLint で静的解析                       |
| `npm run lint:fix`       | ESLint 自動修正                         |
| `npm run format`         | Prettier でコード整形                   |
| `npm run format:check`   | フォーマット差異の確認（CI 向け）       |
| `npm run typecheck`      | TypeScript 型チェック（`tsc --noEmit`） |
| `npm test`               | Jest テスト実行                         |
| `npm test -- --coverage` | カバレッジ付きテスト                    |

---

## 5. 環境変数

プロジェクトルートに `.env.local` を作成して設定します（`.env.local` は `.gitignore` に含まれており、コミットされません）。

### `NEXT_PUBLIC_BASE_PATH`（任意）

リバースプロキシがパスプレフィックスを付与する環境で使用します。

```bash
# .env.local
NEXT_PUBLIC_BASE_PATH=/proxy/3000
```

| 設定しない場合 | `http://localhost:3000/` で直接アクセスする通常開発環境        |
| -------------- | -------------------------------------------------------------- |
| 設定する場合   | code-server ポート転送（`/proxy/3000/`）などリバースプロキシ下 |

> **重要**: `NEXT_PUBLIC_BASE_PATH` のポート番号は、**dev サーバが実際に listen しているポート**（= リバースプロキシが転送するポート）と一致させること。例えばポート 3000 が塞がっていて dev が 3001 で起動した場合、`/proxy/3000` 固定のままだとページ内リンク・アドレスバーの「移動」が `/proxy/3000/...`（別ポート）へ飛び **404** になる。その場合は `.env.local` を `/proxy/3001` に直すか、ポート 3000 を空けて 3000 で起動する。

設定すると以下に反映されます。

- `next.config.ts` の `assetPrefix` — `_next/static/...` への HTML 参照パスにプレフィックスを付与
- `src/lib/proxy/rewrite.ts` — `/browse` / `/api/proxy` へのリンク書き換え時にプレフィックスを付与

詳細は [docs/arch/proxy.md §リバースプロキシ下でのパスプレフィックス](arch/proxy.md) を参照。

---

## 6. IDE 設定（推奨）

### VS Code

以下の拡張機能を入れると、ESLint と Prettier がエディタと連携します。

- [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint)
- [Prettier - Code formatter](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)

`.vscode/settings.json` に以下を追加すると保存時に自動フォーマットが走ります。

```json
{
  "editor.formatOnSave": true,
  "editor.defaultFormatter": "esbenp.prettier-vscode",
  "editor.codeActionsOnSave": {
    "source.fixAll.eslint": "explicit"
  }
}
```

---

## 7. よくあるトラブル

### `npm install` が失敗する

Node.js のバージョンを確認してください。Node.js 18 未満では動作しません。

```bash
node --version   # v18.0.0 以上であること
```

### ポート 3000 が使用中

別プロセスがポートを占有している場合、別ポートで起動できます。

```bash
npm run dev -- --port 3001
```

ただし `NEXT_PUBLIC_BASE_PATH` を設定している場合は、**そのポート番号も合わせて変更する**こと（例 `NEXT_PUBLIC_BASE_PATH=/proxy/3001`）。ポートと BASE_PATH が食い違うと、リンクやアドレスバーの「移動」が別ポートへ飛んで 404 になる（[§5 NEXT_PUBLIC_BASE_PATH](#next_public_base_path任意) の注記参照）。占有プロセスを止めて 3000 で起動し直すのが最も簡単。

```bash
# 3000 を占有しているプロセスを確認して停止する例
ss -ltnp | grep :3000
```

### TypeScript エラーが出る

`next-env.d.ts` が生成されていない場合は、一度 `npm run build` または `npm run dev` を実行してください（Next.js が自動生成します）。

---

## 8. ヘッドレスブラウザでのデバッグ（方式B）

プロキシの描画を確認・デバッグする手段は 2 系統あります。

| 経路              | 利用者                  | 概要                                                                                                                                       |
| ----------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 方式A: 実ブラウザ | 人間                    | code-server のポート転送 `/proxy/3000/` を実ブラウザで開き、F12 DevTools でデバッグ（[§5](#5-環境変数) の `NEXT_PUBLIC_BASE_PATH` が前提） |
| 方式B: ヘッドレス | Claude 等（コンテナ内） | Playwright headless chromium で `http://localhost:3000` 経由ページを開き、各種記録を取得                                                   |

方式A は追加設定不要で最も確実です。コンテナ内から（実ブラウザを使わずに）描画後の状態・console エラー・network を機械的に取得したい場合に方式B を使います。とくに JS 実行後にしか再現しない不具合（例: リダイレクトループ）の調査に有効です。

### 8.1 セットアップ（初回のみ）

`playwright` は devDependency に含まれるため `npm install` で入りますが、chromium 本体は別途ダウンロードが必要です。

```bash
# chromium 本体 + 実行に必要な OS 依存ライブラリを取得（--with-deps は root/sudo 権限が必要）
npx playwright install --with-deps chromium
```

### 8.2 実行

dev サーバを起動した状態で実行します（方式B はサーバ起動済みを前提とします）。

```bash
# 別ターミナルで dev サーバを起動しておく
npm run dev

# プロキシ対象サイトを開く（http(s):// 始まりは自動で /browse?url= 経由になる）
npm run debug:browser -- https://example.com

# dev サーバ上のパスを直接開く（/ トップや /browse?url=... を指定）
npm run debug:browser -- /
npm run debug:browser -- '/browse?url=https://example.com'
```

実行ごとに `scripts/.debug-out/<timestamp>/` へ以下を出力します（このディレクトリは `.gitignore` 済み）。

| ファイル         | 内容                                      |
| ---------------- | ----------------------------------------- |
| `screenshot.png` | 描画後ページのフルスクリーンショット      |
| `console.log`    | console 出力・ページエラー                |
| `network.json`   | リクエスト / レスポンス（ステータス含む） |
| `page.html`      | 描画後の HTML                             |

| 環境変数                | 既定値                  | 用途                                     |
| ----------------------- | ----------------------- | ---------------------------------------- |
| `DEBUG_BROWSER_ORIGIN`  | `http://localhost:3000` | dev サーバの接続先。ポート変更時に上書き |
| `DEBUG_BROWSER_WAIT_MS` | `1500`                  | 読み込み後に状態取得まで待つミリ秒       |

> dev サーバを 3000 以外で起動した場合は `DEBUG_BROWSER_ORIGIN=http://localhost:3001 npm run debug:browser -- ...` のように接続先を合わせること。
