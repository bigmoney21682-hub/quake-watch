/* Quake Watch page logic: polling loop, charts, history, settings. */
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const POLL_MS = 5 * QW.MIN;
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
      a.dst != null ? `Dst ${a.dst} nT` : null,
      last ? `updated ${ago(last)}` : 'not yet updated',
    ].filter(Boolean).join(' · ');
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
      scales[sc] = d.range ? { range: d.range } : {};
      axes.push(Object.assign({}, axisStyle, { scale: sc, side: seen.size === 1 ? 3 : 1, size: 52, label: d.axis || '', labelSize: 18,
        grid: seen.size === 1 ? axisStyle.grid : { show: false } }));
    });
    const series = [{}].concat(defs.map(d => ({
      label: d.label, stroke: css(d.color), width: 1.5, scale: d.scale || 'y', spanGaps: true,
      points: { show: d.points || false, size: 4 }, paths: d.step ? uPlot.paths.stepped({ align: 1 }) : undefined,
      value: (u, v) => v == null ? '—' : v.toFixed(d.dp ?? 2),
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
    const al = await QW.getAlerts();
    $('#alerts').innerHTML = al.length ? al.slice(0, 200).map(a =>
      `<li><span class="mag">${a.kind === 'quake' ? '⚑' : '◆'}</span><span><b>${a.title}</b><br><span class="small">${a.body || ''}</span></span><span class="when">${fmtT(a.t)}</span></li>`).join('')
      : '<li class="empty">No alerts yet.</li>';
  }

  // ---------- Settings & history ----------
  async function renderSettings() {
    const st = await QW.settings();
    $('#s-notify').checked = st.notify && 'Notification' in self && Notification.permission === 'granted';
    $('#s-radius').value = st.radiusKm; $('#s-minmag').value = st.minMag;
    $('#s-thresh').value = st.anomalyThreshold; $('#s-station').value = st.magStation;
    const rows = await QW.allSamples();
    const first = rows.reduce((m, r) => Math.min(m, r.t), Infinity);
    $('#db-stats').textContent = rows.length
      ? `${rows.length.toLocaleString()} samples logged since ${fmtT(first)}.` : 'No history yet.';
    $('#bg-status').textContent = await bgStatus();
  }
  async function saveSetting(k, v) { const s = await QW.getMeta('settings', {}); s[k] = v; await QW.setMeta('settings', s); }
  $('#s-radius').onchange = e => saveSetting('radiusKm', +e.target.value).then(() => refresh());
  $('#s-minmag').onchange = e => saveSetting('minMag', +e.target.value);
  $('#s-thresh').onchange = e => saveSetting('anomalyThreshold', +e.target.value).then(() => renderStatus());
  $('#s-station').onchange = e => saveSetting('magStation', e.target.value).then(() => QW.setMeta('geo.last', 0)).then(() => refresh());
  $('#s-notify').onchange = async e => {
    if (e.target.checked) {
      if (!('Notification' in self)) { toast('This browser does not support notifications. On iPhone, add to Home Screen first.'); e.target.checked = false; return; }
      const p = await Notification.requestPermission();
      if (p !== 'granted') { toast('Notification permission denied.'); e.target.checked = false; return; }
      await registerPeriodic();
    }
    await saveSetting('notify', e.target.checked);
    $('#bg-status').textContent = await bgStatus();
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
    const backup = { app: 'quake-watch', v: 1, samples: await QW.allSamples(), quakes: await QW.getQuakes(), alerts: await QW.getAlerts() };
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
    return 'This browser only collects while the app is open. Keep it open (or in a tab) for continuous logging.';
  }
  async function notify(alerts) {
    const st = await QW.settings();
    if (!st.notify || !('Notification' in self) || Notification.permission !== 'granted') return;
    for (const a of alerts) {
      if (swReg) swReg.active?.postMessage({ type: 'notify', alert: a });
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
      await renderStatus(r.analysis);
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
    await renderStatus(); await renderCharts();
    await refresh();
    setInterval(refresh, POLL_MS);
    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState === 'visible' && Date.now() - await QW.getMeta('lastCollect', 0) > POLL_MS) refresh();
    });
  })();
})();
