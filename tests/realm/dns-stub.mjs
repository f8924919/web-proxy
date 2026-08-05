// tests/realm/ 用の `dns/promises` スタブ（テスト方針 §1.2）。
//
// proxyFetch の事前検査（assertSsrfAllowed）だけを通過させるためのもの。TEST-NET-3
// （RFC 5737 の 203.0.113.0/24）はブロックリスト外なので事前検査を素通りする。
//
// **不変条件**: 差し替えるのは `dns/promises`（事前検査が使う）だけで、`node:dns`
// （connect.lookup フックが使う）は実物のまま残す。両方を差し替える／取り違えると、
// connect.lookup が実 DNS を引かなくなりテストが無意味化する。
//
// 呼ばれた回数を記録する。呼ばれていない = スタブが適用されておらず、事前検査が自分で
// ループバックを弾いた（= connect.lookup を一度も通っていない）ことを意味する。

export const calls = [];

export const lookup = async (hostname, options) => {
  calls.push({ hostname, options });
  return [{ address: "203.0.113.1", family: 4 }];
};

export default { lookup };
