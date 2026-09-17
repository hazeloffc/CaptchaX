const axios = require("axios");

const HARVEST_URL = "https://harvest.aliyun.local/";
const SDK_URL = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildAliyunPage({ sceneId, prefix, region }) {
  const safe = (s) => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title></title>
    <script>
        window.AliyunCaptchaConfig = { region: '${safe(region)}', prefix: '${safe(prefix)}' };
    </script>
    <script type="text/javascript" src="${SDK_URL}"></script>
</head>
<body>
    <div id="captcha-element"></div>
    <button id="captcha-button">Verify</button>
    <script>
        window.__inst = null;
        window.__verify = null;
        window.__verifyFail = null;
        window.__inited = false;
        function boot() {
            if (typeof window.initAliyunCaptcha !== 'function') { setTimeout(boot, 300); return; }
            try {
                window.initAliyunCaptcha({
                    SceneId: '${safe(sceneId)}',
                    mode: 'popup',
                    element: '#captcha-element',
                    button: '#captcha-button',
                    language: 'en',
                    slideStyle: { width: 360, height: 40 },
                    success: function (param) { window.__verify = (typeof param === 'string') ? param : JSON.stringify(param); },
                    fail: function (err) { try { window.__verifyFail = JSON.stringify(err); } catch (e) { window.__verifyFail = 'fail'; } },
                    captchaVerifyCallback: function (param) {
                        window.__verify = (typeof param === 'string') ? param : JSON.stringify(param);
                        return { captchaResult: true, bizResult: true };
                    },
                    getInstance: function (inst) { window.__inst = inst; window.__inited = true; }
                });
            } catch (e) {
                window.__verifyFail = 'init-error:' + (e && e.message);
            }
        }
        boot();
    </script>
</body>
</html>`;
}

async function humanDrag(page, sx, sy, dist) {
  await page.mouse.move(sx, sy);
  await sleep(120 + Math.random() * 150);
  await page.mouse.down();
  const overshoot = dist + 6 + Math.random() * 5;
  const total = 900 + Math.random() * 500;
  const steps = 28;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const ease = 1 - Math.pow(1 - t, 3);
    const x = ease * overshoot;
    const y = (Math.random() - 0.5) * 2;
    await page.mouse.move(sx + x, sy + y);
    await sleep((total / steps) * (0.7 + Math.random() * 0.6));
  }
  await sleep(150 + Math.random() * 200);
  for (let i = 1; i <= 3; i++) {
    const x = overshoot + ((dist - overshoot) * i) / 3;
    await page.mouse.move(sx + x, sy + (Math.random() - 0.5) * 1.5);
    await sleep(90 + Math.random() * 90);
  }
  await sleep(120);
  await page.mouse.up();
}

async function findSlider(page) {
  return page.evaluate(() => {
    try {
      const sels = [
        "#aliyunCaptcha-sliding-slider",
        "[id*='sliding-slider']",
        "[class*='sliding-slider']",
        ".nc_scale",
        "[class*='slider-btn']",
        "[class*='slider-handle']",
      ];
      for (const s of sels) {
        const el = document.querySelector(s);
        if (el) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            return { x: r.x, y: r.y, w: r.width, h: r.height };
          }
        }
      }
      return null;
    } catch (e) {
      return null;
    }
  }).catch(() => null);
}

async function trackWidth(page, handle) {
  return page.evaluate((h) => {
    try {
      const sels = [
        "#aliyunCaptcha-sliding-track",
        "[id*='sliding-track']",
        "[class*='sliding-track']",
        "[class*='slider-track']",
        ".nc_scale",
      ];
      for (const s of sels) {
        const el = document.querySelector(s);
        if (el) {
          const r = el.getBoundingClientRect();
          if (r.width > h.w + 20) return r.width;
        }
      }
      return null;
    } catch (e) {
      return null;
    }
  }, handle).catch(() => null);
}

async function collectImages(page) {
  return page.evaluate(() => {
    try {
      const out = [];
      const seen = new Set();
      const push = (url, dw, dh, nw, nh) => {
        if (!url || seen.has(url)) return;
        if (url.startsWith("data:")) return;
        seen.add(url);
        out.push({ url, dispW: Math.round(dw), dispH: Math.round(dh), natW: nw, natH: nh });
      };
      document.querySelectorAll("img").forEach((img) => {
        try {
          const r = img.getBoundingClientRect();
          if (r.width < 40 || r.height < 40) return;
          if (!img.src) return;
          push(img.src, r.width, r.height, img.naturalWidth || 0, img.naturalHeight || 0);
        } catch (e) {}
      });
      document.querySelectorAll("div,span").forEach((el) => {
        try {
          const bg = getComputedStyle(el).backgroundImage;
          const m = bg && bg.match(/url\("?(.*?)"?\)/);
          if (!m || seen.has(m[1])) return;
          const r = el.getBoundingClientRect();
          if (r.width < 100 || r.height < 60) return;
          push(m[1], r.width, r.height, 0, 0);
        } catch (e) {}
      });
      return out.slice(0, 12);
    } catch (e) {
      return [];
    }
  }).catch(() => []);
}

function detectGapAlpha(bg, piece) {
  const bw = bg.bitmap.width;
  const bh = bg.bitmap.height;
  const pw = piece.bitmap.width;
  const ph = piece.bitmap.height;
  const bgData = bg.bitmap.data;
  const pcData = piece.bitmap.data;

  let minX = pw, minY = ph, maxX = -1, maxY = -1;
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      if (pcData[(y * pw + x) * 4 + 3] > 40) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const t0 = Date.now();
  let bestX = 0;
  let bestScore = Infinity;
  for (let ox = 0; ox <= bw - (maxX - minX + 1); ox++) {
    if ((ox & 7) === 0 && Date.now() - t0 > 8000) break;
    let score = 0;
    let count = 0;
    for (let y = minY; y <= maxY; y += 2) {
      for (let x = minX; x <= maxX; x += 2) {
        if (pcData[(y * pw + x) * 4 + 3] <= 40) continue;
        const p = pcData[(y * pw + x) * 4];
        const b = bgData[(y * bw + ox + x) * 4];
        const d = p - b;
        score += d * d;
        count++;
      }
    }
    if (count > 0) {
      score = score / count;
      if (score < bestScore) {
        bestScore = score;
        bestX = ox + minX;
      }
    }
  }
  return { gapX: bestX, pieceW: maxX - minX + 1 };
}

async function detectGapFromUrls(cands, ua) {
  let Jimp;
  try {
    Jimp = require("jimp");
  } catch (e) {
    return null;
  }
  const imgs = [];
  for (const c of cands) {
    try {
      const res = await axios.get(c.url, {
        responseType: "arraybuffer",
        timeout: 12000,
        headers: { "User-Agent": ua },
      });
      const img = await Jimp.read(Buffer.from(res.data));
      imgs.push({ cand: c, img });
    } catch (e) {}
  }
  if (imgs.length < 2) return null;

  const hasAlpha = (img) => {
    const d = img.bitmap.data;
    let transparent = 0;
    for (let i = 3; i < d.length; i += 16) {
      if (d[i] < 250) transparent++;
    }
    return transparent > 20;
  };

  const scored = imgs.map(({ cand, img }) => ({
    cand,
    img,
    area: (cand.natW || cand.dispW) * (cand.natH || cand.dispH),
    alpha: hasAlpha(img),
  }));

  const pieces = scored.filter((s) => s.alpha).sort((a, b) => a.area - b.area);
  const bgs = scored.filter((s) => !s.alpha).sort((a, b) => b.area - a.area);
  if (!pieces.length || !bgs.length) return null;

  const piece = pieces[0];
  const bg = bgs[0];
  const gray = async (img) => img.clone().grayscale();
  const res = detectGapAlpha(await gray(bg.img), await gray(piece.img));
  if (!res) return null;

  const natW = bg.cand.natW || bg.cand.dispW;
  const scale = natW ? bg.cand.dispW / natW : 1;
  return {
    gapXDisplay: res.gapX * scale,
    bgDisplayW: bg.cand.dispW,
    pieceDisplayW: (piece.cand.natW || piece.cand.dispW) * ((piece.cand.natW ? piece.cand.dispW / piece.cand.natW : 1) || 1),
  };
}

async function solveAliyun({ sceneId, prefix, region = "sgp", timeout = 120, browserService } = {}) {
  const startTime = Date.now();
  if (!sceneId) throw new Error("sceneId is required");
  if (!prefix) throw new Error("prefix is required");
  if (!["cn", "sgp"].includes(region)) throw new Error("region must be cn or sgp");
  if (!browserService) throw new Error("Browser service not initialized");

  const deadline = Date.now() + Math.min(Math.max(timeout || 120, 20), 300) * 1000;
  const html = buildAliyunPage({ sceneId, prefix, region });

  const token = await browserService.withBrowserContext(async (context) => {
    const page = await context.newPage();
    await page.setRequestInterception(true);
    page.on("request", async (request) => {
      try {
        if ([HARVEST_URL, HARVEST_URL.slice(0, -1)].includes(request.url()) && request.resourceType() === "document") {
          await request.respond({ status: 200, contentType: "text/html", body: html });
        } else {
          await request.continue();
        }
      } catch (e) {}
    });

    await page.goto(HARVEST_URL, { waitUntil: "domcontentloaded", timeout: 30000 });

    try {
      await page.waitForFunction(() => window.__inited === true, { timeout: 25000 });
    } catch (e) {
      const fail = await page.evaluate(() => window.__verifyFail).catch(() => null);
      throw new Error("Aliyun SDK init timeout" + (fail ? " (" + fail + ")" : " (check sceneId/prefix/region)"));
    }

    const getVerify = () => page.evaluate(() => window.__verify).catch(() => null);
    const ua = await page.evaluate(() => navigator.userAgent).catch(() => "Mozilla/5.0");

    await page.click("#captcha-button").catch(() => {});

    let attempt = 0;
    let draggedThisRound = false;

    while (Date.now() < deadline) {
      const v = await getVerify();
      if (v) return v;

      const slider = await findSlider(page);
      if (!slider) {
        await sleep(1000);
        continue;
      }

      if (draggedThisRound) {
        const f = await page.evaluate(() => {
          const x = window.__verifyFail;
          window.__verifyFail = null;
          return x;
        }).catch(() => null);
        if (f) draggedThisRound = false;
        await sleep(1200);
        continue;
      }

      attempt++;
      const cx = slider.x + slider.w / 2;
      const cy = slider.y + slider.h / 2;
      const tw = (await trackWidth(page, slider)) || slider.w * 5;
      const handleRange = Math.max(tw - slider.w, 50);

      let dist = handleRange;
      let method = "full-slide";
      try {
        const cands = await collectImages(page);
        if (cands.length >= 2) {
          const gap = await detectGapFromUrls(cands, ua);
          if (gap && gap.gapXDisplay > 5) {
            const pieceRange = Math.max(gap.bgDisplayW - gap.pieceDisplayW, 20);
            const tweak = attempt === 1 ? 1 : attempt === 2 ? 1.03 : 0.97;
            dist = Math.min(handleRange, (gap.gapXDisplay * handleRange) / pieceRange) * tweak;
            method = "gap-slide";
          }
        }
      } catch (e) {}

      dist = Math.max(10, Math.min(handleRange, dist));
      await humanDrag(page, cx, cy, dist);
      draggedThisRound = true;
      await sleep(2500);
    }

    throw new Error("Timeout waiting for Aliyun verification (no token)");
  });

  if (!token) throw new Error("Failed to get Aliyun token");
  return { success: true, data: token, duration: Date.now() - startTime };
}

module.exports = { solveAliyun, HARVEST_URL };
