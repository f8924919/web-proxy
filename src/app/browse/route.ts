import { NextRequest } from "next/server";
import {
  proxyFetch,
  SsrfBlockedError,
  FetchTimeoutError,
} from "@/lib/proxy/fetch";
import { rewriteHtml } from "@/lib/proxy/rewrite";
import {
  sanitizeHeaders,
  forwardableRequestHeaders,
} from "@/lib/proxy/headers";
import { isNullBodyStatus, relativeRedirect } from "@/lib/proxy/response";
import { pageRateLimiter } from "@/lib/proxy/rateLimit";
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

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");

  if (!url) {
    // 相対 Location でホームへ。req.url から絶対 URL を組むと、リバースプロキシ /
    // ポート転送越しで内部オリジン（localhost）が漏れるため使わない。
    const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
    return relativeRedirect(`${basePath}/`, 307);
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

  // 受信リクエストの Cookie / Authorization をターゲットへ転送し、認証セッションを維持する。
  return relayBrowse(parsed, {
    headers: forwardableRequestHeaders(req.headers),
  });
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

  // Cookie / Authorization に加え、Content-Type を転送して
  // urlencoded / multipart の境界情報を維持する。
  const headers: Record<string, string> = forwardableRequestHeaders(
    req.headers
  );
  const contentType = req.headers.get("content-type");
  if (contentType) headers["content-type"] = contentType;

  return relayBrowse(parsed, {
    method: "POST",
    body: req.body,
    headers,
  });
}

// proxyFetch とレスポンス処理（HTML 書き換え・サニタイズ・ステータス中継）を
// GET / POST で共通化する。SSRF・到達不能のエラー処理もここに集約する。
async function relayBrowse(
  parsed: URL,
  fetchOptions?: Parameters<typeof proxyFetch>[1]
): Promise<Response> {
  let res: Response;
  let finalUrl: string;
  try {
    ({ response: res, finalUrl } = await proxyFetch(parsed.href, fetchOptions));
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
  const outHeaders = sanitizeHeaders(res.headers);

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

    const html = await res.text();
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
