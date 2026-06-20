#!/usr/bin/env node
// プロキシ表示のヘッドレスブラウザデバッグスクリプト（方式B）。
// 対応 Issue: https://github.com/f8924919/web-proxy/issues/32, #34, #39
// 手順・前提は docs/setup.md「8. ヘッドレスブラウザでのデバッグ（方式B）」を参照。
//
// 使い方:
//   npm run debug:browser -- <url>
//     <url> が http(s):// 始まり  -> プロキシ対象とみなし ${BASE_PATH}/browse?url=<encoded> を開く
//     <url> が / 始まり           -> dev サーバ上のパスとして開く（先頭に BASE_PATH を付与）
//
// 方式B は方式A（code-server のリバースプロキシ）を経由しないため、BASE_PATH 付きパスを
// そのまま叩くと dev サーバで 404 になる（#34）。本スクリプトは .env.local の
// NEXT_PUBLIC_BASE_PATH を読み、方式A 同様プレフィックス込みの URL で開いたうえで、
// 同一オリジンへのリクエストからプレフィックスを剥がして dev サーバへ中継する。
//
// 出力先: scripts/.debug-out/<timestamp>/
//   screenshot.png / console.log / network.json / page.html

import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ORIGIN = process.env.DEBUG_BROWSER_ORIGIN ?? "http://localhost:3000";

// 非負ミリ秒の環境変数を読む。非数値・負値は警告して既定値へフォールバックする。
// 特に TIMEOUT_MS は NaN だと Playwright が「タイムアウト無効（待ち続ける）」と解釈し、
// ベストエフォート出力（#39）の前提が崩れるため、ここで弾く。
function readMs(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return n;
  console.warn(
    `${name} の値 "${raw}" は不正です。0 以上の数値を指定してください。${fallback} にフォールバックします。`
  );
  return fallback;
}

const WAIT_MS = readMs("DEBUG_BROWSER_WAIT_MS", 1500);

// page.goto の待機戦略・タイムアウト（#39）。
// 広告・計測等で常時通信が走るサイトは networkidle に到達せず時間切れになるため、
// 既定は load とし、環境変数で切り替えられるようにする。
const VALID_WAIT_UNTIL = ["load", "domcontentloaded", "networkidle", "commit"];
const WAIT_UNTIL = (() => {
  const v = process.env.DEBUG_BROWSER_WAIT_UNTIL;
  if (v == null || v === "") return "load";
  if (VALID_WAIT_UNTIL.includes(v)) return v;
  console.warn(
    `DEBUG_BROWSER_WAIT_UNTIL の値 "${v}" は不正です。` +
      `${VALID_WAIT_UNTIL.join(" / ")} のいずれかを指定してください。load にフォールバックします。`
  );
  return "load";
})();
const GOTO_TIMEOUT_MS = readMs("DEBUG_BROWSER_TIMEOUT_MS", 30000);

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_ROOT = join(__dirname, ".debug-out");
const ENV_LOCAL = join(__dirname, "..", ".env.local");

// 方式B が再現する BASE_PATH を解決する。Next dev サーバと同じ .env.local を正本とし、
// 明示指定（環境変数）があればそれを優先する。未設定なら BASE_PATH なし（""）。
// node スクリプト単体は .env.local を自動読み込みしないため、ここで明示的に読む。
async function resolveBasePath() {
  if (process.env.DEBUG_BROWSER_BASE_PATH != null) {
    return process.env.DEBUG_BROWSER_BASE_PATH;
  }
  if (process.env.NEXT_PUBLIC_BASE_PATH != null) {
    return process.env.NEXT_PUBLIC_BASE_PATH;
  }
  try {
    const text = await readFile(ENV_LOCAL, "utf8");
    const m = text.match(/^\s*NEXT_PUBLIC_BASE_PATH\s*=\s*(.*)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  } catch {
    // .env.local が無ければ BASE_PATH なしとみなす。
  }
  return "";
}

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
// basePath を前置し、方式A（実ブラウザの URL が /proxy/3000/... になる）と同じ
// プレフィックス込みのページ URL で開く。これにより SW のスコープ（${basePath}/）が
// ページを覆い、ページ内遷移・サブリソースも方式A と同じパスで解決される。
function resolveTarget(arg, basePath) {
  if (arg.startsWith("http://") || arg.startsWith("https://")) {
    return `${ORIGIN}${basePath}/browse?url=${encodeURIComponent(arg)}`;
  }
  if (arg.startsWith("/")) {
    return `${ORIGIN}${basePath}${arg}`;
  }
  return null;
}

async function main() {
  const arg = process.argv[2];
  if (!arg) usageAndExit();

  // 方式B が再現する BASE_PATH（方式A のリバースプロキシ前提）を先に解決する。
  const basePath = await resolveBasePath();

  const targetUrl = resolveTarget(arg, basePath);
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

  // 方式B はリバースプロキシ（code-server のポート転送）を経由しないため、
  // BASE_PATH 付き絶対パス（例 /proxy/3000/sw.js）が dev サーバで 404 になる（#34）。
  // 方式A のプレフィックス除去を肩代わりし、同一オリジンへの BASE_PATH 付きリクエストを
  // プレフィックスを剥がして中継する。Service Worker 取得も拾うため context.route を使う。
  if (basePath) {
    console.log(`BASE_PATH 除去を有効化: ${basePath} (方式A 再現)`);
    await page.context().route(`${ORIGIN}${basePath}/**`, async (route) => {
      const url = new URL(route.request().url());
      url.pathname = url.pathname.slice(basePath.length);
      await route.continue({ url: url.toString() });
    });
  }

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
  console.log(`待機戦略: ${WAIT_UNTIL} / タイムアウト: ${GOTO_TIMEOUT_MS}ms`);
  let mainStatus = null;
  let gotoError = null;
  try {
    const resp = await page.goto(targetUrl, {
      waitUntil: WAIT_UNTIL,
      timeout: GOTO_TIMEOUT_MS,
    });
    mainStatus = resp?.status() ?? null;
  } catch (err) {
    // goto がタイムアウト/失敗してもここで終了せず、収集済みの結果を
    // ベストエフォートで出力する（#39。タイムアウト＝全損にしない）。
    gotoError = err;
    console.error(
      `ページの読み込みに失敗しました: ${err.message}\n` +
        `収集済みの結果をベストエフォートで出力します。` +
        `（タイムアウト時は DEBUG_BROWSER_WAIT_UNTIL / DEBUG_BROWSER_TIMEOUT_MS の調整、` +
        `または dev サーバ (${ORIGIN}) の起動を確認してください）`
    );
  }

  // JS 実行（リダイレクト等）の落ち着きを待ってから状態を取る。
  // goto 失敗後でも、収集済みの状態を取りに行く（個々の取得失敗は握りつぶす）。
  await page.waitForTimeout(WAIT_MS).catch(() => {});

  let finalUrl = null;
  try {
    finalUrl = page.url();
  } catch {
    /* ページが取得不能なら null のまま */
  }

  let html = null;
  try {
    html = await page.content();
  } catch (err) {
    consoleLines.push(
      `[debug-browser] page.content() 取得失敗: ${err.message}`
    );
  }

  try {
    await page.screenshot({
      path: join(outDir, "screenshot.png"),
      fullPage: true,
    });
  } catch (err) {
    consoleLines.push(`[debug-browser] screenshot 取得失敗: ${err.message}`);
  }

  await writeFile(join(outDir, "console.log"), consoleLines.join("\n") + "\n");
  await writeFile(
    join(outDir, "network.json"),
    JSON.stringify(networkEntries, null, 2) + "\n"
  );
  if (html != null) {
    await writeFile(join(outDir, "page.html"), html);
  }

  await browser.close();

  console.log("--- 結果 ---");
  console.log(`HTTP ステータス  : ${mainStatus}`);
  console.log(`最終 URL         : ${finalUrl}`);
  console.log(`console 行数      : ${consoleLines.length}`);
  console.log(`network エントリ  : ${networkEntries.length}`);
  console.log(`出力先           : ${outDir}`);

  // goto が失敗していた場合は、結果を出したうえで終了コード 2 を返す。
  if (gotoError) process.exit(2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
