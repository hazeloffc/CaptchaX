# cf-solve — All-in-One Captcha Solver API

Turnstile, reCAPTCHA v3, Altcha PoW, FriendlyCaptcha PoW, hCaptcha, Aliyun Captcha 2.0, Cloudflare challenge (`cf_clearance`), WAF session, page source, sitekey detector.

> Kejujuran API: endpoint PoW & token (turnstile, v3, altcha, friendly) **deterministik 100%**. Endpoint `hcaptcha` & `aliyun` adalah **best-effort** (lolos bila risiko rendah / tipe cocok) dan selalu menjawab jujur `success:false` + alasan bila tidak bisa.

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

### POST /api/hcaptcha
hCaptcha checkbox via browser (best-effort — lolos bila tanpa image challenge).
```json
{ "sitekey": "10000000-ffff-ffff-ffff-000000000001", "siteurl": "https://example.com", "timeout": 60 }
```

### POST /api/aliyun
Aliyun Captcha 2.0 ala CapMonster (best-effort): widget dirender di halaman minimal milik sendiri bermodal `sceneId` + `prefix` situs target — tanpa mengunjungi situs target.
```json
{ "sceneId": "XXXX", "prefix": "xxxxxx", "region": "sgp", "timeout": 120 }
```
`sceneId` + `prefix` diambil dari Network tab situs target saat captcha muncul: `prefix` = subdomain dari `https://<prefix>.captcha-open.*.aliyuncs.com`, `sceneId` dari payload/body request, `region`: `sgp`/`cn` (samakan dengan console; solver otomatis coba region satunya bila init gagal).
Bila init gagal (`INIT_FAIL`) artinya ketiganya tidak cocok / scene tidak aktif — solver langsung menjawab jujur tanpa menunggu timeout.
Opsional: `language` (`en`/`cn`/`tw`), `mode` (`popup`/`embed`/`float`), `sdkUrl` (override CDN SDK), `debug: true` (balikan `debug`: stages, attempts, screenshot saat gagal).

### POST /api/aliyun-extract
Deteksi otomatis `region` + `prefix` + `sceneId` dari URL halaman target (best-effort — captcha biasanya baru dimuat setelah aksi seperti klik Login, jadi pakai URL yang memicu captcha).
```json
{ "url": "https://example.com/login", "timeout": 30 }
```
Response: `{ "success": true, "region": "sgp", "prefix": "xxxxxx", "sceneId": "XXXX", "sceneIds": [...], "apiGetLib": "...", "requests": [...], "hint": "ok" }`
Cara kerja: TRACELESS lolos otomatis; BEHAVIOR-SLIDE drag penuh ala manusia; PUZZLE-SLIDE deteksi gap (`shadow.png` vs `back.png`, template-match jimp) + drag closed-loop (posisi piece dibaca live tiap langkah sampai tepat di gap) + retry multi-attempt dengan koreksi.
Response: `{ "success": true, "verifyParam": "...", "duration": 25.4 }`
`verifyParam` (captchaVerifyParam) langsung dipakai untuk request bisnis ke server situs target. Token sekali pakai & terikat sesi — verifikasi dari IP yang sama.
Tipe icon-click ("klik berurutan") tidak didukung dan dijawab jujur `success:false`.

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

### POST /api/get-sitekey
Deteksi otomatis sitekey captcha dari URL target beserta klasifikasi tipenya. Memakai browser untuk memuat halaman, lalu memindai atribut DOM (`data-sitekey` dll.), inline script, global variable JS, iframe `src`, dan network request/response.
```json
{ "url": "https://example.com/login", "timeout": 30 }
```
Response:
```json
{
  "success": true,
  "url": "https://example.com/login",
  "final_url": "https://example.com/login",
  "title": "Login - Example",
  "detected_providers": ["recaptcha", "turnstile"],
  "sitekeys": [
    {
      "type": "recaptcha",
      "label": "Google reCAPTCHA",
      "variant": "v2-or-v3",
      "sitekey": "6Le-wvkSAAAAAPBMRTvw0Q4Muexq9bi0DJwx_mJ-",
      "pattern": "6L-prefixed (Google reCAPTCHA)",
      "sources": ["dom:data-sitekey", "recaptcha-render-param"],
      "solver": "/api/captchav3",
      "solver_param": "sitekey"
    }
  ],
  "aliyun_hint": null,
  "total_keys_found": 1,
  "duration": 7.2
}
```
Tipe sitekey yang dikenali otomatis:

| `type` | Label | Pola sitekey | Solver endpoint |
|---|---|---|---|
| `turnstile` | Cloudflare Turnstile | diawali `0x` (mis. `0x4AAAAAA...`) | `/api/turnstile` |
| `recaptcha` | Google reCAPTCHA (v2/v3/enterprise) | diawali `6L` | `/api/captchav3` |
| `hcaptcha` | hCaptcha | format UUID `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` | `/api/hcaptcha` |
| `friendly` | FriendlyCaptcha | diawali `FCM` / `FCS` | `/api/friendly` |
| `altcha` | Altcha (possible) | base64 panjang (tanpa static sitekey; pakai `challengeurl`) | `/api/altcha` |

Bila Aliyun Captcha terdeteksi, response menyertakan `aliyun_hint` yang mengarahkan ke `/api/aliyun-extract` karena Aliyun memakai `sceneId` + `prefix` (bukan sitekey tradisional).

Field `solver` dan `solver_param` menunjukkan endpoint + nama parameter yang bisa langsung dipakai untuk solve, jadi kamu bisa otomatis meneruskan `sitekey` yang ditemukan ke solver yang sesuai.

### Test keys
| Solver | Sitekey test | Hasil |
|---|---|---|
| Turnstile | `1x00000000000000000000AA` | `XXXX.DUMMY.TOKEN.XXXX` |
| reCAPTCHA v3 | `6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI` | token valid |
| FriendlyCaptcha | `FCMGEMUD2M567T8G` (demo homepage) | solusi valid |

Rate limit default 5 req/menit/IP (`MAX_REQUESTS_PER_MINUTE`).

## Struktur

- `src/index.js` — Express app (PORT dari env)
- `src/routes/solve.js` — `/turnstile`, `/turnstile-max`, `/captchav3`, `/altcha`, `/friendly`, `/hcaptcha`, `/aliyun`, `/aliyun-extract`, `/cloudflare`, `/waf-session`, `/source`, `/get-sitekey`
- `src/routes/health.js` — `/health`
- `src/services/turnstile.js` — BypassService (fakePage render + action, max, wafSession, getSource)
- `src/services/browser.js` — puppeteer-real-browser pool + xvfb
- `src/services/captchaV3.js` — reCAPTCHA v3 tanpa browser (anchor/reload)
- `src/services/altcha.js` — Altcha PoW v1 (brute force SHA, sesuai `altcha-lib`)
- `src/services/friendly.js` — FriendlyCaptcha PoW v1 (solver WASM resmi `friendly-pow`)
- `src/services/hcaptcha.js` — hCaptcha checkbox/invisible via browser (best-effort, fail-fast saat image challenge)
- `src/services/aliyun.js` — Aliyun Captcha 2.0 harvest (best-effort, closed-loop puzzle drag + jimp gap-detect)
- `src/services/extractAliyun.js` — deteksi sceneId/prefix/region Aliyun dari URL halaman target
- `src/services/getSitekey.js` — deteksi & klasifikasi otomatis sitekey (turnstile/recaptcha/hcaptcha/friendly/altcha) dari URL target
- `src/services/cloudflare.js` — challenge clicker → cf_clearance
