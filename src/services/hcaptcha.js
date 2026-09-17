function buildHPage(sitekey) {
  const safe = String(sitekey).replace(/'/g, "");
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title></title>
</head>
<body>
    <div id="hcaptcha"></div>
    <script src="https://js.hcaptcha.com/1/api.js?onload=onloadHCallback&render=explicit" async defer></script>
    <script>
        window.onloadHCallback = function () {
            hcaptcha.render('hcaptcha', {
                sitekey: '${safe}',
                callback: function (token) {
                    var c = document.createElement('input');
                    c.type = 'hidden';
                    c.name = 'h-captcha-response';
                    c.value = token;
                    document.body.appendChild(c);
                },
            });
        };
    </script>
</body>
</html>`;
}

async function solveHCaptcha({ sitekey, url, timeout = 60000, browserService }) {
  const startTime = Date.now();
  if (!sitekey || !url) {
    throw new Error("Missing sitekey or url parameter");
  }
  if (!browserService) {
    throw new Error("Browser service not initialized");
  }

  const html = buildHPage(sitekey);

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
    await page.waitForSelector('iframe[src*="hcaptcha.com"]', { timeout: 20000 });

    const widget = page.frames().find((f) => {
      try {
        return f.url().includes("hcaptcha.com");
      } catch {
        return false;
      }
    });
    if (!widget) {
      throw new Error("hCaptcha frame not found");
    }
    await widget.click("#checkbox").catch(() => {});

    try {
      await page.waitForFunction(
        () => {
          try {
            return window.hcaptcha.getResponse().length > 10;
          } catch (e) {
            return false;
          }
        },
        { timeout }
      );
    } catch (e) {
      throw new Error("Challenge required or timeout (hCaptcha experimental)");
    }

    return page.evaluate(() => {
      try {
        return window.hcaptcha.getResponse();
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

module.exports = { solveHCaptcha };
