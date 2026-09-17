# cf-solve — All-in-One Captcha Solver API

100% deterministik, tanpa tebak gambar: Turnstile, reCAPTCHA v3, Altcha PoW, FriendlyCaptcha PoW, Cloudflare challenge (`cf_clearance`), WAF session, page source.

> Prinsip repo ini: endpoint yang bisa gagal (tantangan gambar reCAPTCHA v2 / hCaptcha) **tidak disertakan**. Semua endpoint di bawah selalu memberi hasil selama input valid.

## Deploy ke Railway

1. Project terhubung ke repo ini akan **auto-redeploy** setiap push ke `main`.
2. Variables:
   - `PORT=8080` (samakan dengan Target port di Public Networking)
   - `MAX_REQUESTS_PER_MINUTE=5`
   - `NODE_ENV=production`
3. Health check: `GET /` (instant, dikonfigurasi di `railway.json`).
4. Chromium dari apt (`PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium`), Xvfb dikelola internal oleh `puppeteer-real-browser`.

> Catatan: endpoint browser (turnstile, cloudflare, waf-session, source) butuh RAM ≥1GB. Endpoint PoW (captchav3, altcha, friendly) ringan, tanpa browser.

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
Response: `{ "success": true, "token": "XXXX...", "duration": 12.3 }`

### POST /api/turnstile-max
Solve Turnstile yang tertanam di halaman asli (kunjungi URL beneran, klik widget bila perlu).
```json
{ "url": "https://example.com/page-with-turnstile", "timeout": 60 }
```

### POST /api/captchav3
reCAPTCHA v3 tanpa browser (anchor/reload).
```json
{ "sitekey": "6Le-...", "siteurl": "https://example.com", "timeout": 30 }
```
Response: `{ "success": true, "token": "...", "duration": 1.2 }`

### POST /api/altcha
Solve Altcha proof-of-work v1 (SHA-1/256/384/512, murni komputasi — selalu selesai).
Kirim salah satu: `challengeurl` (endpoint JSON `{challenge, salt, ...}`) atau objek `challenge` langsung.
```json
{ "challengeurl": "https://example.com/altcha-challenge", "timeout": 60 }
```
```json
{ "challenge": { "algorithm": "SHA-256", "challenge": "abc...", "salt": "def...&", "signature": "...", "maxnumber": 1000000 } }
```
Response: `{ "success": true, "payload": "eyJ...", "number": 12345, "algorithm": "SHA-256", "duration": 0.4 }`
`payload` (base64) siap dikirim sebagai field `altcha` ke server tujuan.

### POST /api/friendly
Solve FriendlyCaptcha v1 proof-of-work memakai solver resmi (`friendly-pow` WASM, algoritma identik dengan widget browser).
```json
{ "sitekey": "FCM...", "timeout": 180 }
```
Tambahkan `puzzleEndpoint` bila situs memakai endpoint custom (default global `https://api.friendlycaptcha.com/api/v1/puzzle`).
Response: `{ "success": true, "solution": "sig.b64.sol.diag", "puzzles": 48, "field": "frc-captcha-solution", "duration": 50.8 }`
Isi `solution` ke field `frc-captcha-solution` di form tujuan.

### POST /api/cloudflare
Bypass Cloudflare challenge → `cf_clearance`.
```json
{ "url": "https://example.com", "headless": true, "timeout": 30 }
```
Response: `{ "success": true, "cf_clearance": "...", "cookie_string": "...", "cookies": [], "user_agent": "..." }`

### POST /api/waf-session
Ambil cookies + headers sesi WAF dari URL (untuk request lanjutan).
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
| FriendlyCaptcha | `FCMGEMUD2M567T8G` (demo homepage) | solusi valid |

Rate limit default 5 req/menit/IP (`MAX_REQUESTS_PER_MINUTE`).

## Struktur

- `src/index.js` — Express app (PORT dari env)
- `src/routes/solve.js` — `/turnstile`, `/turnstile-max`, `/captchav3`, `/altcha`, `/friendly`, `/cloudflare`, `/waf-session`, `/source`
- `src/routes/health.js` — `/health`
- `src/services/turnstile.js` — BypassService (fakePage render + action, max, wafSession, getSource)
- `src/services/browser.js` — puppeteer-real-browser pool + xvfb
- `src/services/captchaV3.js` — reCAPTCHA v3 tanpa browser (anchor/reload)
- `src/services/altcha.js` — Altcha PoW v1 (brute force SHA, sesuai `altcha-lib`)
- `src/services/friendly.js` — FriendlyCaptcha PoW v1 (solver WASM resmi `friendly-pow`)
- `src/services/cloudflare.js` — challenge clicker → cf_clearance
