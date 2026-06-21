# #73 アンチボット対策（egress IP / ヘッドレス stealth）

- **Issue**: [#73](https://github.com/f8924919/web-proxy/issues/73)
- **ブランチ**: `feature/73-antibot-egress-stealth`
- **ステータス**: 進行中
- **関連**: 本体 #69 / 本番基盤 #71 / RBI #72 / 既存調査 #52（Google enablejs ループ）

## 決定（ユーザー確認済み）

- **スコープ**: 調査 + 最小実装。Google 実測は外部サービスの有料キー入手後に別途（手順を docs 化）。
- **stealth**: 組み込み軽量（launch args `--disable-blink-features=AutomationControlled` + `addInitScript` で `navigator.webdriver` 隠蔽）。playwright-extra/stealth は導入しない（egress IP が支配的で費用対効果が低い）。
- **egress IP**: 自前ブラウザに上流プロキシ env `PROXY_BROWSER_PROXY_SERVER`（+ USERNAME/PASSWORD）を追加。#71 の外部 CDP サービスと両立。

## 受け入れ条件（Issue より）

- [ ] egress IP の選択肢比較・コスト/規約/法的留意を docs にまとめる → setup.md §9.4 / spec
- [ ] stealth 対策の評価と適用範囲の決定 → 組み込み軽量を採用（spec/arch）
- [x] Google 検索を代表ケースに実測 → **確認済み**（下記）
- [ ] 結論（やる/やらない・どこまで）+ 法的留意を docs に残す → spec §アンチボット対策 / setup.md §9.4

## 実測結果（2026-06-21・確認済み）

- **構成**: ローカル PC の ISP 回線（residential IP・`PROXY_BROWSER_PROXY_SERVER` 未使用）+ ブラウザティア（`browserFetch`）。
- **結果**: Google 検索が**成功**（`/sorry/` reCAPTCHA・enablejs ループに落ちない）。
- **含意**: データセンター IP では弾かれていた（#52）のに対しクリーン IP で通った＝**可否は egress IP の質に支配される**という #52 の真因仮説を実証。stealth（軽量）も適用下で問題なし。
- **本番での再現**: データセンター IP のデプロイで同等の結果を得るには residential プロキシ（`PROXY_BROWSER_PROXY_SERVER`）または residential IP 内蔵の外部 CDP サービスが必要（setup.md §9.4）。本実測は「クリーン IP なら通る」ことの確認で、データセンター + residential プロキシ経路の実測は未（必要時に follow-up）。

## 実装メモ

- `src/lib/proxy/browserFetch.ts`:
  - 純粋関数 `browserProxyFromEnv(env)` 追加（`{ server, username?, password? }` or undefined）。
  - 定数 `STEALTH_LAUNCH_ARGS` / `STEALTH_INIT_SCRIPT`。
  - `getBrowser()` の launch 分岐に `{ args: STEALTH_LAUNCH_ARGS, proxy }` を付与（CDP 分岐は外部サービスに委譲）。
  - `browserFetch` の `newContext` 直後に `addInitScript(STEALTH_INIT_SCRIPT)`（両バックエンド適用）。
- テスト: `browserProxyFromEnv` と stealth 定数の単体テスト。launch/addInitScript の I/O はテスト対象外。
