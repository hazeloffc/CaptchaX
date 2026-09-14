require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const solveRoute = require('./routes/solve');
const healthRoute = require('./routes/health');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.use('/api', solveRoute);
app.use('/api', healthRoute);

app.get('/', (req, res) => {
  res.json({
    name: 'Captcha Solver JS',
    version: '2.0.0',
    endpoints: {
      'POST /api/turnstile': 'Solve Turnstile captcha',
      'POST /api/captchav3': 'Solve ReCaptcha v3 (no browser)',
      'POST /api/cloudflare': 'Bypass Cloudflare challenge (cf_clearance)',
      'GET /api/health': 'Health check'
    },
    usage: {
      turnstile: {
        method: 'POST',
        url: '/api/turnstile',
        body: {
          sitekey: '0x4AAAAAA...',
          siteurl: 'https://example.com',
          timeout: 45
        }
      },
      captchav3: {
        method: 'POST',
        url: '/api/captchav3',
        body: {
          sitekey: '6Le-wvk....',
          siteurl: 'https://example.com',
          timeout: 30
        }
      },
      cloudflare: {
        method: 'POST',
        url: '/api/cloudflare',
        body: {
          url: 'https://example.com',
          headless: true,
          timeout: 30
        }
      }
    }
  });
});

app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ success: false, error: err.message || 'Internal Server Error' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Captcha Solver JS running on port ${PORT}`);
  console.log(`http://localhost:${PORT}`);
});

module.exports = app;