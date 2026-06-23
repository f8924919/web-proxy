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

- `next.config.mjs` の `assetPrefix` — `_next/static/...` への HTML 参照パスにプレフィックスを付与
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
| `PROXY_BROWSER_CDP_URL`         | （空）        | 設定すると `chromium.launch()` の代わりに外部ブラウザサービスへ `connectOverCDP` で接続（#71）。空なら自前 Chromium をインプロセス起動      |
| `PROXY_BROWSER_PROXY_SERVER`    | （空）        | 自前ブラウザの上流プロキシ（例 `http://host:port` / `socks5://host:port`）。residential / クリーン IP を通す（#73）。空なら直アクセス       |
| `PROXY_BROWSER_PROXY_USERNAME`  | （空）        | 上流プロキシのユーザー名（任意）                                                                                                            |
| `PROXY_BROWSER_PROXY_PASSWORD`  | （空）        | 上流プロキシのパスワード（任意・シークレット）                                                                                              |
| `PROXY_USER_AGENT`              | （Chrome UA） | ブラウザ・通常中継の双方でターゲットへ送る既定 User-Agent を上書き                                                                          |

> **前提（Chromium バイナリ）**: 自前 Chromium で起動する場合（`PROXY_BROWSER_CDP_URL` 未設定）は Chromium 本体が必要なため、`npx playwright install chromium`（必要に応じ `--with-deps`、[§8.1](#81-セットアップ初回のみ) と同じ）を事前に実行しておくこと。`PROXY_BROWSER_CDP_URL` を設定して外部サービスへ接続する場合は Chromium 本体は不要。本番デプロイ（コンテナ・依存・シークレット）は [§9](#9-本番デプロイブラウザ実行基盤71) を参照。

### レート制限のクライアント IP 特定（信頼ヘッダー・任意だが本番で推奨）

レート制限・ナビゲーションループ検出のバケットキーに使うクライアント IP の信頼元を制御するサーバー専用 env（`NEXT_PUBLIC_` なし）。仕様は [docs/spec/features/proxy.md §クライアント IP の特定](spec/features/proxy.md#クライアント-ip-の特定信頼ヘッダーの明示設定132)。

| 環境変数                  | 既定値 | 用途                                                                                                                                                                                                     |
| ------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PROXY_TRUSTED_IP_HEADER` | （空） | 信頼するクライアント IP ヘッダー名を 1 つ指定（例 `cf-connecting-ip` / `x-real-ip` / `x-forwarded-for`）。前段の信頼プロキシが必ず上書きするヘッダーを設定する。`x-forwarded-for` 指定時は最右の値を採用 |

> **未設定時の挙動（fail-safe）**: 未設定だと転送ヘッダーを一切信頼せず、全クライアントが**単一のグローバルバケット**でレート制限を共有します（IP 詐称による回避は防げますが、個別レート制限は効きません）。本番では前段プロキシ構成に応じて必ず設定してください。接続元 TCP IP は Next.js 15 の `next start` 構成では取得できないため、信頼ヘッダーの明示設定が個別制限の前提になります。

### 中継本文のサイズ上限（メモリ枯渇 DoS 対策・任意）

書き換えのため全量メモリ展開する HTML / CSS の中継本文に上限を設けるサーバー専用 env（`NEXT_PUBLIC_` なし）。仕様は [docs/spec/features/proxy.md §中継本文のサイズ上限](spec/features/proxy.md#中継本文のサイズ上限メモリ枯渇-dos-対策134)。

| 環境変数                 | 既定値              | 用途                                                                                                                                                        |
| ------------------------ | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PROXY_MAX_BUFFER_BYTES` | `10485760`（10MiB） | HTML / CSS 本文の全量バッファ上限（バイト）。超過時は本文を打ち切り `413` を返す。正の整数以外・未設定は既定値。画像・JS 等のストリーム透過アセットは対象外 |

### エラーログのレベル制御（機微 URL マスキング・任意）

中継の異常系ログ（`console.error`）の出力量を制御するサーバー専用 env（`NEXT_PUBLIC_` なし）。閲覧先 URL・ホスト・IP はログ出力前に常時 redact される（レベルに依らず）。仕様は [docs/spec/features/proxy.md §エラーログとプライバシー](spec/features/proxy.md#エラーログとプライバシー機微-url-のマスキング138)。

| 環境変数          | 既定値  | 用途                                                                                                                                                                             |
| ----------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PROXY_LOG_LEVEL` | `error` | ログ出力レベル。`silent`（無出力）/ `error` / `warn` / `info` / `debug`（スタックトレース付き）。未設定・未知値は `error`。機微 URL/ホスト/IP の redact はレベルに依らず常時適用 |

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

---

## 9. 本番デプロイ（ブラウザ実行基盤・#71）

ブラウザバック中継（[§5](#ブラウザバック中継browser-backed-fetch任意)）を本番で使う場合のブラウザ実行基盤を定める。`browserFetch` の**インターフェースは不変**で、バックエンドだけを env で差し替える（接合点は `getBrowser()` の 1 関数）。仕様は [spec §ブラウザ実行基盤](spec/features/proxy.md#ブラウザ実行基盤バックエンドの差し替え71)、実装は [arch §ブラウザ実行基盤の差し替え](arch/proxy.md#ブラウザ実行基盤の差し替え純粋関数--getbrowser71)。

### 9.1 採用方針（比較と決定）

| 観点                 | 自前 Chromium 同梱（既定）                 | 外部ブラウザサービス（CDP 接続）                                          |
| -------------------- | ------------------------------------------ | ------------------------------------------------------------------------- |
| 選択方法             | `PROXY_BROWSER_CDP_URL` 未設定             | `PROXY_BROWSER_CDP_URL` を CDP/WS エンドポイントに設定                    |
| コスト               | 無課金（自前資源）                         | 従量/月額課金（小〜中規模なら無料枠〜数十ドル/月）                        |
| 運用                 | RAM・Chromium 更新・クラッシュ復帰を自前で | 資源・更新は外部任せ。API キー/シークレット管理とネットワーク依存が増える |
| stealth/アンチボット | 標準ヘッドレス（突破力は低い）             | 指紋偽装・CAPTCHA 解決等を備える製品あり                                  |
| egress IP（#73）     | **サーバー IP のまま（#73 未解決）**       | residential/クリーン IP を持つ製品なら **#73 にも有効**                   |
| レイテンシ           | ローカル起動分のみ                         | 外部往復が加わる                                                          |

**決定**: 既定は**自前 Chromium 同梱（コンテナ）**。自己完結・無課金で、コンテナ（VPS/クラウド）デプロイ前提に合致する。**egress IP（[#73](https://github.com/f8924919/web-proxy/issues/73)）やアンチボット突破が要件になったときのみ**、`PROXY_BROWSER_CDP_URL` でクリーン IP を持つ外部 CDP サービスへ切り替える（コード変更不要）。

外部サービスは `connectOverCDP` 互換であれば差し替え可能。代表例（採用時に最新の料金・条件を要確認）:

| サービス                     | 接続               | 向き                                                              |
| ---------------------------- | ------------------ | ----------------------------------------------------------------- |
| Browserless                  | 直接 WS/CDP        | 最も素直に `connectOverCDP`。無料枠あり・資源offloadに手軽        |
| Browserbase                  | Sessions API → CDP | CAPTCHA 解決込み。セッション生成の一手間あり                      |
| Cloudflare Browser Rendering | CDP                | Workers 利用時に低レート                                          |
| Bright Data Scraping Browser | CDP                | **residential IP・指紋偽装・CAPTCHA**。#73 重視ならこれ。帯域課金 |

### 9.2 コンテナデプロイ（自前 Chromium）

Playwright は本番でブラウザ中継を使うため **devDependency → dependency へ昇格**済み。コンテナは Chromium と OS 依存を同梱する Playwright 公式イメージ（タグは `package.json` の `playwright` と一致させる）を用いる。リポジトリの `Dockerfile` を使う。

```bash
docker build -t web-proxy .
docker run -p 3000:3000 \
  -e PROXY_BROWSER_MODE=allowlist \
  -e PROXY_BROWSER_HOSTS=example.com \
  web-proxy
```

- **本番想定値**: `PROXY_BROWSER_MAX_CONCURRENCY` は RAM に合わせて設定する（Chromium は 1 context あたり数百 MB 目安。既定 2 は小規模向け）。`PROXY_BROWSER_TIMEOUT_MS`（既定 15000）/ `PROXY_BROWSER_SETTLE_MS`（既定 1500）はターゲット特性に合わせ調整。context はリクエスト単位で確実に close し、ブラウザはプロセス内で再利用・切断時は自動再接続する（リーク防止）。
- 外部サービスを使う場合は Chromium 同梱が不要になるため、より軽量な Node イメージ + `PROXY_BROWSER_CDP_URL` でも運用できる（その場合 `npx playwright install` は不要）。
- **sandbox（自前 Chromium）**: Playwright 公式イメージはそのまま Chromium sandbox 込みで動作する想定。root 実行や権限制約のあるコンテナで起動に失敗する場合は、適切な seccomp/capabilities を付与するか、公式イメージ推奨の実行方法（非 root `pwuser` で実行）に従うこと。

### 9.3 シークレット（外部サービス利用時）

- `PROXY_BROWSER_CDP_URL` には API キー/トークンを**クエリやベーシック認証として URL に含める**形が多い（例: `wss://chrome.browserless.io?token=<KEY>`、Bright Data は `wss://<user>:<pass>@...`）。**シークレットとして注入**し、リポジトリにコミットしない（`.env.local` はコミット対象外、本番はオーケストレータのシークレット機構で渡す）。
- ログに URL 全体を出さない（トークン漏えい防止）。`browserFetch` はエラー時もエンドポイント全文を出力しない。
- `PROXY_BROWSER_PROXY_PASSWORD` も同様にシークレットとして注入する。

### 9.4 アンチボット対策（egress IP / stealth・#73）

> 仕様は [spec §アンチボット対策](spec/features/proxy.md#アンチボット対策egress-ip--stealth73)。**ヘッドレス化＝アンチボット突破ではない**。実用阻害の主因は **egress IP レピュテーション**（データセンター IP は Google 等の no-JS / bot 判定で支配的に弾かれる。#52 の調査結論）で、次いでヘッドレス検出。

#### egress IP（クリーン IP の通し方）

| 方式                        | 設定                                                | 向き・コスト                                                            |
| --------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------- |
| 自前ブラウザ + 上流プロキシ | `PROXY_BROWSER_PROXY_SERVER`（+ USERNAME/PASSWORD） | 自前 Chromium のまま residential / クリーン IP を通す。プロキシ課金のみ |
| 外部ブラウザサービス（CDP） | `PROXY_BROWSER_CDP_URL`（§9.1）                     | IP プール・stealth ごと外部へ委譲。Bright Data 等は residential IP 内蔵 |

- residential プロキシ例: Bright Data / Oxylabs / Smartproxy 等（帯域/IP 数課金）。データセンタープロキシは安価だが bot 判定で弾かれやすく、Google 等には residential が要る。
- どちらも**規約・法令順守はデプロイ運用者の責任**。対象サイトの利用規約、residential プロキシ事業者の利用規約・取得元 IP の正当性を確認すること。

#### stealth（ヘッドレス検出回避・組み込み軽量）

- 自前 `chromium.launch()` に `--disable-blink-features=AutomationControlled` を付与し、全 context へ `navigator.webdriver` を隠す init script を注入する（依存追加なし）。単純なヘッドレス判定を緩和するが、**網羅的な突破は保証しない**。
- 網羅的 stealth（playwright-extra/stealth 相当）は **導入しない**（egress IP が支配的で費用対効果が低い）。より強い stealth が要る場合は外部ブラウザサービス（実ブラウザ系・指紋偽装込み）に委ねる。

#### Google 検索での実測（未実施・キー入手後）

egress IP の質に依存するため、実測は residential IP を持つ外部サービス/プロキシのアカウント・キー入手後に行う。手順:

1. クリーン IP を設定（`PROXY_BROWSER_PROXY_SERVER`=residential プロキシ、または `PROXY_BROWSER_CDP_URL`=residential IP 内蔵サービス）。
2. `PROXY_BROWSER_MODE=allowlist` / `PROXY_BROWSER_HOSTS=google.com` でブラウザティアを有効化。
3. `npm run debug:browser -- 'https://www.google.com/search?q=test'` または proxy 経由で実アクセスし、`/sorry/`（reCAPTCHA）・enablejs ループに落ちずに結果が出るかを確認。
4. 結果（通る / 通らない・どの IP 種別で）を `docs/task/archive/73-*.md` か後続メモに記録する。
