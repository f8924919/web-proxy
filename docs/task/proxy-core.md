# タスク: プロキシコア実装

**GitHub Issue**: [#4](https://github.com/f8924919/web-proxy/issues/4)
**ステータス**: 未着手
**更新日**: 2026-06-17

---

## 背景 / 目的

現状はホーム画面（URL 入力フォーム）のみ実装されており、`/browse?url=...` へ遷移しても 404 になる。
プロキシ中継・HTML 書き換え・静的アセット中継を実装し、外部サイトをブラウザから閲覧できるようにする。

---

## 受け入れ条件

- [ ] `https://example.com` を入力してブラウズ画面へ遷移し、コンテンツが表示される
- [ ] ブラウズ画面のアドレスバーに現在の URL が表示される
- [ ] アドレスバーに別の URL を入力して遷移できる
- [ ] ターゲットページ内のリンクをクリックするとプロキシ経由で遷移する
- [ ] CSS・画像などの静的アセットが `/api/proxy` 経由で読み込まれる
- [ ] SSRF ブロック対象 URL（例: `http://127.0.0.1`）へのアクセスで 403 が返る
- [ ] `url` パラメータなしで `/browse` にアクセスするとホームへリダイレクト
- [ ] 不正 URL・到達不能サイトで適切なエラーメッセージが表示される
- [ ] レート制限（60 req / IP / 分）を超えると 429 が返る

---

## 実装スコープ

### 新規作成ファイル

| ファイル | 内容 |
|---|---|
| `src/app/browse/route.ts` | ブラウズ Route Handler（生 HTML レスポンスを返す） |
| `src/app/api/proxy/route.ts` | 静的アセット中継 API Route Handler |
| `src/lib/proxy/fetch.ts` | ターゲットへの fetch・SSRF チェック |
| `src/lib/proxy/rewrite.ts` | HTML / CSS URL 書き換え（node-html-parser 使用） |
| `src/lib/proxy/headers.ts` | レスポンスヘッダー処理（除去リスト適用） |
| `src/lib/proxy/rateLimit.ts` | インメモリ・スライディングウィンドウ レート制限 |
| `tests/lib/proxy/` | 上記ユニットテスト |

### 変更ファイル

| ファイル | 内容 |
|---|---|
| `package.json` | `node-html-parser` を追加 |

### v1 スコープ外

- JS の URL 書き換え
- Cookie アイソレーション（サイトをまたいだ分離）
- DNS リバインディング対策
- レート制限の永続化・分散対応

---

## 関連ドキュメント

- [プロキシ機能仕様](../spec/features/proxy.md)
- [ブラウズ画面仕様](../spec/screens/browse.md)
- [ホーム画面仕様](../spec/screens/home.md)
