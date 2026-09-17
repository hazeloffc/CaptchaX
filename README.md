# cf-solve — Cloudflare / Captcha Solver API

Pure Node.js solver: Turnstile (min/max/action), reCAPTCHA v2 & v3, hCaptcha, Cloudflare challenge (`cf_clearance`), WAF session, page source.

## Deploy ke Railway

1. Push repo ini (sudah Railway-ready via `Dockerfile` + `railway.json`).
2. Di Railway: project terhubung ke repo ini akan **auto-redeploy** setiap push ke `main`.
3. Variables:
   - `PORT=8080` (samakan dengan Target port di Public Networking)
   - `MAX_REQUESTS_PER_MINUTE=5`
   - `NODE_ENV=production`
4. Health check: `GET /` (instant, dikonfigurasi di `railway.json`).
5. Chromium dari apt (`PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium`), Xvfb dikelola internal oleh `puppeteer-real-browser` (jangan bungkus dengan `xvfb-run`).

> Catatan: service ini butuh RAM ≥1GB (browser headful via xvfb). Jika OOM, naikkan plan / batasi concurrency.

## Jalankan lokal

```bash
npm install
cp .env.example .env
npm start
```

## API

Base: `http://localhost:5000`

### GET /
Info service + daftar endpoint.

### GET /api/health
Health check (RAM/CPU/disk).

### POST /api/turnstile
Solve Turnstile via fake page. `action` opsional (diteruskan ke `turnstile.render`).
```json
{ "sitekey": "0x4AAAAAA...", "siteurl": "https://example.com", "timeout": 45, "action": "login" }
```
Response sukses:
```json
{ "success": true, "token": "XXXX...", "duration": 12.3 }
```

### POST /api/turnstile-max
Solve Turnstile yang tertanam di halaman asli (kunjungi URL beneran, klik widget bila perlu).
```json
{ "url": "https://example.com/page-with-turnstile", "timeout": 60 }
```

### POST /api/recaptcha-v2
Solve reCAPTCHA v2 checkbox via browser. Gagal jujur bila muncul image challenge.
```json
{ "sitekey": "6Le-...", "siteurl": "https://example.com", "timeout": 60 }
```

### POST /api/captchav3
```json
{ "sitekey": "6Le-...", "siteurl": "https://example.com", "timeout": 30 }
```
Response: `{ "success": true, "token": "...", "duration": 1.2 }`

### POST /api/hcaptcha
hCaptcha checkbox (eksperimental).
```json
{ "sitekey": "10000000-ffff-ffff-ffff-000000000001", "siteurl": "https://example.com", "timeout": 60 }
```

### POST /api/cloudflare
```json
{ "url": "https://example.com", "headless": true, "timeout": 30 }
```
Response: `{ "success": true, "cf_clearance": "...", "cookie_string": "...", "cookies": [], "user_agent": "..." }`

### POST /api/waf-session
Ambil cookies + headers sesi WAF dari URL (berguna untuk request lanjutan).
```json
{ "url": "https://example.com", "timeout": 60 }
```
Response: `{ "success": true, "cookies": [], "headers": {}, "duration": 8.1 }`

### POST /api/source
Ambil HTML hasil render browser (lolos proteksi dasar).
```json
{ "url": "https://example.com", "timeout": 60 }
```
Response: `{ "success": true, "html": "<!DOCTYPE html>...", "duration": 8.1 }`

### Test keys
| Solver | Sitekey test | Hasil |
|---|---|---|
| Turnstile | `1x00000000000000000000AA` | `XXXX.DUMMY.TOKEN.XXXX` |
| reCAPTCHA v3 | `6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI` | token valid |
| hCaptcha | `10000000-ffff-ffff-ffff-000000000001` | pass tanpa challenge |
| reCAPTCHA v2 | `6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI` | checkbox only |

Rate limit default 5 req/menit/IP (`MAX_REQUESTS_PER_MINUTE`).

## Struktur

- `src/index.js` — Express app (PORT dari env)
- `src/routes/solve.js` — `/turnstile`, `/turnstile-max`, `/recaptcha-v2`, `/captchav3`, `/hcaptcha`, `/cloudflare`, `/waf-session`, `/source`
- `src/routes/health.js` — `/health`
- `src/services/turnstile.js` — BypassService (fakePage render + action, max, wafSession, getSource)
- `src/services/browser.js` — puppeteer-real-browser pool + xvfb
- `src/services/captchaV3.js` — reCAPTCHA v3 tanpa browser (anchor/reload)
- `src/services/recaptchaV2.js` — reCAPTCHA v2 checkbox via browser
- `src/services/hcaptcha.js` — hCaptcha checkbox via browser (eksperimental)
- `src/services/cloudflare.js` — challenge clicker → cf_clearance
