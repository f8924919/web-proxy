---
name: finish-task
description: PR マージ後の後処理（main の最新化・マージ済みブランチの削除・閉じ忘れた対応 Issue の close・同梱し損ねた archive 移動の補完）を行う。PR がマージされた直後に使う。
argument-hint: "[merged-branch-name]"
---

# finish-task — タスク完了・マージ後処理

[docs/git-workflow.md](../../../docs/git-workflow.md) §5 step 9 と [docs/task/index.md](../../../docs/task/index.md) の運用注記に沿った、マージ後の定型後処理を実行するオーケストレーション skill。

> **ホスト操作の読み替え**: PR 作成（`gh pr create`）・Issue の close（`gh issue close`）は GitHub 前提。GitHub 以外のホストは git-workflow.md 冒頭注記に従い当該ホストのコマンド（例: `glab mr create`）へ読み替える。リモート無し（純ローカル git）の場合は、archive 移動 PR の代わりに docs ブランチをローカルで `main` へマージする（`main` 直編集の禁止は branch 経由で守る）。

## 前提

- 対象 PR が **すでにマージ済み**であること（ユーザーがマージしたことを確認してから実行する）。
- 引数または文脈から、マージされたブランチ名と、対応する `docs/task/<slug>.md`（あれば）を把握する。
- **対応 Issue 番号**は、マージ済み PR の `Closes #` から機械的に取る（§B-1。取れないときだけブランチ名 `feature|bugfix|hotfix/<issue>-…` の番号を使う）。

## 手順

### A. main 最新化とブランチ削除

1. `git checkout main`
2. `git pull --ff-only origin main`
3. マージ済みブランチを削除する。
   - ローカル: `git branch -d <merged-branch>`
   - リモート: `git push origin --delete <merged-branch>`（ホストが自動削除する設定なら local のみ）
4. `git fetch --prune origin` — ホストが自動削除したリモートブランチの追跡ブランチ（`origin/<merged-branch>`）を片付ける。自分で `git push origin --delete` した分は push の時点で消えているので、何も出なくてよい。

### B. 対応 Issue の close（open のままなら）

> **PR 本文に `Closes #<issue>` があればホストが自動で close する**（git-workflow §5 step 8）。**書き漏らすと Issue が open のまま残り**、気づくのは後日になる。本手順は**その取りこぼしを毎回機械的に拾う安全網**である。

1. **対象の Issue 番号を取り、状態を見る。** **判断の余地なくここまでは必ず実行する。**

   - **正はマージ済み PR の `Closes #`**（GitHub の `closingIssuesReferences`）。1 本の PR で複数の Issue を閉じることがあり、ブランチ名に番号の無い `docs` / `refactor` / `chore` でも `Closes #` は書けるため、ブランチ名だけでは取りこぼす。
   - **ブランチ名の番号は補助**。PR を引けない、または同じリポジトリの `Closes #` が 0 件のときだけ、`feature|bugfix|hotfix/<番号>-…` から取る。

   ```bash
   BRANCH="<merged-branch>"
   PRS=$(gh pr list --state merged --head "$BRANCH" --limit 200 --json number,mergedAt -q 'sort_by(.mergedAt) | reverse | map(.number) | join(" ")')
   PR=${PRS%% *}
   [ "$PR" != "$PRS" ] && echo "警告: ブランチ名 $BRANCH のマージ済み PR が複数ある（$PRS）。マージの新しい #$PR を使う — 今回マージした PR か確かめる"
   ISSUES=""
   [ -n "$PR" ] && ISSUES=$(gh pr view "$PR" --json url,closingIssuesReferences -q '(.url | split("/")[3:5] | join("/")) as $repo | [.closingIssuesReferences[] | select(.repository.owner.login + "/" + .repository.name == $repo) | .number] | join(" ")')
   [ -z "$ISSUES" ] && ISSUES=$(echo "$BRANCH" | sed -nE 's#^(feature|bugfix|hotfix)/([0-9]+)-.*#\2#p')
   echo "PR=${PR:-なし} ISSUES=${ISSUES:-なし}"
   for n in $ISSUES; do gh issue view "$n" --json number,state,title -q '"#\(.number) \(.state) \(.title)"'; done
   ```

   - どちらからも番号が取れない（`Refs #` だけで、ブランチ名にも番号が無い PR。Issue を伴わない `docs` / `refactor` / `chore`）→ 本セクションはスキップ。`Refs #` だけでも `feature|bugfix|hotfix/<番号>-…` のブランチなら、その番号が取れて 2 の判断に進む。
   - **警告が出たら**（同じブランチ名のマージ済み PR が複数ある。`--head` はブランチ名だけで絞り、再利用されたブランチ名や fork の同名ブランチも拾う）、`PR=` の番号が今回マージした PR と同じか確かめる。違えば、`PR=<今回の PR 番号>` にして `ISSUES=""` から下を流し直す（`closingIssuesReferences` だけを引くと、次の項目の除外が効かない）。
   - `Closes other/repo#N`（別リポジトリの Issue）は対象外で、**コマンドが除外する**。jq が PR の `url` から `owner/repo` を取り、同じリポジトリの参照だけを残す（除外しないと、`gh issue view` が今のリポジトリの別の #N を表示し、2・3 の判断にかかる）。全件が別リポジトリなら `ISSUES` は空になり、ブランチ名の番号に戻る。
   - 取れた Issue が複数なら、**1 件ずつ独立に** 2・3 の判断を通す（1 件が親 Issue で close しなくても、他の Issue の判断を止めない）。
   - `CLOSED` → 自動 close されている。何もしない。
   - `OPEN` → 次へ。

2. **`OPEN` の理由を確認する。** タスクメモ（`docs/task/archive/<slug>.md` または `docs/task/<slug>.md`）の**ステータス行**を読む。
   - **「親 Issue として open のまま残す」等の明示がある** → close しない（ロードマップの親 Issue など）。
   - **タスクが未完（PR が Issue の一部だけを片付けた）** → close しない。Issue 本文の残りの受け入れ条件を確認し、必要ならユーザーに次の一手を確認する。**【通知】** [git-workflow.md](../../../docs/git-workflow.md) §5.8。
   - 上記に当たらない＝**単なる閉じ忘れ** → 3 へ。

3. **受け入れ条件の充足を現在の `main` で裏取りしてから** close する。マージ済みという事実は「条件を満たした」の証明ではないので、Issue のチェックボックスを 1 件ずつ現物（`path:line`・テストの実行結果）で確かめる。

   ```bash
   gh issue close <issue> --comment "<完了の根拠: PR 番号・設計 doc・タスクメモ・受け入れ条件の充足表>"
   ```

   `<issue>` は、B-1 で取れた番号のうち、いま 2・3 の判断を通している 1 件（取れたのが 1 件でも複数でも同じ）。

   コメントは日本語（[言語ルール](../../../CLAUDE.md#言語ルール)）。**「マージしたので閉じます」だけでは足りない** — 後から Issue だけを読む人が、何がどこに入ったかを辿れる情報（PR 番号・設計の正本・タスクメモのパス・条件ごとの根拠）を書く。

4. **【任意・節目ごと】閉じ忘れの棚卸し。** 過去分を洗うときだけ実行する。`gh issue list --state open` の各番号について、`docs/task/archive/*.md` の**冒頭数行のうち見出し行か `Issue` を含む行だけ**を照合する（メモ全体を `grep -rl` すると、**そのタスクが起票した別 Issue** や派生 Issue まで拾って誤検出になる）。出力は**候補**であって結論ではなく、1 件ずつ 2 の判断を通す（親 Issue は毎回ここに出る）。

### C. 完了タスクの archive 移動（補完・同梱漏れがある場合のみ）

> archive 移動は**原則タスクを完結させる実装 PR に同梱**する（[docs-guide.md](../../../docs/docs-guide.md) §4.2）。本手順は、同梱できなかった・し損ねた場合の**補完**であり、複数タスク分を 1 本の docs PR にまとめてよい。`main` への直コミットは禁止のため docs ブランチ＋PR で行う（GitHub Flow）。

1. `git checkout -b docs/archive-<slug>`（まとめる場合は内容が分かる別名でよい）
2. `git mv docs/task/<slug>.md docs/task/archive/<slug>.md`
3. `docs/task/index.md` の「タスク」テーブルから該当行を削除する（他に進行中・未着手が無ければプレースホルダ行に戻す）。
4. `docs/task/archive/index.md` の**適切なテーマ表**に 1 行追加する（タスク名・概要・更新日。Issue/PR 番号を概要に添える）。
5. 変更が docs のみなので、必要に応じて `docs-check` サブエージェントで index・リンクの整合を点検する。
6. `git commit`（メッセージは日本語）→ `git push -u origin docs/archive-<slug>` → PR 作成（ベース `main`、本文日本語、関連 Issue/PR を記載。上記「ホスト操作の読み替え」に従う）。
7. この docs PR がマージされたら、`git checkout main && git pull` 後に `docs/archive-<slug>` を local/remote とも削除する（= 本 skill の A を再実行）。**【通知】** PR を出した直後はマージ待ちで止まるので通知を出す（[git-workflow.md](../../../docs/git-workflow.md) §5.8）。

### 対応する task メモが無い場合・実装 PR に同梱済みの場合

- `refactor` / `docs` / `chore` など task ファイルを持たない作業、または archive 移動を実装 PR に同梱済みの場合は C をスキップする。**B（Issue の close）はスキップ扱いにしない** — ブランチ名に番号が無くても PR に同じリポジトリの `Closes #` があれば B-1 で拾う。PR の同じリポジトリの `Closes #` にもブランチ名にも番号が無いときだけ、B-1 が自動的に空振りする。

## やらないこと

- 未マージ PR の後処理（マージは必ずユーザー承認後。先走らない）。
- **受け入れ条件を確かめずに Issue を close すること。** マージ済みは充足の証明ではない（B-3）。親 Issue・部分完了の close も判断を要するので B-2 でユーザーに確認する。
- タスクのテーマ分類の新設など判断を要する変更は主エージェント／ユーザーに委ねる。archive テーマ表に当てはまる区分が無い場合は確認を取る。**【通知】** [git-workflow.md](../../../docs/git-workflow.md) §5.8。
