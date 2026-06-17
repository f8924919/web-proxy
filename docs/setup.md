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

| 設定しない場合 | `http://localhost:3000/` で直接アクセスする通常開発環境 |
| -------------- | ------------------------------------------------------- |
| 設定する場合   | code-server ポート転送（`/proxy/3000/`）などリバースプロキシ下 |

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

### TypeScript エラーが出る

`next-env.d.ts` が生成されていない場合は、一度 `npm run build` または `npm run dev` を実行してください（Next.js が自動生成します）。
