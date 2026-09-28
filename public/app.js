/* Website Checker — dashboard logic */
(() => {
  const $ = (id) => document.getElementById(id);
  const els = {
    urlInput: $('urlInput'), timeoutSelect: $('timeoutSelect'), concurrencySelect: $('concurrencySelect'),
    startBtn: $('startBtn'), stopBtn: $('stopBtn'),
    recheckFailedBtn: $('recheckFailedBtn'), recheckAllBtn: $('recheckAllBtn'),
    copyUpBtn: $('copyUpBtn'), copyDownBtn: $('copyDownBtn'),
    exportBtn: $('exportBtn'), exportMenu: $('exportMenu'),
    searchInput: $('searchInput'), siteList: $('siteList'), sitesCount: $('sitesCount'),
    statTotal: $('statTotal'), statUp: $('statUp'), statDown: $('statDown'), statErr: $('statErr'), statDone: $('statDone'),
    progressText: $('progressText'), progressPct: $('progressPct'), progressBar: $('progressBar'),
    navBack: $('navBack'), navForward: $('navForward'), navReload: $('navReload'),
    statusDot: $('statusDot'), urlText: $('urlText'), loadingSpinner: $('loadingSpinner'), browserStatus: $('browserStatus'),
    screenPlaceholder: $('screenPlaceholder'), screenImg: $('screenImg'),
    activityLog: $('activityLog'),
    resultsSection: $('resultsSection'), upList: $('upList'), downList: $('downList'), errList: $('errList'),
    upCount: $('upCount'), downCount: $('downCount'), errCount: $('errCount'),
  };

  const ICONS = { pending: '⚪', checking: '🔄', up: '🟢', down: '🔴', err: '🟡' };
  let sites = [];
  let searchTerm = '';

  /* ---------- WebSocket ---------- */
  let ws;
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handleMessage(msg);
    };
    ws.onclose = () => setTimeout(connect, 2000);
  }

  function send(msg) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'state':
        sites = msg.snapshot.sites || [];
        setRunning(msg.snapshot.running);
        renderAll();
        break;
      case 'site:update': {
        const idx = sites.findIndex((s) => s.id === msg.site.id);
        if (idx >= 0) sites[idx] = msg.site;
        renderAll();
        if (msg.site.status !== 'pending' && msg.site.status !== 'checking') markDone();
        break;
      }
      case 'progress':
        setProgress(msg.done, msg.total);
        break;
      case 'site:start':
        setBrowserStatus(`جاري فتح ${msg.url}…`);
        els.statusDot.className = 'status-dot checking';
        log(`▶ بدء فحص ${msg.url}`);
        break;
      case 'done':
        setRunning(false);
        setBrowserStatus('انتهى الفحص ✅');
        log(`✔ انتهى الفحص — ${msg.done}/${msg.total}`);
        renderResults();
        break;
      case 'browser:url':
        els.urlText.textContent = msg.url;
        break;
      case 'browser:loading':
        els.loadingSpinner.classList.toggle('on', !!msg.loading);
        if (msg.loading) els.browserStatus.textContent = 'جاري تحميل الموقع...';
        break;
      case 'browser:frame':
        showFrame(msg.data);
        break;
      case 'browser:active': {
        const site = sites.find((s) => s.id === msg.id);
        if (site) {
          document.querySelectorAll('.site-item').forEach((el) => el.classList.remove('active'));
          const item = document.querySelector(`.site-item[data-id="${msg.id}"]`);
          if (item) { item.classList.add('active'); item.scrollIntoView({ block: 'nearest' }); }
        }
        break;
      }
      case 'log':
        log(msg.message);
        break;
    }
  }

  /* ---------- Rendering ---------- */
  function counts() {
    const c = { up: 0, down: 0, err: 0, done: 0 };
    for (const s of sites) {
      if (s.status === 'up') c.up++;
      else if (s.status === 'down') c.down++;
      else if (s.status === 'err') c.err++;
      if (s.status === 'up' || s.status === 'down' || s.status === 'err') c.done++;
    }
    return c;
  }

  function renderAll() {
    const c = counts();
    els.statTotal.textContent = sites.length;
    els.statUp.textContent = c.up;
    els.statDown.textContent = c.down;
    els.statErr.textContent = c.err;
    els.statDone.textContent = `${c.done} / ${sites.length}`;
    els.sitesCount.textContent = sites.length;
    renderSiteList();
    renderResults();
  }

  function renderSiteList() {
    const term = searchTerm.trim().toLowerCase();
    const filtered = term ? sites.filter((s) => s.url.toLowerCase().includes(term)) : sites;
    els.siteList.innerHTML = '';
    for (const s of filtered) {
      const li = document.createElement('li');
      li.className = 'site-item';
      li.dataset.id = s.id;

      const icon = document.createElement('span');
      icon.className = 'site-icon';
      icon.textContent = s.status === 'checking' ? '' : ICONS[s.status];
      if (s.status === 'checking') {
        icon.innerHTML = '<span class="spinner"></span>';
      }

      const info = document.createElement('div');
      info.className = 'site-info';
      const url = document.createElement('span');
      url.className = 'site-url';
      url.textContent = s.url;
      url.title = s.url;
      info.appendChild(url);

      const meta = document.createElement('div');
      meta.className = 'site-meta';
      if (s.status === 'up') {
        meta.classList.add('ok');
        meta.textContent = `يعمل — زمن الفتح: ${s.loadTime != null ? s.loadTime + ' ثانية' : ''}${s.httpStatus ? ` — HTTP ${s.httpStatus}` : ''}`;
      } else if (s.status === 'down') {
        meta.classList.add('bad');
        meta.textContent = `لا يعمل${s.reason ? ' — ' + s.reason : ''}`;
      } else if (s.status === 'err') {
        meta.classList.add('warn');
        meta.textContent = `مشكلة${s.reason ? ' — ' + s.reason : ''}`;
      } else if (s.status === 'checking') {
        meta.textContent = 'جاري الفحص...';
      } else {
        meta.textContent = 'بانتظار';
      }
      info.appendChild(meta);

      const recheck = document.createElement('button');
      recheck.className = 'recheck-one';
      recheck.textContent = '🔄';
      recheck.title = 'إعادة فحص هذا الموقع';
      recheck.onclick = () => recheckSingle(s.url);

      li.append(icon, info, recheck);
      els.siteList.appendChild(li);
    }
  }

  function renderResults() {
    const up = sites.filter((s) => s.status === 'up');
    const down = sites.filter((s) => s.status === 'down');
    const err = sites.filter((s) => s.status === 'err');

    els.resultsSection.hidden = sites.length === 0;
    els.upCount.textContent = up.length;
    els.downCount.textContent = down.length;
    els.errCount.textContent = err.length;

    fillList(els.upList, up, (s) => `<span class="meta ok-time">${s.loadTime != null ? '⏱ ' + s.loadTime + 's' : 'يعمل'}</span>`);
    fillList(els.downList, down, () => `<span class="meta">لا يعمل</span>`);
    fillList(els.errList, err, (s) => `<span class="meta err-reason">${s.reason || 'مشكلة'}</span>`);
  }

  function fillList(ul, list, metaFn) {
    ul.innerHTML = '';
    if (!list.length) {
      ul.innerHTML = '<div class="empty-note">لا توجد مواقع هنا</div>';
      return;
    }
    for (const s of list) {
      const li = document.createElement('li');
      const url = document.createElement('span');
      url.textContent = s.url;
      url.title = s.url;
      li.appendChild(url);
      const meta = document.createElement('span');
      meta.innerHTML = metaFn(s);
      li.appendChild(meta);
      ul.appendChild(li);
    }
  }

  function setRunning(running) {
    els.startBtn.disabled = running;
    els.stopBtn.disabled = !running;
    els.recheckFailedBtn.disabled = running;
    els.recheckAllBtn.disabled = running;
    if (!running) els.loadingSpinner.classList.remove('on');
  }

  function setProgress(done, total) {
    els.progressText.textContent = `${done} / ${total}`;
    const pct = total ? Math.round((done / total) * 100) : 0;
    els.progressPct.textContent = pct + '%';
    els.progressBar.style.width = pct + '%';
    els.statDone.textContent = `${done} / ${sites.length}`;
  }

  function markDone() {
    const c = counts();
    els.statUp.textContent = c.up;
    els.statDown.textContent = c.down;
    els.statErr.textContent = c.err;
    els.statDone.textContent = `${c.done} / ${sites.length}`;
    const total = sites.length;
    const pct = total ? Math.round((c.done / total) * 100) : 0;
    els.progressBar.style.width = pct + '%';
    els.progressText.textContent = `${c.done} / ${total}`;
    els.progressPct.textContent = pct + '%';
    renderResults();
  }

  function showFrame(base64) {
    els.screenPlaceholder.hidden = true;
    els.screenImg.hidden = false;
    els.screenImg.src = 'data:image/jpeg;base64,' + base64;
  }

  function setBrowserStatus(text) {
    els.browserStatus.textContent = text;
  }

  function setStatusDot(status) {
    els.statusDot.className = 'status-dot' + (status ? ' ' + status : '');
  }

  function log(message) {
    const div = document.createElement('div');
    const time = new Date().toLocaleTimeString('en-GB');
    div.innerHTML = `<span class="t">[${time}]</span>${escapeHtml(message)}`;
    els.activityLog.prepend(div);
    while (els.activityLog.children.length > 60) els.activityLog.lastChild.remove();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  /* ---------- Actions ---------- */
  function parseList() {
    return els.urlInput.value.split(/\n|,|;/).map((s) => s.trim()).filter(Boolean);
  }

  els.startBtn.onclick = () => {
    const urls = parseList();
    if (!urls.length) { log('⚠ أدخل قائمة المواقع أولًا'); return; }
    send({
      type: 'start',
      urls,
      timeout: parseInt(els.timeoutSelect.value, 10),
      concurrency: parseInt(els.concurrencySelect.value, 10),
    });
  };

  els.stopBtn.onclick = () => send({ type: 'stop' });

  function recheckSingle(url) {
    send({ type: 'recheck', filter: 'single', url, timeout: parseInt(els.timeoutSelect.value, 10) });
  }

  els.recheckFailedBtn.onclick = () => send({ type: 'recheck', filter: 'failed', timeout: parseInt(els.timeoutSelect.value, 10) });
  els.recheckAllBtn.onclick = () => send({ type: 'recheck', filter: 'all', timeout: parseInt(els.timeoutSelect.value, 10) });

  els.navBack.onclick = () => send({ type: 'nav', action: 'back' });
  els.navForward.onclick = () => send({ type: 'nav', action: 'forward' });
  els.navReload.onclick = () => send({ type: 'nav', action: 'reload' });

  els.searchInput.oninput = () => { searchTerm = els.searchInput.value; renderSiteList(); };

  els.copyUpBtn.onclick = () => copyList(sites.filter((s) => s.status === 'up').map((s) => s.url), 'المواقع العاملة');
  els.copyDownBtn.onclick = () => copyList(
    sites.filter((s) => s.status === 'down' || s.status === 'err').map((s) => s.url),
    'المواقع المتوقفة'
  );

  async function copyList(list, label) {
    if (!list.length) { log(`⚠ لا توجد ${label}`); return; }
    try {
      await navigator.clipboard.writeText(list.join('\n'));
      log(`📋 تم نسخ ${list.length} موقع (${label})`);
    } catch {
      log('⚠ تعذر النسخ — انسخ يدويًا');
    }
  }

  els.exportBtn.onclick = (e) => {
    e.stopPropagation();
    els.exportMenu.classList.toggle('open');
  };
  document.addEventListener('click', () => els.exportMenu.classList.remove('open'));
  els.exportMenu.querySelectorAll('button').forEach((btn) => {
    btn.onclick = () => exportResults(btn.dataset.format);
  });

  function exportResults(format) {
    const c = counts();
    const up = sites.filter((s) => s.status === 'up');
    const down = sites.filter((s) => s.status === 'down');
    const err = sites.filter((s) => s.status === 'err');
    let content, mime, ext;

    if (format === 'json') {
      content = JSON.stringify({
        exportedAt: new Date().toISOString(),
        summary: { total: sites.length, up: c.up, down: c.down, errors: c.err },
        up: up.map((s) => ({ url: s.url, loadTime: s.loadTime, httpStatus: s.httpStatus })),
        down: down.map((s) => ({ url: s.url, reason: s.reason })),
        errors: err.map((s) => ({ url: s.url, reason: s.reason })),
      }, null, 2);
      mime = 'application/json'; ext = 'json';
    } else if (format === 'csv') {
      const rows = [['url', 'status', 'loadTime', 'reason', 'httpStatus']];
      for (const s of sites) {
        rows.push([s.url, s.status, s.loadTime ?? '', s.reason ?? '', s.httpStatus ?? '']);
      }
      content = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
      mime = 'text/csv'; ext = 'csv';
    } else {
      content =
        `Website Checker Results — ${new Date().toLocaleString()}\n` +
        `Total: ${sites.length} | Up: ${c.up} | Down: ${c.down} | Errors: ${c.err}\n\n` +
        `== UP ==\n${up.map((s) => `${s.url} (${s.loadTime ?? '?'}s)`).join('\n')}\n\n` +
        `== DOWN ==\n${down.map((s) => s.url).join('\n')}\n\n` +
        `== ERRORS ==\n${err.map((s) => `${s.url} — ${s.reason ?? ''}`).join('\n')}\n`;
      mime = 'text/plain'; ext = 'txt';
    }

    const blob = new Blob([content], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `website-checker-results.${ext}`;
    a.click();
    URL.revokeObjectURL(a.href);
    log(`⬇ تم تصدير النتائج بصيغة ${ext.toUpperCase()}`);
  }

  /* ---------- Boot ---------- */
  connect();
})();
