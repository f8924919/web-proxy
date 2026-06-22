import { NextRequest } from "next/server";
import { relayAsset, proxyOptions } from "@/lib/proxy/relayAsset";
import { targetFromProxyPath } from "@/lib/proxy/proxyPath";

// アセット中継 Route Handler（パス反映形式 /api/proxy/<scheme>/<host>/<path>・正本。#100）。
// percent-encoding を保つため、デコード済みの catch-all params ではなく生の
// nextUrl.pathname からターゲットを復元し、nextUrl.search をターゲットのクエリとして付す。
// 仕様: docs/spec/features/proxy.md §プロキシ URL スキーム（パス反映）
function handle(req: NextRequest): Promise<Response> {
  const target = targetFromProxyPath(req.nextUrl.pathname, req.nextUrl.search);
  if (!target) {
    return Promise.resolve(new Response("Bad Request", { status: 400 }));
  }
  return relayAsset(req, target);
}

export function GET(req: NextRequest) {
  return handle(req);
}

export function POST(req: NextRequest) {
  return handle(req);
}

export function PUT(req: NextRequest) {
  return handle(req);
}

export function PATCH(req: NextRequest) {
  return handle(req);
}

export function DELETE(req: NextRequest) {
  return handle(req);
}

export function OPTIONS(req: NextRequest) {
  return proxyOptions(req);
}
