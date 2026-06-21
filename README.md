# web-proxy

[proxyium.com](https://proxyium.com/ja/) を参考にした Web ベースのプロキシサービスです。ブラウザで URL を入力すると、サーバーがターゲットサイトへリクエストを中継し、レスポンスを書き換えて返します。アクセス制限のある環境からでも外部 Web サイトを閲覧できることを主目的としています。

Next.js 15（App Router）製。React を介さない Route Handler（`/browse`・`/api/proxy`）で生レスポンスを中継します。

## 主な機能

- **プロキシ中継**: URL 入力フォームからターゲットへ中継（GET / フォーム POST）。リダイレクトは `redirect: "manual"` で自前追従し、クロスオリジンの認証情報漏えいを防ぐ。
- **HTML / CSS 書き換え**: リンク・フォーム・アセット URL をプロキシ経由（`/browse` / `/api/proxy`）に変換。SRI 属性除去・inline CSP 除去・`<meta refresh>` 書き換えを含む。
- **Service Worker による実行時横取り**: ページ内 JS が発行するサブリクエスト（ナビゲーション以外）を `/api/proxy` へ振り向け、同一オリジン化で CORS プリフライトを抑止。
- **クライアント側ナビゲーション横取り**: GET フォーム送信・`<a>` クリック（SPA ルーターの横取りを阻止してフルナビゲーション化）をプロキシ経由に補正。
- **サイト間 Cookie アイソレーション**: Cookie をターゲット origin 単位でスコープ化し、サイト間の混在・漏えいを防止。
- **SSRF 対策 / レート制限**: 解決後 IP のブロックリスト照合（ループバック・プライベート・メタデータ等）。ページ / アセットを別バケットでレート制限。
- **ナビゲーションループ検出**: enablejs 等の自己再ナビ無限ループを検出し、案内ページで打ち切り。
- **ブラウザバック中継（browser-backed fetch）**: 特定サイトの初回ナビゲーションをヘッドレスブラウザ（Playwright）で実行し、JS 解決後の DOM を返す。崩れ/チャレンジ検出による自動ティア昇格・Cookie ウォーミング付き。実行基盤は env で自前 Chromium / 外部 CDP サービスを切替可能。
- **アンチボット最小対策**: 上流プロキシ（residential / クリーン IP）経由・軽量 stealth（突破は保証しない。詳細は [docs/setup.md §9.4](docs/setup.md)）。

## 動作環境

| 項目                 | 要件                                                                   |
| -------------------- | ---------------------------------------------------------------------- |
| OS                   | Linux / macOS / Windows                                                |
| ランタイム           | Node.js 18 以上（推奨 22）                                             |
| ブラウザ中継（任意） | Chromium（`npx playwright install chromium`、または外部 CDP サービス） |

## クイックスタート（開発）

```bash
npm install
npm run dev      # http://localhost:3000
```

リバースプロキシ（code-server のポート転送など）配下で動かす場合は `NEXT_PUBLIC_BASE_PATH` を設定します（下記）。

## 主要コマンド

| コマンド                | 内容                                        |
| ----------------------- | ------------------------------------------- |
| `npm run dev`           | 開発サーバー起動（ホットリロード）          |
| `npm run build`         | 本番ビルド（`.next/` に出力）               |
| `npm start`             | ビルド済みアプリを起動（`next start`）      |
| `npm run lint`          | ESLint（`lint:fix` で自動修正）             |
| `npm run format`        | Prettier 整形（`format:check` で確認）      |
| `npm run typecheck`     | 型チェック（`tsc --noEmit`）                |
| `npm test`              | Jest テスト（`test:watch` で監視）          |
| `npm run debug:browser` | ヘッドレスブラウザでの描画デバッグ（方式B） |

## 環境変数

サーバー専用 env（`NEXT_PUBLIC_` 接頭辞なし）は `.env.local`（開発）やオーケストレータのシークレット機構（本番）で渡します。`.env.local` はコミットされません。**未設定なら従来どおりの通常中継**で動作し、既定挙動は変わりません。

| 環境変数                        | 既定      | 用途                                                                         |
| ------------------------------- | --------- | ---------------------------------------------------------------------------- |
| `NEXT_PUBLIC_BASE_PATH`         | （空）    | リバースプロキシのパスプレフィックス（例 `/proxy/3000`）。**ビルド時に確定** |
| `PROXY_USER_AGENT`              | Chrome UA | ターゲットへ送る既定 User-Agent の上書き                                     |
| `PROXY_BROWSER_MODE`            | `off`     | ブラウザバック中継: `off` / `allowlist` / `on`                               |
| `PROXY_BROWSER_HOSTS`           | （空）    | `allowlist` 対象ホスト接尾辞（カンマ区切り）                                 |
| `PROXY_BROWSER_AUTO_PROMOTE`    | `false`   | 崩れ/チャレンジ検出による自動ブラウザ昇格（#70）                             |
| `PROXY_BROWSER_WAIT_UNTIL`      | `load`    | `page.goto` 待機戦略                                                         |
| `PROXY_BROWSER_TIMEOUT_MS`      | `15000`   | ナビゲーションのタイムアウト（ms）                                           |
| `PROXY_BROWSER_SETTLE_MS`       | `1500`    | DOM 取得前の追加待ち（ms）                                                   |
| `PROXY_BROWSER_MAX_CONCURRENCY` | `2`       | 同時起動 context の上限                                                      |
| `PROXY_BROWSER_CDP_URL`         | （空）    | 設定すると外部ブラウザサービスへ CDP 接続（#71）。空なら自前 Chromium 起動   |
| `PROXY_BROWSER_PROXY_SERVER`    | （空）    | 自前ブラウザの上流プロキシ（residential / クリーン IP。#73）                 |
| `PROXY_BROWSER_PROXY_USERNAME`  | （空）    | 上流プロキシのユーザー名（任意）                                             |
| `PROXY_BROWSER_PROXY_PASSWORD`  | （空）    | 上流プロキシのパスワード（任意・シークレット）                               |

> `NEXT_PUBLIC_BASE_PATH` はアセットの `assetPrefix`（`next.config.mjs`）に効くため**ビルド時に確定**する必要があります。リバースプロキシ配下でアセットが 404 になる場合はこの値を確認してください。詳細は [docs/setup.md §5](docs/setup.md)。

## Docker での実行

Chromium と OS 依存を同梱する Playwright 公式イメージをベースにした `Dockerfile` を用意しています。

```bash
docker build -t web-proxy .
docker run -p 3000:3000 \
  -e PROXY_BROWSER_MODE=allowlist \
  -e PROXY_BROWSER_HOSTS=example.com \
  web-proxy
```

### Docker Compose

```bash
docker compose up --build -d   # 起動
docker compose logs -f         # ログ
docker compose down            # 停止
```

`docker-compose.yml` に主要な env をコメント付きで記載しています。用途に応じてコメントを外して設定してください。

- **外部ブラウザサービス利用時**は `PROXY_BROWSER_CDP_URL` を設定すれば Chromium 同梱は不要になり、より軽量な Node イメージへ差し替え可能です。
- **シークレット**（CDP URL のトークン・プロキシのパスワード等）は compose に直書きせず `.env` / シークレット機構で渡してください。
- 詳細・採用方針・本番想定値・法的留意は [docs/setup.md §9](docs/setup.md) を参照。

## 詳細ドキュメント

| ドキュメント                                 | 内容                                         |
| -------------------------------------------- | -------------------------------------------- |
| [docs/setup.md](docs/setup.md)               | 環境構築・env・Docker/本番デプロイ・デバッグ |
| [docs/spec/](docs/spec/)                     | 動作仕様・画面仕様                           |
| [docs/arch/](docs/arch/)                     | モジュール実装の詳細                         |
| [docs/git-workflow.md](docs/git-workflow.md) | ブランチ運用・Issue ベース開発・PR ルール    |
| [docs/testing/](docs/testing/)               | テスト方針・実行コマンド                     |
| [docs/task/](docs/task/)                     | タスクの進捗管理                             |
