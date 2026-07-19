# セキュリティポリシー

## 脆弱性の報告

セキュリティ上の問題を見つけた場合は、**公開 Issue を作成せず**、GitHub の
[Private Vulnerability Reporting](https://github.com/f8924919/web-proxy/security/advisories/new)
から非公開で報告してください（リポジトリの **Security** タブ →「Report a vulnerability」）。

報告には、可能な範囲で以下を含めてください。

- 影響を受けるコミットまたはブランチ
- 再現手順または PoC
- 想定される影響範囲

非公開報告を受領後、修正方針と公開時期について GitHub Security Advisory 上でやり取りします。

## 対象範囲

本リポジトリは、プロキシ中継・URL 書き換え・認証など本サービス側のコードを対象とします。
特に以下の類型は優先度の高い報告として扱います。

- SSRF（内部ネットワークへの到達・DNS rebinding 等。[docs/spec/features/proxy.md](docs/spec/features/proxy.md) の宛先ポリシー回避）
- 認証バイパス（アクセストークンによる利用制限の回避）
- 中継レスポンスを介したプロキシ利用者への XSS 等の注入

依存パッケージ自体の脆弱性は各上流プロジェクトへ報告してください。

## 運用上の注意

本サービスは任意の外部サイトへリクエストを中継する性質上、**認証を有効化し TLS 終端の背後で運用する**ことを前提とします。設定と乱用対策は [README.md](README.md) の「利用上の注意・乱用対策」および [docs/setup.md](docs/setup.md) を参照してください。

## サポート対象バージョン

リリースタグは設けていないため、`main` ブランチの最新コミットのみをサポート対象とします。
