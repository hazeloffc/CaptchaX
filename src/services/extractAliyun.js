const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Best-effort extraction of Aliyun Captcha 2.0 params from a target page:
// visits the URL, watches captcha-related requests, reads window config + HTML.
async function extractAliyunParams({ url, timeout = 30000, browserService } = {}) {
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
    const reqSeen = new Map(); // url -> postData

    page.on("request", (req) => {
      try {
        const u = req.url() || "";
        if (!/captcha/i.test(u)) return;
        if (reqSeen.size >= 60) return;
        let post = "";
        try {
          post = (req.postData() || "").slice(0, 2000);
        } catch (e) {}
        if (!reqSeen.has(u)) reqSeen.set(u.slice(0, 300), post);
      } catch (e) {}
    });

    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    } catch (e) {}

    // Poll briefly for the SDK config (sites often init lazily).
    const t0 = Date.now();
    let dom = null;
    const pollBudget = Math.min(12000, budget - 3000);
    while (Date.now() - t0 < pollBudget) {
      dom = await page
        .evaluate(() => {
          try {
            const out = { config: null, sceneIds: [], scripts: [], hasInit: false };
            try {
              if (window.AliyunCaptchaConfig) {
                out.config = {
                  region: window.AliyunCaptchaConfig.region || null,
                  prefix: window.AliyunCaptchaConfig.prefix || null,
                };
              }
            } catch (e) {}
            try {
              out.hasInit = typeof window.initAliyunCaptcha === "function";
            } catch (e) {}
            try {
              const html = (document.documentElement && document.documentElement.outerHTML) || "";
              const push = (v) => {
                if (v && out.sceneIds.length < 10 && !out.sceneIds.includes(v)) out.sceneIds.push(v);
              };
              let m;
              const re1 = /SceneId\s*:\s*['"]([^'"]{3,64})['"]/g;
              while ((m = re1.exec(html))) push(m[1]);
              const re2 = /["']sceneId["']\s*:\s*["']([^"']{3,64})["']/g;
              while ((m = re2.exec(html))) push(m[1]);
              const re3 = /[?&](sceneId|CaptchaSceneId|sId)=([A-Za-z0-9_-]{3,64})/g;
              while ((m = re3.exec(html))) push(m[2]);
            } catch (e) {}
            try {
              document.querySelectorAll("script[src]").forEach((s) => {
                const u = s.src || "";
                if (/aliyuncaptcha/i.test(u) && out.scripts.length < 5) out.scripts.push(u.slice(0, 300));
              });
            } catch (e) {}
            return out;
          } catch (e) {
            return null;
          }
        })
        .catch(() => null);
      if (dom && (dom.config || dom.sceneIds.length || dom.scripts.length)) break;
      await sleep(1000);
    }
    dom = dom || { config: null, sceneIds: [], scripts: [], hasInit: false };

    // Also scan subframes for the config (SDK sometimes lives in an iframe).
    if (!dom.config) {
      try {
        for (const f of page.frames()) {
          if (f === page.mainFrame()) continue;
          const c = await f
            .evaluate(() => {
              try {
                return window.AliyunCaptchaConfig
                  ? {
                      region: window.AliyunCaptchaConfig.region || null,
                      prefix: window.AliyunCaptchaConfig.prefix || null,
                    }
                  : null;
              } catch (e) {
                return null;
              }
            })
            .catch(() => null);
          if (c && (c.region || c.prefix)) {
            dom.config = c;
            break;
          }
        }
      } catch (e) {}
    }

    // Parse prefix / sceneId from observed request URLs + payloads.
    let prefix = (dom.config && dom.config.prefix) || null;
    let region = (dom.config && dom.config.region) || null;
    const sceneIds = [...dom.sceneIds];
    const requests = [];
    for (const [u, post] of reqSeen) {
      requests.push({ url: u, post: post ? post.slice(0, 500) : "" });
      if (!prefix) {
        let m = u.match(/https?:\/\/([a-z0-9-]+)\.captcha-open\./i) || u.match(/[?&]prefix=([A-Za-z0-9_-]{2,64})/);
        if (m) prefix = m[1];
      }
      const hay = `${u} ${post}`;
      let m;
      const re = /["'=:](sceneId|CaptchaSceneId)["']?\s*[:=]\s*["']?([A-Za-z0-9_-]{4,64})/g;
      while ((m = re.exec(hay))) {
        if (!sceneIds.includes(m[2]) && sceneIds.length < 10) sceneIds.push(m[2]);
      }
    }

    return {
      region: region || null,
      prefix: prefix || null,
      sceneIds,
      sceneId: sceneIds[0] || null,
      apiGetLib: dom.scripts[0] || null,
      hasInit: !!dom.hasInit,
      requests: requests.slice(0, 15),
      hint:
        prefix && sceneIds.length
          ? "ok"
          : "Tidak lengkap — captcha biasanya baru dimuat setelah aksi (mis. klik Login). Pastikan URL menampilkan/memicu captcha, lalu ulangi.",
    };
  });

  return { success: true, data };
}

module.exports = { extractAliyunParams };
