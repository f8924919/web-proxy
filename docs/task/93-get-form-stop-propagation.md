# #93 yahoo.co.jp 検索でプロキシが外れる

対応 Issue: [#93](https://github.com/f8924919/web-proxy/issues/93) / PR: [#94](https://github.com/f8924919/web-proxy/pull/94)

## 背景

yahoo.co.jp トップの検索ボックスから検索すると、プロキシ経由（`/browse?url=...`）でなく実サイト（`search.yahoo.co.jp`）へ直接遷移し、プロキシが外れる。

## 原因（調査済み）

yahoo.co.jp トップの検索フォームは React 製の標準的な GET フォーム（`<form action="https://search.yahoo.co.jp/search" method="get">`）。GET フォーム横取りスクリプト（[src/lib/proxy/rewrite.ts](../../src/lib/proxy/rewrite.ts) の `GET_FORM_INTERCEPT_HTML` イベント委任）は capture で submit を捕捉し `location.href` をプロキシ URL にセットするが、**`stopImmediatePropagation()` を呼んでいない**。そのため伝播が止まらず、続けて発火する React の bubble フェーズ自前 submit ハンドラが実 URL へ後勝ち遷移し、プロキシを離脱する。

クリック横取り（同 `CLICK_NAV_INTERCEPT_HTML`）は同種の SPA 横取りを `stopImmediatePropagation()` で既に阻止しており、GET フォーム横取り側だけ対策が漏れている非対称が原因。

## 方針

- イベント委任側の横取り時に `e.stopImmediatePropagation()` を追加（クリック横取りと対称化）。
- spec / arch に SPA submit ハンドラ阻止を追記（済）。
- テスト: `tests/lib/proxy/rewrite.dom.test.ts` の GET フォーム横取り検証を、stopImmediatePropagation で defaultPrevented probe が観察できなくなるため navigation スパイ方式へ切り替え。SPA バブル submit ハンドラへ到達しないことを検証するテストを追加。

## 関連 docs

- spec: [docs/spec/features/proxy.md](../spec/features/proxy.md) §GET フォーム送信の横取り
- arch: [docs/arch/proxy.md](../arch/proxy.md) §GET フォーム送信横取りスクリプト注入
