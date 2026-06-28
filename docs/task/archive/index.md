# 完了タスク アーカイブ — 目次

完了したタスクの `{slug}.md` をこのフォルダへ移動し、本ファイルの表に概要を記録します。
進行中・未着手タスクは [../index.md](../index.md) で管理します。

## アーカイブ

| タスク                                                                         | 概要                                                                                                                                                                                                   | 完了日     |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| [project-bootstrap.md](project-bootstrap.md)                                   | プロジェクト初期構築（Next.js 15 + TypeScript + Jest）PR #1                                                                                                                                            | 2026-06-17 |
| [proxy-core.md](proxy-core.md)                                                 | プロキシコア実装（中継・HTML書き換え・SSRF対策・レート制限）Issue #4 / PR #5 #6                                                                                                                        | 2026-06-17 |
| [29-access-cookie-credentials.md](29-access-cookie-credentials.md)             | Cloudflare Access 背後でプロキシ自身の認証 cookie が落ちサブリソースが CORS で失敗する問題の修正 Issue #29 / PR #30                                                                                    | 2026-06-19 |
| [headless-browser-debug.md](headless-browser-debug.md)                         | Playwright によるヘッドレスブラウザデバッグ環境（方式B）の導入 Issue #32 / PR #33                                                                                                                      | 2026-06-19 |
| [34-headless-debug-basepath-strip.md](34-headless-debug-basepath-strip.md)     | 方式B（headless debug）で BASE_PATH 付き sw.js/リンクが 404 になる問題の修正 Issue #34 / PR #36                                                                                                        | 2026-06-19 |
| [53-enablejs-loop-guard.md](53-enablejs-loop-guard.md)                         | enablejs 自己再ナビ無限ループを検出し案内ページで遮断（B 調査は #52）Issue #53 / PR #54                                                                                                                | 2026-06-20 |
| [55-relative-home-redirect.md](55-relative-home-redirect.md)                   | /browse の missing-url リダイレクトを相対 Location 化し localhost 漏えいを修正 Issue #55 / PR #56                                                                                                      | 2026-06-20 |
| [58-client-side-nav-rewrite.md](58-client-side-nav-rewrite.md)                 | JS 動的描画リンクのクライアント側ナビゲーションを横取りしプロキシ離脱を防止 Issue #58 / PR #59                                                                                                         | 2026-06-20 |
| [25-cross-site-cookie-isolation.md](25-cross-site-cookie-isolation.md)         | サイト間 Cookie アイソレーション（Cookie 名スコープ方式・ステートレス）Issue #25 / PR #61                                                                                                              | 2026-06-20 |
| [27-cors-hardening.md](27-cors-hardening.md)                                   | CORS ハードニング（非 GET の origin/referer 除外・許可オリジンの同一オリジン照合）Issue #27 / PR #63                                                                                                   | 2026-06-20 |
| [28-credentials-cross-origin-xhr.md](28-credentials-cross-origin-xhr.md)       | credentials ベースのクロスオリジン XHR 対応（#29/#25 で成立済みを確認し docs クローズアウト）Issue #28 / PR #65                                                                                        | 2026-06-20 |
| [browser-backed-fetch.md](browser-backed-fetch.md)                             | ヘッドレス・ブラウザバック中継（browser-backed fetch）PoC（allowlist 昇格・Cookie ウォーミング）Issue #69 / PR #76                                                                                     | 2026-06-21 |
| [70-heuristic-auto-tier-promotion.md](70-heuristic-auto-tier-promotion.md)     | 崩れ/チャレンジ検出によるブラウザティア自動昇格（noscript/チャレンジ語句/403・503・再昇格抑止）Issue #70 / PR #80                                                                                      | 2026-06-21 |
| [82-spa-click-nav-intercept.md](82-spa-click-nav-intercept.md)                 | SPA クリックの proxy 離脱対策（クリック横取り強化・ルート相対解決・stopImmediatePropagation）Issue #82 / PR #83                                                                                        | 2026-06-21 |
| [71-production-browser-backend.md](71-production-browser-backend.md)           | 本番ブラウザ実行基盤を env で差し替え可能化（自前 Chromium / 外部 CDP・Dockerfile・playwright 昇格）Issue #71 / PR #85                                                                                 | 2026-06-21 |
| [87-docker-next-config-mjs.md](87-docker-next-config-mjs.md)                   | Docker 本番起動の next.config TS 依存を解消（next.config.ts → .mjs 化）Issue #87 / PR #88                                                                                                              | 2026-06-21 |
| [73-antibot-egress-stealth.md](73-antibot-egress-stealth.md)                   | アンチボット最小対策（egress IP プロキシ env + 軽量 stealth）。クリーン IP + ブラウザティアで Google 検索成功を実測 Issue #73 / PR #90                                                                 | 2026-06-21 |
| [93-get-form-stop-propagation.md](93-get-form-stop-propagation.md)             | yahoo 検索でプロキシが外れる不具合の修正（GET フォーム横取りに stopImmediatePropagation 追加・SPA 自前 submit ハンドラ阻止）Issue #93 / PR #94                                                         | 2026-06-21 |
| [100-spa-runtime-relative-url.md](100-spa-runtime-relative-url.md)             | プロキシ経由 SPA のランタイム相対 module import が 404 になる問題を、アセット中継 URL のパス反映形式化（/api/proxy/<scheme>/<host>/<path>）で解消 Issue #100 / PR #106                                 | 2026-06-22 |
| [108-addressbar-fixed-position.md](108-addressbar-fixed-position.md)           | プロキシ UI バーが body{height:100%} のサイト(ipleak.net 等)でスクロール時に消える問題を position:fixed + スペーサー化で解消 Issue #108 / PR #109                                                      | 2026-06-22 |
| [111-special-path-encoding.md](111-special-path-encoding.md)                   | `%2F`・非 ASCII 特殊パスの percent-encoding 保持を回帰テストで固定し spec を整合（実機検証で挙動は正しいと確認・防御と docs 整合のみ）Issue #111 / PR #112                                             | 2026-06-22 |
| [114-spa-query-relative-nav.md](114-spa-query-relative-nav.md)                 | SPA のクエリ相対リンク(?q=…)クリックで url= が落ちプロキシが外れる不具合を修正（DDG「Searches related to」。素通し判定に url= 有無を追加）Issue #114 / PR #116                                         | 2026-06-22 |
| [115-nav-path-reflection.md](115-nav-path-reflection.md)                       | ページ遷移を ?url= からパス反映 /browse/<scheme>/<host>/<path> へ移行し SPA のパラメータ名衝突（DDG ナビタブ）を解消。?url= は 307 互換・SW/横取りも対応 Issue #115 / PR #118                          | 2026-06-22 |
| [120-browser-mode-cssom-inline.md](120-browser-mode-cssom-inline.md)           | ブラウザモードで page.content() が CSSOM 注入 CSS / adoptedStyleSheets を欠落させ CSS-in-JS サイト(news.yahoo.co.jp 等)の表示が崩れる不具合を、取得前の CSSOM 実体化で解消 Issue #120 / PR #121        | 2026-06-23 |
| [124-runtime-request-intercept-shim.md](124-runtime-request-intercept-shim.md) | 初回ロードで SW 未制御により相対/クロスオリジン サブリソース(fetch/XHR)が取りこぼされる問題を、SW 同一規則の横取りシム(window.fetch/XHR.open 上書き)の head 注入で解消 Issue #124 / PR #125            | 2026-06-23 |
| [123-hydration-known-limitation.md](123-hydration-known-limitation.md)         | 調査スパイク: ブラウザモードの React hydration エラー(#418 等)を切り分け、実害なし(コンソールノイズ)と判定し既知の制約として spec/arch に明記。低減策は体験を壊すリスクから見送り Issue #123 / PR #127 | 2026-06-23 |
| [129-ssrf-dns-rebinding-ip-pinning.md](129-ssrf-dns-rebinding-ip-pinning.md)   | SSRF: DNS リバインディング/TOCTOU を undici Agent の connect.lookup で IP ピン留めし封鎖、isSsrfBlocked を IPv6/CGNAT/IPv4-mapped 対応に拡張（全 A/AAAA 検査）Issue #129 #130 / PR #139                | 2026-06-23 |
| [168-sendbeacon-intercept.md](168-sendbeacon-intercept.md)                     | 実行時リクエスト横取りシムに navigator.sendBeacon 上書きを追加し /gen_204 等のルート相対 beacon の 404 を解消（方式B 実測で sendBeacon 由来 404 が 24→0）Issue #168 / PR #169                          | 2026-06-28 |

<!-- タスク完了時の記入例:
| [task-slug.md](task-slug.md) | 1 行サマリ | YYYY-MM-DD |

テーマ別に整理したくなったら、本表を H2 見出しでセクション分割してよい（例: 「## ダウンロード機能」「## 設定」）。
-->
