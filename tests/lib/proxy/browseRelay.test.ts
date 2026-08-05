/** @jest-environment node */
// 仕様: docs/spec/features/proxy.md §中継失敗時のステータス
// 実装意図: docs/arch/proxy.md §エラー型 / §ステータス写像のテスト（#250）
//
// relayBrowse の catch がエラークラスをステータスへ落とす写像を検証する（#250）。
// この写像は #237 の結論（ピン留め由来の SSRF 遮断も 403）が依って立つものだが、
// browseRelay.ts はカバレッジ 0% で守られていなかった。
//
// **proxyFetch / browserFetch だけを差し替える部分モックにする。**
// エラークラス（SsrfBlockedError 等）は jest.requireActual で実クラスを温存する。
// モックしたクラスでは relayBrowse 側の instanceof 判定が成立せず、検証したい写像
// そのものが壊れるため。

import {
  SsrfBlockedError,
  FetchTimeoutError,
  BodyTooLargeError,
} from "@/lib/proxy/fetch";

jest.mock("@/lib/proxy/fetch", () => ({
  ...jest.requireActual("@/lib/proxy/fetch"),
  proxyFetch: jest.fn(),
}));

jest.mock("@/lib/proxy/browserFetch", () => ({
  ...jest.requireActual("@/lib/proxy/browserFetch"),
  browserFetch: jest.fn(),
}));

import { relayBrowse } from "@/lib/proxy/browseRelay";
import { proxyFetch } from "@/lib/proxy/fetch";
import { browserFetch } from "@/lib/proxy/browserFetch";

const mockProxyFetch = proxyFetch as jest.MockedFunction<typeof proxyFetch>;
const mockBrowserFetch = browserFetch as jest.MockedFunction<
  typeof browserFetch
>;

// relayConcurrencyLimiter / cookieJar はシングルトンでリセット API を持たない。
// ConcurrencyLimiter は per-IP に加えキーに依らない global カウンタを持つため IP を
// 変えても分離されないが、relayBrowse が finally で解放するため各テスト完了後に 0 へ
// 戻る（既定上限 512 に対しテストは数件なので顕在化しない）。per-IP 側の累積を避けるため
// テストごとに異なる IP を使う。
let ipSeq = 0;
const nextIp = () => `203.0.113.${++ipSeq}`;

const TARGET = new URL("https://example.com/page");

// 502 経路は意図的に logError を通るためテスト出力が汚れる。前後で復元する
// （テスト方針 §2.3「グローバル状態を変更するテストは前後の値を復元する」）。
let consoleErrorSpy: jest.SpyInstance;

beforeAll(() => {
  consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
});

afterAll(() => {
  consoleErrorSpy.mockRestore();
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe("relayBrowse のステータス写像（中継ティア）", () => {
  test.each([
    ["SsrfBlockedError → 403", () => new SsrfBlockedError("127.0.0.1"), 403],
    ["FetchTimeoutError → 502", () => new FetchTimeoutError(), 502],
    ["BodyTooLargeError → 413", () => new BodyTooLargeError(), 413],
    ["未知の例外 → 502", () => new Error("something unexpected"), 502],
  ])("%s", async (_label, makeError, expected) => {
    mockProxyFetch.mockRejectedValueOnce(makeError());
    const res = await relayBrowse(TARGET, undefined, false, false, nextIp());
    // 502 は予期しない例外の受け皿でもあるため、モックが配線されずに 502 へ落ちた
    // ケースと区別できるよう、中継ティアが実際に呼ばれたことも確認する。
    expect(mockProxyFetch).toHaveBeenCalled();
    expect(res.status).toBe(expected);
  });
});

describe("relayBrowse のステータス写像（ブラウザティア・#69 / #144）", () => {
  // fetchTarget はブラウザティアの失敗を中継ティアへフォールバックさせるが、
  // SsrfBlockedError / BodyTooLargeError だけは伝播させる。フォールバックすると
  // SSRF 遮断が 200 になり、上限超過が別経路で再取得されてしまう。
  test.each([
    [
      "SsrfBlockedError はフォールバックせず 403",
      () => new SsrfBlockedError("::1"),
      403,
    ],
    [
      "BodyTooLargeError はフォールバックせず 413",
      () => new BodyTooLargeError(),
      413,
    ],
  ])("%s になる", async (_label, makeError, expected) => {
    mockBrowserFetch.mockRejectedValueOnce(makeError());
    const res = await relayBrowse(TARGET, undefined, true, false, nextIp());

    expect(res.status).toBe(expected);
    // フォールバックしていない = 中継ティアを呼んでいない
    expect(mockProxyFetch).not.toHaveBeenCalled();
  });

  test("上記以外の失敗は中継ティアへフォールバックする", async () => {
    mockBrowserFetch.mockRejectedValueOnce(new Error("browser crashed"));
    mockProxyFetch.mockRejectedValueOnce(new FetchTimeoutError());

    const res = await relayBrowse(TARGET, undefined, true, false, nextIp());

    expect(mockProxyFetch).toHaveBeenCalled();
    expect(res.status).toBe(502);
  });
});

describe("relayBrowse のステータス写像（② 本文展開の catch）", () => {
  // HTML は書き換えのため全量バッファするので上限が効く（#134）。上限を極小にして
  // 実物の readTextWithLimit に BodyTooLargeError を投げさせ、413 を確認する。
  // relayAsset の CSS 経路（relayAsset.test.ts）と対称。
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
        headers: { "content-type": "text/html" },
      }),
      finalUrl: TARGET.href,
    });

    const res = await relayBrowse(TARGET, undefined, false, false, nextIp());
    expect(res.status).toBe(502);
  });

  test("HTML が上限超過 → 413", async () => {
    mockProxyFetch.mockResolvedValueOnce({
      response: new Response("<html><body>十分に長い本文</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
      finalUrl: TARGET.href,
    });

    const res = await relayBrowse(TARGET, undefined, false, false, nextIp());
    expect(res.status).toBe(413);
  });
});
