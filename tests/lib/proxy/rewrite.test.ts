/** @jest-environment node */
// 仕様: docs/spec/features/proxy.md §HTML 書き換え / §CSS URL 書き換え / §url 未指定時の案内ページ

import {
  rewriteHtml,
  rewriteCss,
  rewriteSrcset,
  buildGetFormDestination,
  buildClickNavDestination,
  buildNavApiRedirect,
  browseNavPrefix,
  extractBrowseTarget,
  buildBrowseDest,
  noUrlBrowseHtml,
  isProxyOwnPath,
  buildRequestInterceptUrl,
  fetchInputUrl,
  escapeHtml,
} from "@/lib/proxy/rewrite";

const BASE = "https://example.com";

// パス反映形式（/api/proxy/<scheme>/<host>/<path>）の独立オラクル（#100）。
// 実装 buildProxyPath とは別に組み立て、書き換え結果を検証する。
const asset = (urlOrPath: string): string => {
  const u = new URL(urlOrPath, BASE);
  return `/api/proxy/${u.protocol.replace(/:$/, "")}/${u.host}${u.pathname}${u.search}${u.hash}`;
};

// パス反映ナビ形式（/browse/<scheme>/<host>/<path>）の独立オラクル（#115）。
// 実装 buildBrowsePath とは別に組み立て、書き換え結果を検証する。
const nav = (urlOrPath: string): string => {
  const u = new URL(urlOrPath, BASE);
  return `/browse/${u.protocol.replace(/:$/, "")}/${u.host}${u.pathname}${u.search}${u.hash}`;
};

describe("rewriteHtml", () => {
  describe("<a href> → /browse（パス反映・#115）", () => {
    test("絶対 URL をパス反映ナビ形式に書き換える", () => {
      const html = `<a href="https://example.com/about">link</a>`;
      const result = rewriteHtml(html, BASE);
      expect(result).toContain(`href="${nav("https://example.com/about")}"`);
    });

    test("相対パスをベース URL で解決してパス反映ナビ形式に書き換える", () => {
      const html = `<a href="/contact">link</a>`;
      const result = rewriteHtml(html, BASE);
      expect(result).toContain(`href="${nav("/contact")}"`);
    });
  });

  describe("<form action> → /browse（パス反映・#115）", () => {
    test("フォームの action をパス反映ナビ形式に書き換える", () => {
      const html = `<form action="/search"></form>`;
      const result = rewriteHtml(html, BASE);
      expect(result).toContain(`action="${nav("/search")}"`);
    });
  });

  describe("<meta http-equiv=refresh> → /browse（パス反映・#115）", () => {
    // 仕様: docs/spec/features/proxy.md §meta refresh の書き換え
    test("ルート相対 url を baseUrl 基準で解決しパス反映ナビ形式に書き換える（遅延は保持）", () => {
      const html = `<meta http-equiv="refresh" content="0;url=/httpservice/retry/enablejs?sei=x">`;
      const result = rewriteHtml(html, BASE);
      expect(result).toContain(
        `content="0;url=${nav("https://example.com/httpservice/retry/enablejs?sei=x")}"`
      );
    });

    test("絶対 url をそのままパス反映ナビ形式に書き換える（遅延を保持）", () => {
      const html = `<meta http-equiv="refresh" content="5; url=https://other.example/next">`;
      const result = rewriteHtml(html, BASE);
      expect(result).toContain(nav("https://other.example/next"));
      expect(result).toMatch(
        /content="5;\s*url=\/browse\/https\/other\.example/
      );
    });

    test("http-equiv の大文字小文字を無視して書き換える", () => {
      const html = `<meta http-equiv="REFRESH" content="0;URL=/foo">`;
      const result = rewriteHtml(html, BASE);
      expect(result).toContain(nav("/foo"));
    });

    test("シングルクォート付き url も書き換える", () => {
      const html = `<meta http-equiv="refresh" content="0; url='/bar'">`;
      const result = rewriteHtml(html, BASE);
      expect(result).toContain(nav("/bar"));
    });

    test("url を持たない純粋な遅延 refresh は書き換えない", () => {
      const html = `<meta http-equiv="refresh" content="5">`;
      const result = rewriteHtml(html, BASE);
      expect(result).toContain(`content="5"`);
      expect(result).not.toContain("/browse?url=");
    });

    test("http(s) に解決されない url（mailto 等）は書き換えない", () => {
      const html = `<meta http-equiv="refresh" content="0;url=mailto:a@example.com">`;
      const result = rewriteHtml(html, BASE);
      expect(result).toContain("mailto:a@example.com");
      expect(result).not.toContain("/browse?url=");
    });

    test("refresh 以外の http-equiv は対象外", () => {
      const html = `<meta http-equiv="content-type" content="text/html;url=/x">`;
      const result = rewriteHtml(html, BASE);
      expect(result).not.toContain("/browse?url=");
    });
  });

  describe("静的アセット → /api/proxy", () => {
    test.each([
      ["<img src>", `<img src="/logo.png">`, "src", "/logo.png"],
      [
        "<link rel=stylesheet href>",
        `<link rel="stylesheet" href="/style.css">`,
        "href",
        "/style.css",
      ],
      ["<script src>", `<script src="/app.js"></script>`, "src", "/app.js"],
    ])("%s を /api/proxy に書き換える", (_label, html, attr, path) => {
      const result = rewriteHtml(html, BASE);
      const expected = asset(path);
      expect(result).toContain(`${attr}="${expected}"`);
    });
  });

  describe("srcset の書き換え（#98）", () => {
    const proxied = (path: string) => asset(path);

    test("<img srcset> の各候補を書き換え記述子を保持する", () => {
      const result = rewriteHtml(`<img srcset="/a.png 1x, /b.png 2x">`, BASE);
      expect(result).toContain(
        `srcset="${proxied("/a.png")} 1x, ${proxied("/b.png")} 2x"`
      );
    });

    test("<source srcset> の幅記述子（w）を保持する", () => {
      const result = rewriteHtml(
        `<picture><source srcset="/a.png 640w, /b.png 1280w"></picture>`,
        BASE
      );
      expect(result).toContain(
        `srcset="${proxied("/a.png")} 640w, ${proxied("/b.png")} 1280w"`
      );
    });

    test("Next.js <Image> の /_next/image?url= を /api/proxy 経由へ振り向ける（400 回避）", () => {
      const inner = "https://s.yimg.jp/i/kids/x.png";
      const nextSrc = `/_next/image?url=${encodeURIComponent(inner)}&w=256&q=75`;
      const result = rewriteHtml(`<img srcset="${nextSrc} 1x">`, BASE);
      // proxy origin 直下の /_next/image ではなく、上流の最適化 URL を中継する
      expect(result).toContain(proxied(nextSrc));
      expect(result).not.toMatch(/srcset="\/_next\/image/);
    });
  });

  describe("<iframe src> → /browse（#135）", () => {
    // 仕様: docs/spec/features/proxy.md §書き換えルール（iframe・#135）
    test("絶対 URL の iframe src をパス反映ナビ形式に書き換える", () => {
      const result = rewriteHtml(
        `<iframe src="https://example.com/embed"></iframe>`,
        BASE
      );
      expect(result).toContain(`src="${nav("https://example.com/embed")}"`);
    });

    test("相対パスの iframe src をベース URL で解決して書き換える", () => {
      const result = rewriteHtml(`<iframe src="/embed"></iframe>`, BASE);
      expect(result).toContain(`src="${nav("/embed")}"`);
    });
  });

  describe("メディア要素 → /api/proxy（#135）", () => {
    // 仕様: docs/spec/features/proxy.md §書き換えルール（video / audio / source・#135）
    test("<video src> を /api/proxy に書き換える", () => {
      const result = rewriteHtml(`<video src="/movie.mp4"></video>`, BASE);
      expect(result).toContain(`src="${asset("/movie.mp4")}"`);
    });

    test("<audio src> を /api/proxy に書き換える", () => {
      const result = rewriteHtml(`<audio src="/sound.mp3"></audio>`, BASE);
      expect(result).toContain(`src="${asset("/sound.mp3")}"`);
    });

    test("<video> 内の <source src> も /api/proxy に書き換える", () => {
      const result = rewriteHtml(
        `<video><source src="/movie.webm"></video>`,
        BASE
      );
      expect(result).toContain(`src="${asset("/movie.webm")}"`);
    });
  });

  describe("<base href> の処理（枠外離脱防止・#135）", () => {
    // 仕様: docs/spec/features/proxy.md §<base href> の処理（枠外離脱防止・#135）
    test("絶対 base href を解決基点に取り込み相対 URL を再ベースする", () => {
      const html = `<base href="https://cdn.example.com/v2/"><img src="logo.png">`;
      const result = rewriteHtml(html, BASE);
      expect(result).toContain(
        `src="${asset("https://cdn.example.com/v2/logo.png")}"`
      );
    });

    test("相対値の base href も baseUrl で解決して再ベースする", () => {
      const html = `<base href="/assets/"><img src="logo.png">`;
      const result = rewriteHtml(html, BASE);
      expect(result).toContain(`src="${asset("/assets/logo.png")}"`);
    });

    test("処理後に base の href を除去し、相対リンクはプロキシ経由へ再ベースする", () => {
      const html = `<base href="https://other.example/app/"><a href="x">l</a>`;
      const result = rewriteHtml(html, BASE);
      // <base href> は除去する（ブラウザ直接解決による枠外離脱を防ぐ）
      expect(result).not.toMatch(/<base[^>]*\shref=/i);
      // 相対リンクは effectiveBase 基準で解決されプロキシ経由になる
      expect(result).toContain(`href="${nav("https://other.example/app/x")}"`);
    });

    test("base の target など href 以外の属性は保持する", () => {
      const html = `<base target="_blank" href="https://cdn.example.com/">`;
      const result = rewriteHtml(html, BASE);
      expect(result).toContain(`target="_blank"`);
      expect(result).not.toMatch(/<base[^>]*\shref=/i);
    });

    test("http(s) に解決できない base href は基点に採用せず baseUrl を用いる", () => {
      const html = `<base href="about:blank"><img src="/x.png">`;
      const result = rewriteHtml(html, BASE);
      expect(result).toContain(`src="${asset("/x.png")}"`);
      expect(result).not.toMatch(/<base[^>]*\shref=/i);
    });
  });

  describe("SRI 属性の除去（A1）", () => {
    // 仕様: docs/spec/features/proxy.md §サブリソース整合性（SRI）属性の除去
    test("src を書き換える script から integrity / crossorigin を除去する", () => {
      const html = `<script src="/app.js" integrity="sha256-abc" crossorigin="anonymous"></script>`;
      const result = rewriteHtml(html, BASE);
      expect(result).toContain(`src="${asset("/app.js")}"`);
      expect(result).not.toContain("integrity");
      expect(result).not.toContain("crossorigin");
    });

    test("integrity を持たない script は src のみ書き換え従来どおり", () => {
      const html = `<script src="/app.js"></script>`;
      const result = rewriteHtml(html, BASE);
      expect(result).toContain(`src="${asset("/app.js")}"`);
      expect(result).not.toContain("integrity");
    });

    test("src を持たないインライン script の中身・属性は触らない", () => {
      const html = `<script integrity="sha256-keep">var a = 1;</script>`;
      const result = rewriteHtml(html, BASE);
      expect(result).toContain("var a = 1;");
      expect(result).toContain(`integrity="sha256-keep"`);
    });
  });

  describe("inline meta CSP の除去（A2）", () => {
    // 仕様: docs/spec/features/proxy.md §inline CSP（meta）の除去
    test("http-equiv=Content-Security-Policy の meta を除去する", () => {
      const html = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'">`;
      const result = rewriteHtml(html, BASE);
      expect(result).not.toContain("Content-Security-Policy");
      expect(result).not.toContain("default-src");
    });

    test("http-equiv の大文字小文字を無視して除去する", () => {
      const html = `<meta http-equiv="CONTENT-SECURITY-POLICY" content="default-src 'self'">`;
      const result = rewriteHtml(html, BASE);
      expect(result).not.toContain("default-src");
    });

    test("Content-Security-Policy-Report-Only は素通しする", () => {
      const html = `<meta http-equiv="Content-Security-Policy-Report-Only" content="default-src 'self'">`;
      const result = rewriteHtml(html, BASE);
      expect(result).toContain("Content-Security-Policy-Report-Only");
      expect(result).toContain("default-src 'self'");
    });

    test("CSP 以外の meta（refresh）は影響を受けない", () => {
      const html = `<meta http-equiv="refresh" content="0;url=/foo">`;
      const result = rewriteHtml(html, BASE);
      expect(result).toContain(nav("/foo"));
    });
  });

  test("アドレスバー HTML スニペットを <body> 直後に注入する", () => {
    const html = `<html><body><p>hello</p></body></html>`;
    const result = rewriteHtml(html, BASE);
    const bodyIdx = result.indexOf("<body>");
    const barIdx = result.indexOf('id="proxy-addressbar"');
    expect(barIdx).toBeGreaterThan(bodyIdx);
  });

  // 仕様: docs/spec/screens/browse.md §アドレスバー / docs/arch/proxy.md §アドレスバー注入（#137）
  describe("アドレスバー URL の HTML エスケープ（#137）", () => {
    // value="…" 属性内の文字列（最初の生 " までを切り出す。エスケープ済みなら
    // 値の途中に生 " は現れないため終端を正しく検出できる）。
    const addressBarValue = (html: string): string => {
      const bar = html.slice(html.indexOf('id="proxy-addressbar"'));
      const marker = '<input value="';
      const start = bar.indexOf(marker) + marker.length;
      const end = bar.indexOf('"', start);
      return bar.slice(start, end);
    };

    test("& < > \" ' を含む URL を一括実体化して value へ埋め込む", () => {
      const url = `https://example.com/?q=<i>&p='x'&r="y"`;
      const result = rewriteHtml(`<html><body></body></html>`, url);
      expect(addressBarValue(result)).toBe(
        `https://example.com/?q=&lt;i&gt;&amp;p=&#39;x&#39;&amp;r=&quot;y&quot;`
      );
    });

    test("属性ブレイクアウトとなる生の < > ' を value 内へ出力しない", () => {
      const url = `https://example.com/?x=<script>alert(1)</script>&y='z'`;
      const value = addressBarValue(
        rewriteHtml(`<html><body></body></html>`, url)
      );
      expect(value).not.toMatch(/[<>']/);
      expect(value).not.toContain("<script>");
    });
  });

  // 仕様: docs/spec/screens/browse.md §コンテンツエリア / docs/arch/proxy.md §アドレスバー注入（#108）
  describe("アドレスバーのビューポート固定（#108）", () => {
    const html = `<html><body><p>hello</p></body></html>`;

    test("バーは position:fixed で、sticky は使わない（body{height:100%} のサイトで消えるため）", () => {
      const result = rewriteHtml(html, BASE);
      const bar = result.slice(result.indexOf('id="proxy-addressbar"'));
      const barTag = bar.slice(0, bar.indexOf(">"));
      expect(barTag).toMatch(/position\s*:\s*fixed/);
      expect(barTag).not.toMatch(/position\s*:\s*sticky/);
    });

    test("バー直後にスペーサー要素を注入してコンテンツの重なりを防ぐ", () => {
      const result = rewriteHtml(html, BASE);
      const barIdx = result.indexOf('id="proxy-addressbar"');
      const spacerIdx = result.indexOf('id="proxy-addressbar-spacer"');
      expect(spacerIdx).toBeGreaterThan(barIdx);
    });

    test("スペーサー高をバーの実レンダリング高へ同期するスクリプトを注入する", () => {
      const result = rewriteHtml(html, BASE);
      // バー高（offsetHeight）をスペーサーの height へ反映し、resize にも追従する
      expect(result).toContain("proxy-addressbar-spacer");
      expect(result).toMatch(/offsetHeight/);
      expect(result).toMatch(/addEventListener\(\s*['"]resize['"]/);
    });
  });

  test("GET フォーム送信横取りスクリプトを <body> 直後に注入する", () => {
    const html = `<html><body><p>hello</p></body></html>`;
    const result = rewriteHtml(html, BASE);
    const bodyIdx = result.indexOf("<body>");
    const scriptIdx = result.indexOf("addEventListener('submit'");
    expect(scriptIdx).toBeGreaterThan(bodyIdx);
  });

  test("クリック横取りは capture・stopImmediatePropagation・#proxy-addressbar 除外を含む（#82）", () => {
    const html = `<html><body><p>hello</p></body></html>`;
    const result = rewriteHtml(html, BASE);
    // capture フェーズ委任（SPA の onClick より先に発火）
    expect(result).toContain("addEventListener('click'");
    // SPA ルーターの onClick 横取りを阻止
    expect(result).toContain("stopImmediatePropagation");
    // 自前 UI（アドレスバー）内は除外
    expect(result).toContain("proxy-addressbar");
  });

  describe("document.domain ドメインガード無効化シム", () => {
    // 仕様: docs/spec/features/proxy.md §document.domain ドメインガードの無効化
    const YAHOO = "https://news.yahoo.co.jp/categories/science";

    test("シムを <head> 最先頭（既存 head 要素より前）に注入する", () => {
      const html = `<html><head><title>t</title></head><body><p>hi</p></body></html>`;
      const result = rewriteHtml(html, YAHOO);
      const headIdx = result.indexOf("<head>");
      const shimIdx = result.indexOf("Document.prototype");
      const titleIdx = result.indexOf("<title>");
      expect(shimIdx).toBeGreaterThan(headIdx);
      expect(shimIdx).toBeLessThan(titleIdx);
    });

    test("ターゲット URL のホスト名（パス・スキーム抜き）を見せかける", () => {
      const result = rewriteHtml(
        `<html><head></head><body></body></html>`,
        YAHOO
      );
      expect(result).toContain('return "news.yahoo.co.jp"');
    });

    test("シムは <body> 直後の既存注入より前に位置する（先に実行される）", () => {
      const html = `<html><head></head><body><p>hi</p></body></html>`;
      const result = rewriteHtml(html, BASE);
      const shimIdx = result.indexOf("Document.prototype");
      const barIdx = result.indexOf('id="proxy-addressbar"');
      expect(shimIdx).toBeGreaterThan(-1);
      expect(shimIdx).toBeLessThan(barIdx);
    });

    test("<head> が無ければ <html> 直後にフォールバック注入する", () => {
      const html = `<html><body><p>hi</p></body></html>`;
      const result = rewriteHtml(html, BASE);
      const htmlIdx = result.indexOf("<html>");
      const shimIdx = result.indexOf("Document.prototype");
      const bodyIdx = result.indexOf("<body>");
      expect(shimIdx).toBeGreaterThan(htmlIdx);
      expect(shimIdx).toBeLessThan(bodyIdx);
    });

    test("<head> も <html> も無ければ文書先頭に注入する", () => {
      const result = rewriteHtml(`<p>hi</p>`, BASE);
      expect(result.trimStart().startsWith("<script>")).toBe(true);
      expect(result).toContain("Document.prototype");
    });

    test("baseUrl が不正でホスト名を導出できない場合はシムを注入しない", () => {
      const result = rewriteHtml(
        `<html><head></head><body></body></html>`,
        "not a url"
      );
      expect(result).not.toContain("Document.prototype");
    });
  });
});

describe("buildGetFormDestination", () => {
  // 仕様: docs/spec/features/proxy.md §GET フォーム送信の横取り（パス反映・#115）
  // パス反映の閲覧ページ／action から target を復元し、フォーム項目でクエリを置き換えて
  // パス反映ナビ形式 /browse/<scheme>/<host>/<path>?<再構築> を返す。
  const PAGE = `https://proxy.test${nav("https://example.com")}`;

  test("GET フォーム: ターゲットのクエリをフォーム項目で置き換えてパス反映ナビへ遷移", () => {
    const action = nav("https://example.com/search");
    const dest = buildGetFormDestination("get", action, PAGE, [
      ["q", "hello world"],
    ]);
    expect(dest).toBe(nav("https://example.com/search?q=hello+world"));
  });

  test("method 未指定は GET 扱いで横取りする", () => {
    const action = nav("https://example.com/search");
    const dest = buildGetFormDestination("", action, PAGE, [["q", "x"]]);
    expect(dest).toBe(nav("https://example.com/search?q=x"));
  });

  test("BASE_PATH（リバースプロキシのパスプレフィックス）を遷移先で保持する", () => {
    const action = `/proxy/3000${nav("https://example.com/search")}`;
    const page = `https://proxy.test/proxy/3000${nav("https://example.com")}`;
    const dest = buildGetFormDestination("get", action, page, [["q", "x"]]);
    expect(dest).toBe(`/proxy/3000${nav("https://example.com/search?q=x")}`);
  });

  test("Google 検索相当: BASE_PATH 付き action＋複数項目をパス反映ナビに復元する（#78）", () => {
    // form.submit() オーバーライド経路でも本関数を共用する。
    const action = `/proxy/3000${nav("https://www.google.com/search")}`;
    const page = `https://proxy.test/proxy/3000${nav("https://www.google.com")}`;
    const dest = buildGetFormDestination("get", action, page, [
      ["q", "playwright test"],
      ["hl", "ja"],
    ]);
    expect(dest).toBe(
      `/proxy/3000${nav("https://www.google.com/search?q=playwright+test&hl=ja")}`
    );
  });

  test("後方互換: action / 閲覧ページが旧 ?url= 形式でもパス反映ナビへ復元する", () => {
    const action = `/browse?url=${encodeURIComponent("https://example.com/search")}`;
    const page = `https://proxy.test/browse?url=${encodeURIComponent("https://example.com")}`;
    const dest = buildGetFormDestination("get", action, page, [["q", "x"]]);
    expect(dest).toBe(nav("https://example.com/search?q=x"));
  });

  test("絶対クロスオリジン action（ハイドレーションで復元された実 URL）をそのまま proxify する（#164）", () => {
    // React 等のハイドレーションで action がパス反映 URL から実サイト絶対 URL（閲覧ページと
    // 別オリジン）へ戻るケース。閲覧ページ（example.com）へフォールバックせず、action の
    // ホスト（search.example.com）自体を実ターゲットとして直接 proxify する。
    const dest = buildGetFormDestination(
      "get",
      "https://search.example.com/search",
      PAGE,
      [["q", "hello world"]]
    );
    expect(dest).toBe(nav("https://search.example.com/search?q=hello+world"));
  });

  test("絶対クロスオリジン action でも BASE_PATH を遷移先で保持する（#164）", () => {
    const page = `https://proxy.test/proxy/3000${nav("https://www.example.com")}`;
    const dest = buildGetFormDestination(
      "get",
      "https://search.example.com/search",
      page,
      [["q", "x"]]
    );
    expect(dest).toBe(
      `/proxy/3000${nav("https://search.example.com/search?q=x")}`
    );
  });

  test("POST フォームは横取りしない（null を返す）", () => {
    const action = nav("https://example.com/search");
    expect(
      buildGetFormDestination("post", action, PAGE, [["q", "x"]])
    ).toBeNull();
  });

  test("action 属性なし: 閲覧ページから target をフォールバック復元する", () => {
    const page = `https://proxy.test${nav("https://example.com/page")}`;
    const dest = buildGetFormDestination("get", "", page, [["q", "x"]]);
    expect(dest).toBe(nav("https://example.com/page?q=x"));
  });

  test("ターゲットを復元できない場合は null を返す", () => {
    // パス反映マーカーも url= も無い
    expect(
      buildGetFormDestination("get", "/browse", "https://proxy.test/", [
        ["q", "x"],
      ])
    ).toBeNull();
  });
});

describe("ナビ横取りヘルパー（browseNavPrefix / extractBrowseTarget / buildBrowseDest・#115）", () => {
  test("browseNavPrefix: パス反映ページは …/browse/ まで・後方互換は + /", () => {
    expect(
      browseNavPrefix("https://p.test/proxy/3000/browse/https/x.com/y")
    ).toBe("/proxy/3000/browse/");
    expect(
      browseNavPrefix("https://p.test/browse?url=https%3A%2F%2Fx.com")
    ).toBe("/browse/");
    expect(browseNavPrefix("https://p.test/other")).toBeNull();
  });

  test("extractBrowseTarget: パス反映 / 後方互換 ?url= の両方から復元", () => {
    expect(
      extractBrowseTarget("https://p.test/proxy/3000/browse/https/x.com/y?z=1")
    ).toBe("https://x.com/y?z=1");
    expect(
      extractBrowseTarget(
        `https://p.test/browse?url=${encodeURIComponent("https://x.com/y")}`
      )
    ).toBe("https://x.com/y");
    expect(extractBrowseTarget("https://p.test/browse/https")).toBeNull();
  });

  test("buildBrowseDest: 絶対 URL をプレフィックス配下のパス反映形式へ", () => {
    expect(buildBrowseDest("https://x.com/y?z=1", "/proxy/3000/browse/")).toBe(
      "/proxy/3000/browse/https/x.com/y?z=1"
    );
    expect(buildBrowseDest("mailto:a@b.com", "/browse/")).toBeNull();
  });
});

describe("buildClickNavDestination", () => {
  // 仕様: docs/spec/features/proxy.md §クライアント側ナビゲーションの横取り（パス反映・#115）
  const TARGET = "https://www.yahoo.co.jp/";
  // 正本はパス反映の閲覧ページ。後方互換（?url=）からの復元も別途検証する。
  const PAGE = `https://proxy.test${nav(TARGET)}`;

  test("外部オリジンの http(s) 絶対 URL: パス反映ナビ形式へ振り向ける", () => {
    const href = "https://news.yahoo.co.jp/articles/abc";
    expect(buildClickNavDestination(href, PAGE)).toBe(nav(href));
  });

  test("http の絶対 URL も対象", () => {
    const href = "http://example.com/p";
    expect(buildClickNavDestination(href, PAGE)).toBe(nav(href));
  });

  test("BASE_PATH（リバースプロキシのパスプレフィックス）を遷移先で保持する", () => {
    const href = "https://news.yahoo.co.jp/articles/abc";
    const page = `https://proxy.test/proxy/3000${nav(TARGET)}`;
    expect(buildClickNavDestination(href, page)).toBe(
      `/proxy/3000${nav(href)}`
    );
  });

  test("ルート相対 URL は現ターゲット origin で解決してパス反映ナビへ（#82）", () => {
    expect(buildClickNavDestination("/articles/abc", PAGE)).toBe(
      nav("https://www.yahoo.co.jp/articles/abc")
    );
  });

  test("相対 URL は現ターゲットを base に解決してパス反映ナビへ（#82）", () => {
    const page = `https://proxy.test${nav("https://www.yahoo.co.jp/news/")}`;
    expect(buildClickNavDestination("article/x", page)).toBe(
      nav("https://www.yahoo.co.jp/news/article/x")
    );
  });

  test("プロトコル相対 URL は外部絶対としてパス反映ナビへ（#82）", () => {
    expect(buildClickNavDestination("//news.yahoo.co.jp/x", PAGE)).toBe(
      nav("https://news.yahoo.co.jp/x")
    );
  });

  test("クエリのみの相対リンク（?q=…）はパス反映の閲覧ページでネイティブ解決され同形を返す（#115）", () => {
    const target = "https://duckduckgo.com/?ia=web&q=test";
    const page = `https://proxy.test/proxy/3000${nav(target)}`;
    // ?q=… は閲覧ページ基準で …/browse/https/duckduckgo.com/?q=… にネイティブ解決される。
    expect(buildClickNavDestination("?q=test my speed", page)).toBe(
      `/proxy/3000${nav("https://duckduckgo.com/?q=test%20my%20speed")}`
    );
  });

  test("ナビタブ相当のルート相対（/?ia=images&q=test）を現ターゲット base でパス反映へ（#115）", () => {
    const target = "https://duckduckgo.com/?ia=web&q=test";
    const page = `https://proxy.test/proxy/3000${nav(target)}`;
    expect(buildClickNavDestination("/?ia=images&q=test", page)).toBe(
      `/proxy/3000${nav("https://duckduckgo.com/?ia=images&q=test")}`
    );
  });

  test("既にパス反映済みの proxy ナビリンクはそのままフルナビゲーション（#115）", () => {
    const self = nav("https://news.yahoo.co.jp/articles/abc");
    expect(buildClickNavDestination(self, PAGE)).toBe(self);
  });

  test("ターゲット自身の /browse/… ルート相対リンクは素通しせず target 解決する（#115 退行ガード）", () => {
    // パス反映ページで target サイトが描く href="/browse/foo" は、proxy origin 直下の
    // /browse/foo に解決され /browse/ マーカーに一致するが、scheme 段が "foo" で復元不能。
    // 素通しすると 400 になるため、現ターゲットを base に解決してパス反映へ振り向ける。
    const target = "https://www.yahoo.co.jp/";
    const page = `https://proxy.test/proxy/3000${nav(target)}`;
    expect(buildClickNavDestination("/browse/foo", page)).toBe(
      `/proxy/3000${nav("https://www.yahoo.co.jp/browse/foo")}`
    );
  });

  test("後方互換: 旧 ?url= 形式の書き換え済みリンクはそのまま返す（#82/#114）", () => {
    const page = `https://proxy.test/browse?url=${encodeURIComponent(TARGET)}`;
    const self = `/browse?url=${encodeURIComponent("https://news.yahoo.co.jp/articles/abc")}`;
    expect(buildClickNavDestination(self, page)).toBe(self);
  });

  test("後方互換: 旧 ?url= 形式の閲覧ページのクエリ相対 ?q= はパス反映ナビへ復元（#114/#115）", () => {
    const page = `https://proxy.test/browse?url=${encodeURIComponent(TARGET)}`;
    const dest = buildClickNavDestination("?q=wifi", page);
    expect(dest).not.toBe("/browse?q=wifi");
    expect(dest).toBe(nav(new URL("?q=wifi", TARGET).href));
  });

  test("# 同一ページアンカーは対象外（null）", () => {
    expect(buildClickNavDestination("#section", PAGE)).toBeNull();
  });

  test.each([
    ["javascript:void(0)"],
    ["mailto:a@b.com"],
    ["tel:0123"],
    ["data:text/plain,hi"],
  ])("非 http スキーム %s は対象外（null）", (href) => {
    expect(buildClickNavDestination(href, PAGE)).toBeNull();
  });

  test("閲覧ページに url= が無い場合の相対リンクは対象外（null）", () => {
    expect(
      buildClickNavDestination("/articles/abc", "https://proxy.test/browse")
    ).toBeNull();
  });

  test("pageUrl が不正なら null", () => {
    expect(
      buildClickNavDestination("https://news.yahoo.co.jp/x", "not a url")
    ).toBeNull();
  });
});

describe("buildNavApiRedirect（Navigation API 駆動の離脱の復元・#172）", () => {
  // 仕様: docs/spec/features/proxy.md §Navigation API 駆動の離脱の復元
  const TARGET = "https://www.youtube.com/";
  const PAGE = `https://proxy.test/proxy/3000${nav(TARGET)}`;
  // dest はブラウザが proxy origin 基準で解決済みの絶対 URL（navigate イベントの destination.url）。
  const PROXY = "https://proxy.test";

  test("proxy origin ルート（'/'）への離脱を現ターゲットのパス反映ルートへ復元する", () => {
    // location.replace('/') が proxy origin ルートへ解決された典型ケース（YouTube）。
    expect(buildNavApiRedirect(`${PROXY}/`, PAGE)).toBe(
      `/proxy/3000${nav("https://www.youtube.com/")}`
    );
  });

  test("proxy origin のルート相対パスへの離脱を現ターゲット基準で復元する", () => {
    expect(buildNavApiRedirect(`${PROXY}/watch?v=abc`, PAGE)).toBe(
      `/proxy/3000${nav("https://www.youtube.com/watch?v=abc")}`
    );
  });

  test("既にパス反映形式（proxy 枠保持）の dest は介入しない（null）", () => {
    const dest = `${PROXY}/proxy/3000${nav("https://www.youtube.com/feed")}`;
    expect(buildNavApiRedirect(dest, PAGE)).toBeNull();
  });

  test("クロスオリジンの dest は対象外（null）", () => {
    expect(buildNavApiRedirect("https://evil.example/", PAGE)).toBeNull();
  });

  test.each([
    ["/api/proxy/https/www.youtube.com/x"],
    ["/_next/static/chunk.js"],
    ["/sw.js"],
    ["/favicon.ico"],
    ["/unlock"],
  ])("プロキシ自前インフラ資産パス %s は介入しない（null）", (p) => {
    expect(buildNavApiRedirect(`${PROXY}${p}`, PAGE)).toBeNull();
  });

  test("/_next/image（ターゲット側エンドポイント）は復元対象", () => {
    // /_next/image は自前ルートから除外される（#102）。ルート離脱として現ターゲットへ復元する。
    // （url= クエリは extractBrowseTarget が復元扱いするため、ここではパスのみで検証する）
    expect(
      buildNavApiRedirect(`${PROXY}/_next/image/x.png`, PAGE)
    ).not.toBeNull();
  });

  test("ターゲットを復元できない閲覧ページ（url= 無し）では null", () => {
    expect(buildNavApiRedirect(`${PROXY}/`, "https://proxy.test/browse")).toBe(
      null
    );
  });

  test("destUrl / pageUrl が不正なら null", () => {
    expect(buildNavApiRedirect("not a url", PAGE)).toBeNull();
    expect(buildNavApiRedirect(`${PROXY}/`, "not a url")).toBeNull();
  });
});

describe("rewriteSrcset", () => {
  const proxied = (path: string) => asset(path);

  test("密度記述子（1x/2x）付きの複数候補を書き換える", () => {
    expect(rewriteSrcset("/a.png 1x, /b.png 2x", BASE)).toBe(
      `${proxied("/a.png")} 1x, ${proxied("/b.png")} 2x`
    );
  });

  test("幅記述子（w）付きの複数候補を書き換える", () => {
    expect(rewriteSrcset("/a.png 640w, /b.png 1280w", BASE)).toBe(
      `${proxied("/a.png")} 640w, ${proxied("/b.png")} 1280w`
    );
  });

  test("記述子なしの単一候補も書き換える", () => {
    expect(rewriteSrcset("/a.png", BASE)).toBe(proxied("/a.png"));
  });

  test("不揃いな空白を正規化して書き換える", () => {
    expect(rewriteSrcset("  /a.png   1x ,  /b.png   2x  ", BASE)).toBe(
      `${proxied("/a.png")} 1x, ${proxied("/b.png")} 2x`
    );
  });

  test("data: URL 内のカンマで誤分割しない", () => {
    const data = "data:image/png;base64,AAAAC, ";
    // data: は http(s) に解決されないため assetUrl はそのまま返す（記述子 1x は保持）
    const src = "data:image/png;base64,AAAAC";
    expect(rewriteSrcset(`${src} 1x`, BASE)).toBe(`${src} 1x`);
    void data;
  });

  test("絶対 URL も書き換える", () => {
    const abs = "https://cdn.example.org/a.png";
    expect(rewriteSrcset(`${abs} 2x`, BASE)).toBe(`${asset(abs)} 2x`);
  });
});

describe("rewriteCss", () => {
  test("url() を /api/proxy に書き換える", () => {
    const css = `body { background: url('/bg.png'); }`;
    const result = rewriteCss(css, BASE);
    expect(result).toContain(asset("/bg.png"));
  });

  test("url() 内の引用符なし表記も書き換える", () => {
    const css = `body { background: url(/bg.png); }`;
    const result = rewriteCss(css, BASE);
    expect(result).toContain(asset("/bg.png"));
  });

  test("@import を /api/proxy に書き換える", () => {
    const css = `@import '/fonts.css';`;
    const result = rewriteCss(css, BASE);
    expect(result).toContain(asset("/fonts.css"));
  });

  test("既に絶対 URL の url() も書き換える", () => {
    const css = `body { background: url('https://cdn.example.com/bg.png'); }`;
    const result = rewriteCss(css, BASE);
    expect(result).toContain(asset("https://cdn.example.com/bg.png"));
  });
});

describe("noUrlBrowseHtml", () => {
  test("アドレスバーを含む 200 用の HTML を返す", () => {
    const html = noUrlBrowseHtml();
    expect(html).toContain('id="proxy-addressbar"');
  });

  test("アドレスバーのフォームが /browse?url= への導線を持つ", () => {
    expect(noUrlBrowseHtml()).toContain("/browse?url=");
  });

  test("自動遷移（meta refresh）を含まない", () => {
    expect(noUrlBrowseHtml().toLowerCase()).not.toContain(
      'http-equiv="refresh"'
    );
  });
});

// 仕様: docs/spec/screens/browse.md §アドレスバー / docs/arch/proxy.md §アドレスバー注入（#137）
describe("escapeHtml（#137）", () => {
  test.each([
    ["&", "&amp;"],
    ["<", "&lt;"],
    [">", "&gt;"],
    ['"', "&quot;"],
    ["'", "&#39;"],
  ])("%p を %p へ実体化する", (input, expected) => {
    expect(escapeHtml(input)).toBe(expected);
  });

  test("& を最初に処理し、生成した実体参照の & を二重実体化しない", () => {
    // 入力の生 < は &lt; になるが、その &lt; の & を &amp;lt; へ二重変換しない。
    expect(escapeHtml("<")).toBe("&lt;");
    // 入力に含まれる生 & のみ &amp; になる（& 優先順を保証）。
    expect(escapeHtml("a&<b")).toBe("a&amp;&lt;b");
  });

  test("特殊文字を含まない文字列・空文字はそのまま返す", () => {
    expect(escapeHtml("")).toBe("");
    expect(escapeHtml("https://example.com/path")).toBe(
      "https://example.com/path"
    );
  });
});

// 実行時リクエスト横取りシム（SW 非依存・#124）の純粋関数。
// 振り向け規則は public/sw.js の rewriteRequestUrl / isProxyOwnPath と対の関係。
describe("isProxyOwnPath（#124）", () => {
  test.each([
    ["/", true, "ホーム"],
    ["", true, "空"],
    ["/sw.js", true, "SW"],
    ["/unlock", true, "解錠ルート（#148）"],
    ["/favicon.ico", true, "favicon"],
    ["/browse", true, "browse 完全一致"],
    ["/browse/https/x.com/y", true, "browse 配下"],
    ["/api/proxy", true, "api/proxy 完全一致"],
    ["/api/proxy/https/x.com/y", true, "api/proxy 配下"],
    ["/_next/static/chunk.js", true, "_next static"],
    ["/_next/image", false, "_next/image 例外"],
    ["/_next/image/x", false, "_next/image 配下例外"],
    ["/api/personalized-articles", false, "ターゲット API"],
    ["/cb_pc.gif", false, "ターゲット相対画像"],
    ["/images/x.png", false, "ターゲット画像"],
    ["/browser", false, "browse 境界（誤判定しない）"],
    ["/api/proxyData", false, "api/proxy 境界（誤判定しない）"],
  ])("%p -> %p (%s)", (pathname, expected) => {
    expect(isProxyOwnPath(pathname, "")).toBe(expected);
  });

  test("basePath を取り除いて判定する", () => {
    expect(isProxyOwnPath("/proxy/3000/api/proxy/https/x", "/proxy/3000")).toBe(
      true
    );
    expect(isProxyOwnPath("/proxy/3000/", "/proxy/3000")).toBe(true);
    expect(
      isProxyOwnPath("/proxy/3000/api/personalized-articles", "/proxy/3000")
    ).toBe(false);
  });
});

describe("buildRequestInterceptUrl（#124）", () => {
  const ORIGIN = "https://proxy.test";
  const PAGE = `${ORIGIN}/browse/https/news.yahoo.co.jp/`;
  // /api/proxy オラクル（basePath 付き）。
  const proxy = (absolute: string, bp = ""): string => {
    const u = new URL(absolute);
    return `${bp}/api/proxy/${u.protocol.replace(/:$/, "")}/${u.host}${u.pathname}${u.search}${u.hash}`;
  };

  test("クロスオリジン絶対 URL はそのまま /api/proxy へ", () => {
    const dest = buildRequestInterceptUrl(
      "https://mhd.yahoo.co.jp/v1/mhdinfo?x=1",
      PAGE,
      ORIGIN,
      ""
    );
    expect(dest).toBe(proxy("https://mhd.yahoo.co.jp/v1/mhdinfo?x=1"));
  });

  test("同一オリジンのルート絶対パスはターゲット origin に解決して /api/proxy へ", () => {
    const dest = buildRequestInterceptUrl(
      `${ORIGIN}/api/personalized-articles?results=50`,
      PAGE,
      ORIGIN,
      ""
    );
    expect(dest).toBe(
      proxy("https://news.yahoo.co.jp/api/personalized-articles?results=50")
    );
  });

  test("相対パス（pageUrl 基準で解決）も振り向ける", () => {
    expect(buildRequestInterceptUrl("/cb_pc.gif?all=1", PAGE, ORIGIN, "")).toBe(
      proxy("https://news.yahoo.co.jp/cb_pc.gif?all=1")
    );
  });

  test("自前ルート（/api/proxy・/browse）は素通し（null）", () => {
    expect(
      buildRequestInterceptUrl(
        `${ORIGIN}/api/proxy/https/x.com/y.js`,
        PAGE,
        ORIGIN,
        ""
      )
    ).toBeNull();
    expect(
      buildRequestInterceptUrl(
        `${ORIGIN}/browse/https/x.com/y`,
        PAGE,
        ORIGIN,
        ""
      )
    ).toBeNull();
  });

  test("非 http(s)（data: / blob:）は素通し（null）", () => {
    expect(
      buildRequestInterceptUrl("data:image/png;base64,AAAA", PAGE, ORIGIN, "")
    ).toBeNull();
    expect(
      buildRequestInterceptUrl(`blob:${ORIGIN}/uuid`, PAGE, ORIGIN, "")
    ).toBeNull();
  });

  test("ターゲット復元不能なページ（url 無し）は素通し（null）", () => {
    expect(
      buildRequestInterceptUrl(`${ORIGIN}/api/x`, `${ORIGIN}/`, ORIGIN, "")
    ).toBeNull();
  });

  test("_next/image はターゲット origin の最適化エンドポイントへ（#102 同様）", () => {
    const dest = buildRequestInterceptUrl(
      `${ORIGIN}/_next/image?url=https%3A%2F%2Fext%2Fa.png&w=64`,
      PAGE,
      ORIGIN,
      ""
    );
    expect(dest).toBe(
      proxy(
        "https://news.yahoo.co.jp/_next/image?url=https%3A%2F%2Fext%2Fa.png&w=64"
      )
    );
  });

  test("basePath を保持して振り向ける（同一オリジン相対・クロスオリジン）", () => {
    const bp = "/proxy/3000";
    const page = `${ORIGIN}${bp}/browse/https/news.yahoo.co.jp/`;
    expect(
      buildRequestInterceptUrl(`${ORIGIN}${bp}/api/x?a=1`, page, ORIGIN, bp)
    ).toBe(proxy("https://news.yahoo.co.jp/api/x?a=1", bp));
    expect(
      buildRequestInterceptUrl("https://cdn.ext/lib.js", page, ORIGIN, bp)
    ).toBe(proxy("https://cdn.ext/lib.js", bp));
  });

  test("不正な URL は素通し（null）", () => {
    expect(
      buildRequestInterceptUrl("http://[bad", PAGE, ORIGIN, "")
    ).toBeNull();
  });
});

describe("fetchInputUrl（#124）", () => {
  test("文字列はそのまま返す", () => {
    expect(fetchInputUrl("https://x.test/a?b=1")).toBe("https://x.test/a?b=1");
    expect(fetchInputUrl("/rel/path")).toBe("/rel/path");
  });

  test("URL オブジェクトは href を返す（.url は存在しないため）", () => {
    expect(fetchInputUrl(new URL("https://x.test/a"))).toBe("https://x.test/a");
  });

  test("Request 風オブジェクト（.url 文字列）は url を返す", () => {
    expect(fetchInputUrl({ url: "https://x.test/api" })).toBe(
      "https://x.test/api"
    );
  });

  test("取り出せない入力は null", () => {
    expect(fetchInputUrl(null)).toBeNull();
    expect(fetchInputUrl(undefined)).toBeNull();
    expect(fetchInputUrl(123)).toBeNull();
    expect(fetchInputUrl({})).toBeNull();
  });
});
