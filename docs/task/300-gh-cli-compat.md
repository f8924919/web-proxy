# #300 gh 2.45 環境でハーネス手順の gh コマンドが失敗する

- **Issue**: [#300](https://github.com/f8924919/web-proxy/issues/300)
- **ブランチ**: `bugfix/300-gh-cli-compat`
- **ステータス**: 進行中
- **基点**: `8c223f0`（PR #299 のマージ）
- **経緯**: PR #299（claude-templates 938ac43 の部分取り込み）のマージ後に `/finish-task` を実行し、手順 B-1 の失敗で発覚

---

## 方針（ユーザー承認 2026-09-28）

- gh 本体は上げず、コマンド側を gh 2.45 でも動く形にする（上流の修正は v2.71.0 / v2.72.0。コンテナを作り直すと版が戻るうえ、GraphQL はどの版でも使える）。
- `gh api graphql` は `permissions.allow` に入れない（mutation も実行できるため参照系の基準から外れる）。finish-task B-1 は毎回確認を挟む。

## 設計

- **finish-task B-1**: `closingIssuesReferences` を `gh api graphql` で引く。owner / repo は `gh api` の `{owner}` / `{repo}` プレースホルダー（カレントリポジトリに展開される）で渡し、別リポジトリの参照は `repository.nameWithOwner` の比較で除外する。`gh` / `jq` の失敗は終了コードで判定し、stderr に `警告:` 行を出してからブランチ名の番号へ戻る。
- **evaluator**: Issue・PR を読むコマンドを `--json <fields>` 付きにする（本文は `title,body`、証跡探索は `comments` / `comments,reviews`）。
- **§5 step 8**: `Closes #` 確認を行頭の `^(Closes|Fixes|Resolves) #[0-9]+` に限る。
- **docs**: setup.md §1 に gh の行、git-workflow §5.3 / §5.6 に `gh api graphql` を allow に入れない理由。

## 進捗

- [x] C1 B-1 を GraphQL 化 — 証跡: 下記「修正後（green）」C1-1〜3・「別リポジトリ参照の除外」
- [x] C2 失敗時の `警告:` 表示 — 証跡: 下記 C2 / C4-3
- [x] C3 複数 PR の警告分岐 — 証跡: 下記 C3
- [x] C4 実行結果（メタ行付き） — 証跡: 下記「修正前」「修正後」「変異 → red」
- [x] C5 evaluator の `--json` 化と限定句 — 証跡: 下記 C5
- [x] C6 step 8 の行頭一致 — 証跡: 下記 C6
- [x] C7 `gh api graphql` を allow に入れない判断の記録 — 証跡: git-workflow §5.6「allow に入れない」表・§5.3 finish-task 行
- [x] C8 setup.md の gh の行 — 証跡: docs/setup.md §1

## 証跡

検査は finish-task 手順 B-1 の bash 断片を `SKILL.md` から取り出して実 PR に当てる使い捨てのハーネス（scratchpad。断片は読むだけで、変異は取り出した複製に当てる — policy §2.5・§8.1 A4）。ケースは 6 件:

| ケース    | 入力                                                         | 期待                             |
| --------- | ------------------------------------------------------------ | -------------------------------- |
| C1-1      | #105（`docs/fix-prettier-drift`、`Closes #101`）             | `101`・警告なし                  |
| C1-2      | #139（`bugfix/129-…`、`Closes #129` と `#130`）              | `129 130`・警告なし              |
| C1-3      | #255（`bugfix/253-…`、`Closes #253`）                        | `253`・警告なし                  |
| C4-2      | #299（`chore/…`、`Closes #` なし）                           | `なし`・警告なし                 |
| C2 / C4-3 | PR 999999（存在しない。手順どおり `ISSUES=""` から流し直す） | `なし`・「取得できなかった」警告 |
| C3        | `chore/project-bootstrap`（マージ済み PR が #6 と #1）       | `4`・「複数」警告                |

> **Issue の C4 ① が挙げた #255 は判別に使えない**: ブランチ名 `bugfix/253-…` の番号でも 253 が取れるので、旧実装でも PASS する（下の変異でも PASS のまま）。判別の主ケースは、ブランチ名に番号の無い #105 と、ブランチ名の番号が Closes の一部しか表さない #139 とした（policy §8.1 A1）。

### 修正前（red）— HEAD の断片

```
META: HEAD=8c223f0 SKILL.md=HEAD と同じ gh version 2.45.0 (2025-07-18 Ubuntu 2.45.0-1ubuntu0.3)
FAIL: C1-1 docs ブランチで Closes #101（#105） — ISSUES=なし（期待 101）警告=なし（期待 なし）
FAIL: C1-2 複数の Closes（#139） — ISSUES=129（期待 129 130）警告=なし（期待 なし）
PASS: C1-3 番号一致（#255） — ISSUES=253（期待 253）警告=なし（期待 なし）
PASS: C4-2 Closes なし・番号なし（#299） — ISSUES=なし（期待 なし）警告=なし（期待 なし）
FAIL: C2/C4-3 存在しない PR 999999 — ISSUES=なし（期待 なし）警告=なし（期待 取得できなかった）
FAIL: C3 同名ブランチの PR が複数（#6 / #1） — ISSUES=なし（期待 4）警告=['警告: ブランチ名 chore/project-bootstrap のマージ済み PR が複数ある（6 1）。マージの新しい #6 を使う — 今回マージした PR か確かめる']（期待 複数）
結果: 2/6 PASS
```

### 修正後（green）

```
META: HEAD=ef063c2 SKILL.md=HEAD と同じ gh version 2.45.0 (2025-07-18 Ubuntu 2.45.0-1ubuntu0.3)
PASS: C1-1 docs ブランチで Closes #101（#105） — ISSUES=101（期待 101）警告=なし（期待 なし）
PASS: C1-2 複数の Closes（#139） — ISSUES=129 130（期待 129 130）警告=なし（期待 なし）
PASS: C1-3 番号一致（#255） — ISSUES=253（期待 253）警告=なし（期待 なし）
PASS: C4-2 Closes なし・番号なし（#299） — ISSUES=なし（期待 なし）警告=なし（期待 なし）
PASS: C2/C4-3 存在しない PR 999999 — ISSUES=なし（期待 なし）警告=['警告: PR #999999 の Closes #（closingIssuesReferences）を取得できなかった（gh api graphql の失敗）。ブランチ名の番号へ戻る']（期待 取得できなかった）
PASS: C3 同名ブランチの PR が複数（#6 / #1） — ISSUES=4（期待 4）警告=['警告: ブランチ名 chore/project-bootstrap のマージ済み PR が複数ある（6 1）。マージの新しい #6 を使う — 今回マージした PR か確かめる']（期待 複数）
結果: 6/6 PASS
```

### 変異 → red（C4 ④: 取得を旧フィールド `gh pr view --json closingIssuesReferences` に戻す）

```
MUTATION: old-field
META: HEAD=77f1256 SKILL.md=HEAD と同じ gh version 2.45.0 (2025-07-18 Ubuntu 2.45.0-1ubuntu0.3)
FAIL: C1-1 docs ブランチで Closes #101（#105） — ISSUES=なし（期待 101）警告=なし（期待 なし）
FAIL: C1-2 複数の Closes（#139） — ISSUES=129（期待 129 130）警告=なし（期待 なし）
PASS: C1-3 番号一致（#255） — ISSUES=253（期待 253）警告=なし（期待 なし）
PASS: C4-2 Closes なし・番号なし（#299） — ISSUES=なし（期待 なし）警告=なし（期待 なし）
FAIL: C2/C4-3 存在しない PR 999999 — ISSUES=なし（期待 なし）警告=なし（期待 取得できなかった）
FAIL: C3 同名ブランチの PR が複数（#6 / #1） — ISSUES=なし（期待 4）警告=['警告: ブランチ名 chore/project-bootstrap のマージ済み PR が複数ある（6 1）。マージの新しい #6 を使う — 今回マージした PR か確かめる']（期待 複数）
結果: 2/6 PASS
```

### 別リポジトリ参照の除外（C1 の「除外する挙動は保つ」）

B-1 の `--jq` プログラムを `SKILL.md` から取り出し、自リポジトリ 2 件 + 別リポジトリ 1 件の模擬応答に当てた:

```
META: HEAD=89ad5f4 作業ツリー=HEAD と同じ gh version 2.45.0 (2025-07-18 Ubuntu 2.45.0-1ubuntu0.3)
実物のjq: 12 30
変異(select除去): 12 7 30
```

### C6（§5 step 8 の行頭一致）

```
META: HEAD=89ad5f4 作業ツリー=HEAD と同じ gh version 2.45.0 (2025-07-18 Ubuntu 2.45.0-1ubuntu0.3)
#299: 0
#255: 1
#105: 1
#139: 2
旧 grep -c 'Closes #' の #299: 1（本文の説明文に当たっていた）
```

### C5（evaluator の `--json` 化）

gh 2.45 では `--json` を付けない `gh issue view` / `gh pr view` は失敗する。evaluator が使う `--json` 付きの形は成功する:

```
META: HEAD=89ad5f4 作業ツリー=HEAD と同じ gh version 2.45.0 (2025-07-18 Ubuntu 2.45.0-1ubuntu0.3)
gh issue view 300 --json comments,title: exit=0
gh pr view 299 --json body,comments,reviews: exit=0
gh issue view 256（--json なし）: exit=1
gh pr view 299（--json なし）: exit=1
```

`.claude/` と `docs/`（archive・research を除く）で `--json` を付けない `gh issue view` / `gh pr view` のコマンド記述は 0 件（残る一致は allow の対象を名指しする散文だけ）。

### C2（`gh pr list` の失敗の分岐）

ブランチ名 `bugfix/253-promotion-mixed-state` で B-1 の断片を流し、`GH_REPO` を存在しないリポジトリにして `gh pr list` を失敗させた:

```
META: HEAD=89ad5f4 作業ツリー=HEAD と同じ gh version 2.45.0 (2025-07-18 Ubuntu 2.45.0-1ubuntu0.3)
GH_REPO=f8924919/no-such-repo で gh pr list を失敗させる:
警告: マージ済み PR の検索（gh pr list）に失敗した。PR の Closes # からは取れないので、ブランチ名の番号へ戻る
PR=なし ISSUES=253
```

## 次にやること

- `/verify-gate`（verify → docs-check → evaluator）

## evaluator の巡

| 巡  | 判定                              | 要対応（区分・指摘）                                                          | 閉じ方の種別               | 証跡 / コミット                            |
| --- | --------------------------------- | ----------------------------------------------------------------------------- | -------------------------- | ------------------------------------------ |
| 1   | FAIL（[欠陥] 1 / [証跡・文言] 3） | [欠陥] C6 の grep ログと別リポジトリ除外の jq ログにメタ行が無い              | 証跡の再取得（メタ行付き） | 本メモ「別リポジトリ参照の除外」「C6」     |
| 1   | 〃                                | [証跡・文言] C4 ④ の変異ログのメタ行が `8c223f0`・未コミット                  | 証跡の再取得               | 本メモ「変異 → red」（再実行して貼り直し） |
| 1   | 〃                                | [証跡・文言] 設計の owner / repo の取り方が実装（`{owner}` / `{repo}`）と違う | メモの記述修正             | 本メモ「設計」                             |
| 1   | 〃                                | [証跡・文言] C5 の段落に「gh 2.45 では」の限定句が無い                        | メモの記述修正             | 本メモ「C5」                               |
| 2   | FAIL（[欠陥] 1 / [証跡・文言] 2） | [欠陥] jq 除外のログにメタ行が無い（1 巡目の再取得を貼り損ねていた）          | 証跡の貼り直し             | 本メモ「別リポジトリ参照の除外」           |
| 2   | 〃                                | [証跡・文言] C4 ④ の変異ログが古いまま（同上）                                | 証跡の再取得と貼り直し     | 本メモ「変異 → red」                       |
| 2   | 〃                                | [証跡・文言] 本表と本文の不一致                                               | メモの記述修正             | 本表                                       |
