/** @jest-environment node */
// 仕様: docs/testing/policy.md §1.1 ローカル完結のネットワーク結合テスト
// 実装意図: docs/arch/proxy.md §undici のメジャーバージョン制約（7 系固定・#236）
//
// npm の undici から生成した Agent を Node 組み込み fetch の dispatcher として渡す、
// という「契約」が実行時に成立していることを検証する。この契約は undici のメジャー
// バージョン差で壊れ（#236 では undici 8 系で UND_ERR_INVALID_ARG）、型検査でも
// モックテストでも検出できない。Node 本体のバンドル undici が 8 系へ上がった場合も
// 逆向きに壊れるため、その検知手段も兼ねる。
//
// 本ポリシー上、外部ネットワークへは一切出ない。接続先は listen(0) で確保した
// 127.0.0.1 の動的ポートに限る。

import { createServer, type Server } from "node:http";
import { lookup as dnsLookup } from "node:dns";
import type { AddressInfo } from "node:net";
import { Agent } from "undici";

const BODY = "ok from local server";

let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(BODY);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

// 本番（src/lib/proxy/fetch.ts の ssrfSafeAgent）と同形の Agent を組み立てる。
// connect.lookup フックの有無で dispatcher の受理可否が変わらないことも同時に見る。
function createAgentLikeProduction(): Agent {
  return new Agent({
    connect: {
      lookup: (hostname, options, callback) => {
        dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
          if (err) return callback(err, "", 0);
          const list = addresses as { address: string; family: number }[];
          const wantsAll = !!(options as { all?: boolean } | undefined)?.all;
          if (wantsAll) {
            return (callback as (e: unknown, a: typeof list) => void)(
              null,
              list
            );
          }
          return callback(null, list[0].address, list[0].family);
        });
      },
    },
  });
}

describe("undici Agent と Node 組み込み fetch の dispatcher 契約", () => {
  test("accepts_plain_agent_as_dispatcher_of_builtin_fetch", async () => {
    const agent = new Agent();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        dispatcher: agent,
      } as RequestInit & { dispatcher: Agent });
      expect(res.status).toBe(200);
      await expect(res.text()).resolves.toBe(BODY);
    } finally {
      await agent.close();
    }
  });

  test("accepts_agent_with_connect_lookup_hook_as_dispatcher", async () => {
    const agent = createAgentLikeProduction();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        dispatcher: agent,
      } as RequestInit & { dispatcher: Agent });
      expect(res.status).toBe(200);
      await expect(res.text()).resolves.toBe(BODY);
    } finally {
      await agent.close();
    }
  });
});
