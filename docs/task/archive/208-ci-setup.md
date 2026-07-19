# CI 導入と公開後の継続的セキュリティ強化

対応 Issue: [#208](https://github.com/f8924919/web-proxy/issues/208)

## 目的

[ci-guide.md](../ci-guide.md) の設計指針に沿って GitHub Actions の CI（lint / format:check / typecheck / test）・CodeQL・dependabot.yml を導入し、green 実績確認後に branch protection の必須チェックへ昇格する。

## 設計判断（criteria-review の指摘を反映して確定）

| 論点            | 決定                                                               | 理由                                                                                                                                          |
| --------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| CI トリガ       | `pull_request`（対 main）+ `push`（main）                          | PR 上のチェックが必須チェック化の前提。main push は protection 下でもマージコミットに対する検証として有効                                     |
| Node バージョン | 22 単一                                                            | README の推奨値。配布形態（サーバー / Docker）上マトリクス不要。`engines` は追加しない（18 以上サポートの README 記載を維持）                 |
| lint 対象       | `eslint src` → `eslint .` + config に ignore 追加                  | ci-guide 項目 2 の対称性。ディレクトリ列挙より漏れがない。顕在化する既存違反は本 PR で修正 or 理由付き ignore（項目 5）                       |
| カバレッジ      | 計測のみ（閾値なし）+ `collectCoverageFrom` 新設                   | ci-guide 項目 3。[testing/policy.md](../testing/policy.md) §1/§5 のスコープ（ロジック層のみ）と実装の既知の乖離を本タスクで解消（双方向同期） |
| CodeQL 言語     | `javascript-typescript` + `actions`                                | 本体は TS。actions はワークフロー定義自体の解析（yt-gui と同方針）                                                                            |
| dependabot      | npm + github-actions / weekly / limit 5 / prefix `chore`           | yt-gui と同構成                                                                                                                               |
| ジョブ構成      | 1 ジョブ直列（lint → format:check → typecheck → test --coverage）  | yt-gui と同型。並列分割は実行時間が問題化してから                                                                                             |
| 権限 / 重複     | `permissions: contents: read`・`concurrency` で同一 ref キャンセル | 最小権限。CodeQL のみ `security-events: write` を追加                                                                                         |
| アクション版    | checkout@v7 / setup-node@v6 / codeql-action@v4                     | 2026-07 時点の現行推奨メジャー（investigate が WebSearch で裏取り済み）                                                                       |
| Phase 分割      | Phase A（実装 PR）/ Phase B（マージ後の必須チェック指定）          | 新規ワークフローの green は当該 PR 上でしか確認できないため。「green 実績」= 実装 PR 上で全ジョブ green と定義                                |

## design-review 後の追加確定（2026-07-19）

- **カバレッジ粒度**: `collectCoverageFrom: ["src/lib/**/*.ts"]` で src/lib 丸ごとモジュール単位。純粋関数と I/O が同居する `browserFetch.ts` 等をファイル除外するとテスト済み純粋関数が母集団から消えるため、除外せず数値低下を許容（閾値なし）。[testing/policy.md](../testing/policy.md) §5 をモジュール単位運用に文言改訂して双方向同期
- **lint の JS 扱い**: tseslint recommended は型情報ルールを含まないため全ファイル適用のままとし、`public/sw.js`（SW ランタイム規約の手書き JS）と `next-env.d.ts`（自動生成）を理由コメント付き ignore。拡大で顕在化した違反は未使用 import 1 件の削除と不要 eslint-disable 7 件の除去（いずれも挙動不変）
- **必須チェック名の契約**: ジョブ名 `test` を明示固定し、workflow 内コメントと ci-guide 参照で「protection が参照する契約」であることを明記。将来の OS 追加は別ジョブで行う
- **Phase B の `strict`**: `required_status_checks.strict` は **false**（マージ前の main 追従を強制しない。単独開発でブランチ更新→再 green の手戻りが過大なため）。protection の PUT はフルペイロード置換のため、既存設定（enforce_admins・PR 必須・force push 禁止等）を全項目再送して適用する

## テスト方針（step 5 の扱い）

ワークフロー YAML・dependabot.yml・CI 設定は [testing/policy.md](../testing/policy.md) §1 の対象スコープ外（ロジック層ではない）。ユニットテストは追加せず、**実装 PR 上での CI 実行そのもの**を検証とする（受け入れ条件の「green 実績」）。`collectCoverageFrom` の変更は既存テストのカバレッジレポート出力で確認する。

## 進捗

- [x] investigate（設計レビュー推奨: yes）
- [x] criteria-review → Issue #208 の受け入れ条件を明確化（トリガ・Node 版・lint 拡大方針・カバレッジ除外・CodeQL 言語・Phase 分割と green 実績の定義）
- [x] design-review → カバレッジ粒度・sw.js の lint 除外・ジョブ名固定・strict=false を確定（上記）
- [x] 実装（Phase A）: workflows 2 本 + dependabot.yml + lint 拡大（違反 8 件解消）+ collectCoverageFrom + docs 同期。ローカルで lint / 型 / test --coverage 全 green
- [x] verify-gate → PR #210（verify green・docs-check 指摘なし・evaluator PASS。非ブロッキング指摘 2 件を反映）
- [x] green 実績: PR #210 上で test（37s）・CodeQL 両言語 pass
- [x] Phase B: `required_status_checks` に `test` を指定（`strict: false`・既存設定を全項目再送で維持、適用後 GET で確認）
