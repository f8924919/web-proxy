# リポジトリのパブリック化

対応 Issue: [#206](https://github.com/f8924919/web-proxy/issues/206)

## 目的

リポジトリを公開（public）に切り替える。公開済みリポジトリ（yt-gui / firefox-wasm）の体裁に合わせて公開前整備を行い、公開後は private + Free プランでは使えなかった branch protection 等の保護機能を有効化する。

## 事前調査（2026-07-19・完了）

公開を妨げる問題がないことを確認済み。

- 秘密情報のハードコードなし（認証トークンは `PROXY_AUTH_TOKEN` 環境変数経由。`.env` は gitignore 済みで git 履歴にも未混入。履歴全体の高エントロピーパターン走査もヒットなし）
- 全コミットが noreply メールアドレス
- 全 Issue / PR（205 件）の本文・コメント走査で機微情報なし
- docs 内の URL は公開サイト参照のみ

## フェーズと進捗

### Phase 1: 公開前整備（進行中）

- [x] `LICENSE` 追加（MIT・ユーザー決定済み）
- [x] `SECURITY.md` 追加（Private Vulnerability Reporting への誘導。SSRF / 認証バイパス / 注入を優先類型として明記）
- [x] `README.md` 更新（ライセンス節追記・環境変数表に `PROXY_AUTH_TOKEN` 追加・「認証未導入」の古い記載を #148 実装済みの実態へ修正）
- [ ] リポジトリ description / topics 設定（`gh repo edit`。PR 外のリポジトリ操作）
- [ ] 本 PR のマージ

### Phase 2: 公開切り替えと保護強化（Phase 1 マージ後・ユーザー最終確認のうえ実施）

- [ ] `gh repo edit --visibility public`
- [ ] `main` の branch protection 設定（PR 必須・`enforce_admins`。[git-workflow.md](../git-workflow.md) §1 のサーバー側保護を稼働させる）
- [ ] secret scanning + push protection 有効化
- [ ] Dependabot alerts 有効化

### Phase 3: 公開後の任意強化（スコープ外・別 Issue に分割）

CI 導入（[ci-guide.md](../ci-guide.md)）・CodeQL・dependabot.yml・CONTRIBUTING / テンプレ類。

## 留意点

- 公開は実質不可逆（clone / fork された内容は回収不能）。Phase 2 の切り替えはユーザーの最終確認を得てから実行する。
- `.claude/` 配下の運用ファイル・docs/task の作業メモも公開対象（走査済み・問題なし）。
