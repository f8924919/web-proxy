# #302 §5.2 の Follow-up: # 確認が本文の説明文に誤反応する

- **Issue**: [#302](https://github.com/f8924919/web-proxy/issues/302)
- **ブランチ**: `bugfix/302-follow-up-grep`
- **ステータス**: 完了（2026-09-28）
- **基点**: `5f93771`（PR #301 のマージ）
- **経緯**: #300（PR #301）で §5 step 8 の `Closes #` 確認だけを行頭一致にし、§5.2 の同じ形の確認を見落としていた。テンプレート側 f8924919/claude-templates#102 で同じ修正を入れたときに気づいた

---

## 設計

[git-workflow.md](../../git-workflow.md) §5.2「評価ゲートの指摘区分と止め時」の follow-up 確認を、`grep -c 'Follow-up: #'` から行頭の `grep -cE '^Follow-up: #[0-9]+'` に変える。理由は §5 step 8 の `Closes #` 確認と同じ（本文の説明文やコードスパンに当たる偽 PASS）。行頭一致なので、`Follow-up: #<N>` は字下げや箇条書き記号を付けずに書くことも明記した。docs-check の指摘を受けて、同じ書き方を [verify-gate](../../../.claude/skills/verify-gate/SKILL.md) 手順 5 の「PR 本文に `Follow-up: #N` を書く」にも添えた（字下げして書くと確認は 0 件になる。書き漏らしを見逃す偽 PASS ではなく、書いたのに「無い」と出る安全側の誤検出）。

## 進捗

- [x] C1 §5.2 の follow-up 確認の行頭一致と理由 — 証跡: docs/git-workflow.md §5.2「止め時の規則」の follow-up Issue の段落
- [x] C2 模擬本文での修正前後の比較 — 証跡: 下記「修正前」「修正後」
- [x] C3 本文を `grep -c` で数える確認が他に残っていない — 証跡: 下記「C3」

## 証跡

検査は git-workflow.md から §5.2 の確認コマンドをそのまま取り出し、模擬本文 4 件に当てる使い捨てのスクリプト（scratchpad）。実 PR に `Follow-up:` 行を持つものが無いので模擬本文。criteria-review の改善案を受けて、字下げした引用の中の `Follow-up: #` も入力に加えた。

### 修正前（red）

```
META: HEAD=5f93771 git-workflow.md=ref HEAD （HEAD と同じ）
取り出した確認: grep -c 'Follow-up: #'
FAIL: 説明文だけ（コードスパン） — 1（期待 0）
FAIL: 説明文だけ（字下げの引用） — 1（期待 0）
PASS: Follow-up 行あり — 1（期待 1）
PASS: Follow-up 行が 2 本 — 2（期待 2）
結果: 2/4 PASS
```

### 修正後

```
META: HEAD=705ad3e git-workflow.md=作業ツリー （HEAD と同じ）
取り出した確認: grep -cE '^Follow-up: #[0-9]+'
PASS: 説明文だけ（コードスパン） — 0（期待 0）
PASS: 説明文だけ（字下げの引用） — 0（期待 0）
PASS: Follow-up 行あり — 1（期待 1）
PASS: Follow-up 行が 2 本 — 2（期待 2）
結果: 4/4 PASS
```

### C3（本文を数える確認の残り）

```
META: HEAD=705ad3e
docs/git-workflow.md:94:.body | grep -cE '^(Closes|Fixes|Resolves) #[0-9]+'
docs/git-workflow.md:190:.body | grep -cE '^Follow-up: #[0-9]+'
```

## 次にやること

- なし（完了）
