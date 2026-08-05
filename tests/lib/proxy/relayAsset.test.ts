/** @jest-environment node */
// 仕様: docs/spec/features/proxy.md §中継失敗時のステータス
// 実装意図: docs/arch/proxy.md §エラー型 / §ステータス写像のテスト（#250）
//
// relayAsset がエラークラスをステータスへ落とす写像を検証する（#250）。
//
// **relayAsset には catch が 2 つある。** ① 上流取得（proxyFetch）の catch は
// SsrfBlockedError だけを instanceof で名指し判定し、残りを無条件に 502 へ丸める
// catch-all。② 本文展開（readTextWithLimit / 書き換え / Response 構築）の catch は
// BodyTooLargeError → 413、それ以外 → 502。両方を検証する。
//
// ①の 502 テストが守るのは「FetchTimeoutError を認識している」ことではなく、
// 「未知の例外でもハンドラをクラッシュさせず 502 を返す」という不変条件である。
//
// **proxyFetch だけを差し替える部分モックにする。**
// エラークラスと readTextWithLimit は jest.requireActual で実物を温存する。
// モックしたクラスでは relayAsset 側の instanceof 判定が成立せず、検証したい写像
// そのものが壊れるため。

import { NextRequest } from "next/server";
import { SsrfBlockedError, FetchTimeoutError } from "@/lib/proxy/fetch";

jest.mock("@/lib/proxy/fetch", () => ({
  ...jest.requireActual("@/lib/proxy/fetch"),
  proxyFetch: jest.fn(),
}));

import { relayAsset } from "@/lib/proxy/relayAsset";
import { proxyFetch } from "@/lib/proxy/fetch";

const mockProxyFetch = proxyFetch as jest.MockedFunction<typeof proxyFetch>;

// assetRateLimiter / relayConcurrencyLimiter / cookieJar はシングルトンでリセット API を
// 持たない。バケットキーは getClientIp が決めるが、既定では PROXY_TRUSTED_IP_HEADER が
// 未設定で**転送ヘッダーを一切信頼せず全リクエストが同一バケット**になるため、
// ヘッダーを変えるだけでは分離できない。テスト中だけ信頼ヘッダーを設定して IP 分離を
// 実効化し、前後で復元する（テスト方針 §2.3）。
//
// なお RateLimiter はキー単位に状態が分離されるためこれで干渉しないが、
// ConcurrencyLimiter の global カウンタはキーに依らず共有である。relayAsset が finally で
// 解放するため各テスト完了後に 0 へ戻り（既定上限 512 に対しテストは数件）実害はない。
const TRUSTED_HEADER = "x-forwarded-for";
let savedTrustedHeader: string | undefined;

let ipSeq = 0;
const makeRequest = () =>
  new NextRequest("https://proxy.example/api/proxy/https/example.com/a.css", {
    headers: { [TRUSTED_HEADER]: `203.0.113.${++ipSeq}` },
  });

const TARGET = "https://example.com/a.css";

// 502 経路は意図的に logError を通るためテスト出力が汚れる。前後で復元する。
let consoleErrorSpy: jest.SpyInstance;

beforeAll(() => {
  savedTrustedHeader = process.env.PROXY_TRUSTED_IP_HEADER;
  process.env.PROXY_TRUSTED_IP_HEADER = TRUSTED_HEADER;
  consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
});

afterAll(() => {
  if (savedTrustedHeader === undefined) {
    delete process.env.PROXY_TRUSTED_IP_HEADER;
  } else {
    process.env.PROXY_TRUSTED_IP_HEADER = savedTrustedHeader;
  }
  consoleErrorSpy.mockRestore();
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe("relayAsset のステータス写像（① 上流取得の catch）", () => {
  test("SsrfBlockedError → 403", async () => {
    mockProxyFetch.mockRejectedValueOnce(new SsrfBlockedError("127.0.0.1"));
    const res = await relayAsset(makeRequest(), TARGET);
    expect(mockProxyFetch).toHaveBeenCalled();
    expect(res.status).toBe(403);
  });

  // SsrfBlockedError 以外はすべて catch-all に落ちる。FetchTimeoutError も
  // 名指し判定されているわけではないため、同じ経路であることを対で示す。
  test.each([
    ["FetchTimeoutError", () => new FetchTimeoutError()],
    ["未知の例外", () => new Error("something unexpected")],
  ])("%s → 502（catch-all）", async (_label, makeError) => {
    mockProxyFetch.mockRejectedValueOnce(makeError());
    const res = await relayAsset(makeRequest(), TARGET);
    expect(mockProxyFetch).toHaveBeenCalled();
    expect(res.status).toBe(502);
  });
});

describe("relayAsset のステータス写像（② 本文展開の catch）", () => {
  // CSS は書き換えのため全量バッファするので上限が効く（#134）。上限を極小にして
  // 実物の readTextWithLimit に BodyTooLargeError を投げさせ、413 を確認する。
  let savedLimit: string | undefined;

  beforeAll(() => {
    savedLimit = process.env.PROXY_MAX_BUFFER_BYTES;
    process.env.PROXY_MAX_BUFFER_BYTES = "8";
  });

  afterAll(() => {
    if (savedLimit === undefined) {
      delete process.env.PROXY_MAX_BUFFER_BYTES;
    } else {
      process.env.PROXY_MAX_BUFFER_BYTES = savedLimit;
    }
  });

  test("本文読み取りが失敗 → 502（catch-all）", async () => {
    // BodyTooLargeError 以外で本文展開が失敗する経路。ハンドラをクラッシュ（500）
    // させず 502 に落ちることを固定する。
    const failing = new ReadableStream({
      start(controller) {
        controller.error(new Error("stream broke"));
      },
    });
    mockProxyFetch.mockResolvedValueOnce({
      response: new Response(failing, {
        status: 200,
        headers: { "content-type": "text/css" },
      }),
      finalUrl: TARGET,
    });

    const res = await relayAsset(makeRequest(), TARGET);
    expect(res.status).toBe(502);
  });

  test("CSS が上限超過 → 413", async () => {
    mockProxyFetch.mockResolvedValueOnce({
      response: new Response("a{color:red}body{margin:0}", {
        status: 200,
        headers: { "content-type": "text/css" },
      }),
      finalUrl: TARGET,
    });

    const res = await relayAsset(makeRequest(), TARGET);
    expect(res.status).toBe(413);
  });
});
