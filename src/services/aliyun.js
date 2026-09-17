const axios = require("axios");

const HARVEST_URL = "http://captcha-harvest.aliyun.test/";
const SDK_URL = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);

function jsStr(s) {
  return String(s == null ? "" : s)
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\r/g, "")
    .replace(/\n/g, "");
}

function buildAliyunPage({ sceneId, prefix, region, language, mode, sdkUrl }) {
  const sdk = sdkUrl || SDK_URL;
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>aliyun-harvest</title>
    <script>
        window.AliyunCaptchaConfig = { region: '${jsStr(region)}', prefix: '${jsStr(prefix)}' };
        window.__ali = { verify: null, fails: [], inited: false, sdkLoaded: false, sdkErr: null,
                         shadow: null, back: null, instMethods: [] };
        (function () {
            function grab(u) {
                try {
                    if (typeof u !== 'string') return;
                    if (u.indexOf('shadow.png') > -1) window.__ali.shadow = u;
                    else if (u.indexOf('back.png') > -1) window.__ali.back = u;
                } catch (e) {}
            }
            window.__grab = grab;
            try {
                var ofetch = window.fetch;
                window.fetch = function () { try { grab(arguments[0]); } catch (e) {} return ofetch.apply(this, arguments); };
            } catch (e) {}
            try {
                var oopen = XMLHttpRequest.prototype.open;
                XMLHttpRequest.prototype.open = function (m, u) { try { grab(u); } catch (e) {} return oopen.apply(this, arguments); };
            } catch (e) {}
            try {
                var d = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
                if (d && d.set) {
                    Object.defineProperty(HTMLImageElement.prototype, 'src', {
                        configurable: true,
                        get: function () { return d.get.call(this); },
                        set: function (v) { try { grab(v); } catch (e) {} return d.set.call(this, v); }
                    });
                }
            } catch (e) {}
            // Scan DOM periodically as a backstop (SDK may set src before hooks run).
            setInterval(function () {
                try {
                    if (window.__ali.shadow && window.__ali.back) return;
                    var imgs = document.querySelectorAll('img');
                    for (var i = 0; i < imgs.length; i++) { grab(imgs[i].currentSrc || imgs[i].src); }
                } catch (e) {}
            }, 500);
        })();
    <\/script>
    <script src="${sdk}" charset="utf-8" onload="window.__ali.sdkLoaded=true" onerror="window.__ali.sdkErr='script-load-error'"><\/script>
</head>
<body>
    <div id="captcha-element"></div>
    <button id="captcha-button" style="margin:40px;padding:12px 28px;font-size:16px;">Verify</button>
    <script>
        function bootAli(n) {
            if (typeof window.initAliyunCaptcha !== 'function') {
                if (n < 120) { setTimeout(function () { bootAli(n + 1); }, 300); }
                return;
            }
            try {
                window.initAliyunCaptcha({
                    SceneId: '${jsStr(sceneId)}',
                    prefix: '${jsStr(prefix)}',
                    region: '${jsStr(region)}',
                    mode: '${jsStr(mode)}',
                    element: '#captcha-element',
                    button: '#captcha-button',
                    language: '${jsStr(language)}',
                    slideStyle: { width: 360, height: 40 },
                    success: function (p) {
                        window.__ali.verify = (typeof p === 'string') ? p : JSON.stringify(p);
                    },
                    fail: function (e) {
                        try { window.__ali.fails.push('fail:' + JSON.stringify(e)); }
                        catch (_) { window.__ali.fails.push('fail'); }
                    },
                    onError: function (e) {
                        try { window.__ali.fails.push('onError:' + JSON.stringify(e)); }
                        catch (_) { window.__ali.fails.push('onError'); }
                    },
                    captchaVerifyCallback: function (p) {
                        window.__ali.verify = (typeof p === 'string') ? p : JSON.stringify(p);
                        return { captchaResult: true, bizResult: true };
                    },
                    onBizResultCallback: function () {},
                    getInstance: function (inst) {
                        window.__inst = inst;
                        window.__ali.inited = true;
                        try {
                            var ms = [];
                            for (var k in inst) { if (typeof inst[k] === 'function') ms.push(k); }
                            window.__ali.instMethods = ms.slice(0, 30);
                        } catch (e) {}
                    }
                });
            } catch (e) {
                window.__ali.sdkErr = 'init-error:' + ((e && e.message) || e);
            }
        }
        bootAli(0);
    <\/script>
</body>
</html>`;
}

// ---------------- image / gap analysis (Node side, Jimp) ----------------

async function downloadImage(url, ua) {
  const res = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 15000,
    maxContentLength: 8 * 1024 * 1024,
    headers: {
      "User-Agent": ua || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      Accept: "image/png,image/*,*/*",
      Referer: "https://captcha-harvest.aliyun.test/",
    },
  });
  return Buffer.from(res.data);
}

// Template-match the jigsaw piece over the background (X axis).
// Returns { gapX, pieceW, score, confidence } in NATURAL pixels of back.png.
async function computeGap(shadowBuf, backBuf) {
  let Jimp;
  try {
    Jimp = require("jimp");
  } catch (e) {
    return null;
  }
  const piece = (await Jimp.read(shadowBuf)).grayscale();
  const bg = (await Jimp.read(backBuf)).grayscale();
  const pw = piece.bitmap.width;
  const ph = piece.bitmap.height;
  const bw = bg.bitmap.width;
  const bh = bg.bitmap.height;
  if (!pw || !ph || !bw || !bh || pw >= bw) return null;

  const pc = piece.bitmap.data;
  const bc = bg.bitmap.data;
  // Opaque bounding box of the piece (alpha channel).
  let minX = pw, maxX = -1, minY = ph, maxY = -1;
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      if (pc[(y * pw + x) * 4 + 3] > 40) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const oy0 = Math.max(0, minY);
  const oy1 = Math.min(ph - 1, maxY, bh - 1);

  const t0 = Date.now();
  let bestX = 0;
  let best = Infinity;
  let sum = 0;
  let n = 0;
  for (let ox = 0; ox <= bw - (maxX + 1); ox += 1) {
    if ((ox & 15) === 0 && Date.now() - t0 > 9000) break;
    let score = 0;
    let count = 0;
    for (let y = oy0; y <= oy1; y += 2) {
      const bRow = y * bw;
      const pRow = y * pw;
      for (let x = minX; x <= maxX; x += 2) {
        if (pc[(pRow + x) * 4 + 3] <= 40) continue;
        const d = pc[(pRow + x) * 4] - bc[(bRow + ox + x) * 4];
        score += d * d;
        count++;
      }
    }
    if (!count) continue;
    score /= count;
    sum += score;
    n++;
    if (score < best) {
      best = score;
      bestX = ox;
    }
  }
  if (!n) return null;
  const mean = sum / n;
  return {
    gapX: bestX,
    pieceW: maxX - minX + 1,
    pieceH: maxY - minY + 1,
    bgW: bw,
    bgH: bh,
    pieceMinX: minX,
    score: best,
    confidence: mean > 0 ? Math.max(0, 1 - best / mean) : 0,
  };
}

// ---------------- page helpers ----------------

const SLIDER_SELS = [
  "#aliyunCaptcha-sliding-slider",
  "[id*='sliding-slider']",
  "[id*='aliyunCaptcha-slider']",
  "[class*='sliding-slider']",
  "[class*='slider-handle']",
  "[class*='slider-btn']",
  ".nc_scale",
  "[id*='nc_'][id*='slider'], [class*='nc-slider']",
];
const PUZZLE_SELS = ["#aliyunCaptcha-puzzle", "[id*='aliyunCaptcha-puzzle']", "img[src*='shadow.png']"];
const BG_SELS = ["#aliyunCaptcha-img", "[id*='aliyunCaptcha-img']", "img[src*='back.png']"];
const GATE_SELS = [
  "#aliyunCaptcha-captcha-text",
  "[id*='captcha-text']",
  "[id*='aliyunCaptcha-tip']",
  "button#aliyunCaptcha-button, #aliyunCaptcha-button",
];
const FAIL_WORDS = [
  "验证失败", "验证不通过", "failed", "failure", "incorrect", "wrong", "try again", "重试",
  "超时", "timeout", "expired", "过期", "busy", "繁忙", "risk", "风控", "blocked", "封禁",
  "abnormal", "异常", "刷新", "refresh",
];
const ICONCLICK_WORDS = ["依次点击", "按顺序", "点选", "click in order", "select in order", "tap in order", "顺序点击"];

async function findVisible(page, selectors) {
  const frames = page.frames();
  for (const frame of frames) {
    for (const sel of selectors) {
      let h = null;
      try {
        h = await frame.$(sel).catch(() => null);
      } catch (e) {}
      if (!h) continue;
      try {
        const box = await h.boundingBox().catch(() => null);
        if (box && box.width > 2 && box.height > 2) return { frame, handle: h, box, sel };
      } catch (e) {}
    }
  }
  return null;
}

async function getAliState(page) {
  return page
    .evaluate(() => {
      try {
        const a = window.__ali || {};
        return {
          verify: a.verify || null,
          fails: Array.isArray(a.fails) ? a.fails.slice(-10) : [],
          inited: !!a.inited,
          sdkLoaded: !!a.sdkLoaded,
          sdkErr: a.sdkErr || null,
          shadow: a.shadow || null,
          back: a.back || null,
          instMethods: a.instMethods || [],
          hasInst: !!window.__inst,
        };
      } catch (e) {
        return null;
      }
    })
    .catch(() => null);
}

async function getLayout(page) {
  return page
    .evaluate(() => {
      try {
        const r = (sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const b = el.getBoundingClientRect();
          if (!b || b.width < 2) return null;
          return { x: b.x, y: b.y, w: b.width, h: b.height };
        };
        const puzzle = document.querySelector("#aliyunCaptcha-puzzle");
        const bg = document.querySelector("#aliyunCaptcha-img");
        let text = "";
        try {
          const root =
            document.querySelector("[id*='aliyunCaptcha-window']") ||
            document.querySelector("[id*='aliyunCaptcha']") ||
            document.body;
          text = (root.innerText || "").slice(0, 600);
        } catch (e) {}
        return {
          slider: r("#aliyunCaptcha-sliding-slider"),
          puzzle: r("#aliyunCaptcha-puzzle"),
          bg: r("#aliyunCaptcha-img"),
          puzzleLeft: puzzle ? parseFloat(puzzle.style.left) || 0 : null,
          puzzleSrc: puzzle ? (puzzle.currentSrc || puzzle.src || "").slice(0, 220) : null,
          bgSrc: bg ? (bg.currentSrc || bg.src || "").slice(0, 220) : null,
          button: r("#captcha-button"),
          gate: r("#aliyunCaptcha-captcha-text"),
          text,
        };
      } catch (e) {
        return null;
      }
    })
    .catch(() => null);
}

async function clickCenter(page, box) {
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x + rand(-30, -10), y + rand(-10, 10), { steps: 4 }).catch(() => {});
  await sleep(rand(100, 220));
  await page.mouse.move(x, y, { steps: 4 }).catch(() => {});
  await sleep(rand(80, 180));
  await page.mouse.down().catch(() => {});
  await sleep(rand(60, 140));
  await page.mouse.up().catch(() => {});
}

// Closed-loop drag: hold the slider and advance until the measured piece
// position reaches targetPageX (piece image-left edge, page coords).
async function closedLoopDrag(page, sliderBox, targetPageX, measurePieceX, dbgAttempt) {
  const sx = sliderBox.x + sliderBox.width / 2;
  const sy = sliderBox.y + sliderBox.height / 2;
  const samples = [];
  await page.mouse.move(sx + rand(-35, -12), sy + rand(-10, 10), { steps: 4 }).catch(() => {});
  await sleep(rand(140, 280));
  await page.mouse.move(sx, sy, { steps: 5 }).catch(() => {});
  await sleep(rand(100, 220));
  await page.mouse.down().catch(() => {});
  let moved = 0;
  try {
    const t0 = Date.now();
    while (Date.now() - t0 < 14000) {
      const cur = await measurePieceX();
      if (cur == null) break;
      samples.push(Math.round(cur));
      const remaining = targetPageX - cur;
      if (remaining <= 1.4) break;
      const step = Math.max(2, Math.min(remaining * rand(0.3, 0.5), 26));
      moved += step;
      await page.mouse.move(sx + moved, sy + rand(-1.6, 1.6), { steps: 2 }).catch(() => {});
      await sleep(rand(35, 95));
    }
    await sleep(rand(180, 380));
    // Final correction nudge if still short.
    const cur = await measurePieceX();
    if (cur != null) {
      samples.push(Math.round(cur));
      const remaining = targetPageX - cur;
      if (remaining > 3 && remaining < 60) {
        moved += remaining * 0.6;
        await page.mouse.move(sx + moved, sy + rand(-1, 1), { steps: 2 }).catch(() => {});
        await sleep(rand(150, 300));
      } else if (remaining < -4 && remaining > -40) {
        moved += remaining * 0.5;
        await page.mouse.move(sx + moved, sy + rand(-1, 1), { steps: 2 }).catch(() => {});
        await sleep(rand(150, 300));
      }
      const end = await measurePieceX();
      if (end != null) samples.push(Math.round(end));
    }
  } finally {
    await sleep(rand(100, 200));
    await page.mouse.up().catch(() => {});
  }
  if (dbgAttempt) dbgAttempt.samples = samples.slice(-12);
  return { moved: Math.round(moved) };
}

async function openLoopDrag(page, sx, sy, dist) {
  await page.mouse.move(sx + rand(-30, -10), sy + rand(-8, 8), { steps: 4 }).catch(() => {});
  await sleep(rand(140, 280));
  await page.mouse.move(sx, sy, { steps: 4 }).catch(() => {});
  await sleep(rand(100, 200));
  await page.mouse.down().catch(() => {});
  try {
    const overshoot = dist + rand(5, 10);
    const total = rand(900, 1400);
    const steps = 26;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const ease = 1 - Math.pow(1 - t, 3);
      await page.mouse
        .move(sx + ease * overshoot, sy + rand(-1.6, 1.6), { steps: 1 })
        .catch(() => {});
      await sleep((total / steps) * rand(0.7, 1.3));
    }
    await sleep(rand(150, 350));
    for (let i = 1; i <= 3; i++) {
      await page.mouse
        .move(sx + overshoot + ((dist - overshoot) * i) / 3, sy + rand(-1, 1), { steps: 1 })
        .catch(() => {});
      await sleep(rand(80, 170));
    }
  } finally {
    await sleep(rand(100, 220));
    await page.mouse.up().catch(() => {});
  }
}

async function sliderRange(page, found) {
  try {
    const r = await found.frame
      .evaluate((el) => {
        try {
          const p = el.parentElement;
          if (!p) return null;
          const pr = p.getBoundingClientRect();
          const sr = el.getBoundingClientRect();
          const range = pr.width - sr.width;
          return range > 20 && range < 2000 ? range : null;
        } catch (e) {
          return null;
        }
      }, found.handle)
      .catch(() => null);
    if (r) return r;
  } catch (e) {}
  return Math.max(120, 360 - (found.box ? found.box.width : 40));
}

// ---------------- main solver ----------------

async function solveAliyun({
  sceneId,
  prefix,
  region = "sgp",
  language = "en",
  mode = "popup",
  timeout = 120,
  sdkUrl,
  debug = false,
  browserService,
} = {}) {
  const startTime = Date.now();
  if (!sceneId) throw new Error("sceneId is required");
  if (!prefix) throw new Error("prefix is required");
  if (!["cn", "sgp"].includes(region)) throw new Error("region must be cn or sgp");
  if (!["popup", "embed", "float"].includes(mode)) throw new Error("mode must be popup, embed or float");
  if (!browserService) throw new Error("Browser service not initialized");

  const ua =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  const html = buildAliyunPage({ sceneId, prefix, region, language, mode, sdkUrl });
  const deadline = Date.now() + Math.min(Math.max(timeout || 120, 20), 300) * 1000;

  const dbg = { stages: [], attempts: [], fails: [], instMethods: [], type: null, screenshot: null };
  const mark = (s) => {
    dbg.stages.push(`${((Date.now() - startTime) / 1000).toFixed(1)}s:${s}`);
  };
  const TWEAKS = [0, 3, -3, 6, -6, 9, -9, 12, -12, 5];

  const fail = async (page, msg) => {
    const st = await getAliState(page).catch(() => null);
    if (st) {
      dbg.fails = st.fails || [];
      dbg.instMethods = st.instMethods || [];
    }
    if (debug && page) {
      try {
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
    try {
      await page.setUserAgent(ua).catch(() => {});
    } catch (e) {}

    await page.setRequestInterception(true);
    page.on("request", async (request) => {
      try {
        const rt = request.resourceType();
        let isMain = true;
        try {
          const f = request.frame();
          if (f && page.mainFrame && f !== page.mainFrame()) isMain = false;
        } catch (e) {}
        const isHarvest = (request.url() || "").startsWith(HARVEST_URL);
        if (rt === "document" && isMain && isHarvest) {
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
      await page.goto(HARVEST_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    } catch (e) {
      await fail(page, `Harvest page navigation failed: ${e.message}`);
    }

    // 1. SDK init.
    mark("wait-init");
    try {
      await page.waitForFunction(() => window.__ali && window.__ali.inited === true, {
        timeout: 30000,
        polling: 400,
      });
    } catch (e) {
      const st = await getAliState(page);
      const why = !st
        ? "page eval failed"
        : st.sdkErr
          ? st.sdkErr
          : !st.sdkLoaded
            ? "SDK script failed to load (network blocked? custom sdkUrl?)"
            : "initAliyunCaptcha never became ready (wrong sceneId/prefix/region?)";
      await fail(page, `Aliyun SDK init timeout (${why})`);
    }
    mark("inited");
    {
      const st = await getAliState(page);
      if (st) dbg.instMethods = st.instMethods || [];
    }

    const getVerify = async () => {
      const st = await getAliState(page);
      return st && st.verify ? st.verify : null;
    };

    // 2. Trigger verification (popup button).
    let triggerAttempted = false;
    let instProbed = false;
    const trigger = async () => {
      const lay = await getLayout(page);
      if (lay && lay.button) {
        mark("click-button");
        await clickCenter(page, { x: lay.button.x, y: lay.button.y, width: lay.button.w, height: lay.button.h });
        await sleep(1500);
        return true;
      }
      // Fallback: click via selector (frames).
      const btn = await findVisible(page, ["#captcha-button"]).catch(() => null);
      if (btn) {
        mark("click-button-frame");
        await clickCenter(page, btn.box);
        await sleep(1500);
        return true;
      }
      if (!instProbed) {
        instProbed = true;
        await page
          .evaluate(() => {
            try {
              const inst = window.__inst;
              if (!inst) return "no-inst";
              const cands = ["show", "popup", "startTracelessVerification", "verify", "refresh"];
              for (const m of cands) {
                try {
                  if (typeof inst[m] === "function") {
                    inst[m]();
                    return m;
                  }
                } catch (e) {}
              }
              return "none";
            } catch (e) {
              return "err";
            }
          })
          .catch(() => null);
        await sleep(1500);
      }
      return false;
    };

    // 3. Attempt loop.
    let tweakIdx = 0;
    let lastImgKey = null;
    let idleSince = Date.now();
    let attemptNo = 0;

    while (Date.now() < deadline) {
      const v = await getVerify();
      if (v) {
        mark("verified");
        return v;
      }

      const slider = await findVisible(page, SLIDER_SELS);
      if (!slider) {
        const lay = await getLayout(page);
        // Gate text ("click to start") visible? click it.
        if (lay && lay.gate) {
          mark("click-gate");
          await clickCenter(page, { x: lay.gate.x, y: lay.gate.y, width: lay.gate.w, height: lay.gate.h });
          await sleep(1800);
          continue;
        }
        if (!triggerAttempted) {
          await trigger();
          triggerAttempted = true;
          idleSince = Date.now();
        }
        // Icon-click / unsupported type detection via popup text.
        if (lay && lay.text) {
          const low = lay.text.toLowerCase();
          if (ICONCLICK_WORDS.some((w) => low.includes(w.toLowerCase()))) {
            dbg.type = "icon-click";
            await fail(page, "Aliyun icon-click (point-select in order) type is not supported by this solver");
          }
        }
        if (Date.now() - idleSince > 45000) {
          const st = await getAliState(page);
          const hint = st && st.fails && st.fails.length ? ` (${st.fails[st.fails.length - 1]})` : "";
          await fail(page, `No slider UI appeared within 45s${hint} — scene may be blocked/risk-rejected for this IP`);
        }
        await sleep(1200);
        continue;
      }
      idleSince = Date.now();

      // Unsupported-type check.
      const lay = await getLayout(page);
      if (lay && lay.text) {
        const low = lay.text.toLowerCase();
        if (ICONCLICK_WORDS.some((w) => low.includes(w.toLowerCase()))) {
          dbg.type = "icon-click";
          await fail(page, "Aliyun icon-click (point-select in order) type is not supported by this solver");
        }
      }

      attemptNo++;
      const att = { n: attemptNo, method: null, gapX: null, target: null, tweak: 0, confidence: null, outcome: null };
      dbg.attempts.push(att);
      mark(`attempt:${attemptNo}`);

      // Fresh geometry.
      let sliderBox = slider.box;
      try {
        const fresh = await slider.handle.boundingBox().catch(() => null);
        if (fresh && fresh.width > 2) sliderBox = fresh;
      } catch (e) {}

      // Image URLs: hook capture first, DOM backstop second.
      let st = await getAliState(page);
      let shadowUrl = st && st.shadow;
      let backUrl = st && st.back;
      if ((!shadowUrl || !backUrl) && lay) {
        if (lay.puzzleSrc && lay.puzzleSrc.includes("shadow.png")) shadowUrl = lay.puzzleSrc;
        if (lay.bgSrc && lay.bgSrc.includes("back.png")) backUrl = lay.bgSrc;
      }
      if (!shadowUrl || !backUrl) {
        try {
          const found = await page
            .evaluate(() => {
              try {
                const out = { shadow: null, back: null };
                document.querySelectorAll("img").forEach((img) => {
                  const u = img.currentSrc || img.src || "";
                  if (u.includes("shadow.png")) out.shadow = u;
                  else if (u.includes("back.png")) out.back = u;
                });
                return out;
              } catch (e) {
                return { shadow: null, back: null };
              }
            })
            .catch(() => null);
          if (found) {
            shadowUrl = shadowUrl || found.shadow;
            backUrl = backUrl || found.back;
          }
        } catch (e) {}
      }

      const imgKey = shadowUrl && backUrl ? `${shadowUrl}|${backUrl}` : "noimg";
      if (imgKey !== lastImgKey) {
        lastImgKey = imgKey;
        tweakIdx = 0;
      }
      const tweak = TWEAKS[Math.min(tweakIdx, TWEAKS.length - 1)];
      att.tweak = tweak;

      if (shadowUrl && backUrl) {
        // ---- puzzle slide with closed-loop control ----
        dbg.type = "puzzle-slide";
        att.method = "closed-loop";
        let gap = null;
        try {
          const [sb, bb] = await Promise.all([downloadImage(shadowUrl, ua), downloadImage(backUrl, ua)]);
          gap = await computeGap(sb, bb);
        } catch (e) {
          att.outcome = `img-download-fail:${e.message}`.slice(0, 120);
        }
        const layNow = (await getLayout(page)) || lay;
        const bgBox = layNow && layNow.bg;
        const puzBox0 = layNow && layNow.puzzle;
        if (!gap || !bgBox || !puzBox0) {
          att.outcome = !gap ? "gap-compute-fail" : "layout-missing";
          mark(`attempt:${attemptNo}:fallback-fullslide`);
          const range = await sliderRange(page, slider);
          await openLoopDrag(page, sliderBox.x + sliderBox.width / 2, sliderBox.y + sliderBox.height / 2, range);
        } else {
          att.gapX = gap.gapX;
          att.confidence = +gap.confidence.toFixed(3);
          const scaleBg = bgBox.w / gap.bgW;
          const target = Math.round(bgBox.x + gap.gapX * scaleBg + tweak);
          att.target = target;
          mark(`attempt:${attemptNo}:gap=${gap.gapX}->${target}`);
          const measurePieceX = async () => {
            const l = await getLayout(page);
            if (!l || !l.puzzle) return null;
            return l.puzzle.x;
          };
          // Sanity: gap must be right of the piece start.
          if (target < puzBox0.x + 4) {
            att.outcome = "gap-insane-fullslide";
            const range = await sliderRange(page, slider);
            await openLoopDrag(page, sliderBox.x + sliderBox.width / 2, sliderBox.y + sliderBox.height / 2, range);
          } else {
            const res = await closedLoopDrag(page, sliderBox, target, measurePieceX, att);
            att.moved = res.moved;
          }
        }
      } else {
        // ---- behavior-only slide: drag to the end ----
        dbg.type = dbg.type || "behavior-slide";
        att.method = "full-slide";
        mark(`attempt:${attemptNo}:fullslide`);
        const range = await sliderRange(page, slider);
        att.target = Math.round(range);
        await openLoopDrag(page, sliderBox.x + sliderBox.width / 2, sliderBox.y + sliderBox.height / 2, range);
      }

      // Post-drag: wait for verify / refresh / reset.
      const tWait = Date.now() + 6000;
      let outcome = "unknown";
      while (Date.now() < tWait) {
        await sleep(500);
        const vv = await getVerify();
        if (vv) {
          att.outcome = "success";
          mark("verified");
          return vv;
        }
        const st2 = await getAliState(page);
        const key2 = st2 && st2.shadow && st2.back ? `${st2.shadow}|${st2.back}` : imgKey;
        if (key2 !== imgKey) {
          outcome = "images-refreshed";
          break;
        }
        const lay2 = await getLayout(page);
        if (lay2 && lay2.text) {
          const low = lay2.text.toLowerCase();
          if (FAIL_WORDS.some((w) => low.includes(w.toLowerCase()))) {
            outcome = "fail-text";
            await sleep(1500);
            break;
          }
        }
        const sl2 = await findVisible(page, SLIDER_SELS);
        if (!sl2) {
          outcome = "slider-gone";
          await sleep(2000);
          const vv2 = await getVerify();
          if (vv2) {
            att.outcome = "success";
            return vv2;
          }
          break;
        }
      }
      // Piece returned to start? (attempt rejected, same images)
      try {
        const lay3 = await getLayout(page);
        const st3 = await getAliState(page);
        const key3 = st3 && st3.shadow && st3.back ? `${st3.shadow}|${st3.back}` : imgKey;
        if (key3 === imgKey && lay3 && lay3.puzzle && lay3.bg) {
          if (lay3.puzzle.x <= lay3.bg.x + 6) outcome = outcome === "unknown" ? "piece-reset" : outcome;
        }
      } catch (e) {}
      if (!att.outcome) att.outcome = outcome;
      mark(`attempt:${attemptNo}:${outcome}`);
      if (outcome !== "images-refreshed") tweakIdx++;
      if (outcome === "slider-gone") triggerAttempted = false; // popup may have closed: re-trigger next round
      await sleep(800);
    }

    await fail(page, "Timeout waiting for Aliyun verification (no verifyParam returned)");
    return null;
  });

  if (!token) {
    const err = new Error("Failed to get Aliyun token");
    err.debug = dbg;
    throw err;
  }
  return { success: true, data: token, duration: Date.now() - startTime, debug: dbg };
}

module.exports = { solveAliyun, buildAliyunPage, computeGap, HARVEST_URL, SDK_URL };
