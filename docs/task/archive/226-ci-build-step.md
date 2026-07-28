# CI への build ステップ追加と改行コードの正規化（#226）

対応 Issue: [#226](https://github.com/f8924919/web-proxy/issues/226) / 関連: [#225](https://github.com/f8924919/web-proxy/issues/225)（実害の発生例）・[#218](https://github.com/f8924919/web-proxy/pull/218)（起因）

## 経緯

dependabot #218 が `react` のみを 19.2.8 に更新し `react-dom` を 19.2.7 に据え置いたまま CI 全 pass でマージされ、`main` の `npm run build` を失敗させた（#225）。lint / 型チェック / テストはビルド時のバージョン整合チェックを踏まないため検知できなかった。

あわせて #223 の作業中、Windows の `core.autocrlf=true` により `npm run format:check` が全ファイルを警告し、実際の整形崩れがノイズに埋もれて PR #228 の CI を 1 度失敗させた。

## 方針

1. **CI に build ステップを追加**。実行コストが最も高いため既存ステップの末尾に置き、早期 fail を優先する。
2. **`.gitattributes` で改行コードを LF に正規化**。当初は `docs/setup.md` に回避策を書くだけの予定だったが、正規化すれば問題自体が消えるためこちらを本則とした。

## 判断の記録

- **`.next/cache` のキャッシュは導入しない**。古いキャッシュによる incremental build で本来 fail すべきビルドが通りうるうえ、実測でジョブ全体 53 秒・build ステップ単体 19 秒（[run 30341709130](https://github.com/f8924919/web-proxy/actions/runs/30341709130)）と判断基準の 3 分を大きく下回るため不要。
- **ジョブ名 `test` は変更しない**（branch protection の必須チェック名。ci-guide 項目 8）。
- `npm run build` を CLAUDE.md の「主要コマンド」節から「Lint / Format / 型チェック」節へ移した。ci-guide 項目 1 が「CI のコマンドは CLAUDE.md 記載のローカルコマンドと同一」と定めており、build が検証ゲートに入った以上そちらに置くのが整合するため。

## 検証メモ

- **壊し込み実証**: `react-dom` を `19.2.7` に完全固定して push し、`Build (next build)` ステップのみが fail することを CI で確認した（[run 30341037987](https://github.com/f8924919/web-proxy/actions/runs/30341037987)）。他のステップは全て success で、追加前の CI なら素通りしていた状態である。
  - `^19.2.7` では 19.2.8 も許容されて再現しないため、完全固定が必要だった。
  - `package.json` だけ書き換えても CI は `npm ci` で lock に従うため、`npm install` で lock まで反映する必要がある。
- **改行コード正規化の効果**: 正規化後、Windows でも `npm run format:check` が `All matched files use Prettier code style!` を返すことを確認した。
- ワークフローの更新には `gh` トークンに `workflow` スコープが必要（`gh auth refresh -h github.com -s workflow`）。
- ワークフローのトリガは `pull_request` と main への push のみのため、ブランチ push だけでは CI が走らない。壊し込み検証には draft PR の作成が必要だった。

## 進捗

- [x] 調査（investigate）・受け入れ条件レビュー（criteria-review）
- [x] docs 先行（`docs/ci-guide.md` 項目 9 追加・`docs/setup.md` 追記）
- [x] 壊し込み実証 → build ステップ追加・`.gitattributes` 追加
- [x] 検証（verify / docs-check / evaluator）
- [ ] PR 作成・マージ（PR #230）
