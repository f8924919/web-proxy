#!/usr/bin/env node
// プロキシ表示のヘッドレスブラウザデバッグスクリプト（方式B）。
// 対応 Issue: https://github.com/f8924919/web-proxy/issues/32
// 手順・前提は docs/setup.md「8. ヘッドレスブラウザでのデバッグ（方式B）」を参照。
//
// 使い方:
//   npm run debug:browser -- <url>
//     <url> が http(s):// 始まり  -> プロキシ対象とみなし /browse?url=<encoded> を開く
//     <url> が / 始まり           -> dev サーバ上のパスとしてそのまま開く（/ や /browse?url=... を直接指定）
//
// 出力先: scripts/.debug-out/<timestamp>/
//   screenshot.png / console.log / network.json / page.html

import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ORIGIN = process.env.DEBUG_BROWSER_ORIGIN ?? "http://localhost:3000";
const WAIT_MS = Number(process.env.DEBUG_BROWSER_WAIT_MS ?? 1500);

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_ROOT = join(__dirname, ".debug-out");

function usageAndExit() {
  console.error(
    "使い方: npm run debug:browser -- <url>\n" +
      "  例) npm run debug:browser -- https://example.com\n" +
      "  例) npm run debug:browser -- /\n" +
      "  例) npm run debug:browser -- '/browse?url=https://example.com'"
  );
  process.exit(1);
}

// 引数を dev サーバ上で開く絶対 URL へ解決する。
function resolveTarget(arg) {
  if (arg.startsWith("http://") || arg.startsWith("https://")) {
    return `${ORIGIN}/browse?url=${encodeURIComponent(arg)}`;
  }
  if (arg.startsWith("/")) {
    return `${ORIGIN}${arg}`;
  }
  return null;
}

async function main() {
  const arg = process.argv[2];
  if (!arg) usageAndExit();

  const targetUrl = resolveTarget(arg);
  if (!targetUrl) {
    console.error(
      `URL は http(s):// もしくは / から始めてください（受け取った値: ${arg}）`
    );
    usageAndExit();
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = join(OUT_ROOT, stamp);
  await mkdir(outDir, { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage();

  // console 出力を収集する。
  const consoleLines = [];
  page.on("console", (msg) => {
    consoleLines.push(`[${msg.type()}] ${msg.text()}`);
  });
  page.on("pageerror", (err) => {
    consoleLines.push(`[pageerror] ${err.message}`);
  });

  // network のリクエスト・レスポンスを収集する。
  const networkEntries = [];
  const byRequest = new Map();
  page.on("request", (req) => {
    const entry = {
      method: req.method(),
      url: req.url(),
      resourceType: req.resourceType(),
      status: null,
      requestHeaders: req.headers(),
    };
    byRequest.set(req, entry);
    networkEntries.push(entry);
  });
  page.on("response", (res) => {
    const entry = byRequest.get(res.request());
    if (entry) {
      entry.status = res.status();
      entry.responseHeaders = res.headers();
    }
  });
  page.on("requestfailed", (req) => {
    const entry = byRequest.get(req);
    if (entry) entry.failure = req.failure()?.errorText ?? "failed";
  });

  console.log(`対象 URL: ${targetUrl}`);
  let mainStatus = null;
  try {
    const resp = await page.goto(targetUrl, {
      waitUntil: "networkidle",
      timeout: 30000,
    });
    mainStatus = resp?.status() ?? null;
  } catch (err) {
    console.error(
      `ページの読み込みに失敗しました: ${err.message}\n` +
        `dev サーバ (${ORIGIN}) が起動しているか確認してください（npm run dev）。`
    );
    await browser.close();
    process.exit(2);
  }

  // JS 実行（リダイレクト等）の落ち着きを待ってから状態を取る。
  await page.waitForTimeout(WAIT_MS);

  const finalUrl = page.url();
  const html = await page.content();

  await page.screenshot({
    path: join(outDir, "screenshot.png"),
    fullPage: true,
  });
  await writeFile(join(outDir, "console.log"), consoleLines.join("\n") + "\n");
  await writeFile(
    join(outDir, "network.json"),
    JSON.stringify(networkEntries, null, 2) + "\n"
  );
  await writeFile(join(outDir, "page.html"), html);

  await browser.close();

  console.log("--- 結果 ---");
  console.log(`HTTP ステータス  : ${mainStatus}`);
  console.log(`最終 URL         : ${finalUrl}`);
  console.log(`console 行数      : ${consoleLines.length}`);
  console.log(`network エントリ  : ${networkEntries.length}`);
  console.log(`出力先           : ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
