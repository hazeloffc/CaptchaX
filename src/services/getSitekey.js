const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Classify a sitekey string into a captcha type with metadata.
 * Returns an object { type, label, endpoint, pattern } or null if unknown.
 */
function classifyKey(raw) {
  if (!raw || typeof raw !== "string") return null;
  const key = raw.trim();
  if (!key || key.length < 4) return null;

  // ---- Cloudflare Turnstile ----
  // Format: 0x4AAAAAA... (base64url-ish, selalu diawali "0x" dan panjang ~40+ char)
  if (/^0x[a-zA-Z0-9_-]{10,}$/.test(key)) {
    let variant = "managed";
    // 1x00000000000000000000AA = dummy test key (always passes)
    if (/^1x0{10,}/.test(key)) variant = "test-dummy";
    // 0x4AAAAAAAC / 0x4AAAAAAAH / 0x4AAAAAAAK — umumnya managed/non-interactive/invisible
    if (/^0x4AAAAAAA/.test(key)) variant = "managed-or-non-interactive";
    return {
      type: "turnstile",
      label: "Cloudflare Turnstile",
      sitekey: key,
      variant,
      pattern: "0x-prefixed (base64url)",
    };
  }

  // ---- reCAPTCHA (v2 / v2-invisible / v3 / enterprise) ----
  // Semua sitekey Google reCAPTCHA diawali "6L" atau "6Lc/6Le/6Lf/6Ld" dll, base64-like ~40 char
  // Enterprise kadang diawali "6Lc"/"6Le" juga; tapi test key = 6LeIxAcTAAAA...
  if (/^6L[a-zA-Z0-9_-]{10,}(-[a-zA-Z0-9_-]+)?$/.test(key)) {
    let variant = "unknown";
    // Test key publik Google (selalu valid)
    if (key === "6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI") variant = "v3-test";
    else if (/^6Lc/.test(key)) variant = "v2-checkbox";
    else if (/^6Ld/.test(key)) variant = "v2-invisible";
    else if (/^6Lg/.test(key)) variant = "v2-android";
    else if (/^6Le/.test(key)) variant = "v2-or-v3";
    else if (/^6Lf/.test(key)) variant = "v2-or-v3";
    else variant = "recaptcha";
    // Suffix dengan "-" panjang sering menandakan enterprise score-based (v3)
    if (/-[a-zA-Z0-9_-]{20,}$/.test(key)) variant = "enterprise";
    return {
      type: "recaptcha",
      label: "Google reCAPTCHA",
      sitekey: key,
      variant,
      pattern: "6L-prefixed (Google reCAPTCHA)",
    };
  }

  // ---- hCaptcha ----
  // Format UUID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx (8-4-4-4-12 hex)
  // Ada juga sitekey pendek numerik untuk enterprise (jarang); UUID yang paling umum.
  if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(key)) {
    return {
      type: "hcaptcha",
      label: "hCaptcha",
      sitekey: key,
      variant: "checkbox-or-invisible",
      pattern: "UUID format",
    };
  }
  // hCaptcha test key (well-known)
  if (/^10000000-ffff-ffff-ffff-000000000001$/.test(key)) {
    return {
      type: "hcaptcha",
      label: "hCaptcha",
      sitekey: key,
      variant: "test-always-pass",
      pattern: "UUID format (test key)",
    };
  }
  // Beberapa sitekey hCaptcha enterprise bisa tanpa strip (32 char hex panjang)
  if (/^[0-9a-fA-F]{32,}$/.test(key) && key.length >= 32 && key.length <= 64) {
    return {
      type: "hcaptcha",
      label: "hCaptcha (enterprise hex)",
      sitekey: key,
      variant: "enterprise",
      pattern: "hex string (32+ char)",
    };
  }

  // ---- FriendlyCaptcha (v1) ----
  // Diawali "FCM" atau "FCS" diikuti base64-ish. Contoh test: FCMGEMUD2M567T8G
  if (/^FC[MS][A-Z0-9]{6,}$/.test(key)) {
    let variant = "v1";
    if (/^FCS/.test(key)) variant = "v2-or-eu";
    if (key === "FCMGEMUD2M567T8G") variant = "v1-test-demo";
    return {
      type: "friendly",
      label: "FriendlyCaptcha",
      sitekey: key,
      variant,
      pattern: "FCM/FCS prefix",
    };
  }

  // ---- Altcha ----
  // Altcha TIDAK pakai static sitekey; tapi jika ada key base64 panjang yang masuk ke
  // `data-sitekey` pada .altcha div, umumnya berupa base64 JSON {challenge,salt,...}
  // Kita tandai sebagai "altcha-like" jika panjang base64 dan ada konteks altcha.
  if (/^[a-zA-Z0-9+/=_-]{60,}$/.test(key) && !/^0x|^6L/.test(key) && key.length > 60) {
    // Kemungkinan altcha payload/key
    return {
      type: "altcha",
      label: "Altcha (possible)",
      sitekey: key,
      variant: "possible",
      pattern: "long base64 (detect from context)",
    };
  }

  return {
    type: "unknown",
    label: "Unknown",
    sitekey: key,
    variant: "unrecognized",
    pattern: "no known pattern",
  };
}

/**
 * Visit a URL with the browser, scan DOM + network requests + global vars for
 * captcha sitekeys, and classify each one.
 *
 * @param {object} opts
 * @param {string} opts.url         - target URL
 * @param {number} [opts.timeout=30000]
 * @param {BrowserService} opts.browserService
 */
async function getSitekey({ url, timeout = 30000, browserService } = {}) {
  if (!url) throw new Error("url is required");
  try {
    new URL(url);
  } catch (e) {
    throw new Error("Invalid url");
  }
  if (!browserService) throw new Error("Browser service not initialized");

  const budget = Math.min(Math.max(timeout || 30000, 10000), 90000);

  const data = await browserService.withBrowserContext(async (context) => {
    const page = await context.newPage();
    await page.setDefaultTimeout(30000);
    await page.setDefaultNavigationTimeout(30000);

    // Tangkap request ke domain captcha provider untuk ambil sitekey dari query param / path
    const requests = [];
    const requestKeys = new Map(); // key -> { sources: [type,...] }

    const addKey = (k, source) => {
      if (!k) return;
      const key = String(k).trim();
      if (!key || key.length < 4) return;
      if (key.length > 200) return; // mustahil sitekey sepanjang ini
      if (!requestKeys.has(key)) {
        requestKeys.set(key, { sources: [] });
      }
      const entry = requestKeys.get(key);
      if (!entry.sources.includes(source) && entry.sources.length < 8) {
        entry.sources.push(source);
      }
    };

    // Script URL patterns yang menandakan provider captcha dimuat
    const PROVIDER_RE = {
      recaptcha: /(google\.com\/recaptcha|gstatic\.com\/recaptcha)/i,
      turnstile: /challenges\.cloudflare\.com\/turnstile/i,
      hcaptcha: /(hcaptcha\.com|assets\.hcaptcha\.com)/i,
      friendly: /(cdn.jsdelivr.net\/npm\/friendly-pow|api\.friendlycaptcha\.com)/i,
      altcha: /(altcha\.org|cdn\.jsdelivr\.net\/npm\/altcha|altcha.min)/i,
      aliyun: /(aliyuncaptcha|captcha-open\.)/i,
    };

    const providersDetected = new Set();

    page.on("request", (req) => {
      try {
        const u = req.url() || "";
        if (requests.length < 100) requests.push(u.slice(0, 300));

        for (const [name, re] of Object.entries(PROVIDER_RE)) {
          if (re.test(u)) providersDetected.add(name);
        }

        // sitekey dari query param
        let m;
        if (/sitekey/i.test(u)) {
          m = u.match(/[?&](?:sitekey|siteKey|data-sitekey|k)=([^&"'<>\s]{4,200})/i);
          if (m) addKey(decodeURIComponent(m[1]), `request:${new URL(u).hostname}`);
        }
        // render?render=reCAPTCHA_v3_sitekey
        m = u.match(/\/recaptcha\/(?:enterprise|api)\.js\?.*[?&]render=([^&"'<>\s]{4,80})/i);
        if (m && m[1] !== "explicit") addKey(decodeURIComponent(m[1]), "recaptcha-render-param");

        // hcaptcha sitekey di path atau query: /1/sitekey/...
        m = u.match(/hcaptcha\.com\/[0-9]+\/([0-9a-fA-F-]{20,80})\/?/i);
        if (m) addKey(m[1], "hcaptcha-request-path");

        // turnstile/v0/sitekey/...
        m = u.match(/challenges\.cloudflare\.com\/turnstile\/v0([a-z-]*)\/([^/?&"'<>\s]{4,120})/i);
        if (m) addKey(m[2], "turnstile-request-path");

        // postData bisa berisi sitekey
        let post = "";
        try {
          post = req.postData() || "";
        } catch (e) {}
        if (post) {
          const pm = post.match(/(?:sitekey|siteKey|k)=([^&"'<>\s]{4,200})/i);
          if (pm) addKey(decodeURIComponent(pm[1]), "postdata");
        }
      } catch (e) {}
    });

    // Intersep respons untuk parse script inline yang memuat konfigurasi (recaptcha explicit render)
    page.on("response", async (res) => {
      try {
        const u = res.url() || "";
        const ct = res.headers()["content-type"] || "";
        if (!/html|javascript|json/i.test(ct)) return;
        const text = await res.text().catch(() => "");
        if (!text || text.length > 2_000_000) return;

        scanTextForKeys(text, (k, src) => addKey(k, src), `response:${new URL(u).hostname}`);
      } catch (e) {}
    });

    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: Math.min(budget, 45000) });
    } catch (e) {
      // timeout awal tidak fatal; kita tetap scan apa yang sudah ter-load
    }

    // Beri waktu bagi widget captcha untuk dirender + request API keluar
    const t0 = Date.now();
    while (Date.now() - t0 < Math.min(8000, budget - 3000)) {
      await sleep(800);
    }

    // ---- Scan DOM + window globals (termasuk subframe) ----
    const framesToScan = [page.mainFrame(), ...page.frames().filter((f) => f !== page.mainFrame())];
    for (const frame of framesToScan) {
      try {
        const result = await frame.evaluate(() => {
          const found = [];
          const add = (k, source) => {
            if (k && typeof k === "string") found.push({ key: k.trim(), source });
          };

          // Data-attribute pada elemen
          const attrTargets = [
            "[data-sitekey]",
            "[data-site-key]",
            "[data-site-key-prop]",
            "[data-hcaptcha-sitekey]",
            "[data-recaptcha-site-key]",
            "div[class*='g-recaptcha']",
            "div.g-recaptcha",
            ".cf-turnstile",
            "[data-turnstile-sitekey]",
            "[data-friendly-captcha-sitekey]",
            ".frc-captcha",
            ".altcha",
            "#captcha",
            "[class*='captcha']",
          ];
          for (const sel of attrTargets) {
            let nodes = [];
            try {
              nodes = Array.from(document.querySelectorAll(sel));
            } catch (e) {}
            for (const el of nodes) {
              for (const attr of ["data-sitekey", "data-site-key", "data-site-key-prop",
                                  "data-hcaptcha-sitekey", "data-recaptcha-site-key",
                                  "data-turnstile-sitekey", "data-friendly-captcha-sitekey",
                                  "data-key", "data-puzzle-endpoint"]) {
                const v = el.getAttribute && el.getAttribute(attr);
                if (v) add(v, `attr:${attr}@${sel}`);
              }
            }
          }

          // Iframe src (recaptcha / hcaptcha / turnstile frame)
          const iframes = Array.from(document.querySelectorAll("iframe[src]"));
          for (const f of iframes) {
            const src = f.src || "";
            try {
              const u = new URL(src, location.href);
              const k = u.searchParams.get("sitekey") || u.searchParams.get("k") || u.searchParams.get("siteKey");
              if (k) add(k, `iframe-src:${u.hostname}`);
              // turnstile: /cdn-cgi/challenge-platform/.../challenges.cloudflare.com.0x.../...
              const m1 = src.match(/challenges\.cloudflare\.com\.([^/&?"'<>]{4,200})/);
              if (m1) add(m1[1].replace(/^com\./, ""), "iframe-turnstile-enc");
              // reCAPTCHA v2 anchor: /recaptcha/api2/anchor?k=...
              const m2 = src.match(/[?&]k=([^&"'<>\s]{4,80})/);
              if (m2 && /recaptcha|google\.com|gstatic/.test(src)) add(m2[1], "iframe-recaptcha-k");
              // hCaptcha frame: /captcha/...uuid...
              const m3 = src.match(/\/captcha\/[0-9a-f-]{30,80}/i);
              if (m3) {
                const seg = m3[0].split("/").pop();
                add(seg, "iframe-hcaptcha-seg");
              }
            } catch (e) {}
          }

          // Script src — hanya untuk mendeteksi provider (sitekey biasanya ada di inline script atau data-attr)
          for (const s of Array.from(document.querySelectorAll("script[src]"))) {
            const u = s.src || "";
            if (/recaptcha/i.test(u)) window.__DETECTED_PROVIDERS = window.__DETECTED_PROVIDERS || new Set();
          }

          // Global variables yang umum berisi sitekey
          const globals = [
            "grecaptcha", "___grecaptcha_cfg", "turnstile", "hcaptcha",
            "friendlyCaptcha", "altcha", "AliyunCaptchaConfig", "captchaKey",
            "SITE_KEY", "RECAPTCHA_SITE_KEY", "HCAPTCHA_SITE_KEY", "TURNSTILE_SITE_KEY",
            "cfTurnstileKey",
          ];
          const readGlobal = (name) => {
            try {
              return window[name];
            } catch (e) {
              return undefined;
            }
          };

          // grecaptcha.getPageId / ___grecaptcha_cfg sering menyimpan sitekey di clients/render
          try {
            const cfg = readGlobal("___grecaptcha_cfg");
            if (cfg && cfg.clients) {
              for (const k of Object.keys(cfg.clients)) {
                if (typeof k === "string" && k.length > 10) add(k, "global:___grecaptcha_cfg.clients");
                const c = cfg.clients[k];
                if (c && c.sitekey) add(String(c.sitekey), "global:___grecaptcha_cfg.clients.*.sitekey");
              }
            }
          } catch (e) {}

          // Sweep properti window yang kelihatan seperti sitekey
          try {
            const re = /(sitekey|site_key|siteKey|recaptcha|hcaptcha|turnstile)/i;
            for (const k of Object.keys(window)) {
              if (!re.test(k)) continue;
              try {
                const v = window[k];
                if (typeof v === "string" && v.length > 8 && v.length < 200) add(v, `global:${k}`);
                if (v && typeof v === "object") {
                  for (const sk of ["sitekey", "siteKey", "site_key", "key"]) {
                    if (typeof v[sk] === "string") add(v[sk], `global:${k}.${sk}`);
                  }
                }
              } catch (e) {}
            }
          } catch (e) {}

          // Inline scripts — scan text
          try {
            const html = document.documentElement ? document.documentElement.outerHTML : "";
            if (html) {
              const scanToFound = (k, src) => add(k, src);
              scanTextForKeysInPage(html, scanToFound);
            }
          } catch (e) {}

          return {
            found,
            url: location.href,
            title: document.title || "",
          };
        }).catch(() => null);

        if (result && Array.isArray(result.found)) {
          for (const { key, source } of result.found) {
            addKey(key, source);
          }
        }
      } catch (e) {}
    }

    // Klasifikasikan semua key yang terakumulasi
    const classified = [];
    const seen = new Set();
    for (const [key, meta] of requestKeys.entries()) {
      const c = classifyKey(key);
      if (!c) continue;
      // filter key yang cuma hash/acak base64 pendek tanpa konteks provider
      if (c.type === "altcha" && !meta.sources.some((s) => /altcha/i.test(s)) && !providersDetected.has("altcha")) {
        // kemungkinan besar bukan altcha; skip jika panjangnya tidak cocok
        continue;
      }
      if (c.type === "unknown") continue; // skip noise
      const sig = `${c.type}:${key}`;
      if (seen.has(sig)) continue;
      seen.add(sig);

      // Tentukan solver endpoint yang sesuai
      const solverMap = {
        turnstile: { solver: "/api/turnstile", param: "sitekey" },
        recaptcha: { solver: "/api/captchav3", param: "sitekey" },
        hcaptcha: { solver: "/api/hcaptcha", param: "sitekey" },
        friendly: { solver: "/api/friendly", param: "sitekey" },
        altcha: { solver: "/api/altcha", param: "challengeurl or challenge" },
      };

      classified.push({
        type: c.type,
        label: c.label,
        variant: c.variant,
        sitekey: c.sitekey,
        pattern: c.pattern,
        sources: [...new Set(meta.sources)].slice(0, 8),
        solver: (solverMap[c.type] || {}).solver || null,
        solver_param: (solverMap[c.type] || {}).param || null,
      });
    }

    // Jika Aliyun terdeteksi dari network/script tapi belum ada sceneId yang berguna,
    // berikan catatan karena Aliyun memakai sceneId+prefix, bukan sitekey tradisional.
    const aliyunHint = providersDetected.has("aliyun")
      ? "Aliyun Captcha terdeteksi — tidak menggunakan sitekey biasa; gunakan /api/aliyun-extract untuk mengambil sceneId + prefix."
      : null;

    return {
      url,
      final_url: page.url(),
      title: (await page.title().catch(() => "")) || "",
      detected_providers: Array.from(providersDetected),
      sitekeys: classified,
      aliyun_hint: aliyunHint,
      requests_logged: requests.slice(0, 30),
      total_keys_found: classified.length,
    };
  });

  return { success: true, data };
}

// --- helpers ---

function scanTextForKeys(text, addKey, ctx) {
  if (!text) return;

  // g-recaptcha / recaptcha data-sitekey
  let m;
  const re1 = /data-sitekey\s*=\s*["']([^"']{4,200})["']/gi;
  while ((m = re1.exec(text))) addKey(m[1], `${ctx}:data-sitekey`);

  // sitekey : "xxx" / sitekey: 'xxx' / sitekey: `xxx`
  const re2 = /['"]?sitekey['"]?\s*[:=]\s*["'`]\s*([^"'`\s]{4,200})\s*["'`]/gi;
  while ((m = re2.exec(text))) addKey(m[1], `${ctx}:sitekey-literal`);

  // grecaptcha.render("id", {sitekey: "..."})
  const re3 = /render\s*\([^)]*sitekey\s*:\s*["']([^"']{4,200})["']/gi;
  while ((m = re3.exec(text))) addKey(m[1], `${ctx}:grecaptcha.render`);

  // turnstile.render(..., {sitekey: "..."})
  const re4 = /turnstile\.render\s*\([^)]*sitekey\s*:\s*["']([^"']{4,200})["']/gi;
  while ((m = re4.exec(text))) addKey(m[1], `${ctx}:turnstile.render`);

  // hcaptcha.render / data-hcaptcha-sitekey
  const re5 = /data-hcaptcha-sitekey\s*=\s*["']([^"']{4,200})["']/gi;
  while ((m = re5.exec(text))) addKey(m[1], `${ctx}:data-hcaptcha-sitekey`);
  const re5b = /hcaptcha\.render\s*\([^)]*sitekey\s*:\s*["']([^"']{4,200})["']/gi;
  while ((m = re5b.exec(text))) addKey(m[1], `${ctx}:hcaptcha.render`);

  // FriendlyCaptcha data-friendly-captcha-sitekey
  const re6 = /data-friendly-captcha-sitekey\s*=\s*["']([^"']{4,200})["']/gi;
  while ((m = re6.exec(text))) addKey(m[1], `${ctx}:data-friendly-captcha-sitekey`);
  // new FriendlyCaptcha({ startMode: "auto", sitekey: "..."})
  const re6b = /FriendlyCaptcha\s*\([^)]*sitekey\s*:\s*["']([^"']{4,200})["']/gi;
  while ((m = re6b.exec(text))) addKey(m[1], `${ctx}:FriendlyCaptcha ctor`);

  // Altcha widget: new Altcha({ challenge: {...} }) biasanya tidak punya static sitekey; skip

  // captchaKey = "xxx";  SITE_KEY = "xxx"; RECAPTCHA_SITE_KEY = "xxx"
  const re7 = /(?:RECAPTCHA_SITE_KEY|HCAPTCHA_SITE_KEY|TURNSTILE_SITE_KEY|SITE_KEY|captchaKey|g_captcha_key)\s*=\s*["'`]\s*([^"'`\s;)]{4,200})\s*["'`]/gi;
  while ((m = re7.exec(text))) addKey(m[1], `${ctx}:var-assignment`);

  // Regex khusus pola-pola terkenal walau tanpa atribut "sitekey":
  // Turnstile 0x.... sering muncul langsung di js
  const reT = /["'`](0x[a-zA-Z0-9_-]{10,80})["'`]/g;
  while ((m = reT.exec(text))) addKey(m[1], `${ctx}:0x-literal`);

  // reCAPTCHA 6L...
  const reR = /["'`](6L[a-zA-Z0-9_-]{10,80})["'`]/g;
  while ((m = reR.exec(text))) addKey(m[1], `${ctx}:6L-literal`);

  // hCaptcha UUID
  const reH = /["'`]([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})["'`]/g;
  while ((m = reH.exec(text))) addKey(m[1], `${ctx}:uuid-literal`);

  // FriendlyCaptcha FCM...
  const reF = /["'`](FC[MS][A-Z0-9]{6,80})["'`]/g;
  while ((m = reF.exec(text))) addKey(m[1], `${ctx}:FCM-literal`);
}

// Versi yang dipakai di browser (evaluate) — perlu self-contained agar bisa di-serialize
// eslint-disable-next-line no-unused-vars
function scanTextForKeysInPage(text, add) {
  if (!text) return;
  let m;
  const patterns = [
    { re: /data-sitekey\s*=\s*["']([^"']{4,200})["']/gi, src: "dom:data-sitekey" },
    { re: /data-hcaptcha-sitekey\s*=\s*["']([^"']{4,200})["']/gi, src: "dom:data-hcaptcha-sitekey" },
    { re: /data-friendly-captcha-sitekey\s*=\s*["']([^"']{4,200})["']/gi, src: "dom:data-friendly-sitekey" },
    { re: /data-turnstile-sitekey\s*=\s*["']([^"']{4,200})["']/gi, src: "dom:data-turnstile-sitekey" },
    { re: /['"]?sitekey['"]?\s*[:=]\s*["'`]\s*([^"'`\s]{4,200})\s*["'`]/gi, src: "dom:sitekey-literal" },
    { re: /["'`](0x[a-zA-Z0-9_-]{10,80})["'`]/g, src: "dom:0x-literal" },
    { re: /["'`](6L[a-zA-Z0-9_-]{10,80})["'`]/g, src: "dom:6L-literal" },
    { re: /["'`]([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})["'`]/g, src: "dom:uuid-literal" },
    { re: /["'`](FC[MS][A-Z0-9]{6,80})["'`]/g, src: "dom:FCM-literal" },
  ];
  for (const { re, src } of patterns) {
    re.lastIndex = 0;
    while ((m = re.exec(text))) add(m[1], src);
  }
}

module.exports = { getSitekey, classifyKey };
