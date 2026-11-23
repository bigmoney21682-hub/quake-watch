/* Quake Watch page logic: polling loop, charts, history, settings. */
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const POLL_MS = 5 * QW.MIN;
  const BUILD = '2026-11-23a';
  let rangeH = 24, charts = {}, busy = false, quakes = [];

  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const fmtT = t => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const ago = t => { const m = Math.round((Date.now() - t) / 6e4); return m < 60 ? m + ' min ago' : m < 2880 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago'; };
  function toast(msg) { const el = $('#toast'); el.textContent = msg; el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => el.hidden = true, 3500); }

  // ---------- Navigation ----------
  document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => {
    document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x === b));
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + b.dataset.view));
    if (b.dataset.view === 'dash') renderCharts();
    if (b.dataset.view === 'events') renderEvents();
    if (b.dataset.view === 'settings') renderSettings();
  });
  $('#ranges').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    rangeH = +b.dataset.h;
    document.querySelectorAll('#ranges button').forEach(x => x.classList.toggle('on', x === b));
    renderCharts();
  };

  // ---------- Status card ----------
  async function renderStatus(a) {
    a = a || await QW.analyze();
    $('#idx').textContent = a.index == null ? '—' : a.index.toFixed(2);
    const lv = $('#level'); lv.className = 'pill ' + a.level; lv.textContent = a.level;
    $('#status').className = 'card status ' + a.level;
    $('#reason').textContent = a.reason;
    $('#chips').innerHTML = Object.entries(a.scores).map(([k, s]) => {
      const z = s.z == null ? `<span class="small">baseline ${s.n} pts</span>` : `z <b>${s.z >= 0 ? '+' : ''}${s.z.toFixed(2)}</b>`;
      return `<span class="chip ${s.z != null && Math.abs(s.z) >= 3 ? 'hot' : ''}">${k} ${z}</span>`;
    }).join('') || '<span class="small">No data yet.</span>';
    const last = await QW.getMeta('lastCollect', 0);
    $('#meta').textContent = [
      a.kp != null ? `Kp ${a.kp.toFixed(1)}` : null,
      a.ap != null ? `a ${a.ap}` : null,
      a.dst != null ? `Dst ${a.dst} nT` : null,
      a.f107 != null ? `F10.7 ${a.f107.toFixed(0)} sfu` : null,
      a.xray != null ? `X-ray ${QW.xrayClass(a.xray)}` : null,
      `quakes 3 d: ${a.q3} (≈${a.expected3.toFixed(1)} usual)`,
      last ? `updated ${ago(last)}` : 'not yet updated',
    ].filter(Boolean).join(' · ');
  }

  // ---------- Forecast + stream ----------
  async function renderForecast() {
    const st = await QW.settings();
    const open = (await QW.getForecasts()).find(f => f.status === 'open');
    const a = await QW.analyze();
    let html = '<h2>Forecast</h2>';
    if (open) {
      const left = Math.max(0, (open.until - Date.now()) / QW.DAY);
      html += `<p><b>Active:</b> M${open.mag}+ within ${open.radiusKm} km by ${fmtT(open.until)} <span class="small">(${left.toFixed(1)} days left)</span></p>
        <p class="small">Trigger: ${open.trigger} · ${open.detail}${open.baseChance != null ? ` · chance by luck alone ≈ ${Math.round(open.baseChance * 100)}%` : ''}</p>`;
    } else {
      html += `<p class="small">No active forecast. One opens when the precursor index goes elevated, or when solar activity and local seismic reports rise together.</p>`;
    }
    html += `<p class="small">Solar input: ${a.solarWhy.length ? '<b>rising</b>, ' + a.solarWhy.join(', ') : 'normal'} · Seismic reports: ${a.q3} in 3 days (≈${a.expected3.toFixed(1)} usual)</p>`;
    $('#forecast').innerHTML = html;
    $('#forecast').classList.toggle('active', !!open);
    const el = $('#stream');
    if (st.streamUrl) {
      if (el.dataset.src !== st.streamUrl) {
        el.dataset.src = st.streamUrl;
        el.innerHTML = `<audio controls preload="none" src="${st.streamUrl.replace(/"/g, '&quot;')}"></audio><p class="small">If it won't play, the station may be offline or the link may point to a web page instead of the audio itself.</p>`;
      }
    } else {
      el.dataset.src = '';
      el.innerHTML = '<p class="small">Add an earth-signal stream URL in Settings (for example the EPD Laboratories ELF/VLF feed) to listen here.</p>';
    }
  }
  async function renderScore() {
    const st = await QW.settings();
    const fcs = await QW.getForecasts();
    const done = fcs.filter(f => f.status !== 'open'), hits = done.filter(f => f.status === 'hit');
    const base = done.filter(f => f.baseChance != null);
    const expected = base.reduce((x, f) => x + f.baseChance, 0);
    let baseTxt = '';
    try { baseTxt = ` Luck alone: ≈${Math.round(QW.chance((await QW.baseRate(st)).perDay, st.forecastDays) * 100)}% per ${st.forecastDays}-day window at current settings.`; } catch {}
    $('#score').innerHTML = done.length
      ? `<p><b>${hits.length} hit${hits.length === 1 ? '' : 's'} / ${done.length} scored</b> (${Math.round(hits.length / done.length * 100)}%) · chance would give ≈${expected.toFixed(1)} hits.${baseTxt}</p>
         <p class="small">${done.length < 10 ? 'Too few forecasts to judge yet. It needs at least 10–20 before the comparison means anything.' : hits.length > expected * 1.5 ? 'Running ahead of chance so far.' : 'Not beating chance so far.'}</p>`
      : `<p class="small">No forecasts scored yet.${baseTxt}</p>`;
    $('#forecasts').innerHTML = fcs.slice(0, 50).map(f =>
      `<li><span class="mag fc-${f.status}">${f.status.toUpperCase()}</span><span>M${f.mag}+ · ${f.radiusKm} km · ${f.trigger}<br><span class="small">${
        f.quake ? `M${f.quake.mag.toFixed(1)} ${f.quake.place}, ${(f.lead / QW.DAY).toFixed(1)} d lead` : f.detail || ''}</span></span><span class="when">${fmtT(f.t)}</span></li>`).join('');
  }

  // ---------- Charts ----------
  function quakeMarkers() {
    return {
      hooks: {
        draw: [u => {
          const { ctx } = u, [x0, x1] = [u.scales.x.min, u.scales.x.max];
          ctx.save();
          ctx.strokeStyle = css('--quake'); ctx.fillStyle = css('--quake');
          ctx.setLineDash([4, 4]); ctx.lineWidth = devicePixelRatio;
          ctx.font = `${11 * devicePixelRatio}px system-ui`;
          for (const q of quakes) {
            const t = q.t / 1000; if (t < x0 || t > x1) continue;
            const x = Math.round(u.valToPos(t, 'x', true));
            ctx.beginPath(); ctx.moveTo(x, u.bbox.top); ctx.lineTo(x, u.bbox.top + u.bbox.height); ctx.stroke();
            ctx.fillText('M' + (q.mag ?? 0).toFixed(1), x + 3 * devicePixelRatio, u.bbox.top + 12 * devicePixelRatio);
          }
          ctx.restore();
        }],
      },
    };
  }

  async function plot(id, defs, opts = {}) {
    const el = document.getElementById(id);
    const from = rangeH ? Date.now() - rangeH * QW.HOUR : 0;
    const raw = await Promise.all(defs.map(d => d.data ? d.data(from) : QW.getSeries(d.s, from)));
    if (charts[id]) { charts[id].destroy(); delete charts[id]; }
    if (!raw.some(r => r.length)) { el.innerHTML = '<div class="empty">No data in this range yet — history builds up as the app runs.</div>'; return; }
    el.innerHTML = '';
    const tables = raw.map(r => [r.map(p => p[0] / 1000), r.map(p => p[1])]);
    const data = uPlot.join(tables.map(t => t[0].length ? t : [[from / 1000], [null]]));
    const axisStyle = { stroke: css('--muted'), grid: { stroke: css('--line'), width: 1 }, ticks: { stroke: css('--line') } };
    const xMin = rangeH ? from / 1000 : Math.min(...tables.filter(t => t[0].length).map(t => t[0][0]));
    const scales = { x: { time: true, range: () => [xMin, Date.now() / 1000] } }, axes = [Object.assign({}, axisStyle)];
    const seen = new Set();
    defs.forEach(d => {
      const sc = d.scale || 'y';
      if (seen.has(sc)) return; seen.add(sc);
      scales[sc] = d.log ? { distr: 3, log: 10 } : d.range ? { range: d.range } : {};
      axes.push(Object.assign({}, axisStyle, d.fmtAxis ? { values: (u, vs) => vs.map(d.fmtAxis) } : {}, { scale: sc, side: seen.size === 1 ? 3 : 1, size: 52, label: d.axis || '', labelSize: 18,
        grid: seen.size === 1 ? axisStyle.grid : { show: false } }));
    });
    const series = [{}].concat(defs.map(d => ({
      label: d.label, stroke: css(d.color), width: 1.5, scale: d.scale || 'y', spanGaps: true,
      points: { show: d.points || false, size: 4 }, paths: d.step ? uPlot.paths.stepped({ align: 1 }) : undefined,
      value: (u, v) => v == null ? '—' : d.fmt ? d.fmt(v) : v.toFixed(d.dp ?? 2),
    })));
    charts[id] = new uPlot({
      width: el.clientWidth, height: opts.height || 220, scales, axes, series,
      cursor: { sync: { key: 'qw' } }, legend: { live: true }, plugins: [quakeMarkers()],
    }, data, el);
  }

  async function renderCharts() {
    quakes = await QW.getQuakes();
    const st = await QW.settings();
    $('#mag-hint').textContent = `USGS ${st.magStation}, 1-min`;
    await Promise.all([
      plot('c-tell', [
        { s: 'tell.E', label: '|E| mV/km', color: '--s1', points: true },
        { s: 'tell.Ex', label: 'Ex', color: '--s2' },
        { s: 'tell.Ey', label: 'Ey', color: '--s3' },
      ]),
      plot('c-iono', [
        { s: 'iono.TEC', label: 'TEC (TECU)', color: '--s2', axis: 'TECU', points: true },
        { s: 'iono.dTEC', label: 'Anomaly (TECU)', color: '--s1', scale: 'd', axis: 'Δ TECU', points: true },
      ]),
      plot('c-mag', [
        { s: 'geo.H', label: 'H (nT)', color: '--s2', axis: 'H nT', dp: 1 },
        { s: 'geo.Z', label: 'Z (nT)', color: '--s3', scale: 'z', axis: 'Z nT', dp: 1 },
      ]),
      plot('c-ulf', [{
        label: 'Z/H ratio', color: '--s4', dp: 3,
        data: async from => QW.polarization(
          await QW.getSeries('geo.H', from - QW.HOUR), await QW.getSeries('geo.Z', from - QW.HOUR)).filter(p => p[0] >= from),
      }]),
      plot('c-sun', [
        { s: 'sun.Xray', label: 'X-ray', color: '--s1', scale: 'xr', log: true, axis: 'W/m²', fmt: QW.xrayClass, fmtAxis: v => QW.xrayClass(v) },
        { s: 'sun.F107', label: 'F10.7 sfu', color: '--s2', scale: 'f', axis: 'sfu', dp: 0, points: true },
      ]),
      plot('c-space', [
        { s: 'sw.Kp', label: 'Kp', color: '--s4', step: true, range: [0, 9], axis: 'Kp', dp: 2 },
        { s: 'sw.speed', label: 'Wind km/s', color: '--s1', scale: 'v', axis: 'km/s', dp: 0 },
      ]),
      plot('c-idx', [{ s: 'idx', label: 'Index', color: '--s1', points: true }], { height: 180 }),
    ]);
  }
  new ResizeObserver(() => { for (const [id, c] of Object.entries(charts)) c.setSize({ width: document.getElementById(id).clientWidth, height: c.height }); })
    .observe($('main'));
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', renderCharts);

  // ---------- Events ----------
  async function renderEvents() {
    const st = await QW.settings();
    quakes = await QW.getQuakes();
    $('#q-hint').textContent = `within ${st.radiusKm} km · last 30 days · USGS`;
    $('#quakes').innerHTML = quakes.length ? quakes.slice(0, 100).map(q =>
      `<li><span class="mag">M${(q.mag ?? 0).toFixed(1)}</span><a href="${q.url}" target="_blank" rel="noopener">${q.place || q.id}</a><span class="when">${fmtT(q.t)}</span></li>`).join('')
      : '<li class="empty">No earthquakes recorded in the radius yet.</li>';
    await renderScore();
    const al = await QW.getAlerts();
    $('#alerts').innerHTML = al.length ? al.slice(0, 200).map(a =>
      `<li><span class="mag">${{ quake: '⚑', forecast: '◎', verify: '✓', coincidence: '☉' }[a.kind] || '◆'}</span><span><b>${a.title}</b><br><span class="small">${a.body || ''}</span></span><span class="when">${fmtT(a.t)}</span></li>`).join('')
      : '<li class="empty">No alerts yet.</li>';
  }

  // ---------- Settings & history ----------
  async function renderSettings() {
    const st = await QW.settings();
    $('#s-notify').checked = st.notify && 'Notification' in self && Notification.permission === 'granted';
    $('#notify-help').textContent = notifyHelp();
    $('#diag').textContent = [
      'Build ' + BUILD,
      isIOS ? 'iOS ' + (iosVer.join('.') || '?') : navigator.platform,
      'Home Screen app: ' + (standalone ? 'yes' : 'no'),
      'Notifications API: ' + ('Notification' in self ? 'yes' : 'no'),
      'permission: ' + ('Notification' in self ? Notification.permission : 'n/a'),
      'service worker: ' + (swReg?.active ? 'active' : 'none'),
    ].join(' · ');
    $('#s-radius').value = st.radiusKm; $('#s-minmag').value = st.minMag;
    $('#s-thresh').value = st.anomalyThreshold; $('#s-station').value = st.magStation;
    $('#s-fdays').value = st.forecastDays; $('#s-fmag').value = st.forecastMag; $('#s-stream').value = st.streamUrl;
    const rows = await QW.allSamples();
    const first = rows.reduce((m, r) => Math.min(m, r.t), Infinity);
    $('#db-stats').textContent = rows.length
      ? `${rows.length.toLocaleString()} samples logged since ${fmtT(first)}.` : 'No history yet.';
    $('#bg-status').textContent = await bgStatus();
  }
  async function saveSetting(k, v) { const s = await QW.getMeta('settings', {}); s[k] = v; await QW.setMeta('settings', s); }
  $('#s-radius').onchange = e => saveSetting('radiusKm', +e.target.value).then(() => refresh());
  $('#s-minmag').onchange = e => saveSetting('minMag', +e.target.value);
  $('#s-fdays').onchange = e => saveSetting('forecastDays', +e.target.value);
  $('#s-fmag').onchange = e => saveSetting('forecastMag', +e.target.value);
  $('#s-stream').onchange = e => {
    const v = e.target.value.trim() || QW.DEFAULTS.streamUrl;
    e.target.value = v;
    saveSetting('streamUrl', v).then(renderForecast);
  };
  $('#s-thresh').onchange = e => saveSetting('anomalyThreshold', +e.target.value).then(() => renderStatus());
  $('#s-station').onchange = e => saveSetting('magStation', e.target.value).then(() => QW.setMeta('geo.last', 0)).then(() => refresh());
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const iosVer = (navigator.userAgent.match(/OS (\d+)_(\d+)/) || []).slice(1).map(Number);
  function notifyHelp() {
    if (!('Notification' in self)) {
      if (isIOS && iosVer.length && (iosVer[0] < 16 || (iosVer[0] === 16 && iosVer[1] < 4)))
        return `This iPhone runs iOS ${iosVer.join('.')}, and web-app notifications need iOS 16.4 or newer. Update iOS, or rely on the ntfy alerts.`;
      if (isIOS && !standalone)
        return 'This copy is running inside Safari, not as a Home Screen web app. Delete the Home Screen icon. In Safari, tap Share → Add to Home Screen, and make sure "Open as Web App" is ON. Then open it from the new icon.';
      return 'This browser does not expose notifications to this page.';
    }
    if (Notification.permission === 'denied')
      return isIOS ? 'Notifications are blocked. On iPhone open Settings → Notifications → Quake Watch → Allow Notifications. If it isn\'t listed, delete the app from the Home Screen, add it again, and tap the switch here.'
        : 'Notifications are blocked for this site. Allow them in the browser\'s site settings, then try again.';
    return '';
  }
  // iOS only shows the permission prompt when requestPermission() runs directly inside a tap,
  // so ask first thing in the click handler, before any other await.
  $('#s-notify').onclick = async e => {
    const on = e.target.checked;
    if (on) {
      let p = 'Notification' in self ? Notification.permission : 'unsupported';
      if (p === 'default') p = await Notification.requestPermission();
      if (p !== 'granted') {
        e.target.checked = false;
        const help = notifyHelp() || 'Permission was not granted. Tap the switch again and choose Allow.';
        $('#notify-help').textContent = help; toast(help);
        await saveSetting('notify', false);
        return;
      }
      $('#notify-help').textContent = '';
      await registerPeriodic();
    }
    await saveSetting('notify', on);
    $('#bg-status').textContent = await bgStatus();
  };
  $('#test-notify').onclick = async () => {
    if (!('Notification' in self) || Notification.permission !== 'granted') { toast(notifyHelp() || 'Turn notifications on first.'); return; }
    const reg = swReg || await navigator.serviceWorker?.ready;
    const a = { title: 'Quake Watch test', body: 'Notifications are working.', kind: 'test' };
    if (reg) await reg.showNotification(a.title, { body: a.body, icon: 'icons/icon-192.png', tag: 'test' });
    else new Notification(a.title, { body: a.body });
  };

  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  const stamp = () => new Date().toISOString().slice(0, 16).replace(':', '');
  $('#export-csv').onclick = async () => {
    const rows = await QW.allSamples();
    const csv = 'series,time_utc,value\n' + rows.map(r => `${r.s},${new Date(r.t).toISOString()},${r.v}`).join('\n');
    download(`quake-watch-${stamp()}.csv`, csv, 'text/csv');
  };
  $('#export-json').onclick = async () => {
    const backup = { app: 'quake-watch', v: 2, samples: await QW.allSamples(), quakes: await QW.getQuakes(), alerts: await QW.getAlerts(), forecasts: await QW.getForecasts() };
    download(`quake-watch-backup-${stamp()}.json`, JSON.stringify(backup), 'application/json');
  };
  $('#import').onchange = async e => {
    try {
      const b = JSON.parse(await e.target.files[0].text());
      if (b.app !== 'quake-watch') throw new Error('Not a Quake Watch backup');
      const by = {};
      for (const r of b.samples) (by[r.s] = by[r.s] || []).push([r.t, r.v]);
      for (const [s, pts] of Object.entries(by)) await QW.putSamples(s, pts);
      await QW.putQuakes(b.quakes || []);
      for (const a of b.alerts || []) { delete a.id; await QW.addAlert(a); }
      for (const f of b.forecasts || []) { delete f.id; await QW.addForecast(f); }
      toast(`Imported ${b.samples.length.toLocaleString()} samples.`);
      renderSettings(); renderCharts();
    } catch (err) { toast('Import failed: ' + err.message); }
    e.target.value = '';
  };
  $('#clear').onclick = async () => {
    const b = $('#clear');
    if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Tap again to erase everything'; setTimeout(() => { b.dataset.armed = ''; b.textContent = 'Clear all history'; }, 4000); return; }
    await QW.clearAll();
    b.dataset.armed = ''; b.textContent = 'Clear all history';
    toast('History cleared.'); renderSettings(); renderCharts(); renderStatus();
  };
  $('#backfill').onclick = async () => {
    const b = $('#backfill'); b.disabled = true;
    try {
      await QW.backfill((i, n) => $('#backfill-status').textContent = `Backfilling ${i}/${n} files…`);
      $('#backfill-status').textContent = 'Backfill complete.';
      renderCharts(); renderStatus();
    } catch (err) { $('#backfill-status').textContent = 'Backfill failed: ' + err.message; }
    b.disabled = false;
  };

  // ---------- Service worker, background sync, notifications ----------
  let swReg = null;
  async function registerPeriodic() {
    if (!swReg || !('periodicSync' in swReg)) return false;
    try {
      const p = await navigator.permissions.query({ name: 'periodic-background-sync' });
      if (p.state !== 'granted') return false;
      await swReg.periodicSync.register('collect', { minInterval: 30 * QW.MIN });
      return true;
    } catch { return false; }
  }
  async function bgStatus() {
    if (!swReg) return 'Service worker unavailable — open over HTTPS or localhost.';
    if ('periodicSync' in swReg) {
      const tags = await swReg.periodicSync.getTags().catch(() => []);
      if (tags.includes('collect')) return 'Background checks enabled (the browser picks the cadence, typically every few hours).';
      return 'Install the app to your home screen to enable background checks.';
    }
    if (isIOS) return 'iPhone only checks while the app is open. iOS gives Home Screen apps no background time, so alerts appear only while the app is open or was used recently.';
    return 'This browser only collects while the app is open. Keep it open (or in a tab) for continuous logging.';
  }
  async function notify(alerts) {
    const st = await QW.settings();
    if (!st.notify || !('Notification' in self) || Notification.permission !== 'granted') return;
    for (const a of alerts) {
      if (swReg) await swReg.showNotification(a.title, { body: a.body, icon: 'icons/icon-192.png', tag: a.ref || a.kind, data: { url: './' } });
      else new Notification(a.title, { body: a.body });
    }
  }

  // ---------- Main loop ----------
  async function refresh() {
    if (busy) return; busy = true;
    $('#refresh').classList.add('spin');
    try {
      const r = await QW.collect();
      if (r.errors.length) toast('Some sources failed: ' + r.errors.map(e => e.split(':')[0]).join(', '));
      for (const a of r.alerts) toast(a.title + ' — ' + a.body);
      await notify(r.alerts);
      await renderStatus(r.analysis); await renderForecast();
      if ($('#view-dash').classList.contains('active')) await renderCharts();
      if ($('#view-events').classList.contains('active')) await renderEvents();
    } catch (err) { console.error(err); toast('Update failed: ' + err.message); }
    $('#refresh').classList.remove('spin'); busy = false;
  }
  $('#refresh').onclick = refresh;

  (async function init() {
    if ('serviceWorker' in navigator) {
      try { swReg = await navigator.serviceWorker.register('sw.js'); await navigator.serviceWorker.ready; await registerPeriodic(); }
      catch (err) { console.warn('SW registration failed', err); }
    }
    await renderStatus(); await renderForecast(); await renderCharts();
    await refresh();
    setInterval(refresh, POLL_MS);
    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState === 'visible' && Date.now() - await QW.getMeta('lastCollect', 0) > POLL_MS) refresh();
    });
  })();
})();
