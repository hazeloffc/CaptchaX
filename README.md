# cf-solve — Cloudflare / Captcha Solver API

Pure Node.js solver: Turnstile, reCAPTCHA v3, Cloudflare challenge (`cf_clearance`).

## Deploy ke Railway

1. Push repo ini (sudah Railway-ready via `Dockerfile` + `railway.json`).
2. Di Railway: **New Project → Deploy from GitHub repo → `cf-solve`**.
3. Variables (optional):
   - `PORT` — otomatis diisi Railway, jangan set manual.
   - `MAX_REQUESTS_PER_MINUTE=5`
   - `NODE_ENV=production`
4. Health check: `GET /api/health` (sudah dikonfigurasi di `railway.json`).
5. Browser dijalankan dengan `xvfb-run`, Chromium dari apt (`PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium`).

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
```json
{ "sitekey": "0x4AAAAAA...", "siteurl": "https://example.com", "timeout": 45 }
```
Response sukses:
```json
{ "success": true, "token": "XXXX...", "duration": 12.3 }
```

### POST /api/captchav3
```json
{ "sitekey": "6Le-...", "siteurl": "https://example.com", "timeout": 30 }
```
Response: `{ "success": true, "token": "...", "duration": 1.2 }`

### POST /api/cloudflare
```json
{ "url": "https://example.com", "headless": true, "timeout": 30 }
```
Response: `{ "success": true, "cf_clearance": "...", "cookie_string": "...", "cookies": [], "user_agent": "..." }`

Rate limit default 5 req/menit/IP (`MAX_REQUESTS_PER_MINUTE`).

## Struktur

- `src/index.js` — Express app (PORT dari env)
- `src/routes/solve.js` — `/turnstile`, `/captchav3`, `/cloudflare`
- `src/routes/health.js` — `/health`
- `src/services/turnstile.js` — BypassService (fakePage render)
- `src/services/browser.js` — puppeteer-real-browser pool + xvfb
- `src/services/captchaV3.js` — reCAPTCHA v3 tanpa browser (anchor/reload)
- `src/services/cloudflare.js` — challenge clicker → cf_clearance
