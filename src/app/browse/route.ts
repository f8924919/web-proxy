import { NextRequest } from "next/server";
import { proxyFetch, SsrfBlockedError, FetchTimeoutError } from "@/lib/proxy/fetch";
import { rewriteHtml } from "@/lib/proxy/rewrite";
import { sanitizeHeaders } from "@/lib/proxy/headers";
import { rateLimiter } from "@/lib/proxy/rateLimit";

function errorHtml(message: string): string {
  return `<!DOCTYPE html><html lang="ja"><body style="font-family:sans-serif;padding:2rem">
<h2>エラー</h2><p>${message}</p><a href="/">ホームへ戻る</a></body></html>`;
}

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");

  if (!url) {
    return Response.redirect(new URL("/", req.url), 307);
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

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
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
    throw err;
  }

  const contentType = res.headers.get("content-type") ?? "";
  const outHeaders = sanitizeHeaders(res.headers);

  if (!contentType.includes("text/html")) {
    return new Response(res.body, { status: res.status, headers: outHeaders });
  }

  const html = await res.text();
  const rewritten = rewriteHtml(html, parsed.href);
  outHeaders.set("Content-Type", "text/html; charset=utf-8");
  return new Response(rewritten, { status: res.status, headers: outHeaders });
}
