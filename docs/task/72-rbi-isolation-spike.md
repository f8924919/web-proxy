# #72 調査スパイク: RBI（リモートブラウザ分離・画面ストリーミング）方式の技術評価

- **Issue**: [#72](https://github.com/f8924919/web-proxy/issues/72)
- **ブランチ**: `docs/rbi-isolation-spike`
- **ステータス**: 進行中（調査完了・採用可否はユーザー判断待ち）
- **種別**: 調査スパイク（実装なし。成果物は本メモの比較表＋採用判断）
- **関連**: 前段の現実解 #69（ブラウザバック中継）/ アンチボット #73 / 本番基盤 #71 / 既存調査 #52（Google enablejs ループ）
- **調査日**: 2026-06-22

> 確度凡例: **【一次】** 公式 docs / 価格ページ / 特許, **【二次】** ベンダー解説・第三者記事, **【推定】** 一般値からの試算, **【自社】** 本リポジトリのコード／docs 裏取り。

---

## 結論（採用判断のためのサマリ）

- **全面 RBI 化は非推奨**。proxyium 型の「常時接続・大量・匿名・日本語ユーザ」というトラフィック特性に対し、(1) ピクセルストリーミングの帯域（5〜20Mbps/セッション × 同時数で egress 転送費が支配的）、(2) 商用 SaaS の user/browser-hour/分課金がトラフィック特性と不一致、(3) 日本語 IME の忠実度作り込みコスト、(4) ステートレス Next.js → ステートフルなリアルタイムメディアクラスタへの質的なアーキテクチャ転換、の 4 点で割に合わない。
- **採用するなら「ハイブリッドの段階導入」一択**。現行の書き換え方式（`rewrite.ts` / `sw.js` / `browserFetch.ts`）を基盤に据え、**書き換えで壊れる/ブロックされる特定サイトのみ RBI 経路へフォールバック**する。これは #73 の「Google は egress IP 質に可否が支配される（residential / 外部 CDP が必要）」という実証結果とも棲み分けが整合する。
- **段階導入の接合点は既に存在する**。#71 で導入済みの `getBrowser()` / `browserBackendFromEnv()`（CDP 切り替え）と `shouldUseBrowser`（allowlist ティア判定）が、RBI 経路を疎結合に差し込む自然なシームになる。現行 Next.js を壊さず PoC 可能。
- **推奨 PoC**: Kasm Workspaces（Community 同時 5）または Neko（OSS）を自前ホストで、対象 1〜数サイト・同時 10 セッション規模に限定して検証。検証項目は (a) 日本語 IME パススルー可否、(b) 帯域・サーバ実測、(c) ハイブリッド振り分けロジック。商用での少量・短期検証なら Hyperbeam（埋め込み API が用途に最も近く 10,000 分/月無料）が低リスク。

> **採用可否（やる / やらない / どの段階まで）はユーザー判断**。本メモは判断材料の提示であり、決定後にステータスを更新する。

---

## 1. ストリーミング方式の比較（受け入れ条件 1）

RBI には大きく 3 系統。現行 web-proxy（サーバ側で HTML/JS を書き換え、ユーザのブラウザで再実行）は下表の「DOM ミラー」に近い互換性プロファイルを持つ（サニタイズではなく中継書き換えである点が異なる）。

| 軸 | ピクセル（WebRTC/VNC） | DOM ミラー | NVR（Cloudflare 専用） |
| --- | --- | --- | --- |
| 仕組み | リモートで完全ブラウザ実行→映像エンコード配信、入力のみ逆送 | リモート DOM をサニタイズ→ローカルで再構築・再実行 | Skia 描画コマンドを傍受・トークン化・圧縮→ローカル再描画（特許 US10452868B1） |
| 帯域 | 重い **5〜20Mbps/セッション**（WebRTC 1080p で 3〜6Mbps） | 軽い | 軽〜中（ピクセルより大幅に軽い） |
| 互換性 | 最高（WebGL/動画/Canvas が本物の Chromium で動く） | 最弱（動的コンテンツに弱く「壊れたページ」が出る）【一次: Cloudflare】 | 高（DOM 再構築の弱点を回避と主張）【一次】 |
| 遅延 | 中（入力往復 50〜200ms。local echo で緩和） | 低 | 中 |
| 分離度（セキュリティ） | 最高（Web コードがエンドポイントに届かない） | 中（第三者コードをローカル再実行） | 高 |
| 自前実装容易性 | 中（OSS あり: Neko 等） | 中 | **不可**（Cloudflare 専用特許） |

> **web-proxy への示唆**: 現行書き換え方式は DOM ミラーと同じ互換性の壁（SPA / WebGL / 厳格 CSP/CORS / 強アンチボット）に直面する。RBI を入れる動機は主に**互換性の底上げ**で、その場合はピクセル方式（自前 OSS）か Cloudflare/Hyperbeam 等の WebRTC/NVR を使うことになる。【二次/自社】

---

## 2. OSS / 商用サービスの評価（受け入れ条件 2）

| サービス | 方式 | 自前ホスト | 課金体系 | API/CDP | 推奨度・所感 |
| --- | --- | --- | --- | --- | --- |
| **Cloudflare Browser Isolation** | NVR | 不可（SaaS） | ZT $7/user・月 + RBI add-on（~$10/user・月の非公式値）【二次】 | 人間ブラウジング向け。自動化は別製品 Browser Rendering | △ user 課金が匿名大量トラフィックと不一致 |
| **Browserbase** | ヘッドレス+CDP | **不可**（公式価格ページが self-host を否定。一部二次情報は誤り）【一次】 | $20/月25並列〜$99/月100並列、超過 $0.10〜0.12/browser-hr | Playwright/Puppeteer/Selenium 完全対応 | × 人間向け画面 proxy ではなく自動化基盤 |
| **Hyperbeam** | WebRTC ピクセル | 不可（SaaS） | 参加者×分、10,000 分/月無料、分単価は要問い合わせ【二次】 | REST + npm SDK（埋め込み上位 API） | ○ 「サイトに仮想ブラウザを埋め込む」用途に最も近い。少量検証向き |
| **Kasm Workspaces** | コンテナ + KasmVNC（ピクセル系） | **可（自前ホスト本命）** | Community 無料（**同時 5**）/ Enterprise $5/user・月〜 + 自前サーバ費【一次/二次】 | 開発者 API あり | ◎ 大量自前ホストの本命。運用は自前 |
| **browserless** | ヘッドレス+CDP | **可**（Docker、非商用無料） | Unit（30 秒）課金 / Scale $200/月〜 | CDP/Playwright/Puppeteer 完全対応 | △ 自動化基盤。画面配信は別途作り込み |
| **Neko（OSS）** | WebRTC ピクセル | **可** | 自前のみ・無料 | — | ○ Hyperbeam の自前ホスト代替 |
| **Apache Guacamole（OSS）** | VNC/RDP の Web 配信 | **可** | 無料 | — | 汎用リモートデスクトップ。ブラウザ専用ではないが転用可 |

> **示唆**: 商用 SaaS は「少数・自動化・短時間」には安いが、proxyium 型の常時接続・大量匿名トラフィックには課金モデルが致命的に合わない。大量化するなら自前ホスト（Kasm / Neko）が前提。

---

## 3. 資源コスト試算（受け入れ条件 3）

### 基礎データ（根拠）
- ヘッドレス Chromium 1 セッション RAM: コールド 50〜150MB、実用 **150〜300MB / 一般目安 300〜500MB**。【二次】
- CPU: 目安 **1 コア / 2〜3 セッション**。【二次】
- Kasm 実測サイジング: 8C/64GB→約 8、16C/64GB→最大 20、32C/128GB→最大 48（CPU オーバーサブスクライブ時）。デフォルト 2 CPU / 約 2.7GB/セッション。【一次: Kasm docs】
- 帯域（ピクセル方式）: **5〜20Mbps/セッション**（WebRTC 1080p で 3〜6Mbps）。【二次】

> 注: RBI（画面配信型）の 1 セッションは「ヘッドレス Chromium + 映像エンコード」で自動化用ヘッドレスより重い。Kasm 実測「2 CPU・約 2.7GB/セッション」を現実的単価として採る。

### 自前ホスト試算（ピクセル方式・Kasm 相当）

| 同時セッション | RAM 目安 | vCPU 目安 | 帯域（平均 8Mbps 想定） | サーバ感（クラウド概算） |
| --- | --- | --- | --- | --- |
| 10 | 約 30GB | 約 20 | 約 80Mbps | 中規模 1 台（16C/64GB クラス）。月 数百ドル【推定】 |
| 100 | 約 270GB | 約 200 | 約 0.8Gbps | 数〜十数台プール + LB。月 数千ドル + 転送量【推定】 |
| 1000 | 約 2.7TB | 約 2000 | 約 8Gbps（ピーク 20Gbps） | 数十〜百台クラスタ。月 数万ドル + **転送量が支配的**【推定】 |

- **転送量が効く**: 8Mbps × 1000 セッション × 1 時間 ≈ 3.6TB/時。クラウド egress 単価 $0.08〜0.09/GB 級だと転送費だけで時間あたり数百ドル規模になり得る。自前 IDC / 転送無料枠の大きいプロバイダ選定が要件。【推定】

### 商用サービス課金感
- **Cloudflare**: user 課金（匿名大量と不適合）。
- **Browserbase**: 1000 並列常時 ≈ 1000 × 720hr × $0.10 ≈ **$72,000/月** オーダー。【一次価格からの推定】
- **Hyperbeam**: 参加者×分で常時接続の大量ユーザは累積高額化。

---

## 4. 忠実度リスク評価: IME / DL・UP / クリップボード（受け入れ条件 4）

| 機能 | ピクセル方式 | DOM ミラー | NVR | 作り込みコスト |
| --- | --- | --- | --- | --- |
| **日本語 IME 入力** | 高リスク。リモート IME 変換は候補ウィンドウ遅延・誤配置・取りこぼし。**ローカル変換確定文字列のみ送る**実装（IME パススルー）が必須【二次】 | 中（ローカルブラウザのネイティブ IME がそのまま効く） | リモート入力ならピクセルと同リスク | **大**（ピクセル/NVR） |
| **ファイル DL** | リモート DL→中継転送が必要。ポリシで禁止実装も多い | 中 | リモート DL→転送 | 中〜大 |
| **ファイル UP** | ローカル→リモートサーバ→対象サイトの二段階 | 中 | 同上 | 中〜大 |
| **クリップボード** | シリアライズ→転送→デシリアライズで遅延・制限 | 比較的容易（ローカル DOM） | 転送が必要 | 中 |

> **最大リスクは日本語 IME**。proxyium 類似の「日本語ユーザが検索・フォーム入力する」用途では、ピクセル/NVR の RBI は IME 体験が劣化しやすく、IME パススルー設計の作り込みが必要。Kasm/Neko 等 OSS ではここは自前対応領域。商用（Cloudflare）はポリシ機能が揃うが IME は弱い。

---

## 5. 既存 `rewrite.ts` / `sw.js` の「軽量フォールバック」降格範囲（受け入れ条件 5）

現行アーキテクチャ（[docs/arch/proxy.md](../arch/proxy.md) 裏取り済み【自社】）と RBI の責務境界:

| 現行が担う処理 | コード位置 | RBI 導入後の位置づけ |
| --- | --- | --- |
| HTML/CSS の URL 書き換え（`<a>`/`<form>`/`<img>`/`<link>`/`<script>`/meta refresh） | `rewrite.ts` HTML/CSS 書き換え | **軽量フォールバック側に残る**（書き換え経路を維持する限り必要） |
| GET フォーム送信横取り（#93/#78） | `rewrite.ts` GET フォーム横取りスクリプト | **RBI 経路では不要**（実ブラウザがネイティブにフォーム送信）→ 書き換え経路のみで使用 |
| `<a>` クリック / SPA ルーター横取り（#82） | `rewrite.ts` クリックナビ横取りスクリプト | **RBI 経路では不要**（実ブラウザがネイティブ遷移）→ 書き換え経路のみ |
| `location`/`history` API 駆動の JS 遷移 | **現状フック不能**（[rewrite.ts コメント:353「完全対応は RBI #72」]） | **RBI が解決する中核**（実ブラウザ上の操作なので原理的に追従） |
| 実行時リクエスト横取り（XHR・動的 img/script・非 GET API） | `sw.js` fetch ハンドラ | **RBI 経路では不要**（実ブラウザ内で完結）→ 書き換え経路のみ |
| `document.domain` ガード無効化シム（Yahoo 等） | `rewrite.ts` `<head>` 先頭注入 | **RBI 経路では不要**（同一オリジン問題が発生しない） |
| 初回ナビゲーションのヘッドレス実行（#69） | `browserFetch.ts`（インプロセス Playwright） | **RBI の前駆**。#69 は「初回レンダリングのスナップショット」止まりで、表示後の動的操作（無限スクロール追加読込・動的 XHR・クリック遷移）は依然 `rewrite.ts`/`sw.js` の横取り任せ＝ RBI が根本解決する領域 |

**境界の要点**: RBI（画面ストリーム）は「表示**後**の動的操作」を実ブラウザ上で行うため、`rewrite.ts` のスクリプト注入群（GET フォーム / クリックナビ / document.domain シム）と `sw.js` の XHR 横取りは RBI 経路では**丸ごと不要**になる。書き換え方式は「RBI を使わない大半のサイト向けの軽量フォールバック」に降格する。#69 のブラウザバック中継は RBI への自然な足がかり。

---

## 6. アーキテクチャ移行コスト: ステートレス Next.js → RBI

### 現行との距離（大きい）【自社】
現行はステートレス: レート制限 `rateLimit.ts` / ループ検出 `loopGuard.ts` / 昇格抑止 `promotion.ts` がいずれも「インメモリ Map・プロセス再起動でリセット・複数インスタンス共有非対応」（docs/arch/proxy.md 明記）。RBI は以下を新規に要する:

- **常駐ブラウザプール**: セッションごとの Chromium 起動・維持・破棄ライフサイクル。
- **セッションアフィニティ**: WebRTC/WS 接続を「同じブラウザを持つノード」に固定するスティッキールーティング。ステートレス前提と根本的に相反。
- **高 RAM / 高帯域ノード + オートスケール + アイドル GC**（§3）。
- **WebRTC シグナリング / TURN・STUN / メディア経路**。

「Vercel 的ステートレス関数」から「ステートフルなリアルタイムメディアクラスタ」への質的転換であり移行コストは大きい。

### 段階導入（ハイブリッド）の現実性 — 高い
- **デフォルト = 現行書き換え方式**（ステートレス・低コスト・大半のサイトで十分）。
- **特定サイトのみ RBI フォールバック**: 書き換えで壊れる/ブロックされるサイトをルールベースで RBI 経路へ振り分け。既存 `shouldUseBrowser`（allowlist）/ `shouldPromoteToBrowser`（ヒューリスティック昇格, #70）の判定機構を再利用できる。
- **接合点は #71 で既存**: `getBrowser()` / `browserBackendFromEnv()`（launch / CDP 切り替え）が RBI サービスを疎結合に差し込むシーム。RBI 経路だけ別サービス（Kasm/Neko 自前 or Hyperbeam）として切り出せば現行 Next.js を壊さず段階検証できる。
- **#73 との整合**: Google は egress IP 質に可否が支配される（residential / 外部 CDP が必要）と実証済み。RBI を residential 出口つきで特定サイト限定に適用するのは合理的な棲み分け。

---

## 7. 総合比較表

| 方式 / サービス | 方式 | 自前ホスト | 互換性 | 帯域 / コスト | 忠実度リスク | 移行コスト | 推奨度 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 現行: 書き換え方式 | DOM 書き換え中継 | 可（現状） | 中（壊れるサイトあり） | 軽い / 低 | 低（ローカル IME） | — | 基盤として維持【自社】 |
| ピクセル方式（汎用） | WebRTC/VNC 映像 | — | 最高 | 重い 5〜20Mbps / 高 | 高（IME 要作り込み） | 大 | 互換性が要る時の最終手段【二次】 |
| NVR（Cloudflare 専用） | Skia ベクター転送 | 不可 | 高 | 軽〜中 / user 課金 | 中〜高 | 中 | proxyium 型には課金不一致【一次】 |
| Cloudflare Browser Isolation | NVR | 不可 | 高 | $7+~$10/user・月 | ポリシ完備（IME 弱） | 中 | △ user 課金が用途不一致【二次】 |
| Browserbase | ヘッドレス+CDP | 不可 | 高 | $0.10〜0.12/browser-hr | 自動化向け・画面 UX 非対象 | 中 | × 人間向け画面 proxy でない【一次】 |
| Hyperbeam | WebRTC ピクセル | 不可 | 最高 | 参加者×分・10k 分無料 | 中（埋め込み API で緩和） | 小〜中 | ○ 埋め込み用途に最も近い・少量検証向き【二次】 |
| Kasm Workspaces | コンテナ+KasmVNC | **可** | 高 | 自前サーバ + $5/user（Ent） | 自前作り込み | 大 | ◎ 大量自前ホストの本命【一次/二次】 |
| browserless | ヘッドレス+CDP | **可** | 高 | Unit 課金 / 自前無料 | 自動化向け・画面 UX 非対象 | 中 | △ 自動化基盤、画面配信は別途【一次】 |
| Neko（OSS） | WebRTC ピクセル | **可** | 最高 | 自前のみ・無料 | 自前作り込み | 大 | ○ Hyperbeam の自前ホスト代替【二次】 |

---

## 主要ソース

- [Cloudflare and Remote Browser Isolation（NVR）](https://blog.cloudflare.com/cloudflare-and-remote-browser-isolation/) 【一次】
- [US10452868B1 — Web browser remoting using network vector rendering（特許）](https://patents.google.com/patent/US10452868B1/en) 【一次】
- [Cloudflare Zero Trust / SASE Plans & Pricing](https://www.cloudflare.com/plans/zero-trust-services/) 【一次】
- [Browserbase Pricing](https://www.browserbase.com/pricing) / [Concurrency docs](https://docs.browserbase.com/optimizations/concurrency/overview) 【一次】
- [Hyperbeam](https://hyperbeam.com/) / [API Docs](https://next.hyperbeam.com/docs/api/) 【一次/二次】
- [Kasm Sizing and Deployment Guide](https://kasm.com/docs/latest/how_to/sizing_operations.html) / [Community Edition](https://kasm.com/community-edition) 【一次】
- [browserless GitHub](https://github.com/browserless/browserless) / [Pricing](https://www.browserless.io/pricing) 【一次】
- [Pixel Pushing vs DOM rendering（virtualbrowser.com）](https://www.virtualbrowser.com/en/post/rendering-technology-rbi-pixel-pushing-vs-dom-comparison) 【二次】
- [Headless Chrome at Scale: CPU/RAM/Cost](https://medium.com/@zlata_18516/headless-chrome-at-scale-cpu-ram-and-cost-optimization-strategies-caea743245c4) / [WebScraping.AI: resource requirements](https://webscraping.ai/faq/headless-chromium/what-are-the-resource-requirements-for-running-headless-chromium-at-scale) 【二次】
- [Red5: WebRTC 1080p bitrate](https://www.red5.net/blog/debunking-the-myth-8-reasons-why-webrtc-is-capable-of-high-quality-audio-video-today/) 【二次】
- 内部裏取り: [docs/arch/proxy.md](../arch/proxy.md)（`rewrite.ts` / `sw.js` / `browserFetch.ts` / ステートレス性）【自社】
