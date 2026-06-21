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

### ブラウザバック中継（browser-backed fetch・任意）

特定サイトの `/browse` GET をヘッドレスブラウザ（インプロセス Playwright）で中継し、JS 解決後の DOM を返す機能のサーバー専用 env（いずれも `NEXT_PUBLIC_` なし）。**未設定なら常に通常の中継（`proxyFetch`）で、既定挙動は変わりません**。仕様は [docs/spec/features/proxy.md §ブラウザバック中継](spec/features/proxy.md#ブラウザバック中継browser-backed-fetch)。

| 環境変数                        | 既定値        | 用途                                                                                                                                        |
| ------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `PROXY_BROWSER_MODE`            | `off`※        | `off`（常に通常中継）/ `allowlist`（host 一致時のみブラウザ）/ `on`（常にブラウザ）。※未設定で `PROXY_BROWSER_HOSTS` が非空なら `allowlist` |
| `PROXY_BROWSER_HOSTS`           | （空）        | カンマ区切りのホスト接尾辞リスト。`example.com` は `example.com` と `*.example.com` に一致                                                  |
| `PROXY_BROWSER_WAIT_UNTIL`      | `load`        | `page.goto` の待機戦略。`load` / `domcontentloaded` / `networkidle` / `commit`                                                              |
| `PROXY_BROWSER_TIMEOUT_MS`      | `15000`       | `page.goto` のタイムアウト（ミリ秒）                                                                                                        |
| `PROXY_BROWSER_SETTLE_MS`       | `1500`        | 読み込み後に DOM 取得まで待つ追加ミリ秒（JS の落ち着き待ち）                                                                                |
| `PROXY_BROWSER_MAX_CONCURRENCY` | `2`           | 同時に起動するブラウザ context の上限                                                                                                       |
| `PROXY_USER_AGENT`              | （Chrome UA） | ブラウザ・通常中継の双方でターゲットへ送る既定 User-Agent を上書き                                                                          |

> **前提（Chromium バイナリ）**: 本機能はブラウザ起動に Chromium 本体を要するため、`npx playwright install chromium`（必要に応じ `--with-deps`、[§8.1](#81-セットアップ初回のみ) と同じ）を事前に実行しておくこと。Playwright は現状 devDependency のため、本番でブラウザ中継を使う場合は依存の昇格と RAM・起動コストの考慮が要る（本番実行基盤の決定は [#71](https://github.com/f8924919/web-proxy/issues/71)）。

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

| 環境変数                   | 既定値                                  | 用途                                                                                   |
| -------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------- |
| `DEBUG_BROWSER_ORIGIN`     | `http://localhost:3000`                 | dev サーバの接続先。ポート変更時に上書き                                               |
| `DEBUG_BROWSER_WAIT_MS`    | `1500`                                  | 読み込み後に状態取得まで待つミリ秒                                                     |
| `DEBUG_BROWSER_WAIT_UNTIL` | `load`                                  | `page.goto` の待機戦略（§8.4）。`load` / `domcontentloaded` / `networkidle` / `commit` |
| `DEBUG_BROWSER_TIMEOUT_MS` | `30000`                                 | `page.goto` のタイムアウト（ミリ秒）。重いサイトでは延長して使う                       |
| `DEBUG_BROWSER_BASE_PATH`  | `.env.local` の `NEXT_PUBLIC_BASE_PATH` | 方式B が再現する BASE_PATH（§8.3）。通常は指定不要（`.env.local` を読む）              |

> dev サーバを 3000 以外で起動した場合は `DEBUG_BROWSER_ORIGIN=http://localhost:3001 npm run debug:browser -- ...` のように接続先を合わせること。

> `page.goto` がタイムアウトしても、収集済みの最終 URL・スクリーンショット・console・network・HTML を**可能な範囲で出力**する（タイムアウト＝全損にしない）。出力後に終了コード `2` で終わるため、結果は確認できる。dev サーバ未起動などページ取得自体が成立しない場合は出力が空に近くなる。

### 8.3 BASE_PATH（リバースプロキシ）の再現（#34）

方式A は code-server のポート転送（`/proxy/3000/`）越しに実ブラウザで開くため、リバースプロキシが先頭の `/proxy/3000` を除去してから dev サーバへ転送する。一方、方式B は `http://localhost:3000` を直叩きするためこのプレフィックス除去を経由しない。そのまま `/proxy/3000/sw.js` 等の BASE_PATH 付きパスを取得すると dev サーバで **404** になる（[§5](#5-環境変数) の `NEXT_PUBLIC_BASE_PATH` 参照）。

このため `debug:browser` は方式A を次のように再現する。

1. `.env.local` の `NEXT_PUBLIC_BASE_PATH` を読み、方式A と同じく **プレフィックス込みの URL**（例 `…/proxy/3000/browse?url=…`）でページを開く。これにより Service Worker のスコープ（`${BASE_PATH}/`）がページを覆い、ページ内リンク・サブリソースも方式A と同じパスで解決される。
2. 同一オリジンへの BASE_PATH 付きリクエストを Playwright の `route` で横取りし、**プレフィックスを除去**して dev サーバへ中継する（リバースプロキシの肩代わり）。Service Worker スクリプトの取得も対象。

通常は `.env.local` を正本に自動解決するため設定不要。一時的に上書きしたい場合のみ `DEBUG_BROWSER_BASE_PATH` を使う（dev サーバ側の `NEXT_PUBLIC_BASE_PATH` と一致させること。食い違うと SW 登録などが 404 になる）。

### 8.4 待機戦略（waitUntil）とタイムアウト（#39）

`page.goto` の待機戦略は `DEBUG_BROWSER_WAIT_UNTIL` で切り替える。既定は `load`。

| 値                 | 完了条件                   | 使い分け                                                                       |
| ------------------ | -------------------------- | ------------------------------------------------------------------------------ |
| `load`（既定）     | `load` イベント発火        | 主要リソース読み込み後に確認。重いサイトでも完走しやすく、汎用的に使える       |
| `domcontentloaded` | DOM 構築完了               | 最速。リダイレクトの有無だけ確認したいときなど。画像等が未取得のことがある     |
| `networkidle`      | ネットワークが概ねアイドル | 遅延描画まで待ちたいとき。広告・計測で常時通信が走るサイトでは到達せず時間切れ |
| `commit`           | レスポンス受信・遷移確定   | 最終 URL（リダイレクト先）だけ早く知りたいとき                                 |

広告・計測・ストリーミング等で**常時通信が走るサイト**（例: `news.yahoo.co.jp`）は `networkidle` に到達せずタイムアウトする。既定を `load` にしているのはこのためで、`load` 到達後に `DEBUG_BROWSER_WAIT_MS`（既定 1500ms）だけ追加で待ち、JS 実行（リダイレクト等）の落ち着きを拾う。

タイムアウトは `DEBUG_BROWSER_TIMEOUT_MS`（既定 30000ms）で調整する。それでも時間切れになる場合でも、収集済みの結果はベストエフォートで出力される（§8.2 の注記）。

```bash
# 重いサイトを domcontentloaded 起点・タイムアウト延長で開く例
DEBUG_BROWSER_WAIT_UNTIL=domcontentloaded DEBUG_BROWSER_TIMEOUT_MS=60000 \
  npm run debug:browser -- https://news.yahoo.co.jp/categories/science
```
