function buildV2Page(sitekey) {
  const safe = String(sitekey).replace(/'/g, "");
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title></title>
</head>
<body>
    <div id="recaptcha"></div>
    <script src="https://www.google.com/recaptcha/api.js?onload=onloadV2Callback&render=explicit" async defer></script>
    <script>
        window.onloadV2Callback = function () {
            window.__v2wid = grecaptcha.render('recaptcha', {
                sitekey: '${safe}',
                callback: function (token) {
                    var c = document.createElement('input');
                    c.type = 'hidden';
                    c.name = 'g-recaptcha-response';
                    c.value = token;
                    document.body.appendChild(c);
                },
            });
        };
    </script>
</body>
</html>`;
}

async function solveRecaptchaV2({ sitekey, url, timeout = 60000, browserService }) {
  const startTime = Date.now();
  if (!sitekey || !url) {
    throw new Error("Missing sitekey or url parameter");
  }
  if (!browserService) {
    throw new Error("Browser service not initialized");
  }

  const html = buildV2Page(sitekey);

  const token = await browserService.withBrowserContext(async (context) => {
    const page = await context.newPage();

    await page.setRequestInterception(true);
    page.on("request", async (request) => {
      try {
        if ([url, url + "/"].includes(request.url()) && request.resourceType() === "document") {
          await request.respond({ status: 200, contentType: "text/html", body: html });
        } else {
          await request.continue();
        }
      } catch (e) {}
    });

    await page.goto(url, { waitUntil: "domcontentloaded" });
    const anchorEl = await page.waitForSelector('iframe[src*="recaptcha/api2/anchor"]', { timeout: 30000 });

    let anchor = null;
    for (let i = 0; i < 20 && !anchor; i++) {
      try {
        anchor = await anchorEl.contentFrame();
      } catch (e) {}
      if (!anchor) {
        anchor = page.frames().find((f) => {
          try {
            return f.url().includes("recaptcha/api2/anchor");
          } catch {
            return false;
          }
        }) || null;
      }
      if (!anchor) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    if (!anchor) {
      throw new Error("Recaptcha anchor frame not found");
    }
    await anchor.click("#recaptcha-anchor").catch(() => {});

    try {
      await page.waitForFunction(
        () => {
          try {
            return window.__v2wid !== undefined && window.grecaptcha.getResponse(window.__v2wid).length > 10;
          } catch (e) {
            return false;
          }
        },
        { timeout }
      );
    } catch (e) {
      const challenged = await page
        .evaluate(() => {
          try {
            const b = document.querySelector('iframe[src*="recaptcha/api2/bframe"]');
            if (!b) return false;
            const r = b.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && getComputedStyle(b).visibility !== "hidden";
          } catch (err) {
            return false;
          }
        })
        .catch(() => false);
      throw new Error(challenged ? "Image challenge required (not auto-solvable)" : "Failed to get token (timeout)");
    }

    return page.evaluate(() => {
      try {
        return window.grecaptcha.getResponse(window.__v2wid);
      } catch (e) {
        return null;
      }
    });
  });

  if (!token || token.length < 10) {
    throw new Error("Failed to get token");
  }

  return { success: true, data: token, duration: Date.now() - startTime };
}

module.exports = { solveRecaptchaV2 };
