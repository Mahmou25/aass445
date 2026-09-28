/**
 * Website Checker — Real-browser site inspection server.
 * Opens every URL in a real Chromium browser (Playwright), streams the live
 * screen to the dashboard via CDP screencast, and reports real open/timeout/error.
 */
const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ---------------- State ---------------- */

const state = {
  sites: [],            // {id, url, status, reason, loadTime, httpStatus, checkedAt}
  running: false,
  stopRequested: false,
  timeout: 15000,       // ms
  concurrency: 3,
  done: 0,
  total: 0,
  startedAt: null,
};

let browser = null;
let context = null;
const workerPages = new Map();   // workerIndex -> page
const sitePages = new Map();    // siteId -> page
let activePage = null;          // page shown in the embedded browser view
let activeSiteId = null;
let screencastCdp = null;
let screencastOn = false;
let screenshotTimer = null;

/* ---------------- Browser bootstrap ---------------- */

function findSystemBrowser() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return undefined;
}

async function ensureBrowser() {
  if (browser) return;
  const executablePath = findSystemBrowser();
  const launchOpts = {
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
  };
  if (executablePath) launchOpts.executablePath = executablePath;
  browser = await chromium.launch(launchOpts);
  context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
  });
  broadcast({ type: 'log', message: `تم تشغيل المتصفح الداخلي (${executablePath ? path.basename(executablePath) : 'bundled chromium'})` });
}

/* ---------------- Screencast (live screen streaming) ---------------- */

function stopScreencast() {
  screencastOn = false;
  if (screenshotTimer) { clearInterval(screenshotTimer); screenshotTimer = null; }
  const cdp = screencastCdp;
  screencastCdp = null;
  if (cdp) {
    cdp.send('Page.stopScreencast', {}).catch(() => {});
    cdp.detach().catch(() => {});
  }
}

async function sendFrame(base64Data) {
  broadcast({ type: 'browser:frame', data: base64Data });
}

async function snapshotActivePage() {
  if (!activePage) return;
  try {
    const buf = await activePage.screenshot({ type: 'jpeg', quality: 75 });
    await sendFrame(buf.toString('base64'));
  } catch {}
}

async function startScreencast(page) {
  if (!page) return;
  stopScreencast();
  activePage = page;
  try {
    const cdp = await context.newCDPSession(page);
    screencastCdp = cdp;
    screencastOn = true;
    await cdp.send('Page.enable');
    cdp.on('Page.screencastFrame', async (params) => {
      if (!screencastOn) return;
      broadcast({ type: 'browser:frame', data: params.data });
      try { await cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId }); } catch {}
    });
    await cdp.send('Page.startScreencast', {
      format: 'jpeg', quality: 70, maxWidth: 1100, maxHeight: 700, everyNthFrame: 2,
    });
    await snapshotActivePage();
    broadcast({ type: 'log', message: 'تم تفعيل البث المباشر للشاشة' });
  } catch (e) {
    // Fallback: periodic screenshots if screencast is unsupported
    screencastCdp = null;
    screenshotTimer = setInterval(() => { if (screencastOn) snapshotActivePage(); }, 800);
    broadcast({ type: 'log', message: 'تعذر البث المباشر — تم التحويل إلى لقطات دورية' });
  }
}

function setActiveSite(siteId) {
  const page = sitePages.get(siteId);
  if (page && page !== activePage) {
    activeSiteId = siteId;
    startScreencast(page);
    broadcast({ type: 'browser:active', id: siteId });
  }
}

/* ---------------- Messaging ---------------- */

function broadcast(msg) {
  const payload = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(payload);
  }
}

function broadcastSite(id) {
  const site = state.sites.find((s) => s.id === id);
  if (site) broadcast({ type: 'site:update', site });
}

function broadcastProgress() {
  broadcast({ type: 'progress', done: state.done, total: state.total });
}

function resetResults(statuses) {
  for (const s of state.sites) {
    if (!statuses || statuses.includes(s.status)) {
      Object.assign(s, { status: 'pending', reason: null, loadTime: null, httpStatus: null, checkedAt: null });
    }
  }
  state.done = 0;
  state.total = 0;
}

/* ---------------- Error classification ---------------- */

const ERROR_LABELS = [
  [/ERR_CERT_COMMON_NAME_INVALID|ERR_CERT_AUTHORITY_INVALID|ERR_CERT_DATE_INVALID|ERR_CERTIFICATE|ERR_SSL|ERR_CONNECTION_RESET/i, 'SSL Error'],
  [/ERR_NAME_NOT_RESOLVED|ERR_DNS/i, 'DNS Error'],
  [/ERR_CONNECTION_REFUSED/i, 'Connection Refused'],
  [/ERR_CONNECTION_CLOSED|ERR_NETWORK_CHANGED/i, 'Network Error'],
  [/ERR_EMPTY_RESPONSE/i, 'Empty Response'],
  [/ERR_TUNNEL_CONNECTION_FAILED/i, 'Tunnel Failed'],
];

function classifyError(err) {
  const msg = (err && err.message) || String(err);
  if (err && err.name === 'TimeoutError' || /Timeout of \d+ms exceeded|Navigation timeout/i.test(msg)) {
    return { status: 'down', reason: 'Timeout — انتهت المهلة' };
  }
  for (const [re, label] of ERROR_LABELS) {
    if (re.test(msg)) return { status: 'error', reason: label };
  }
  const code = msg.match(/(net::\w+)/);
  if (code) return { status: 'error', reason: code[1] };
  return { status: 'error', reason: msg.slice(0, 120) || 'خطأ غير معروف' };
}

/* ---------------- URL helpers ---------------- */

function normalizeUrl(raw) {
  let u = (raw || '').trim();
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try {
    const parsed = new URL(u);
    if (!parsed.hostname.includes('.')) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/* ---------------- Core check ---------------- */

async function checkSite(site) {
  updateSite(site, { status: 'checking', reason: null, loadTime: null, httpStatus: null });
  broadcast({ type: 'site:start', id: site.id, url: site.url });
  setActiveSite(site.id);

  const page = sitePages.get(site.id);
  const start = Date.now();
  broadcast({ type: 'browser:loading', loading: true });
  try {
    const resp = await page.goto(site.url, {
      waitUntil: 'domcontentloaded',
      timeout: state.timeout,
    });
    const httpStatus = resp ? resp.status() : null;

    let loadMs = Date.now() - start;
    try {
      const navDuration = await page.evaluate(() => {
        const entries = performance.getEntriesByType('navigation');
        return entries.length ? Math.round(entries[0].duration) : null;
      });
      if (navDuration && navDuration >= 0) loadMs = navDuration;
    } catch {}

    // Give the page a brief moment so the screencast shows real content.
    await page.waitForTimeout(400).catch(() => {});
    broadcast({ type: 'browser:loading', loading: false });

    updateSite(site, {
      status: 'up',
      loadTime: Math.round(loadMs) / 1000,
      httpStatus,
      checkedAt: new Date().toISOString(),
    });
  } catch (err) {
    const { status, reason } = classifyError(err);
    updateSite(site, { status, reason, checkedAt: new Date().toISOString() });
    broadcast({ type: 'browser:loading', loading: false });
  } finally {
    broadcastProgress();
  }
}

function updateSite(site, patch) {
  Object.assign(site, patch);
  broadcastSite(site.id);
}

/* ---------------- Queue runner ---------------- */

async function runQueue(urls) {
  state.running = true;
  state.stopRequested = false;
  state.startedAt = Date.now();
  state.done = 0;
  state.total = urls.length;

  // Create one real browser page per worker.
  const workerCount = Math.max(1, Math.min(state.concurrency, urls.length || 1));
  for (let i = 0; i < workerCount; i++) {
    const page = await context.newPage();
    page.setDefaultTimeout(state.timeout);
    attachPageListeners(page);
    workerPages.set(i, page);
  }
  broadcast({ type: 'log', message: `بدء الفحص — ${urls.length} موقع بعدد ${workerCount} متوازٍ` });

  const queue = [...urls];
  let counter = 0;

  async function worker(idx) {
    const page = workerPages.get(idx);
    while (queue.length && !state.stopRequested) {
      const site = queue.shift();
      sitePages.set(site.id, page);
      await checkSite(site);
      state.done += 1;
      counter++;
    }
  }

  await Promise.all(Array.from({ length: workerCount }, (_, i) => worker(i)));

  // Close worker pages.
  for (const [, page] of workerPages) {
    try { await page.close(); } catch {}
  }
  workerPages.clear();
  sitePages.clear();

  stopScreencast();
  state.running = false;
  broadcast({ type: 'done', done: state.done, total: state.total });
  broadcast({ type: 'log', message: 'انتهى الفحص' });
}

/* ---------------- HTTP API ---------------- */

function parseUrlList(body) {
  const raw = Array.isArray(body.urls) ? body.urls : String(body.urls || '').split(/\n|,|;/);
  const seen = new Set();
  const urls = [];
  for (const item of raw) {
    const url = normalizeUrl(item);
    if (url && !seen.has(url)) { seen.add(url); urls.push(url); }
  }
  return urls;
}

function ensureSites(urls) {
  const existing = new Map(state.sites.map((s) => [s.url, s]));
  state.sites = urls.map((url, i) => {
    if (existing.has(url)) return existing.get(url);
    return { id: 's' + Date.now().toString(36) + i, url, status: 'pending', reason: null, loadTime: null, httpStatus: null, checkedAt: null };
  });
}

app.post('/api/start', async (req, res) => {
  try {
    if (state.running) return res.status(409).json({ error: 'الفحص يعمل حاليًا' });
    const urls = parseUrlList(req.body);
    if (!urls.length) return res.status(400).json({ error: 'لا توجد روابط صالحة' });
    state.timeout = Math.min(120000, Math.max(3000, parseInt(req.body.timeout, 10) || 15000));
    state.concurrency = Math.min(6, Math.max(1, parseInt(req.body.concurrency, 10) || 3));
    await ensureBrowser();
    resetResults();
    ensureSites(urls);
    broadcast({ type: 'state', snapshot: publicState() });
    runQueue(state.sites);
    res.json({ ok: true, count: urls.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/recheck', async (req, res) => {
  try {
    if (state.running) return res.status(409).json({ error: 'الفحص يعمل حاليًا' });
    if (!state.sites.length) return res.status(400).json({ error: 'لا توجد نتائج سابقة — ابدأ فحصًا أولًا' });
    const filter = req.body.filter || 'all'; // all | failed | single
    let targets = [];
    if (filter === 'failed') {
      targets = state.sites.filter((s) => s.status === 'down' || s.status === 'error');
    } else if (filter === 'single') {
      const url = normalizeUrl(req.body.url);
      const site = state.sites.find((s) => s.url === url);
      if (!site) return res.status(400).json({ error: 'الموقع غير موجود في القائمة' });
      targets = [site];
    } else {
      targets = state.sites;
    }
    if (!targets.length) return res.status(400).json({ error: 'لا توجد مواقع محددة لإعادة الفحص' });

    state.timeout = Math.min(120000, Math.max(3000, parseInt(req.body.timeout, 10) || state.timeout));
    resetResults();
    for (const t of targets) {
      Object.assign(t, { status: 'pending', reason: null, loadTime: null, httpStatus: null, checkedAt: null });
    }
    await ensureBrowser();
    broadcast({ type: 'state', snapshot: publicState() });
    runQueue(targets);
    res.json({ ok: true, count: targets.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/stop', (req, res) => {
  state.stopRequested = true;
  broadcast({ type: 'log', message: 'تم طلب إيقاف الفحص — سيتوقف بعد الموقع الحالي' });
  res.json({ ok: true });
});

app.post('/api/navigate', async (req, res) => {
  try {
    const page = activePage;
    if (!page) return res.status(400).json({ error: 'لا توجد صفحة نشطة' });
    const action = req.body.action;
    if (action === 'back') await page.goBack({ timeout: 10000 }).catch(() => {});
    else if (action === 'forward') await page.goForward({ timeout: 10000 }).catch(() => {});
    else if (action === 'reload') await page.reload({ timeout: state.timeout, waitUntil: 'domcontentloaded' }).catch(() => {});
    else return res.status(400).json({ error: 'action غير صالح' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function publicState() {
  return {
    sites: state.sites,
    running: state.running,
    timeout: state.timeout,
    concurrency: state.concurrency,
    done: state.done,
    total: state.total,
  };
}

/* ---------------- WebSocket ---------------- */

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'state', snapshot: publicState() }));

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    try {
      if (msg.type === 'start') {
        if (state.running) return;
        const urls = parseUrlList({ urls: msg.urls });
        if (!urls.length) return;
        state.timeout = Math.min(120000, Math.max(3000, parseInt(msg.timeout, 10) || 15000));
        state.concurrency = Math.min(6, Math.max(1, parseInt(msg.concurrency, 10) || 3));
        await ensureBrowser();
        resetResults();
        ensureSites(urls);
        broadcast({ type: 'state', snapshot: publicState() });
        runQueue(state.sites);
      } else if (msg.type === 'recheck') {
        if (state.running || !state.sites.length) return;
        const filter = msg.filter || 'all';
        let targets = [];
        if (filter === 'failed') targets = state.sites.filter((s) => s.status === 'down' || s.status === 'error');
        else if (filter === 'single') {
          const site = state.sites.find((s) => s.url === msg.url);
          if (site) targets = [site];
        } else targets = state.sites;
        if (!targets.length) return;
        resetResults();
        for (const t of targets) Object.assign(t, { status: 'pending', reason: null, loadTime: null, httpStatus: null, checkedAt: null });
        await ensureBrowser();
        broadcast({ type: 'state', snapshot: publicState() });
        runQueue(targets);
      } else if (msg.type === 'stop') {
        state.stopRequested = true;
      } else if (msg.type === 'nav') {
        if (!activePage) return;
        if (msg.action === 'back') await activePage.goBack({ timeout: 10000 }).catch(() => {});
        else if (msg.action === 'forward') await activePage.goForward({ timeout: 10000 }).catch(() => {});
        else if (msg.action === 'reload') await activePage.reload({ timeout: state.timeout, waitUntil: 'domcontentloaded' }).catch(() => {});
      }
    } catch (e) {
      broadcast({ type: 'log', message: 'خطأ: ' + e.message });
    }
  });
});

/* ---------------- URL bar + loading status tracking ---------------- */

function attachPageListeners(page) {
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) {
      broadcast({ type: 'browser:url', url: frame.url() });
    }
  });
  page.on('load', () => broadcast({ type: 'browser:loading', loading: false }));
  page.on('domcontentloaded', () => {
    // keep loading=true until full load; some pages never fire 'load'
    setTimeout(() => broadcast({ type: 'browser:loading', loading: false }), 1200);
  });
}

server.listen(PORT, () => {
  console.log(`Website Checker running at http://localhost:${PORT}`);
});
