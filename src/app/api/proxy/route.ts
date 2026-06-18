import { NextRequest } from "next/server";
import { proxyFetch, SsrfBlockedError } from "@/lib/proxy/fetch";
import { rewriteCss } from "@/lib/proxy/rewrite";
import {
  sanitizeHeaders,
  forwardableRequestHeaders,
  relayRequestHeaders,
  buildCorsPreflightHeaders,
} from "@/lib/proxy/headers";
import { isNullBodyStatus } from "@/lib/proxy/response";
import { assetRateLimiter } from "@/lib/proxy/rateLimit";
import { getClientIp } from "@/lib/proxy/clientIp";

export async function GET(req: NextRequest) {
  return relayAsset(req);
}

// SW が同一オリジンの /api/proxy へ振り向けた非 GET リクエストの中継。
// 仕様: docs/spec/features/proxy.md §CORS プリフライト対応
export async function POST(req: NextRequest) {
  return relayAsset(req);
}

export async function PUT(req: NextRequest) {
  return relayAsset(req);
}

export async function PATCH(req: NextRequest) {
  return relayAsset(req);
}

export async function DELETE(req: NextRequest) {
  return relayAsset(req);
}

// CORS プリフライト（防御的）。通常は SW の同一オリジン化でプリフライト自体が
// 発生しないが、真のクロスオリジン OPTIONS にも応答できるようにする。
export async function OPTIONS(req: NextRequest) {
  const headers = buildCorsPreflightHeaders(
    req.headers.get("origin"),
    req.headers.get("access-control-request-headers")
  );
  return new Response(null, { status: 204, headers });
}

async function relayAsset(req: NextRequest): Promise<Response> {
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

  const ip = getClientIp(req.headers);
  try {
    assetRateLimiter.check(ip);
  } catch {
    return new Response("Too Many Requests", { status: 429 });
  }

  // GET/HEAD は既存の許可リスト（Cookie/Authorization）を維持。
  // 非 GET は拒否リスト方式で広めにヘッダーを転送し、ボディも転送する。
  const isBodyMethod = req.method !== "GET" && req.method !== "HEAD";
  const headers = isBodyMethod
    ? relayRequestHeaders(req.headers)
    : forwardableRequestHeaders(req.headers);

  let res: Response;
  try {
    res = await proxyFetch(parsed.href, {
      method: req.method,
      body: isBodyMethod ? req.body : undefined,
      headers,
    });
  } catch (err) {
    if (err instanceof SsrfBlockedError) {
      return new Response("Forbidden", { status: 403 });
    }
    return new Response("Bad Gateway", { status: 502 });
  }

  const contentType = res.headers.get("content-type") ?? "";
  const outHeaders = sanitizeHeaders(res.headers);

  // クロスオリジン要求（Origin あり）にのみ CORS 許可ヘッダーを付与する。
  // 同一オリジンのアセット中継には Origin が付かないため影響しない。
  const origin = req.headers.get("origin");
  if (origin) {
    outHeaders.set("Access-Control-Allow-Origin", origin);
    outHeaders.set("Access-Control-Allow-Credentials", "true");
    outHeaders.append("Vary", "Origin");
  }

  try {
    // 204/304 などボディを持てないステータスはボディを null にして中継する
    // （ボディ付きで Response を構築すると例外になり 500 クラッシュするため）。
    if (isNullBodyStatus(res.status)) {
      return new Response(null, { status: res.status, headers: outHeaders });
    }

    if (contentType.includes("text/css")) {
      const css = await res.text();
      const rewritten = rewriteCss(css, parsed.href);
      outHeaders.set("Content-Type", "text/css; charset=utf-8");
      return new Response(rewritten, {
        status: res.status,
        headers: outHeaders,
      });
    }

    return new Response(res.body, { status: res.status, headers: outHeaders });
  } catch (err) {
    // ボディ読取り・変換・Response 構築中の予期しない例外は 500 ではなく 502 で返す
    console.error("[proxy/asset]", err);
    return new Response("Bad Gateway", { status: 502 });
  }
}
