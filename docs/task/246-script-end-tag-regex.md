# #246 promotion.ts の終了タグ正規表現が空白入り終了タグにマッチしない

対応 Issue: [#246](https://github.com/f8924919/web-proxy/issues/246)

## 背景

CodeQL の Code scanning アラート #4（`js/bad-tag-filter` / high）が [src/lib/proxy/promotion.ts](../../src/lib/proxy/promotion.ts) の `visibleTextOutsideNoscript()` を指摘。「この正規表現は `</script >` のような終了タグにマッチしない」。

GitHub のセキュリティ通知を精査した結果、開いていた Code scanning アラート 4 件のうち、実バグはこの 1 件のみ（残る 3 件 = `js/request-forgery` × 1・`js/incomplete-url-scheme-check` × 2 は緩和済み / 前提不成立の false positive として dismiss）。Dependabot・Secret scanning のアラートは 0 件。

## 原因（調査済み）

`visibleTextOutsideNoscript()` は script / style / noscript を内容ごと除去して可視テキストを取り出すが、終了タグを `<\/script>` のような固定文字列としてのみ照合している。HTML の終了タグはタグ名と `>` の間に空白・改行を挟める（`</script >` / `</script\n>`）ため、これらにマッチしない。

**セキュリティ影響はない**。本関数はサニタイザではなく、ヒューリスティック自動ティア昇格の判定材料を作る用途で、出力は文字数比較にしか使われない。実害は**昇格の検出漏れ**:

- 除去に失敗するとスクリプト本文が可視テキストとして数えられ、文字数が `SPA_SHELL_MAX_TEXT` / `NOSCRIPT_DOMINANT_MAX_TEXT`（各 64）を超える
- 結果 `hasEmptySpaShell()` の条件③・`shouldPromoteToBrowser()` の `<noscript>` 主体判定が偽になり、ブラウザティアへ昇格しない

なお `shouldPromoteToBrowser()` の開始タグ判定 `<noscript[\s>]` は既に空白を許容しており、終了タグ側だけが厳密固定文字列という非対称な状態だった。

## 方針

- 3 つの正規表現の終了タグを `<\/script(?:\s[^>]*)?>` 形式へ拡張する。style / noscript も同様。
- **`node-html-parser` への切り替えは行わない**。[docs/arch/proxy.md](../arch/proxy.md) §`src/lib/proxy/promotion.ts` に「パーサは使わず既存の正規表現方針に揃える」と明記された既定路線があり、方針転換は本タスクのスコープ外。
- テスト: `tests/lib/proxy/promotion.test.ts` に変則終了タグの回帰ケースを追加する。

### 方針の変更: 属性付き終了タグへの追従（PR #247 の CI で判明）

当初は「`>` 直前の空白のみ許容（`<\/script\s*>`）」とし、属性付き終了タグ（`</script bar>`）は**対象外**としていた。理由は「`[^>]*` まで緩めると `</scriptfoo>` のような別トークンを誤認する」というもの。

しかし PR #247 の CodeQL スキャンで、空白のみ対応した状態でも**新規アラート #5 が発生**した（`This regular expression does not match script end tags like </script\t\n bar>.`）。CodeQL は 2 形態の両方に追従して初めてアラートを閉じる。

再検討の結果、当初の懸念は**正規表現の書き方に依存する問題**だった。`</script[^>]*>` と書けば `</scriptfoo>` を誤認するが、**タグ名の直後に空白か `>` を要求する** `</script(?:\s[^>]*)?>` の形なら誤認しない（`</scriptfoo>` は `script` の直後が `f` なのでマッチしない）。HTML5 のエラー回復（属性を無視して終了タグ扱い）とも一致する。

よって属性付き終了タグも対象に含めるよう方針を変更し、同 PR に追加コミットした。誤認しないことは回帰テスト（`</scriptfoo>` ケース）で担保する。

## 関連 docs

- spec: [docs/spec/features/proxy.md](../spec/features/proxy.md) §ヒューリスティック自動ティア昇格（崩れ/チャレンジ検出）
- arch: [docs/arch/proxy.md](../arch/proxy.md) §`src/lib/proxy/promotion.ts`
- 初出タスク: [#70](archive/70-heuristic-auto-tier-promotion.md)
