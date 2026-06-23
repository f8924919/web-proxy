import { NextRequest } from "next/server";
import { forwardableRequestHeaders } from "@/lib/proxy/headers";
import {
  shouldUseBrowser,
  browserTierConfigFromEnv,
} from "@/lib/proxy/browserFetch";
import { targetFromBrowsePath } from "@/lib/proxy/browsePath";
import {
  relayBrowse,
  browseGuards,
  htmlResponse,
} from "@/lib/proxy/browseRelay";
import { getClientIp } from "@/lib/proxy/clientIp";

// ページ遷移のパス反映ルート（/browse/<scheme>/<host>/<path>・正本。#115）。
// percent-encoding を保つため、デコード済みの catch-all params ではなく生の
// nextUrl.pathname からターゲットを復元し、nextUrl.search をターゲットのクエリとして付す。
// 仕様: docs/spec/features/proxy.md §ページ遷移のパス反映（#115）

export function GET(req: NextRequest) {
  const target = targetFromBrowsePath(req.nextUrl.pathname, req.nextUrl.search);
  if (!target) return htmlResponse("URL が正しくありません。", 400);

  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return htmlResponse("URL が正しくありません。", 400);
  }

  const guard = browseGuards(req, parsed);
  if (guard) return guard;

  // allowlist 指定サイトはブラウザバック中継（browserFetch）へ昇格する（#69）。
  // allowlist 非該当でも、中継ティアの結果が崩れ/チャレンジなら自動昇格する（#70。GET のみ許可）。
  const useBrowser = shouldUseBrowser(parsed.href, browserTierConfigFromEnv());
  return relayBrowse(
    parsed,
    { headers: forwardableRequestHeaders(req.headers, parsed.origin) },
    useBrowser,
    true,
    getClientIp(req.headers)
  );
}

// フォーム POST 送信の中継（パス反映形式）。method / body / Content-Type を転送する。
// 仕様: docs/spec/features/proxy.md §POST 中継
export async function POST(req: NextRequest) {
  const target = targetFromBrowsePath(req.nextUrl.pathname, req.nextUrl.search);
  if (!target) return htmlResponse("URL が指定されていません。", 400);

  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return htmlResponse("URL が正しくありません。", 400);
  }

  const guard = browseGuards(req, parsed);
  if (guard) return guard;

  const headers: Record<string, string> = forwardableRequestHeaders(
    req.headers,
    parsed.origin
  );
  const contentType = req.headers.get("content-type");
  if (contentType) headers["content-type"] = contentType;

  return relayBrowse(
    parsed,
    {
      method: "POST",
      body: req.body,
      headers,
    },
    false,
    false,
    getClientIp(req.headers)
  );
}
