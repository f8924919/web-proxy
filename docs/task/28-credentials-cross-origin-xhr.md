# #28 credentials ベースのクロスオリジン XHR 対応

- **Issue**: [#28](https://github.com/f8924919/web-proxy/issues/28) feat(v2): credentials ベースのクロスオリジン XHR 対応
- **ブランチ**: `feature/28-credentials-cross-origin-xhr`
- **ステータス**: 進行中（docs クローズアウト・テスト green、PR 前）
- **関連**: 由来 #21、依存 Cookie アイソレーション #25、credentials 変更 #29

## 調査結論（重要）

Issue #28 の背景欄「SW 振り向けは `credentials: "omit"` を用いる」は **#21 当時の古い記述**で、現状は既に解決済み。

- SW は `credentials: "same-origin"` で振り向け済み（[public/sw.js](../../public/sw.js) L148 / L155、#29 で `omit`→`same-origin`）。
- Cookie 往復は #25 で完成（往路 `scopedCookieHeader`・復路 `sanitizeSetCookie`）。
- 同一オリジン `/api/proxy` への振り向けにより、プロキシ origin に保存されたターゲットのスコープ Cookie が `/api/proxy` まで届き、往路スコープ抽出で現ターゲット分だけ上流転送される＝ `credentials: include` 相当のクロスオリジン XHR が成立。

したがって #28 は **実装上ほぼ達成済み**で、残作業は spec/arch の古い「対象外」記述の更新（v2 課題から外す）と、観点を明示した回帰テスト 1 件。

## 方式（ユーザー確定: docs クローズアウト）

- 実装は現状維持（sw.js / route.ts / headers.ts のロジック変更なし）。
- spec/arch の「完全な credentials 制御は対象外」2 箇所を「#28 対応済み（プロキシ経由のスコープ Cookie に限り成立）」へ更新。
- **既知の制約を明記**: SW は元リクエストの credentials モード（omit/same-origin/include）を区別せず一律 `same-origin` で振り向けるため、`omit` 指定でも当該ターゲット自身のスコープ Cookie が送られ得る。ただし送信先は常に現ターゲット分のみでサイト間漏えいは無い。

## 受け入れ条件（Issue より）

- [x] SW 振り向け時の credentials 方針を設計する（`same-origin` でプロキシ origin Cookie を載せる。#29 で導入済みを確認）
- [x] サーバー側でターゲットへ Cookie を転送し credentials: include 相当の XHR が成立することを検証（#28 観点の単体テスト追加）
- [x] Cookie アイソレーション（#25）との整合（混在 jar から現ターゲット分のみ転送・他サイト分とインフラ cookie を除外）
- [x] spec / arch を更新し v2 課題から外す

## 変更ファイル

- `docs/spec/features/proxy.md`: §認証情報の転送 §セキュリティ上の制約 の credentials 記述を更新。
- `docs/arch/proxy.md`: §制約（MVP）の credentials 記述を更新。
- `tests/lib/proxy/headers.test.ts`: 混在 Cookie jar から現ターゲット分のみ転送する #28 観点テストを追加。

## 既知の制約（範囲外）

- 元リクエストの credentials モード区別（omit を尊重してターゲット Cookie を送らない）は対象外。同一ターゲットのスコープ内のみの over-send でありサイト間漏えいは無いため、docs クローズアウトでは扱わない。
- プロキシ外で取得・保存された非スコープ Cookie は転送対象外。
