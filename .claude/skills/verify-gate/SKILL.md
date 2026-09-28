---
name: verify-gate
description: PR 前の検証ゲートを一括実行する。ブランチ種別を判定し、verify（lint/型/テスト）→ docs-check（docs 変更時）→ evaluator（モードに応じて）のサブエージェントを順に起動して結果を集約する。実装が一段落し PR を出す前に使う。
---

# verify-gate — PR 前検証ゲート

[docs/git-workflow.md](../../../docs/git-workflow.md) §5 step 7 の検証ゲートを、ブランチ種別に応じて順に起動するオーケストレーション skill。
**判定ルールの正本は git-workflow §5.2**。この skill は手順の入口であり、ルールを再定義しない（変更は git-workflow 側で行う）。

## 前提

- 実装が一段落し、ローカルに変更がある状態で実行する。
- これは委譲の入口なので、各ゲートの**合否判断・設計判断はサブエージェントと主エージェント／ユーザーが行う**（§5.1）。skill はサブエージェントを正しい順序・条件で起動することだけを担う。
- **直列化**: `docs-check` と `evaluator` を同時並行で起動しない。`evaluator` の `git` 参照が `docs-check` の作業ツリー修正と干渉しうるため、必ず順に回す。

## 手順

1. **対象の把握**
   - `git branch --show-current` でブランチ名を取得し、接頭辞からブランチ種別を判定する。
   - `git status --short` / `git diff --name-only main...HEAD`（無ければ `git diff --name-only`）で変更ファイル一覧を取得する。
   - `git diff --shortstat main...HEAD`（無ければ `git diff --shortstat`）で変更規模（ファイル数・行数）を把握する（evaluator の auto 判定に使う）。

2. **verify（常時）**
   - `verify` サブエージェントを起動し、lint / フォーマット / 型 / テストを green にする。
   - 設計判断が必要な失敗が残った場合はここで止め、主エージェント／ユーザーに上げる。verify の報告に原因らしい記述が混ざっても、主エージェントは未確認の仮説として扱い、確認するまで集約報告へ書かない（[testing/policy.md](../../../docs/testing/policy.md) §8.3）。**【通知】** [git-workflow.md](../../../docs/git-workflow.md) §5.8。

3. **docs-check（docs/CLAUDE.md を変更した場合のみ）**
   - 変更ファイルに `docs/` 配下または `CLAUDE.md` が含まれるなら `docs-check` サブエージェントを起動し、index 更新漏れ・リンク切れ・旧語彙の残存・命名・関連仕様リンクなどを点検する（観点の正本は [docs-check.md](../../agents/docs-check.md)）。
   - 含まれないならスキップしてよい。

4. **evaluator（受け入れ条件を持つブランチのみ・モードに従う）**
   - 対象は `feature` / `bugfix` / `hotfix` ブランチのみ。`refactor` / `docs` / `chore` は常に対象外（スキップ）。
   - `CLAUDE.md` の「**評価ゲート（evaluator）モード**」（`always` / `auto` / `off`）を読み、モードの定義（§5.2）に従って起動可否を決める。**必ず `verify` を green にした後**に実行する。
     - **`always`**: 対象ブランチで**必ず** `evaluator` を起動する。「単純だから」でスキップしない（スキップ判断自体が排除したい自己評価バイアス）。
     - **`auto`**: 変更規模が §5.2 の閾値を超える場合に `evaluator` を起動する。超えない場合はスキップしてよい。
       - 起動して評価が終わったら、**1 度だけ**「今後 `feature`/`bugfix`/`hotfix` で常時 evaluator を有効（`always`）にしますか？」とユーザーに確認し、Yes なら `CLAUDE.md` のモードを `always` に更新する（以降は固定）。No ならモードは `auto` のまま。**【通知】** [git-workflow.md](../../../docs/git-workflow.md) §5.8。
     - **`off`**: 起動しない。
   - モード行が見つからない場合は安全側に倒し、ユーザーにモードを確認する（勝手に `off` 扱いにしない）。**【通知】** [git-workflow.md](../../../docs/git-workflow.md) §5.8。

5. **集約報告**
   - 起動した各ゲートの結果（pass/fail・要対応・要判断）を主エージェントがまとめて報告する。
   - `evaluator` の結果は**区分ごとの件数**（`[欠陥] N 件 / [証跡・文言] M 件`）と総合判定（PASS / PASS（follow-up あり）/ FAIL）を書き、`[証跡・文言]` の各項目について**「この PR で直した」か「follow-up Issue #N に落とした」か**を明示する（[git-workflow.md](../../../docs/git-workflow.md) §5.2「評価ゲートの指摘区分と止め時」）。主エージェントは `[欠陥]` を `[証跡・文言]` へ格下げしない。
   - `verify` / `docs-check` が FAIL を返した場合、または `evaluator` に **`[欠陥]` が残る**場合は PR 作成に進まず、主エージェント／ユーザーで対応方針を決める。**【通知】** [git-workflow.md](../../../docs/git-workflow.md) §5.8。`[証跡・文言]` だけなら PR 作成に進んでよい（直したあとの `evaluator` 再評価は不要。再評価が要るのは `[欠陥]` を直したときだけ）。
   - **`[欠陥]` を直した後の再評価**では、前回の報告（区分ごとの項目・`path:line`）と各項目の**閉じ方の種別・証跡パスまたはコミット**の対応表を `evaluator` の起動プロンプトに渡し、「ここから確認を始める」と指示する。**同じ表をタスクメモにも残す**（正本は [git-workflow.md](../../../docs/git-workflow.md) §5.2「止め時の規則」3）。
   - follow-up Issue を作ったら `docs/task/index.md` の「起票済み・未着手の Issue」表に載せ、PR 本文に `Follow-up: #N` を書く。

## やらないこと

- ルール（起動条件・閾値・モデル選定など）の再定義。正本は git-workflow §5.2。
- サブエージェントの判断結果の上書き。skill は起動と集約に徹する。
