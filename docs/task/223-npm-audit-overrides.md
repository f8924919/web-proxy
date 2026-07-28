# npm audit high の解消（#223）

対応 Issue: [#223](https://github.com/f8924919/web-proxy/issues/223)

## 経緯

dependabot PR（#218〜#222）のマージ後に `npm install` を実行したところ、`npm audit` で high 5 件が検出された。`npm audit fix` は `--force` を付けても `added 0 / removed 0 / changed 0` で 1 件も解消できなかった。

## 方針

1. **next を 15.5.22 へ更新**（`^15.5.19` の範囲内）。high 8 勧告のうち next 由来の全件が解消する。
2. **`overrides` で postcss / sharp / js-yaml / brace-expansion@5 を修正版に固定**。next が postcss を完全固定（8.4.31）し sharp を `^0.34.3` で要求しているため、上流更新では昇格しない。
3. **brace-expansion の 1.x / 2.x は据え置く**。5.x は API 非互換で `minimatch@3` / `minimatch@9` を壊すため強制できない。

`npm update` は 43 パッケージが変化しスコープが過大なため採らない。

恒久的な方針・overrides の削除条件は [docs/arch/dependencies.md](../arch/dependencies.md) を正本とする。

## 誤判断とその訂正（記録）

- **「next は stable に修正版が無い」は誤り**だった。`npm audit` が集約表示する `range` が `9.3.4-canary.0 - 16.3.0-preview.7` だったため 16.x 系の話と取り違えたが、per-advisory のレンジはいずれも `<15.5.21` で、15.5.22 は公開済みだった。この誤りに基づいて起票した追跡 Issue #224 は close 済み。
- **「brace-expansion を据え置けば audit high は 1 件」も誤解を招く提示だった**。その状態は古い lock が 1.1.15 / 2.1.1 を固定していたことによるもので、クリーン再生成すると 1.1.16 / 2.1.2（実際には 3 勧告中 2 件が修正済み＝より安全）に解決され、npm の報告は逆に 27 件へ増える。実エクスポージャを優先して 1.1.16 / 2.1.2 を採用した。

## 検証メモ

- `npm ls` の表示は wanted 版を含むため実インストール版と読み違えやすい。各解決パスの `package.json` から実バージョンを確認すること。
- `npm audit --json` の集約 `range` はアドバイザリの和集合で実態とずれる。`via` の個別レンジを見る。
- postcss（PostCSS 設定なし）・sharp（`next/image` 未使用）はいずれも実質未使用のため、専用テストは追加せず既存の lint / typecheck / test / build で検証する。
- 作業中に `npm run build` が react 19.2.8 / react-dom 19.2.7 の不整合で失敗することが判明。main 由来の別問題として #225 / PR #227 で修正済み（マージ済み）。CI に build ステップが無く検知できなかった点は #226 で追跡。

## 進捗

- [x] 調査（investigate）・受け入れ条件レビュー（criteria-review）
- [x] docs 先行（`docs/arch/dependencies.md` 新規作成・`docs/arch/index.md` / `docs/docs-guide.md` 追記）
- [x] next 15.5.22 更新・`overrides` 追加・`package-lock.json` 再生成
- [x] 検証（verify / docs-check / evaluator）
- [ ] PR 作成・マージ
