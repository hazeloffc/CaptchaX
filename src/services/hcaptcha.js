const HCAPTCHA_API = "https://js.hcaptcha.com/1/api.js?render=explicit";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);

function jsStr(s) {
  return String(s == null ? "" : s)
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\r/g, "")
    .replace(/\n/g, "");
}

function buildHPage({ sitekey, theme, size, hl, host, endpoint, assethost, imghost, reportapi, rqdata }) {
  const opts = [];
  opts.push(`sitekey: '${jsStr(sitekey)}'`);
  if (theme) opts.push(`theme: '${jsStr(theme)}'`);
  if (size) opts.push(`size: '${jsStr(size)}'`);
  if (hl) opts.push(`hl: '${jsStr(hl)}'`);
  if (host) opts.push(`host: '${jsStr(host)}'`);
  if (endpoint) opts.push(`endpoint: '${jsStr(endpoint)}'`);
  if (assethost) opts.push(`assethost: '${jsStr(assethost)}'`);
  if (imghost) opts.push(`imghost: '${jsStr(imghost)}'`);
  if (reportapi) opts.push(`reportapi: '${jsStr(reportapi)}'`);
  if (rqdata) opts.push(`rqdata: '${jsStr(rqdata)}'`);

  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>hcaptcha-solver</title>
    <script>
        window.__h = { token: null, events: [], widgetId: null, renderErr: null, sdkLoaded: false };
    <\/script>
    <script src="${HCAPTCHA_API}" onload="window.__h.sdkLoaded=true" async defer><\/script>
</head>
<body>
    <div id="hcap"></div>
    <script>
        function bootH(n) {
            if (!window.hcaptcha || typeof window.hcaptcha.render !== 'function') {
                if (n < 120) { setTimeout(function () { bootH(n + 1); }, 300); }
                return;
            }
            try {
                var id = window.hcaptcha.render('hcap', {
                    ${opts.join(",\n                    ")},
                    callback: function (t) { window.__h.token = t; window.__h.events.push('token'); },
                    'expired-callback': function () { window.__h.events.push('expired'); window.__h.token = null; },
                    'chalexpired-callback': function () { window.__h.events.push('chalexpired'); },
                    'open-callback': function () { window.__h.events.push('open'); },
                    'close-callback': function () { window.__h.events.push('close'); },
                    'error-callback': function (e) { window.__h.events.push('error:' + (e || 'unknown')); }
                });
                window.__h.widgetId = id;
                window.__h.events.push('rendered');
            } catch (e) {
                window.__h.renderErr = String((e && e.message) || e);
            }
        }
        bootH(0);
    <\/script>
</body>
</html>`;
}

async function getState(page) {
  return page
    .evaluate(() => {
      try {
        const h = window.__h || {};
        let resp = null;
        try {
          if (window.hcaptcha && h.widgetId !== null && h.widgetId !== undefined) {
            resp = window.hcaptcha.getResponse(h.widgetId) || null;
          }
        } catch (e) {}
        if (!resp) {
          const sels = [
            'textarea[name="h-captcha-response"]',
            'textarea[name="g-recaptcha-response"]',
            'input[name="h-captcha-response"]',
          ];
          for (const s of sels) {
            try {
              const el = document.querySelector(s);
              if (el && el.value && el.value.length > 10) {
                resp = el.value;
                break;
              }
            } catch (e) {}
          }
        }
        return {
          token: h.token || resp || null,
          events: Array.isArray(h.events) ? h.events.slice(-20) : [],
          widgetId: h.widgetId,
          renderErr: h.renderErr || null,
          sdkLoaded: !!h.sdkLoaded,
          hasHcaptcha: !!(window.hcaptcha && window.hcaptcha.render),
        };
      } catch (e) {
        return { token: null, events: [], widgetId: null, renderErr: "eval-fail", sdkLoaded: false, hasHcaptcha: false };
      }
    })
    .catch(() => null);
}

async function listCaptchaIframes(page) {
  try {
    const handles = await page.$$("iframe");
    const out = [];
    for (const h of handles) {
      try {
        const info = await h.evaluate((el) => ({
          src: (el.src || "").slice(0, 160),
          title: (el.title || "").slice(0, 120),
        }));
        const box = await h.boundingBox().catch(() => null);
        const interesting =
          /hcaptcha\.com|newassets|hcaptcha/i.test(info.src + " " + info.title);
        if (interesting) {
          out.push({
            src: info.src,
            title: info.title,
            w: box ? Math.round(box.width) : 0,
            h: box ? Math.round(box.height) : 0,
            x: box ? Math.round(box.x) : 0,
            y: box ? Math.round(box.y) : 0,
          });
        }
      } catch (e) {}
    }
    return out;
  } catch (e) {
    return [];
  }
}

async function findCheckbox(page) {
  // Prefer the real checkbox element inside its frame (precise coords),
  // fall back to the iframe box (click near left where the box sits).
  const frames = page.frames();
  for (const f of frames) {
    try {
      const url = f.url() || "";
      if (!/hcaptcha\.com|newassets/i.test(url)) continue;
      const cb = await f.$("#checkbox").catch(() => null);
      if (!cb) continue;
      const box = await cb.boundingBox().catch(() => null);
      if (box && box.width > 2 && box.height > 2) {
        return { frame: f, handle: cb, box, kind: "checkbox-el" };
      }
    } catch (e) {}
  }
  // Fallback: smallest visible hcaptcha iframe (checkbox widget, not challenge modal).
  try {
    const handles = await page.$$(
      'iframe[src*="hcaptcha.com"], iframe[src*="newassets"], iframe[title*="hCaptcha" i], iframe[title*="hcaptcha" i]'
    );
    let best = null;
    for (const h of handles) {
      try {
        const box = await h.boundingBox().catch(() => null);
        if (!box || box.width < 10 || box.height < 10) continue;
        const area = box.width * box.height;
        if (!best || area < best.area) {
          let frame = null;
          try {
            frame = await h.contentFrame();
          } catch (e) {}
          best = { frame, handle: h, box, area };
        }
      } catch (e) {}
    }
    if (best) return { frame: best.frame, handle: best.handle, box: best.box, kind: "iframe" };
  } catch (e) {}
  return null;
}

async function humanClick(page, x, y) {
  await page.mouse.move(x + rand(-40, -15), y + rand(-14, 14), { steps: 5 }).catch(() => {});
  await sleep(rand(120, 260));
  await page.mouse.move(x, y, { steps: 6 }).catch(() => {});
  await sleep(rand(90, 220));
  await page.mouse.down().catch(() => {});
  await sleep(rand(60, 160));
  await page.mouse.up().catch(() => {});
}

async function solveHCaptcha({
  sitekey,
  url,
  timeout = 60000,
  browserService,
  rqdata,
  size,
  invisible,
  hl,
  theme,
  host,
  endpoint,
  assethost,
  imghost,
  reportapi,
  debug = false,
} = {}) {
  const startTime = Date.now();
  if (!sitekey || !url) throw new Error("Missing sitekey or url parameter");
  if (!browserService) throw new Error("Browser service not initialized");

  let targetHost = null;
  try {
    targetHost = new URL(url).hostname;
  } catch (e) {
    throw new Error("Invalid siteurl");
  }

  const wantInvisible = !!(invisible || (size && String(size).toLowerCase() === "invisible"));
  const html = buildHPage({
    sitekey,
    theme: theme || "light",
    size: wantInvisible ? "invisible" : size || "normal",
    hl: hl || "en",
    host,
    endpoint,
    assethost,
    imghost,
    reportapi,
    rqdata,
  });

  const dbg = { stages: [], events: [], iframes: [], clicked: null, screenshot: null };
  const mark = (s) => {
    dbg.stages.push(`${((Date.now() - startTime) / 1000).toFixed(1)}s:${s}`);
  };

  const deadline = Date.now() + Math.min(Math.max(timeout || 60000, 10000), 180000);

  const fail = async (page, msg) => {
    if (debug && page) {
      try {
        const st = await getState(page);
        if (st) dbg.events = st.events || [];
        dbg.iframes = await listCaptchaIframes(page);
        dbg.screenshot = await page
          .screenshot({ type: "jpeg", quality: 55, encoding: "base64" })
          .catch(() => null);
      } catch (e) {}
    }
    const err = new Error(msg);
    err.debug = dbg;
    throw err;
  };

  const token = await browserService.withBrowserContext(async (context) => {
    const page = await context.newPage();

    await page.setRequestInterception(true);
    page.on("request", async (request) => {
      try {
        const rt = request.resourceType();
        let sameHost = false;
        try {
          sameHost = new URL(request.url()).hostname === targetHost;
        } catch (e) {}
        let isMain = true;
        try {
          const f = request.frame();
          if (f && page.mainFrame && f !== page.mainFrame()) isMain = false;
        } catch (e) {}
        if (rt === "document" && isMain && sameHost) {
          await request.respond({ status: 200, contentType: "text/html; charset=utf-8", body: html });
        } else {
          await request.continue();
        }
      } catch (e) {
        try {
          await request.continue();
        } catch (_) {}
      }
    });

    mark("goto");
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    } catch (e) {
      await fail(page, `Navigation failed: ${e.message}`);
    }

    // 1. Wait for widget render.
    mark("wait-render");
    let st = null;
    try {
      await page.waitForFunction(
        () => window.__h && window.__h.widgetId !== null && window.__h.widgetId !== undefined,
        { timeout: 25000, polling: 400 }
      );
    } catch (e) {
      st = await getState(page);
      dbg.events = (st && st.events) || [];
      const hint = !st
        ? "page eval failed"
        : !st.sdkLoaded && !st.hasHcaptcha
          ? "hcaptcha api.js failed to load (network blocked?)"
          : st.renderErr
            ? `render error: ${st.renderErr}`
            : "widget did not render (invalid sitekey?)";
      await fail(page, `hCaptcha widget render timeout (${hint})`);
    }
    st = await getState(page);
    dbg.events = (st && st.events) || [];
    const widgetId = st ? st.widgetId : 0;
    mark(`rendered:${widgetId}`);

    // Token might already exist (passive / no-challenge keys).
    if (st && st.token && st.token.length > 10) return st.token;

    // 2. Trigger verification.
    if (wantInvisible) {
      mark("execute-invisible");
      await page
        .evaluate((id) => {
          try {
            window.hcaptcha.execute(id);
            return true;
          } catch (e) {
            return false;
          }
        }, widgetId)
        .catch(() => false);
    } else {
      mark("find-checkbox");
      let found = null;
      const tFind = Date.now() + 15000;
      while (Date.now() < tFind) {
        found = await findCheckbox(page);
        if (found) break;
        // Maybe an invisible sitekey: try execute() once as fallback.
        st = await getState(page);
        if (st && st.token) return st.token;
        await sleep(800);
      }
      if (!found) {
        mark("execute-fallback");
        const ok = await page
          .evaluate((id) => {
            try {
              window.hcaptcha.execute(id);
              return true;
            } catch (e) {
              return false;
            }
          }, widgetId)
          .catch(() => false);
        if (!ok) {
          dbg.iframes = await listCaptchaIframes(page);
          await fail(page, "hCaptcha checkbox not found (widget may be invisible — retry with invisible:true)");
        }
      } else {
        mark(`click:${found.kind}`);
        try {
          await found.handle.scrollIntoViewIfNeeded().catch(() => {});
        } catch (e) {}
        await sleep(300);
        let box = found.box;
        try {
          const fresh = await found.handle.boundingBox().catch(() => null);
          if (fresh && fresh.width > 2) box = fresh;
        } catch (e) {}
        let cx, cy;
        if (found.kind === "checkbox-el") {
          cx = box.x + box.width / 2;
          cy = box.y + box.height / 2;
        } else {
          // Widget iframe: checkbox sits at the left side.
          cx = box.x + Math.min(30, box.width * 0.15);
          cy = box.y + box.height / 2;
        }
        dbg.clicked = { x: Math.round(cx), y: Math.round(cy), kind: found.kind };
        await humanClick(page, cx, cy);
        await sleep(2500);

        // Fallback: precise in-frame click if nothing happened yet.
        st = await getState(page);
        const acted =
          (st && st.token) ||
          (st && st.events.some((e) => /^(open|error|token)/.test(e)));
        if (!acted && found.frame) {
          mark("click:frame-fallback");
          try {
            await found.frame.click("#checkbox", { delay: 60 });
            await sleep(2000);
          } catch (e) {}
        }
      }
    }

    // 3. Poll for token / challenge / error.
    mark("poll");
    let sawOpen = false;
    while (Date.now() < deadline) {
      st = await getState(page);
      if (st && st.token && st.token.length > 10) {
        dbg.events = st.events;
        return st.token;
      }
      if (st) {
        dbg.events = st.events;
        const errEv = st.events.find((e) => e.indexOf("error:") === 0);
        if (errEv) {
          await fail(page, `hCaptcha error: ${errEv.slice(6)} (sitekey/domain blocked?)`);
        }
        if (st.events.includes("open")) {
          sawOpen = true;
          await fail(
            page,
            "hCaptcha image challenge required — automatic solving not possible (typical for datacenter IPs). Token only succeeds on no-challenge / passive risk."
          );
        }
      }
      // Heuristic: a large hcaptcha iframe = challenge modal.
      try {
        const ifs = await listCaptchaIframes(page);
        const big = ifs.find((f) => f.w > 320 && f.h > 250);
        if (big) {
          dbg.iframes = ifs;
          sawOpen = true;
          await fail(
            page,
            "hCaptcha image challenge required — automatic solving not possible (typical for datacenter IPs). Token only succeeds on no-challenge / passive risk."
          );
        }
      } catch (e) {}
      await sleep(600);
    }

    st = await getState(page);
    if (st) dbg.events = st.events;
    await fail(
      page,
      sawOpen
        ? "hCaptcha image challenge required — automatic solving not possible."
        : "Timeout waiting for hCaptcha token (checkbox may not have been accepted)"
    );
    return null;
  });

  if (!token || token.length < 10) {
    const err = new Error("Failed to get token");
    err.debug = dbg;
    throw err;
  }
  return { success: true, data: token, duration: Date.now() - startTime, debug: dbg };
}

module.exports = { solveHCaptcha, buildHPage };
