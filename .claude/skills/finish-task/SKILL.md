---
name: finish-task
description: PR マージ後の後処理を実行する。main を最新化し、マージ済みブランチを削除（local/remote）し、完了タスクメモを docs/task/archive/ へ移動して両 index を更新する（archive 移動は docs ブランチ＋PR として行う）。PR がマージされた直後に使う。
---

# finish-task — タスク完了・マージ後処理

[docs/git-workflow.md](../../../docs/git-workflow.md) §5 step 9 と [docs/task/index.md](../../../docs/task/index.md) の運用注記に沿った、マージ後の定型後処理を実行するオーケストレーション skill。

> **ホスト操作の読み替え**: PR 作成（`gh pr create`）は GitHub 前提。GitHub 以外のホストは git-workflow.md 冒頭注記に従い当該ホストのコマンド（例: `glab mr create`）へ読み替える。リモート無し（純ローカル git）の場合は、archive 移動 PR の代わりに docs ブランチをローカルで `main` へマージする（`main` 直編集の禁止は branch 経由で守る）。

## 前提

- 対象 PR が **すでにマージ済み**であること（ユーザーがマージしたことを確認してから実行する）。
- 引数または文脈から、マージされたブランチ名と、対応する `docs/task/<slug>.md`（あれば）を把握する。

## 手順

### A. main 最新化とブランチ削除

1. `git checkout main`
2. `git pull --ff-only origin main`
3. マージ済みブランチを削除する。
   - ローカル: `git branch -d <merged-branch>`
   - リモート: `git push origin --delete <merged-branch>`（ホストが自動削除する設定なら local のみ）

### B. 完了タスクの archive 移動（対応する task メモがある場合のみ）

> `main` への直コミットは禁止のため、archive 移動は専用の docs ブランチ＋PR で行う（GitHub Flow）。

1. `git checkout -b docs/archive-<slug>`
2. `git mv docs/task/<slug>.md docs/task/archive/<slug>.md`
3. `docs/task/index.md` の「進行中・未着手」テーブルから該当行を削除する（他に進行中が無ければプレースホルダ行に戻す）。
4. `docs/task/archive/index.md` の**適切なテーマ表**に 1 行追加する（タスク名・概要・更新日。Issue/PR 番号を概要に添える）。
5. 変更が docs のみなので、必要に応じて `docs-check` サブエージェントで index・リンクの整合を点検する。
6. コミット（日本語）→ `git push -u origin docs/archive-<slug>` → PR 作成（ベース `main`、本文日本語、関連 Issue/PR を記載。上記「ホスト操作の読み替え」に従う）。
7. この docs PR がマージされたら、`git checkout main && git pull` 後に `docs/archive-<slug>` を local/remote とも削除する（= 本 skill の A を再実行）。

### 対応する task メモが無い場合

- `refactor` / `docs` / `chore` など task ファイルを持たない作業では B をスキップし、A（main 最新化・ブランチ削除）のみで完了とする。

## やらないこと

- 未マージ PR の後処理（マージは必ずユーザー承認後。先走らない）。
- タスクのテーマ分類の新設など判断を要する変更は主エージェント／ユーザーに委ねる。archive テーマ表に当てはまる区分が無い場合は確認を取る。
