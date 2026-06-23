# #120 ブラウザモードで CSSOM 注入 CSS が page.content() に含まれず表示が崩れる

- **Issue**: [#120](https://github.com/f8924919/web-proxy/issues/120)
- **ブランチ**: `bugfix/120-browser-mode-cssom-inline`
- **ステータス**: 進行中
- **種別**: バグ修正
- **関連**: ブラウザバック中継 #69 / 自動ティア昇格 #70 / 本番基盤 #71
- **着手日**: 2026-06-23

---

## 結論（原因）

`PROXY_BROWSER_MODE=on`（ブラウザバック中継）で news.yahoo.co.jp を開くとレイアウトが崩れる。原因は `browserFetch` が返す `await page.content()` が **CSSOM に注入された CSS をシリアライズしない**こと。

news.yahoo.co.jp は CSS-in-JS（emotion/styled-components 系の本番 "speedy" モード）を使い、クライアントで CSS を `CSSStyleSheet.insertRule()` で CSSOM に直接注入し、`<style>` 要素のテキストは空にする。`page.content()` は DOM のテキストノードのみをシリアライズするため、CSSOM 上の CSS が配信 HTML から欠落する。

### 実測（裏取り・2026-06-23）

| モード         | 配信 HTML の inline CSS                          | 描画                                  |
| -------------- | ------------------------------------------------ | ------------------------------------- |
| OFF（中継）    | `<style>` に約 44,600 文字                       | 正常（ヘッダー/2カラム/フッター整う） |
| ON（ブラウザ） | `<style>` に 339 文字のみ（先頭 `<style>` は空） | 崩壊（ヘッダー無スタイル・全幅化）    |

決定的確認: ブラウザの live DOM で、ある `<style>` は **textContent=0 なのに `sheet.cssRules` が 361 個**保持していた。`adoptedStyleSheets` は今回未使用（0 件）。両モードとも React hydration エラー（#418/#425）は出るが OFF は正常描画のため、崩れの主因は CSS 欠落。

修正プロトタイプ（CSSOM ルールを `<style>` へ書き戻し）で `<style>` の CSS が 339 → 63,620 文字に回復することを確認済み。

## 設計方針（ユーザー確認済み）

- **適用範囲**: CSSOM 書き戻し（空 `<style>` の実体化）＋ `adoptedStyleSheets` の `<style>` 化の**両方**。
- **有効化**: ブラウザモード時は**常時オン**（page.content() の CSS 欠落は常に不利益なため）。env フラグは設けない。
- `page.content()` を呼ぶ直前に `page.evaluate()` で DOM を実体化してから取得する。
- cross-origin 等で `cssRules` が読めないシートは例外を握り潰して安全にスキップ（全損させない）。
- 既存テキストより CSSOM ルールが多い場合のみ書き戻す（冪等）。

## 対象ファイル

- `src/lib/proxy/browserFetch.ts`（純粋関数 `inlineCssomStyles(doc)` を追加し、`page.evaluate(inlineCssomStyles)` を `page.content()` 直前に挿入）
- `tests/lib/proxy/browserFetch.test.ts`（`inlineCssomStyles` の単体テスト追加）
- `docs/spec/features/proxy.md` / `docs/arch/proxy.md`（設計反映）

## 受け入れ条件

- [ ] `<style>` の `sheet.cssRules` を `<style>` テキストへ書き戻す（テキストが CSSOM ルールより短い場合のみ＝冪等）。
- [ ] `document.adoptedStyleSheets` の各シートのルールを `<style data-proxy-adopted>` として `<head>` へ出力する。
- [ ] `cssRules` が読めないシートは安全にスキップし全損させない。
- [ ] news.yahoo.co.jp のブラウザモード配信 HTML の inline CSS 量が大幅増（CSS 欠落解消）。
- [ ] `inlineCssomStyles` の単体テストを追加し green。
- [ ] lint / 型 / テストが green。
