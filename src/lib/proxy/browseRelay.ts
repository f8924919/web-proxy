import { NextRequest } from "next/server";
import {
  proxyFetch,
  SsrfBlockedError,
  FetchTimeoutError,
  BodyTooLargeError,
  readTextWithLimit,
  maxBufferBytesFromEnv,
} from "@/lib/proxy/fetch";
import { browserFetch } from "@/lib/proxy/browserFetch";
import {
  autoPromoteEnabledFromEnv,
  shouldPromoteToBrowser,
  promotionGuard,
} from "@/lib/proxy/promotion";
import { rewriteHtml } from "@/lib/proxy/rewrite";
import { sanitizeHeaders, htmlUiHeaders } from "@/lib/proxy/headers";
import {
  cookieJar,
  buildSessionCookie,
  setCookiesFromHeaders,
  type SessionRef,
} from "@/lib/proxy/cookieJar";
import { isNullBodyStatus } from "@/lib/proxy/response";
import { pageRateLimiter } from "@/lib/proxy/rateLimit";
import { isAllowedTarget, allowedPortsFromEnv } from "@/lib/proxy/targetPolicy";
import {
  relayConcurrencyLimiter,
  ConcurrencyLimitExceededError,
} from "@/lib/proxy/concurrency";
import { navigationLoopGuard, loopGuidanceHtml } from "@/lib/proxy/loopGuard";
import { getClientIp } from "@/lib/proxy/clientIp";
import {
  proxyAuthConfigFromEnv,
  isAuthorized,
  safeRedirectPath,
  unlockHtml,
  AUTH_HEADER_NAME,
} from "@/lib/proxy/auth";
import { logError } from "@/lib/logger";

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

// ページ遷移（/browse）の中継処理。パス反映形式（/browse/<scheme>/<host>/<path>・#115）と
// 後方互換の ?url= 形式の両ルートが、ターゲット絶対 URL を決定したうえで本モジュールへ委譲する。
// 仕様: docs/spec/features/proxy.md §ページ遷移のパス反映 / §ナビゲーションループの検出

// 上流レスポンスの Set-Cookie をブラウザへ返さず、最終 URL の origin をキーに jar へ
// 格納する（#151 Phase 1）。session が無い経路（後方互換 ?url= GET 等）では何もしない。
function storeRelayCookies(
  session: SessionRef | undefined,
  finalUrl: string,
  responseHeaders: Headers
): void {
  if (!session) return;
  cookieJar.store(
    session.id,
    new URL(finalUrl).origin,
    setCookiesFromHeaders(responseHeaders)
  );
}

// 新規セッションのときだけ __pxy_sid を Set-Cookie する（#151 Phase 1）。
function issueSessionCookie(
  session: SessionRef | undefined,
  outHeaders: Headers
): void {
  if (session?.isNew) {
    outHeaders.append("Set-Cookie", buildSessionCookie(session.id, BASE_PATH));
  }
}

export function errorHtml(message: string): string {
  return `<!DOCTYPE html><html lang="ja"><body style="font-family:sans-serif;padding:2rem">
<h2>エラー</h2><p>${message}</p><a href="/">ホームへ戻る</a></body></html>`;
}

export function htmlResponse(message: string, status: number): Response {
  // プロキシ自身の UI レスポンスには X-Frame-Options: DENY を付与する（#131）。
  return new Response(errorHtml(message), {
    status,
    headers: htmlUiHeaders(),
  });
}

// ナビゲーションループ検出時の静的案内ページ（自動遷移を含まない）。
function loopGuidanceResponse(): Response {
  return new Response(loopGuidanceHtml(), {
    status: 200,
    headers: htmlUiHeaders(),
  });
}

// レート制限・ナビゲーションループ検出を行い、打ち切るべきなら Response を返す。
// 続行可能なら null を返す。GET / POST の両ルートで共通利用する。
export function browseGuards(req: NextRequest, parsed: URL): Response | null {
  // 任意の共有トークン認証（#148）。有効（PROXY_AUTH_TOKEN 設定時）かつ未認証なら、
  // レート制限等を消費する前にトークン入力フォーム付き 401 を返す。redirect は元の閲覧 URL
  // （アプリ相対・BASE_PATH なし）。解錠後に /unlock がここへ 303 で戻す。
  const authConfig = proxyAuthConfigFromEnv();
  if (
    !isAuthorized(
      req.headers.get(AUTH_HEADER_NAME),
      req.headers.get("cookie"),
      authConfig
    )
  ) {
    const redirectTo = safeRedirectPath(
      req.nextUrl.pathname + req.nextUrl.search,
      BASE_PATH
    );
    return new Response(unlockHtml(redirectTo, BASE_PATH), {
      status: 401,
      headers: htmlUiHeaders(),
    });
  }

  const ip = getClientIp(req.headers);
  try {
    pageRateLimiter.check(ip);
  } catch {
    return new Response("Too Many Requests", { status: 429 });
  }
  // 中継先スキーム・ポートの制限（オープンプロキシ乱用対策・#133）。非 http(s)・許可外
  // ポート（既定 80/443・PROXY_ALLOWED_PORTS で追加）は中継せず 403 を返す。
  if (!isAllowedTarget(parsed, allowedPortsFromEnv())) {
    return htmlResponse("このアドレスへのアクセスは許可されていません。", 403);
  }
  // enablejs 等の自己再ナビゲーション無限ループを検出したら、ループを駆動する中継 HTML では
  // なく自動遷移を含まない案内ページを返して打ち切る（429 に達する前に発火）。
  if (navigationLoopGuard.check(ip, parsed)) {
    return loopGuidanceResponse();
  }
  return null;
}

// 中継ティアを選んでターゲットを取得する。ブラウザティアは SSRF 以外の失敗時に
// 中継ティア（proxyFetch）へフォールバックし、ブラウザ依存で全損にしない（#69）。
async function fetchTarget(
  url: string,
  fetchOptions: Parameters<typeof proxyFetch>[1],
  useBrowser: boolean
) {
  if (!useBrowser) return proxyFetch(url, fetchOptions);
  try {
    return await browserFetch(url, fetchOptions);
  } catch (err) {
    // SSRF ブロックは 403 として扱うため伝播させる。
    if (err instanceof SsrfBlockedError) throw err;
    // DOM サイズ上限超過（#144）は中継ティアへフォールバックせず 413 として扱うため伝播させる
    // （フォールバックすると上限超過の中継先を別経路で再取得することになり挙動が揃わない）。
    if (err instanceof BodyTooLargeError) throw err;
    logError("[proxy/browser-fallback]", err);
    return proxyFetch(url, fetchOptions);
  }
}

// proxyFetch とレスポンス処理（HTML 書き換え・サニタイズ・ステータス中継）を
// GET / POST で共通化する。SSRF・到達不能のエラー処理もここに集約する。
// useBrowser が true の GET はブラウザバック中継へ昇格する（POST は常に false）。
// allowAutoPromote が true（GET のみ）の場合、中継ティアの結果が崩れ/チャレンジなら
// browserFetch で自動再取得する（#70）。
export async function relayBrowse(
  parsed: URL,
  fetchOptions?: Parameters<typeof proxyFetch>[1],
  useBrowser = false,
  allowAutoPromote = false,
  ip = "unknown",
  session?: SessionRef
): Promise<Response> {
  // 同時接続数の制限（#133）。スロットを確保し、レスポンス構築後に finally で解放する
  // （ストリーム透過本文の転送中は計上しない）。ip は呼び出し元（route）が getClientIp で解決して渡す。
  let release: () => void;
  try {
    release = relayConcurrencyLimiter.acquire(ip);
  } catch (err) {
    if (err instanceof ConcurrencyLimitExceededError) {
      return err.scope === "global"
        ? htmlResponse(
            "現在アクセスが集中しています。時間をおいて再度お試しください。",
            503
          )
        : htmlResponse(
            "リクエストが多すぎます。時間をおいて再度お試しください。",
            429
          );
    }
    throw err;
  }

  try {
    let res: Response;
    let finalUrl: string;
    try {
      ({ response: res, finalUrl } = await fetchTarget(
        parsed.href,
        fetchOptions,
        useBrowser
      ));
    } catch (err) {
      if (err instanceof SsrfBlockedError) {
        return htmlResponse("アクセスできない URL です。", 403);
      }
      // ブラウザティアの DOM サイズ上限超過（#144）。展開後経路（下の catch）の 413 と
      // メッセージ・ステータスを揃える。
      if (err instanceof BodyTooLargeError) {
        return htmlResponse("ページのサイズが大きすぎます。", 413);
      }
      if (err instanceof FetchTimeoutError) {
        return htmlResponse("サイトに接続できませんでした。", 502);
      }
      // DNS 解決失敗など、その他の予期しないエラー
      logError("[proxy/browse]", err);
      return htmlResponse("サイトへの接続に失敗しました。", 502);
    }

    const contentType = res.headers.get("content-type") ?? "";
    // 中継 Cookie はブラウザへ返さず、リダイレクト追従後の最終 URL の origin（書き換え基準
    // baseUrl と揃える。#42）をキーに jar へ格納する（#151 Phase 1）。新規セッションなら
    // __pxy_sid を発行する。
    storeRelayCookies(session, finalUrl, res.headers);
    let outHeaders = sanitizeHeaders(res.headers);
    issueSessionCookie(session, outHeaders);

    try {
      // 204/304 などボディを持てないステータスはボディを null にして中継する
      // （ボディ付きで Response を構築すると例外になり 500 クラッシュするため）。
      if (isNullBodyStatus(res.status)) {
        return new Response(null, { status: res.status, headers: outHeaders });
      }

      if (!contentType.includes("text/html")) {
        return new Response(res.body, {
          status: res.status,
          headers: outHeaders,
        });
      }

      // 書き換えのため HTML を全量バッファするが、巨大レスポンスによる OOM を防ぐためサイズ
      // 上限を課す（超過は BodyTooLargeError → 413。#134）。
      const maxBytes = maxBufferBytesFromEnv();
      let html = await readTextWithLimit(res, maxBytes);

      // 自動ティア昇格（#70）: 中継ティアの結果が崩れ/チャレンジなら browserFetch で再取得する。
      // allowlist で既にブラウザティア（useBrowser）の場合・POST（allowAutoPromote=false）は対象外。
      // 同一 host+path の再昇格は promotionGuard が抑止し、二重取得コストの無限ループを防ぐ。
      if (
        allowAutoPromote &&
        !useBrowser &&
        autoPromoteEnabledFromEnv() &&
        shouldPromoteToBrowser(html, res.status, contentType) &&
        promotionGuard.tryPromote(parsed)
      ) {
        try {
          const promoted = await browserFetch(parsed.href, fetchOptions);
          res = promoted.response;
          finalUrl = promoted.finalUrl;
          storeRelayCookies(session, finalUrl, res.headers);
          outHeaders = sanitizeHeaders(res.headers);
          issueSessionCookie(session, outHeaders);
          html = await readTextWithLimit(res, maxBytes);
        } catch (err) {
          // 昇格は best-effort。失敗時は初回の中継ティア応答をそのまま使う（全損にしない）。
          logError("[proxy/auto-promote]", err);
        }
      }

      // baseUrl はリダイレクト追従後の最終 URL を用いる（#42）。
      const rewritten = rewriteHtml(html, finalUrl);
      outHeaders.set("Content-Type", "text/html; charset=utf-8");
      return new Response(rewritten, {
        status: res.status,
        headers: outHeaders,
      });
    } catch (err) {
      // 本文が上限超過なら 413（メモリ枯渇 DoS 対策。#134）。
      if (err instanceof BodyTooLargeError) {
        return htmlResponse("ページのサイズが大きすぎます。", 413);
      }
      // ボディ読取り・変換・Response 構築中の予期しない例外は 500 ではなく 502 で返す
      logError("[proxy/browse-render]", err);
      return htmlResponse("サイトの読み込みに失敗しました。", 502);
    }
  } finally {
    // 上流取得〜レスポンス構築までを 1 スロットとして計上し、ここで解放する（#133）。
    release();
  }
}
