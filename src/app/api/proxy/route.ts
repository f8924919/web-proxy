import { NextRequest } from "next/server";
import { proxyFetch, SsrfBlockedError } from "@/lib/proxy/fetch";
import { rewriteCss } from "@/lib/proxy/rewrite";
import { sanitizeHeaders } from "@/lib/proxy/headers";
import { rateLimiter } from "@/lib/proxy/rateLimit";

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");

  if (!url) {
    return new Response("Bad Request", { status: 400 });
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return new Response("Bad Request", { status: 400 });
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
      return new Response("Forbidden", { status: 403 });
    }
    return new Response("Bad Gateway", { status: 502 });
  }

  const contentType = res.headers.get("content-type") ?? "";
  const outHeaders = sanitizeHeaders(res.headers);

  if (contentType.includes("text/css")) {
    const css = await res.text();
    const rewritten = rewriteCss(css, parsed.href);
    outHeaders.set("Content-Type", "text/css; charset=utf-8");
    return new Response(rewritten, { status: res.status, headers: outHeaders });
  }

  return new Response(res.body, { status: res.status, headers: outHeaders });
}
