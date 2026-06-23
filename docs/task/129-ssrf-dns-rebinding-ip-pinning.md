# 129 SSRF: DNS リバインディング/TOCTOU 対策と IPv6/CGNAT ブロックリスト拡張

- 対応 Issue: [#129](https://github.com/f8924919/web-proxy/issues/129)（TOCTOU/DNS リバインディング）/ [#130](https://github.com/f8924919/web-proxy/issues/130)（IPv6/CGNAT/IPv4-mapped）
- ブランチ: `bugfix/129-ssrf-dns-rebinding-ip-pinning`
- ステータス: 進行中

## 背景

#129 と #130 は同一の名前解決経路（`assertSsrfAllowed` / `isSsrfBlocked` / `proxyFetch` / `installSsrfGuard`）に対する修正で、統合実装する。

## 設計方針（ユーザー確認済み）

1. **TOCTOU 対策（#129）**: `proxyFetch` に **undici の `Agent` を `dispatcher`** として渡し、`connect.lookup` フックで名前解決を 1 回に統一。全アドレスを検査し、通過した IP に**ピン留め**して接続する（検査 IP == 接続 IP）。
   - → `undici` を依存に追加する（現状未導入。Node v22）。
2. **ブロックリスト拡張（#130）**: `isSsrfBlocked` を `net.isIP` で v4/v6 分岐し両対応化。
   - IPv4: 既存 + CGNAT `100.64.0.0/10`
   - IPv6: `::1` / `fc00::/7` / `fe80::/10` / `::`、IPv4-mapped `::ffff:a.b.c.d` は対応 IPv4 として判定
   - `assertSsrfAllowed` は `dns.lookup(host, { all: true, verbatim: true })` で全 A/AAAA を検査
3. **ブラウザ中継（#129・残存許容）**: `installSsrfGuard` を全件・IPv6 対応に強化。Chromium の接続時再解決による残存 TOCTOU は spec/arch に明記（IP ピン留めは構造上不可）。

## docs（先行・反映済み）

- [docs/spec/features/proxy.md](../spec/features/proxy.md) §SSRF 対策 / §DNS リバインディング・TOCTOU 対策 / §SSRF（不弱化）
- [docs/arch/proxy.md](../arch/proxy.md) §SSRF チェック / §browserFetch

## テスト方針

- 純粋関数中心（[testing/policy.md](../testing/policy.md) 準拠。ネットワーク I/O は対象外）。
- `isSsrfBlocked`: v4/v6・CGNAT・IPv4-mapped・境界値の追加ケース。
- `connect.lookup` の判定中心部は純粋関数（アドレス配列 → 採用 IP / 遮断）に切り出して単体テスト。

## 受け入れ条件

#129 / #130 の Issue 本文チェックリストを正本とする。
