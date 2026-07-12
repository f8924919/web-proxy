---
name: finish-task
description: PR マージ後の後処理を実行する。main を最新化し、マージ済みブランチを削除（local/remote）する。完了タスクメモの archive 移動は原則実装 PR に同梱済みの前提で、同梱できなかった場合のみ補完として docs ブランチ＋PR（複数タスクまとめ可）で行う。PR がマージされた直後に使う。
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

### B. 完了タスクの archive 移動（補完・同梱漏れがある場合のみ）

> archive 移動は**原則タスクを完結させる実装 PR に同梱**する（[docs-guide.md](../../../docs/docs-guide.md) §4.2）。本手順は、同梱できなかった・し損ねた場合の**補完**であり、複数タスク分を 1 本の docs PR にまとめてよい。`main` への直コミットは禁止のため docs ブランチ＋PR で行う（GitHub Flow）。

1. `git checkout -b docs/archive-<slug>`（まとめる場合は内容が分かる別名でよい）
2. `git mv docs/task/<slug>.md docs/task/archive/<slug>.md`
3. `docs/task/index.md` の「進行中・未着手」テーブルから該当行を削除する（他に進行中が無ければプレースホルダ行に戻す）。
4. `docs/task/archive/index.md` の**適切なテーマ表**に 1 行追加する（タスク名・概要・更新日。Issue/PR 番号を概要に添える）。
5. 変更が docs のみなので、必要に応じて `docs-check` サブエージェントで index・リンクの整合を点検する。
6. コミット（日本語）→ `git push -u origin docs/archive-<slug>` → PR 作成（ベース `main`、本文日本語、関連 Issue/PR を記載。上記「ホスト操作の読み替え」に従う）。
7. この docs PR がマージされたら、`git checkout main && git pull` 後に `docs/archive-<slug>` を local/remote とも削除する（= 本 skill の A を再実行）。

### 対応する task メモが無い場合・実装 PR に同梱済みの場合

- `refactor` / `docs` / `chore` など task ファイルを持たない作業、または archive 移動を実装 PR に同梱済みの場合は B をスキップし、A（main 最新化・ブランチ削除）のみで完了とする。

## やらないこと

- 未マージ PR の後処理（マージは必ずユーザー承認後。先走らない）。
- タスクのテーマ分類の新設など判断を要する変更は主エージェント／ユーザーに委ねる。archive テーマ表に当てはまる区分が無い場合は確認を取る。
