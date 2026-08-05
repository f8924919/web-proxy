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
import { cookieJar } from "@/lib/proxy/cookieJar";
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

// 自動ティア昇格（#70）の失敗時に、応答が中継ティアとブラウザティアで混在しないこと（#253）。
//
// 昇格ブロックは res / finalUrl / outHeaders / html をまとめて差し替える。途中で失敗したら
// 4 つとも中継ティアのまま（＝一部だけブラウザティアにならない）ことを固定する。
//
// **混在は「ステータスが 200」だけでは検出できない。** rewriteHtml(html, finalUrl) の
// finalUrl は相対リンクの解決基点で、browseUrl → buildBrowsePath により絶対 URL の
// ホストがパスへ埋め込まれる。そこで両ティアで異なるホストと異なるステータスを返させ、
// (1) ステータス (2) 書き換え後のリンク先ホスト の両方を確認する。
//
// promotionGuard はシングルトンでリセット API が無いため、テストごとに異なる host+path を
// 使う。同一 URL だと 2 件目以降で tryPromote が false を返し、昇格が発火しないまま
// green になってしまう（browserFetch の呼び出し回数もあわせて assert する）。
describe("自動ティア昇格の失敗時の巻き戻し（#253）", () => {
  const RELAY_HOST = "relay-tier.example";
  const BROWSER_HOST = "browser-tier.example";
  // shouldPromoteToBrowser は 403 で真になる。中継ティアを 403・ブラウザティアを 200 に
  // すれば、昇格発火とステータス差の両方をこれ 1 つで満たせる。
  const RELAY_STATUS = 403;
  const BROWSER_STATUS = 200;

  let savedAutoPromote: string | undefined;

  beforeAll(() => {
    savedAutoPromote = process.env.PROXY_BROWSER_AUTO_PROMOTE;
    process.env.PROXY_BROWSER_AUTO_PROMOTE = "true";
  });

  afterAll(() => {
    if (savedAutoPromote === undefined) {
      delete process.env.PROXY_BROWSER_AUTO_PROMOTE;
    } else {
      process.env.PROXY_BROWSER_AUTO_PROMOTE = savedAutoPromote;
    }
  });

  // promotionGuard の 60 秒抑止に引っかからないよう、テストごとに別 path を使う。
  let pathSeq = 0;
  const nextTarget = () =>
    new URL(`https://${RELAY_HOST}/promote-${++pathSeq}`);

  const relayResponse = () => ({
    response: new Response('<html><body><a href="/next">n</a></body></html>', {
      status: RELAY_STATUS,
      headers: { "content-type": "text/html" },
    }),
    finalUrl: `https://${RELAY_HOST}/page`,
  });

  // 実物の readTextWithLimit に早期判定（Content-Length）で落としてもらう。
  // PROXY_MAX_BUFFER_BYTES をいじると中継ティア側の初回読み取りが先に落ちるため、
  // ブラウザティアの応答にだけ過大な content-length を付ける。
  const oversizedBrowserResponse = () => ({
    response: new Response('<html><body><a href="/next">n</a></body></html>', {
      status: BROWSER_STATUS,
      headers: { "content-type": "text/html", "content-length": "999999999" },
    }),
    finalUrl: `https://${BROWSER_HOST}/page`,
  });

  async function expectRelayTierResponse(res: Response) {
    // (1) ステータスが中継ティア側であること
    expect(res.status).toBe(RELAY_STATUS);
    expect(res.status).not.toBe(BROWSER_STATUS);

    // (2) 書き換え基準 URL が中継ティア側であること。相対 href が中継ティアのホストを
    //     含むパスへ解決されていれば、finalUrl が巻き戻っている。
    const body = await res.text();
    expect(body).toContain(RELAY_HOST);
    expect(body).not.toContain(BROWSER_HOST);
  }

  test("昇格後の本文が上限超過なら中継ティアの応答へ巻き戻す", async () => {
    mockProxyFetch.mockResolvedValueOnce(relayResponse());
    mockBrowserFetch.mockResolvedValueOnce(oversizedBrowserResponse());

    const res = await relayBrowse(
      nextTarget(),
      undefined,
      false,
      true,
      nextIp()
    );

    expect(mockBrowserFetch).toHaveBeenCalledTimes(1); // 昇格が実際に発火した
    await expectRelayTierResponse(res);
  });

  test("browserFetch 自体が失敗した場合も中継ティアの応答になる", async () => {
    mockProxyFetch.mockResolvedValueOnce(relayResponse());
    mockBrowserFetch.mockRejectedValueOnce(new Error("browser crashed"));

    const res = await relayBrowse(
      nextTarget(),
      undefined,
      false,
      true,
      nextIp()
    );

    expect(mockBrowserFetch).toHaveBeenCalledTimes(1);
    await expectRelayTierResponse(res);
  });

  test("昇格中の SSRF 遮断も中継ティアの応答へ巻き戻す（403 にしない）", async () => {
    // 中継ティアの本文は SSRF 検査済みの経路で取得済みなので開示リスクはない。
    // 「SSRF は常に 403」の明示的な例外（docs/arch/proxy.md §昇格失敗時の巻き戻し）。
    mockProxyFetch.mockResolvedValueOnce(relayResponse());
    mockBrowserFetch.mockRejectedValueOnce(new SsrfBlockedError("127.0.0.1"));

    const res = await relayBrowse(
      nextTarget(),
      undefined,
      false,
      true,
      nextIp()
    );

    expect(mockBrowserFetch).toHaveBeenCalledTimes(1);
    await expectRelayTierResponse(res);
  });

  test("browserFetch の BodyTooLargeError も中継ティアの応答へ巻き戻す", async () => {
    // DOM 概算超過（#144）。fetchTarget 経由なら 413 だが、昇格ブロックは
    // fetchTarget を通らないため巻き戻す（発生源で応答を変えない）。
    mockProxyFetch.mockResolvedValueOnce(relayResponse());
    mockBrowserFetch.mockRejectedValueOnce(new BodyTooLargeError());

    const res = await relayBrowse(
      nextTarget(),
      undefined,
      false,
      true,
      nextIp()
    );

    expect(mockBrowserFetch).toHaveBeenCalledTimes(1);
    await expectRelayTierResponse(res);
  });

  test("昇格が成功したらブラウザティアの応答になる（正常系）", async () => {
    mockProxyFetch.mockResolvedValueOnce(relayResponse());
    mockBrowserFetch.mockResolvedValueOnce({
      response: new Response(
        '<html><body><a href="/next">n</a></body></html>',
        {
          status: BROWSER_STATUS,
          headers: { "content-type": "text/html" },
        }
      ),
      finalUrl: `https://${BROWSER_HOST}/page`,
    });

    const res = await relayBrowse(
      nextTarget(),
      undefined,
      false,
      true,
      nextIp()
    );

    expect(mockBrowserFetch).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(BROWSER_STATUS);
    const body = await res.text();
    expect(body).toContain(BROWSER_HOST);
    expect(body).not.toContain(RELAY_HOST);
  });

  test("巻き戻しても browserFetch で得た Cookie は jar に残る", async () => {
    // storeRelayCookies は本文読み取りより前に呼ぶ設計（巻き戻し対象外）。
    // 後ろに置くと巻き戻し時に保存されず、Cookie セッションウォーミングが失われる。
    const target = nextTarget();
    const sessionId = `sid-warm-${target.pathname}`;
    mockProxyFetch.mockResolvedValueOnce(relayResponse());
    mockBrowserFetch.mockResolvedValueOnce({
      response: new Response("<html><body>x</body></html>", {
        status: BROWSER_STATUS,
        headers: {
          "content-type": "text/html",
          "content-length": "999999999",
          "set-cookie": "warm=1; Path=/",
        },
      }),
      finalUrl: `https://${BROWSER_HOST}/page`,
    });

    const res = await relayBrowse(target, undefined, false, true, nextIp(), {
      id: sessionId,
      isNew: false,
    });

    expect(mockBrowserFetch).toHaveBeenCalledTimes(1);
    // 応答は巻き戻っている
    expect(res.status).toBe(RELAY_STATUS);
    // Cookie は巻き戻さない
    expect(
      cookieJar.cookieHeader(sessionId, `https://${BROWSER_HOST}`)
    ).toContain("warm=1");
  });

  // issueSessionCookie は Headers を破壊的に変更するため、候補ヘッダーへの適用漏れ
  // （__pxy_sid が発行されない = セッションが毎回切り替わり jar が機能しない）と
  // 二重適用の両方を防ぐ必要がある。
  test.each([
    [
      "巻き戻し時",
      () => mockBrowserFetch.mockResolvedValueOnce(oversizedBrowserResponse()),
    ],
    [
      "昇格成功時",
      () =>
        mockBrowserFetch.mockResolvedValueOnce({
          response: new Response("<html><body>ok</body></html>", {
            status: BROWSER_STATUS,
            headers: { "content-type": "text/html" },
          }),
          finalUrl: `https://${BROWSER_HOST}/page`,
        }),
    ],
  ])("%s、__pxy_sid はちょうど 1 個だけ発行される", async (_label, setup) => {
    mockProxyFetch.mockResolvedValueOnce(relayResponse());
    setup();

    const res = await relayBrowse(
      nextTarget(),
      undefined,
      false,
      true,
      nextIp(),
      { id: "sid-test", isNew: true }
    );

    expect(mockBrowserFetch).toHaveBeenCalledTimes(1); // 昇格が実際に発火した
    const sidCookies = res.headers
      .getSetCookie()
      .filter((c) => c.startsWith("__pxy_sid="));
    expect(sidCookies).toHaveLength(1);
  });
});
