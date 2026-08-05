---
paths:
  - "docs/*.md"
  - "docs/**/*.md"
---

# docs 編集時のルール

docs の追加・更新基準の**正本は [docs/docs-guide.md](../../docs/docs-guide.md)**。着手前に必ず読むこと。本ファイルは編集時に思い出すべき要点のみで、詳細はコピーしない（drift 防止。[git-workflow.md](../../docs/git-workflow.md) §5.3 と同方針）。

## 忘れやすい点（正本の要約）

- **index 追記**: ファイルを追加・改名・削除したら、同フォルダの `index.md` を必ず更新する（spec / arch / task それぞれ。docs-guide §3.4）。
- **相互リンク**: spec ↔ arch ↔ コードの導線を保つ。`arch/index.md` の表には対応する `spec/` を「関連仕様」列で併記（docs-guide §3.3）。リンク切れと命名規則（kebab-case）を確認する。
- **タスク状態**: `docs/task/index.md` のステータス（未着手 / 進行中）と更新日は状態が変わるたびに更新する（docs-guide §3.2）。
- **`docs/task/index.md` は短く保つ**: 置くのは「タスク」「起票済み・未着手の Issue」の 2 表だけ。**完了タスクの経緯・申し送りは `docs/task/archive/index.md` へ**（毎セッション読み込まれるファイルなので、内容がそのまま文脈コストになる。docs-guide §3.2）。
- **完了タスクの archive 移動**: docs-guide §4.2 の手順に従い、**原則タスクを完結させる実装 PR に同梱**する。同梱できなかった場合のみ docs ブランチ＋PR で補完する（`/finish-task` skill・複数タスクまとめ可）。`main` への直コミットは禁止。
