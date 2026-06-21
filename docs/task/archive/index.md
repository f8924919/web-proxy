# 完了タスク アーカイブ — 目次

完了したタスクの `{slug}.md` をこのフォルダへ移動し、本ファイルの表に概要を記録します。
進行中・未着手タスクは [../index.md](../index.md) で管理します。

## アーカイブ

| タスク                                                                     | 概要                                                                                                                | 完了日     |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------- |
| [project-bootstrap.md](project-bootstrap.md)                               | プロジェクト初期構築（Next.js 15 + TypeScript + Jest）PR #1                                                         | 2026-06-17 |
| [proxy-core.md](proxy-core.md)                                             | プロキシコア実装（中継・HTML書き換え・SSRF対策・レート制限）Issue #4 / PR #5 #6                                     | 2026-06-17 |
| [29-access-cookie-credentials.md](29-access-cookie-credentials.md)         | Cloudflare Access 背後でプロキシ自身の認証 cookie が落ちサブリソースが CORS で失敗する問題の修正 Issue #29 / PR #30 | 2026-06-19 |
| [headless-browser-debug.md](headless-browser-debug.md)                     | Playwright によるヘッドレスブラウザデバッグ環境（方式B）の導入 Issue #32 / PR #33                                   | 2026-06-19 |
| [34-headless-debug-basepath-strip.md](34-headless-debug-basepath-strip.md) | 方式B（headless debug）で BASE_PATH 付き sw.js/リンクが 404 になる問題の修正 Issue #34 / PR #36                     | 2026-06-19 |
| [53-enablejs-loop-guard.md](53-enablejs-loop-guard.md)                     | enablejs 自己再ナビ無限ループを検出し案内ページで遮断（B 調査は #52）Issue #53 / PR #54                             | 2026-06-20 |
| [55-relative-home-redirect.md](55-relative-home-redirect.md)               | /browse の missing-url リダイレクトを相対 Location 化し localhost 漏えいを修正 Issue #55 / PR #56                   | 2026-06-20 |
| [58-client-side-nav-rewrite.md](58-client-side-nav-rewrite.md)             | JS 動的描画リンクのクライアント側ナビゲーションを横取りしプロキシ離脱を防止 Issue #58 / PR #59                      | 2026-06-20 |
| [25-cross-site-cookie-isolation.md](25-cross-site-cookie-isolation.md)     | サイト間 Cookie アイソレーション（Cookie 名スコープ方式・ステートレス）Issue #25 / PR #61                           | 2026-06-20 |
| [27-cors-hardening.md](27-cors-hardening.md)                               | CORS ハードニング（非 GET の origin/referer 除外・許可オリジンの同一オリジン照合）Issue #27 / PR #63                | 2026-06-20 |
| [28-credentials-cross-origin-xhr.md](28-credentials-cross-origin-xhr.md)   | credentials ベースのクロスオリジン XHR 対応（#29/#25 で成立済みを確認し docs クローズアウト）Issue #28 / PR #65     | 2026-06-20 |
| [browser-backed-fetch.md](browser-backed-fetch.md)                         | ヘッドレス・ブラウザバック中継（browser-backed fetch）PoC（allowlist 昇格・Cookie ウォーミング）Issue #69 / PR #76  | 2026-06-21 |
| [70-heuristic-auto-tier-promotion.md](70-heuristic-auto-tier-promotion.md) | 崩れ/チャレンジ検出によるブラウザティア自動昇格（noscript/チャレンジ語句/403・503・再昇格抑止）Issue #70 / PR #80   | 2026-06-21 |

<!-- タスク完了時の記入例:
| [task-slug.md](task-slug.md) | 1 行サマリ | YYYY-MM-DD |

テーマ別に整理したくなったら、本表を H2 見出しでセクション分割してよい（例: 「## ダウンロード機能」「## 設定」）。
-->
