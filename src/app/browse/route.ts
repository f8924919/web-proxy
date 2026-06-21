import { NextRequest } from "next/server";
import {
  proxyFetch,
  SsrfBlockedError,
  FetchTimeoutError,
} from "@/lib/proxy/fetch";
import {
  browserFetch,
  shouldUseBrowser,
  browserTierConfigFromEnv,
} from "@/lib/proxy/browserFetch";
import {
  autoPromoteEnabledFromEnv,
  shouldPromoteToBrowser,
  promotionGuard,
} from "@/lib/proxy/promotion";
import { rewriteHtml, noUrlBrowseHtml } from "@/lib/proxy/rewrite";
import {
  sanitizeHeaders,
  forwardableRequestHeaders,
} from "@/lib/proxy/headers";
import { isNullBodyStatus } from "@/lib/proxy/response";
import { pageRateLimiter } from "@/lib/proxy/rateLimit";
import { navigationLoopGuard, loopGuidanceHtml } from "@/lib/proxy/loopGuard";
import { getClientIp } from "@/lib/proxy/clientIp";

function errorHtml(message: string): string {
  return `<!DOCTYPE html><html lang="ja"><body style="font-family:sans-serif;padding:2rem">
<h2>エラー</h2><p>${message}</p><a href="/">ホームへ戻る</a></body></html>`;
}

function htmlResponse(message: string, status: number): Response {
  return new Response(errorHtml(message), {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

// ナビゲーションループ検出時の静的案内ページ（自動遷移を含まない）。
// 仕様: docs/spec/features/proxy.md §ナビゲーションループの検出
function loopGuidanceResponse(): Response {
  return new Response(loopGuidanceHtml(), {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");

  if (!url) {
    // url 未指定はリダイレクトせず、アドレスバー付き案内ページ(200) をその場で返す。
    // 以前のホーム(${BASE_PATH}/)への 307 はリバースプロキシ配下で 404 になっていた（#74）。
    return new Response(noUrlBrowseHtml(), {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return htmlResponse("URL が正しくありません。", 400);
  }

  const ip = getClientIp(req.headers);
  try {
    pageRateLimiter.check(ip);
  } catch {
    return new Response("Too Many Requests", { status: 429 });
  }

  // enablejs 等の自己再ナビゲーション無限ループを検出したら、ループを駆動する中継 HTML では
  // なく自動遷移を含まない案内ページを返して打ち切る（429 に達する前に発火）。
  if (navigationLoopGuard.check(ip, parsed)) {
    return loopGuidanceResponse();
  }

  // 受信リクエストの Cookie / Authorization をターゲットへ転送し、認証セッションを維持する。
  // Cookie は現ターゲット origin にスコープされた分だけを転送する（サイト間アイソレーション）。
  // allowlist 指定サイトはブラウザバック中継（browserFetch）へ昇格する（#69）。
  // allowlist 非該当でも、中継ティアの結果が崩れ/チャレンジなら自動昇格する（#70。GET のみ許可）。
  const useBrowser = shouldUseBrowser(parsed.href, browserTierConfigFromEnv());
  return relayBrowse(
    parsed,
    {
      headers: forwardableRequestHeaders(req.headers, parsed.origin),
    },
    useBrowser,
    true
  );
}

// フォーム POST 送信の中継。リクエストの method / body / Content-Type をターゲットへ転送する。
// 仕様: docs/spec/features/proxy.md §POST 中継
export async function POST(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");

  // POST は GET のホームリダイレクトと異なり、url 欠落・不正は 400 とする。
  if (!url) {
    return htmlResponse("URL が指定されていません。", 400);
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return htmlResponse("URL が正しくありません。", 400);
  }

  const ip = getClientIp(req.headers);
  try {
    pageRateLimiter.check(ip);
  } catch {
    return new Response("Too Many Requests", { status: 429 });
  }

  if (navigationLoopGuard.check(ip, parsed)) {
    return loopGuidanceResponse();
  }

  // Cookie / Authorization に加え、Content-Type を転送して
  // urlencoded / multipart の境界情報を維持する。
  const headers: Record<string, string> = forwardableRequestHeaders(
    req.headers,
    parsed.origin
  );
  const contentType = req.headers.get("content-type");
  if (contentType) headers["content-type"] = contentType;

  return relayBrowse(parsed, {
    method: "POST",
    body: req.body,
    headers,
  });
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
    console.error("[proxy/browser-fallback]", err);
    return proxyFetch(url, fetchOptions);
  }
}

// proxyFetch とレスポンス処理（HTML 書き換え・サニタイズ・ステータス中継）を
// GET / POST で共通化する。SSRF・到達不能のエラー処理もここに集約する。
// useBrowser が true の GET はブラウザバック中継へ昇格する（POST は常に false）。
// allowAutoPromote が true（GET のみ）の場合、中継ティアの結果が崩れ/チャレンジなら
// browserFetch で自動再取得する（#70）。
async function relayBrowse(
  parsed: URL,
  fetchOptions?: Parameters<typeof proxyFetch>[1],
  useBrowser = false,
  allowAutoPromote = false
): Promise<Response> {
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
    if (err instanceof FetchTimeoutError) {
      return htmlResponse("サイトに接続できませんでした。", 502);
    }
    // DNS 解決失敗など、その他の予期しないエラー
    console.error("[proxy/browse]", err);
    return htmlResponse("サイトへの接続に失敗しました。", 502);
  }

  const contentType = res.headers.get("content-type") ?? "";
  // Set-Cookie のスコープ鍵にはリダイレクト追従後の最終 URL の origin を用いる
  // （書き換え基準 baseUrl と揃える。#42）。
  let outHeaders = sanitizeHeaders(res.headers, new URL(finalUrl).origin);

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

    let html = await res.text();

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
        outHeaders = sanitizeHeaders(res.headers, new URL(finalUrl).origin);
        html = await res.text();
      } catch (err) {
        // 昇格は best-effort。失敗時は初回の中継ティア応答をそのまま使う（全損にしない）。
        console.error("[proxy/auto-promote]", err);
      }
    }

    // baseUrl はリダイレクト追従後の最終 URL を用いる（#42）。
    const rewritten = rewriteHtml(html, finalUrl);
    outHeaders.set("Content-Type", "text/html; charset=utf-8");
    return new Response(rewritten, { status: res.status, headers: outHeaders });
  } catch (err) {
    // ボディ読取り・変換・Response 構築中の予期しない例外は 500 ではなく 502 で返す
    console.error("[proxy/browse-render]", err);
    return htmlResponse("サイトの読み込みに失敗しました。", 502);
  }
}
