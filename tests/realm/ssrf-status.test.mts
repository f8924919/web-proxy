// テスト方針: docs/testing/policy.md §1.2 単一 realm での実行環境 smoke
// 仕様: docs/spec/features/proxy.md §中継失敗時のステータス / §SSRF 対策
// 実装意図: docs/arch/proxy.md §DNS リバインディング / TOCTOU 対策（テスト環境固有の realm 差）
//
// **なぜ Jest では書けないのか（#237）**
//
// jest-environment-node はテストコードを vm context で実行するため、テスト側で生成した
// オブジェクトは Node 内部から見て別 realm になる。undici の makeNetworkError は
// isErrorLike(reason)（`instanceof Error` を見る）が偽のとき Error を作り直すため、
// connect.lookup が投げた SsrfBlockedError は Jest 上でだけプレーンな Error へ置き換わり、
// findSsrfCause の instanceof 判定が成立しない。単一 realm で動く実運用ではこの置換が
// 起きず 403 が返るが、その挙動は Jest では原理的に検証できない。
//
// このレーンは実運用と同じ単一 realm で proxyFetch を走らせ、connect.lookup 由来の
// SsrfBlockedError が instanceof を保ったまま伝播すること（= 呼び出し側が 403 に写像
// できる状態であること）だけを smoke として確認する。振る舞いの網羅は Jest 側で行う。
//
// **false green を避ける**
//
// dns/promises のスタブが効かなかった場合、事前検査（assertSsrfAllowed）が自分で
// ループバックを弾いて **同じ SsrfBlockedError** を投げるため、connect.lookup を一度も
// 通らずにテストが緑になる。これは本テストが守ろうとしているものを何も守らない状態なので、
// (1) スタブが呼ばれたこと (2) 遮断されたアドレスがループバックであること
// （= 事前検査が見た 203.0.113.1 ではないこと）の両方を assert して塞ぐ。

import { test } from "node:test";
import assert from "node:assert/strict";

import { proxyFetch, SsrfBlockedError } from "../../src/lib/proxy/fetch.ts";
import { calls } from "./dns-stub.mjs";

test("connect.lookup 由来の SSRF 遮断が instanceof を保ったまま伝播する", async () => {
  const before = calls.length;

  // 事前検査はスタブの 203.0.113.1（ブロックリスト外）で通過し、connect.lookup は
  // 実 DNS で localhost を 127.0.0.1 / ::1 に解決するため接続前に遮断される。
  // ポートは fetch の "bad port" 以外であればよく、待受は不要。外部へは出ない。
  const err = await proxyFetch("http://localhost:8181/").then(
    () => null,
    (e: unknown) => e
  );

  // 1. スタブが適用されている（= 事前検査を通過して connect.lookup へ進んだ）
  assert.ok(
    calls.length > before,
    "dns/promises スタブが呼ばれていない。フックが適用されておらず、事前検査が自分で" +
      "ループバックを弾いた可能性が高い（connect.lookup を通っていない）"
  );

  // 2. 単一 realm では包み直されず instanceof が成立する（本テストの主目的）
  assert.ok(
    err instanceof SsrfBlockedError,
    `SsrfBlockedError として捕捉できない: ${String(err)}`
  );

  // 3. 遮断されたのは connect.lookup が解決したループバックであり、
  //    事前検査が見たアドレス（203.0.113.1）ではない
  assert.match((err as Error).message, /127\.0\.0\.1|::1/);
});
