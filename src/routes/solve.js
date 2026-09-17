const express = require('express');
const router = express.Router();
const { BypassService } = require('../services/turnstile');
const { BrowserService } = require('../services/browser');
const { solveRecaptchaV3 } = require('../services/captchaV3');
const { solveRecaptchaV2 } = require('../services/recaptchaV2');
const { solveHCaptcha } = require('../services/hcaptcha');
const { solveCloudflare } = require('../services/cloudflare');

const requestCounts = new Map();
const MAX_REQUESTS = parseInt(process.env.MAX_REQUESTS_PER_MINUTE) || 5;

function checkRateLimit(ip) {
  const now = Date.now();
  const windowStart = now - 60000;
  if (!requestCounts.has(ip)) requestCounts.set(ip, []);
  const requests = requestCounts.get(ip).filter(t => t > windowStart);
  requestCounts.set(ip, requests);
  if (requests.length >= MAX_REQUESTS) return false;
  requests.push(now);
  return true;
}

router.post('/turnstile', async (req, res) => {
  const startTime = Date.now();
  let browserService = null;
  
  try {
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    if (!checkRateLimit(clientIp)) {
      return res.status(429).json({ success: false, error: 'Rate limit exceeded' });
    }

    const { sitekey, siteurl, timeout, action } = req.body;
    
    if (!sitekey) {
      return res.status(400).json({ success: false, error: 'sitekey is required' });
    }
    if (!siteurl) {
      return res.status(400).json({ success: false, error: 'siteurl is required' });
    }
    
    try {
      new URL(siteurl);
    } catch {
      return res.status(400).json({ success: false, error: 'Invalid siteurl' });
    }

    const solveTimeout = Math.min(Math.max(timeout || 45, 10), 120);
    
    browserService = new BrowserService();
    const bypassService = new BypassService(browserService);
    await browserService.initialize();
    
    const result = await bypassService.solveTurnstileMin(siteurl, sitekey, null, solveTimeout * 1000, { action });
    
    if (result.success) {
      res.json({ 
        success: true, 
        token: result.data, 
        duration: parseFloat(((Date.now() - startTime) / 1000).toFixed(2))
      });
    } else {
      res.json({ success: false, error: result.error });
    }
  } catch (error) {
    console.error('[turnstile] Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    if (browserService) {
      await browserService.shutdown();
    }
  }
});

router.post('/captchav3', async (req, res) => {
  const startTime = Date.now();
  
  try {
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    if (!checkRateLimit(clientIp)) {
      return res.status(429).json({ success: false, error: 'Rate limit exceeded' });
    }

    const { sitekey, siteurl, timeout } = req.body;
    
    if (!sitekey) {
      return res.status(400).json({ success: false, error: 'sitekey is required' });
    }
    if (!siteurl) {
      return res.status(400).json({ success: false, error: 'siteurl is required' });
    }
    
    try {
      new URL(siteurl);
    } catch {
      return res.status(400).json({ success: false, error: 'Invalid siteurl' });
    }

    const solveTimeout = Math.min(Math.max(timeout || 30, 10), 60);
    
    const token = await solveRecaptchaV3({
      sitekey: sitekey,
      url: siteurl
    });

    if (token) {
      res.json({
        success: true,
        token: token,
        duration: parseFloat(((Date.now() - startTime) / 1000).toFixed(2))
      });
    } else {
      res.json({ success: false, error: 'Failed to get token' });
    }
    
  } catch (error) {
    console.error('[recaptcha] Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/cloudflare', async (req, res) => {
  const startTime = Date.now();
  
  try {
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    if (!checkRateLimit(clientIp)) {
      return res.status(429).json({ success: false, error: 'Rate limit exceeded' });
    }

    const { url, headless, proxy, proxyFile, timeout } = req.body;
    
    if (!url) {
      return res.status(400).json({ success: false, error: 'url is required' });
    }
    
    try {
      new URL(url);
    } catch {
      return res.status(400).json({ success: false, error: 'Invalid url' });
    }

    const result = await solveCloudflare({
      url: url,
      headless: headless !== undefined ? headless : true,
      proxy: proxy || null,
      proxyFile: proxyFile || null,
      timeout: timeout || 30
    });

    if (result.success) {
      res.json({
        success: true,
        cf_clearance: result.cf_clearance,
        cookie_string: result.cookie_string,
        cookies: result.all_cookies,
        user_agent: result.user_agent,
        final_url: result.url,
        domain: result.domain,
        timestamp: result.timestamp,
        duration: parseFloat(((Date.now() - startTime) / 1000).toFixed(2))
      });
    } else {
      res.json({ success: false, error: result.error });
    }
    
  } catch (error) {
    console.error('[cloudflare] Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/turnstile-max', async (req, res) => {
  const startTime = Date.now();
  let browserService = null;

  try {
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    if (!checkRateLimit(clientIp)) {
      return res.status(429).json({ success: false, error: 'Rate limit exceeded' });
    }

    const { url, timeout, proxy } = req.body;

    if (!url) {
      return res.status(400).json({ success: false, error: 'url is required' });
    }

    try {
      new URL(url);
    } catch {
      return res.status(400).json({ success: false, error: 'Invalid url' });
    }

    const solveTimeout = Math.min(Math.max(timeout || 60, 10), 120);

    browserService = new BrowserService();
    const bypassService = new BypassService(browserService);
    await browserService.initialize();

    const result = await bypassService.solveTurnstileMax(url, proxy || null, solveTimeout * 1000);

    if (result.success) {
      res.json({
        success: true,
        token: result.data,
        duration: parseFloat(((Date.now() - startTime) / 1000).toFixed(2))
      });
    } else {
      res.json({ success: false, error: result.error });
    }
  } catch (error) {
    console.error('[turnstile-max] Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    if (browserService) {
      await browserService.shutdown();
    }
  }
});

router.post('/recaptcha-v2', async (req, res) => {
  const startTime = Date.now();
  let browserService = null;

  try {
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    if (!checkRateLimit(clientIp)) {
      return res.status(429).json({ success: false, error: 'Rate limit exceeded' });
    }

    const { sitekey, siteurl, timeout } = req.body;

    if (!sitekey) {
      return res.status(400).json({ success: false, error: 'sitekey is required' });
    }
    if (!siteurl) {
      return res.status(400).json({ success: false, error: 'siteurl is required' });
    }

    try {
      new URL(siteurl);
    } catch {
      return res.status(400).json({ success: false, error: 'Invalid siteurl' });
    }

    const solveTimeout = Math.min(Math.max(timeout || 60, 10), 120);

    browserService = new BrowserService();
    await browserService.initialize();

    const result = await solveRecaptchaV2({
      sitekey,
      url: siteurl,
      timeout: solveTimeout * 1000,
      browserService
    });

    res.json({
      success: true,
      token: result.data,
      duration: parseFloat(((Date.now() - startTime) / 1000).toFixed(2))
    });
  } catch (error) {
    console.error('[recaptcha-v2] Error:', error.message);
    res.json({ success: false, error: error.message });
  } finally {
    if (browserService) {
      await browserService.shutdown();
    }
  }
});

router.post('/hcaptcha', async (req, res) => {
  const startTime = Date.now();
  let browserService = null;

  try {
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    if (!checkRateLimit(clientIp)) {
      return res.status(429).json({ success: false, error: 'Rate limit exceeded' });
    }

    const { sitekey, siteurl, timeout } = req.body;

    if (!sitekey) {
      return res.status(400).json({ success: false, error: 'sitekey is required' });
    }
    if (!siteurl) {
      return res.status(400).json({ success: false, error: 'siteurl is required' });
    }

    try {
      new URL(siteurl);
    } catch {
      return res.status(400).json({ success: false, error: 'Invalid siteurl' });
    }

    const solveTimeout = Math.min(Math.max(timeout || 60, 10), 120);

    browserService = new BrowserService();
    await browserService.initialize();

    const result = await solveHCaptcha({
      sitekey,
      url: siteurl,
      timeout: solveTimeout * 1000,
      browserService
    });

    res.json({
      success: true,
      token: result.data,
      duration: parseFloat(((Date.now() - startTime) / 1000).toFixed(2))
    });
  } catch (error) {
    console.error('[hcaptcha] Error:', error.message);
    res.json({ success: false, error: error.message });
  } finally {
    if (browserService) {
      await browserService.shutdown();
    }
  }
});

router.post('/waf-session', async (req, res) => {
  const startTime = Date.now();
  let browserService = null;

  try {
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    if (!checkRateLimit(clientIp)) {
      return res.status(429).json({ success: false, error: 'Rate limit exceeded' });
    }

    const { url, timeout, proxy } = req.body;

    if (!url) {
      return res.status(400).json({ success: false, error: 'url is required' });
    }

    try {
      new URL(url);
    } catch {
      return res.status(400).json({ success: false, error: 'Invalid url' });
    }

    const solveTimeout = Math.min(Math.max(timeout || 60, 10), 120);

    browserService = new BrowserService();
    const bypassService = new BypassService(browserService);
    await browserService.initialize();

    const result = await bypassService.wafSession(url, proxy || null, solveTimeout * 1000);

    if (result.success) {
      res.json({
        success: true,
        cookies: result.data.cookies,
        headers: result.data.headers,
        duration: parseFloat(((Date.now() - startTime) / 1000).toFixed(2))
      });
    } else {
      res.json({ success: false, error: result.error });
    }
  } catch (error) {
    console.error('[waf-session] Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    if (browserService) {
      await browserService.shutdown();
    }
  }
});

router.post('/source', async (req, res) => {
  const startTime = Date.now();
  let browserService = null;

  try {
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    if (!checkRateLimit(clientIp)) {
      return res.status(429).json({ success: false, error: 'Rate limit exceeded' });
    }

    const { url, timeout, proxy } = req.body;

    if (!url) {
      return res.status(400).json({ success: false, error: 'url is required' });
    }

    try {
      new URL(url);
    } catch {
      return res.status(400).json({ success: false, error: 'Invalid url' });
    }

    const solveTimeout = Math.min(Math.max(timeout || 60, 10), 120);

    browserService = new BrowserService();
    const bypassService = new BypassService(browserService);
    await browserService.initialize();

    const result = await bypassService.getSource(url, proxy || null, solveTimeout * 1000);

    if (result.success) {
      res.json({
        success: true,
        html: result.data,
        duration: parseFloat(((Date.now() - startTime) / 1000).toFixed(2))
      });
    } else {
      res.json({ success: false, error: result.error });
    }
  } catch (error) {
    console.error('[source] Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    if (browserService) {
      await browserService.shutdown();
    }
  }
});

module.exports = router;
