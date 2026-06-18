import { NextRequest } from "next/server";
import {
  proxyFetch,
  SsrfBlockedError,
  FetchTimeoutError,
} from "@/lib/proxy/fetch";
import { rewriteHtml } from "@/lib/proxy/rewrite";
import { sanitizeHeaders } from "@/lib/proxy/headers";
import { isNullBodyStatus } from "@/lib/proxy/response";
import { rateLimiter } from "@/lib/proxy/rateLimit";

function errorHtml(message: string): string {
  return `<!DOCTYPE html><html lang="ja"><body style="font-family:sans-serif;padding:2rem">
<h2>エラー</h2><p>${message}</p><a href="/">ホームへ戻る</a></body></html>`;
}

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");

  if (!url) {
    const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
    return Response.redirect(new URL(basePath + "/", req.url), 307);
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return new Response(errorHtml("URL が正しくありません。"), {
      status: 400,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  try {
    rateLimiter.check(ip);
  } catch {
    return new Response("Too Many Requests", { status: 429 });
  }

  let res: Response;
  try {
    res = await proxyFetch(parsed.href);
  } catch (err) {
    if (err instanceof SsrfBlockedError) {
      return new Response(errorHtml("アクセスできない URL です。"), {
        status: 403,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    if (err instanceof FetchTimeoutError) {
      return new Response(errorHtml("サイトに接続できませんでした。"), {
        status: 502,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    // DNS 解決失敗など、その他の予期しないエラー
    console.error("[proxy/browse]", err);
    return new Response(errorHtml("サイトへの接続に失敗しました。"), {
      status: 502,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
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
    const rewritten = rewriteHtml(html, parsed.href);
    outHeaders.set("Content-Type", "text/html; charset=utf-8");
    return new Response(rewritten, { status: res.status, headers: outHeaders });
  } catch (err) {
    // ボディ読取り・変換・Response 構築中の予期しない例外は 500 ではなく 502 で返す
    console.error("[proxy/browse-render]", err);
    return new Response(errorHtml("サイトの読み込みに失敗しました。"), {
      status: 502,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
}
