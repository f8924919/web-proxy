# #151 調査スパイク: サイト間アイソレーションの本質対応（オリジン分離 / サーバー側 Cookie jar）

- **Issue**: [#151](https://github.com/f8924919/web-proxy/issues/151)
- **ブランチ**: `feature/151-isolation-spike`
- **ステータス**: 進行中（調査完了・段階導入方針を決定／実装は別 Issue へ分割）
- **種別**: 調査スパイク（実装なし。成果物は本メモの比較表＋採用方針）
- **派生元**: #131（構造的制約の指摘）/ PR #150（最小緩和: `X-Frame-Options: DENY` + docs 注意明記）
- **関連**: #136（Authorization オリジンスコープ）/ #148（任意の共有トークン認証）/ #72（RBI 評価スパイク）
- **調査日**: 2026-06-24

> 確度凡例: **【一次】** 公式仕様・RFC・ブラウザ挙動, **【自社】** 本リポジトリのコード／docs 裏取り, **【推定】** 一般則からの試算。

---

## 結論（採用方針のためのサマリ）

- **採用方針 = 両者併用の段階導入**（ユーザー決定 2026-06-24）。脅威は 2 系統あり、単独方式ではどちらかが残るため、デプロイ要件に依存しない Phase 1 を先に入れ、要件が整うデプロイで Phase 2 を opt-in する。
- **Phase 1（即時・全デプロイ共通）: サーバー側 `HttpOnly` Cookie jar**。中継 Cookie をクライアントへ返さずサーバー側 jar に保持し、`document.cookie` 露出（脅威 a）を塞ぐ。サブドメイン／ワイルドカード証明書・DNS に依存せず、現行の BASE_PATH リバースプロキシ配下でもそのまま動く。**ステートレス→ステートフル化**のトレードオフを負う。
- **Phase 2（デプロイ要件充足時・feature-flag）: サブドメイン origin 分離**。中継先を `<base32(origin)>.proxy.example` 等のサブドメインへ割り当て、ワイルドカード証明書で配信して**ブラウザの SOP そのもの**でサイト間を隔離する。脅威 (b)（同一オリジン fetch によるセッション乗っ取り）を完全に解く**唯一**の方式。サブドメイン運用ができないデプロイ（パスプレフィックス固定）では OFF にして従来動作＋Phase 1 にフォールバックする＝**両対応**。
- **重要な分析**: Phase 1（jar）単独では脅威 (b) は残る。単一オリジン上である限りサーバーは「どの中継先サイトの JS が fetch を発行したか」を区別できず、jar は宛先サイトの Cookie を自動付与してしまう。**(b) を構造的に解くのは Phase 2（origin 分離）だけ**。したがって Phase 1 はあくまで露出面の縮小であり、完全対応には Phase 2 を要する。

> **本メモは判断材料と方針の提示**。実装は本 Issue を「Phase 1 実装」「Phase 2 実装」の別 Issue へ分割して進める（#151 受け入れ条件のスパイク許容に従う）。

---

## 1. 脅威モデル（#131 の構造的制約・裏取り済み【自社】）

URL 書き換え方式のため、すべての中継先は**単一のプロキシ origin** 上で実行される（[docs/spec/features/proxy.md §サイト間アイソレーションの構造的制約](../spec/features/proxy.md)）。残る脅威は 2 系統。

| # | 脅威 | 仕組み | 現状の対策と限界 |
| - | ---- | ------ | ---------------- |
| **(a)** | `document.cookie` 露出 | スコープ鍵は Cookie *名*接頭辞（`__pxy.<base64url(origin)>.`）にすぎず、ブラウザのオリジン境界ではない。中継した悪性／XSS 被害サイトの JS が `document.cookie` で**全サイトのスコープ化 Cookie を読める** | Cookie スコープ化（`headers.ts`）は上流転送をサイト別に限定するだけ。ブラウザ内の読取りは防げない |
| **(b)** | 同一オリジン fetch のセッション乗っ取り | 同一プロキシ origin ゆえ、悪性サイト JS が `fetch('/api/proxy/https/victim/…')` を発行でき、被害サイト宛リクエストには Cookie（`HttpOnly` 含む）が自動付与される | スコープ化では防げない。`HttpOnly` でも自動付与は起こる。**構造的** |

- 分類: OWASP A01:2021 (Broken Access Control) / A05 (Security Misconfiguration) / CWE-346。深刻度 Critical（構造的）。
- 現行はステートレス（`rateLimit.ts` / `loopGuard.ts` / `promotion.ts` がいずれもインメモリ Map・プロセス再起動でリセット・複数インスタンス共有非対応）。サーバー側 Cookie ストアは持たない【自社: docs/arch/proxy.md】。

---

## 2. 方式比較

| 観点 | 方式1: サブドメイン origin 分離 | 方式2: サーバー側 `HttpOnly` jar |
| ---- | ------------------------------- | -------------------------------- |
| 脅威 (a) document.cookie 露出 | ✅ 解消（別オリジンで `document.cookie` が分離） | ✅ 解消（Cookie をクライアントへ返さない） |
| **脅威 (b) 同一オリジン fetch 乗っ取り** | ✅ **解消**（ブラウザの SOP が enforce。`a.proxy` の JS は `b.proxy` をクレデンシャル付きで取得不可） | ❌ **未解決**（jar は発行元サイトを識別できず宛先 Cookie を自動付与） |
| 実装規模 | 大（`rewrite.ts` の URL 組み立て全面・SW をオリジン別登録・Cookie スコープ鍵・ルーティング） | 中（jar ストレージ・セッション識別・TTL・スケール） |
| 運用前提 | ワイルドカード証明書 + DNS 制御が必須 | なし（ストレージのみ） |
| 現行 BASE_PATH（リバースプロキシ）との整合 | ⚠️ サブドメイン × パスプレフィックスの二重構造。成立可否の検証が必要 | ✅ 影響なし（ステートレス→ステートフルのみ） |
| ステートフル化 | 不要（Cookie はブラウザのオリジン別ストアに委ねられる） | **必要**（セッション識別 + jar） |

---

## 3. Phase 1: サーバー側 `HttpOnly` Cookie jar

### 狙いと範囲

- 中継 Cookie をクライアントへ一切返さず（`Set-Cookie` を握り潰し）、サーバー側 jar に origin スコープで保持する。往路はターゲット origin の jar から復元して上流へ転送する。これで `document.cookie` から中継 Cookie が消え、脅威 (a) を塞ぐ。
- **デプロイ非依存**: サブドメイン・証明書・DNS を要さないため、現行 BASE_PATH リバースプロキシ配下でそのまま導入できる＝Phase 2 の前提が整わないデプロイでも有効。

### 設計の要点（実装 Issue で詳細化）

- **セッション識別**: jar を引くためのセッション ID Cookie（例: `__pxy_sid`、`HttpOnly; SameSite=Lax`）を 1 つだけクライアントへ発行する。これは中継 Cookie ではなくプロキシ自身の Cookie で、`__pxy.` スコープ接頭辞・`__pxy_auth`（#148）と衝突しない命名にする。
- **jar ストレージ**: 初期はインメモリ Map（既存 `rateLimit.ts` 等と同じステートレス・単一プロセス前提）。TTL / 上限 / GC を持つ。複数インスタンス・永続化は将来課題として明記（スケール時は外部ストア）。
- **移行**: 現行の `sanitizeSetCookie` / `scopedCookieHeader`（`headers.ts`）を jar 経由へ置換。`__pxy.<鍵>.` 形式のブラウザ保存は廃止 or 併存を判断する。
- **既知の限界（実装時に docs 化）**:
  - **脅威 (b) は残る**（§2）。Phase 1 は (a) 限定の緩和。
  - **クライアント側 `document.cookie` 書き込み**: ターゲット JS が `document.cookie` で設定する Cookie は jar に入らない。これを jar へ送るには既存シム（`rewrite.ts` の注入スクリプト）で `document.cookie` を横取りする追加対応が要る。未対応なら client-only Cookie は従来どおりオリジン共有のまま（要トレードオフ判断）。
  - **ステートフル化**: セッション喪失（再起動・別インスタンス）で再ログインが必要。

---

## 4. Phase 2: サブドメイン origin 分離（feature-flag・デプロイ要件あり）

### 狙いと範囲

- 中継先を origin ごとのサブドメイン（例: `<base32url(origin)>.proxy.example`）へ割り当て、ワイルドカード証明書 `*.proxy.example` で配信する。ブラウザのオリジン境界そのもので (a)(b) 双方を解消する。
- **feature-flag で opt-in**。サブドメイン運用ができないデプロイ（パスプレフィックス固定）では OFF にし、従来の単一 origin + Phase 1 jar で動かす＝**両対応**（ユーザー要件）。

### 影響範囲（裏取り済み【自社】・実装 Issue で精査）

- **URL 書き換え** `rewrite.ts`: `<a href>` / `<form action>` / `<iframe src>` の組み立て、アドレスバー注入、SW 登録スニペット（`navigator.serviceWorker.register('${BASE_PATH}/sw.js', {scope:'${BASE_PATH}/'})`、`rewrite.ts:521-526`）がパス反映前提。サブドメイン分離では振り向け先ドメインへの組み立てに変更。
- **SW 登録スコープ** `public/sw.js`: 現行は単一オリジンのパスベーススコープ（`deriveBasePath`、`sw.js:15-21`）。オリジンが変わると**各サブドメイン origin ごとに独立 SW** が必要。`isProxyOwnPath` の自前ルート判定（`/browse` `/api/proxy` `/_next`）も見直し。
- **Cookie スコープ鍵** `headers.ts`: オリジンが分かれれば Cookie はブラウザのオリジン別ストアに委ねられ、`__pxy.<鍵>.` の名前接頭辞スコープは不要化（Phase 1 の jar とも整合を取る）。
- **ルーティング** `src/app/browse/` `src/app/api/proxy/`: パス反映スキーム（`/browse/<scheme>/<host>/…`）とサブドメイン割当の対応付け。
- **BASE_PATH との二重構造** `next.config.mjs`: `assetPrefix` のみ使用・`basePath` 未使用（`next.config.mjs:6,12`）。サブドメイン × パスプレフィックスの両立可否を要検証（#131 既知の懸念）。

### 運用前提

- ワイルドカード証明書（`*.proxy.example`）・ワイルドカード DNS・サブドメインを割り当てられるホスティング。これらが無いデプロイでは Phase 2 を OFF。

---

## 5. 段階導入のロードマップ

| Phase | 内容 | デプロイ要件 | 解消する脅威 | 状態 |
| ----- | ---- | ------------ | ------------ | ---- |
| 0（済） | 最小緩和: `X-Frame-Options: DENY` + docs 注意（PR #150 / #131） | なし | クリックジャッキングのみ | 完了 |
| **1** | サーバー側 `HttpOnly` Cookie jar | なし（全デプロイ共通） | (a) | 別 Issue で実装 |
| **2** | サブドメイン origin 分離（feature-flag） | ワイルドカード証明書 + DNS | (a) + **(b)** | 別 Issue で実装（要件充足デプロイで opt-in） |

- Phase 1 → Phase 2 の順。Phase 2 は要件が整うまで OFF、整えば opt-in。
- 補償的コントロール: #148 の任意トークン認証（接続元の縛り）と #136 の Authorization オリジンスコープは Phase 2 完了まで併用価値がある。

---

## 6. 次アクション（実装 Issue 分割）

本 Issue を以下へ分割して実装する（受け入れ条件のスパイク許容に従う）。起票済み。

- **Phase 1 実装 Issue [#155](https://github.com/f8924919/web-proxy/issues/155)**: サーバー側 `HttpOnly` Cookie jar 化。受け入れ条件 = サイト間で `document.cookie` に他サイト中継 Cookie が現れないことをテストで検証。`headers.ts` の jar 移行・`__pxy_sid` 発行・TTL/GC・docs 反映。
- **Phase 2 実装 Issue [#156](https://github.com/f8924919/web-proxy/issues/156)**: サブドメイン origin 分離（feature-flag）。受け入れ条件 = サブドメインモード ON で `a.proxy` の JS から `b.proxy` のセッションへアクセスできないことをテスト／手動で検証。`rewrite.ts` / `sw.js` / ルーティング / 証明書運用 docs。

---

## 主要根拠

- [docs/spec/features/proxy.md §サイト間 Cookie アイソレーション / §サイト間アイソレーションの構造的制約（#131）](../spec/features/proxy.md) 【自社】
- [docs/arch/proxy.md](../arch/proxy.md)（`headers.ts` / `rewrite.ts` / `sw.js` / ステートレス性）【自社】
- `src/lib/proxy/headers.ts`（Cookie スコープ化）/ `src/lib/proxy/auth.ts:8-11`（`__pxy_auth` 非衝突）/ `public/sw.js:15-48`（SW スコープ・`isProxyOwnPath`）/ `next.config.mjs:6,12`（`assetPrefix`・`basePath` 未使用）【自社】
- ブラウザの Same-Origin Policy（サブドメインは別オリジン）【一次】
