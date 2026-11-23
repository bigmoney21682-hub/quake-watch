/* Quake Watch core: data sources, storage, anomaly analysis.
 * Plain script (no modules) so it loads in both the page and the service worker
 * via <script> / importScripts. Everything hangs off self.QW. */
(function (G) {
  'use strict';
  const QW = (G.QW = G.QW || {});

  // ---------- Config ----------
  QW.FL = { lat: 27.8, lon: -81.7, bbox: { w: -87.7, e: -79.8, s: 24.4, n: 31.1 } };
  QW.DEFAULTS = {
    radiusKm: 800,          // earthquake watch radius around central Florida
    minMag: 2.5,            // notify on quakes at/above this magnitude
    anomalyThreshold: 3,    // composite robust z-score that raises an "Elevated" alert
    notify: true,
    magStation: 'BSL',      // Stennis Space Center, MS — closest USGS observatory to Florida
  };
  const SWPC = 'https://services.swpc.noaa.gov';
  const DAY = 864e5, HOUR = 36e5, MIN = 6e4;
  QW.DAY = DAY; QW.HOUR = HOUR; QW.MIN = MIN;

  // Series catalogue: id -> label/unit/group. "local" series feed the anomaly index.
  QW.SERIES = {
    'tell.E':   { label: 'Telluric |E| (FL mean)', unit: 'mV/km', group: 'telluric', local: true },
    'tell.Ex':  { label: 'Telluric Ex (north)', unit: 'mV/km', group: 'telluric' },
    'tell.Ey':  { label: 'Telluric Ey (east)', unit: 'mV/km', group: 'telluric' },
    'geo.H':    { label: 'Horizontal field H', unit: 'nT', group: 'magnetic' },
    'geo.Z':    { label: 'Vertical field Z', unit: 'nT', group: 'magnetic' },
    'iono.TEC': { label: 'Ionospheric TEC (FL mean)', unit: 'TECU', group: 'ionosphere' },
    'iono.dTEC':{ label: 'TEC anomaly vs. baseline', unit: 'TECU', group: 'ionosphere', local: true },
    'idx':      { label: 'Precursor index (RMS |z|)', unit: '', group: 'index' },
    'sw.Kp':    { label: 'Planetary Kp', unit: '', group: 'space' },
    'sw.Dst':   { label: 'Dst ring current', unit: 'nT', group: 'space' },
    'sw.speed': { label: 'Solar wind speed', unit: 'km/s', group: 'space' },
    'sw.Bz':    { label: 'IMF Bz (GSM)', unit: 'nT', group: 'space' },
  };

  // ---------- IndexedDB ----------
  let dbp;
  QW.db = function () {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open('quake-watch', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('samples', { keyPath: ['s', 't'] });
        d.createObjectStore('quakes', { keyPath: 'id' }).createIndex('t', 't');
        d.createObjectStore('alerts', { keyPath: 'id', autoIncrement: true }).createIndex('t', 't');
        d.createObjectStore('meta');
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  };
  function tx(store, mode, fn) {
    return QW.db().then(d => new Promise((res, rej) => {
      const t = d.transaction(store, mode);
      const out = fn(t.objectStore(store));
      t.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
      t.onerror = () => rej(t.error);
    }));
  }
  QW.putSamples = (s, pts) => pts.length ? tx('samples', 'readwrite', st => {
    for (const [t, v] of pts) if (Number.isFinite(t) && Number.isFinite(v)) st.put({ s, t, v });
  }) : Promise.resolve();
  QW.getSeries = (s, from = 0, to = Date.now() + DAY) => tx('samples', 'readonly', st =>
    st.getAll(IDBKeyRange.bound([s, from], [s, to]))).then(rows => rows.map(r => [r.t, r.v]));
  QW.allSamples = () => tx('samples', 'readonly', st => st.getAll());
  QW.getMeta = (k, dflt) => tx('meta', 'readonly', st => st.get(k)).then(v => v === undefined ? dflt : v);
  QW.setMeta = (k, v) => tx('meta', 'readwrite', st => st.put(v, k));
  QW.settings = () => QW.getMeta('settings', {}).then(s => Object.assign({}, QW.DEFAULTS, s));
  QW.putQuakes = qs => tx('quakes', 'readwrite', st => qs.forEach(q => st.put(q)));
  QW.getQuakes = () => tx('quakes', 'readonly', st => st.getAll()).then(a => a.sort((x, y) => y.t - x.t));
  QW.addAlert = a => tx('alerts', 'readwrite', st => st.add(Object.assign({ t: Date.now() }, a)));
  QW.getAlerts = () => tx('alerts', 'readonly', st => st.getAll()).then(a => a.sort((x, y) => y.t - x.t));
  QW.clearAll = async () => {
    await Promise.all(['samples', 'quakes', 'alerts'].map(s => tx(s, 'readwrite', st => st.clear())));
    for (const k of ['geo.last', 'iono.last', 'initialized', 'lastLevel', 'lastCollect']) await tx('meta', 'readwrite', st => st.delete(k));
  };

  // ---------- Fetch helpers ----------
  async function getJSON(url) {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status + ' ' + url);
    return r.json();
  }
  const ts = s => Date.parse(/Z$|[+-]\d\d:?\d\d$/.test(s) ? s : s + 'Z');
  const inFL = ([lon, lat]) => { const b = QW.FL.bbox; return lon >= b.w && lon <= b.e && lat >= b.s && lat <= b.n; };
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;

  // ---------- Sources ----------
  // 1. Telluric: NOAA SWPC modeled geoelectric field (1-min), averaged over Florida grid points.
  async function efieldFile(name) {
    const d = await getJSON(`${SWPC}/json/lists/rgeojson/US-Canada-1D/${name}`);
    const pts = d.features.filter(f => inFL(f.geometry.coordinates)).map(f => f.properties);
    if (!pts.length) return null;
    // time_tag in these files is date-only; the filename carries the full timestamp.
    const m = name.match(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)/);
    const t = m ? Date.UTC(m[1], m[2] - 1, m[3], m[4], m[5], m[6]) : ts(d.time_tag);
    const Ex = mean(pts.map(p => p.Ex)), Ey = mean(pts.map(p => p.Ey));
    const E = mean(pts.map(p => Math.hypot(p.Ex, p.Ey)));
    return { t, E, Ex, Ey };
  }
  async function efieldList() {
    const html = await (await fetch(`${SWPC}/json/lists/rgeojson/US-Canada-1D/`, { cache: 'no-store' })).text();
    return [...new Set(html.match(/\d{8}T\d{6}-\d+-Efield-US-Canada\.json/g) || [])].sort();
  }
  async function storeE(r) {
    if (!r) return;
    await QW.putSamples('tell.E', [[r.t, r.E]]);
    await QW.putSamples('tell.Ex', [[r.t, r.Ex]]);
    await QW.putSamples('tell.Ey', [[r.t, r.Ey]]);
  }
  QW.fetchTelluric = async () => { const l = await efieldList(); await storeE(await efieldFile(l[l.length - 1])); };

  // 2. Geomagnetic: USGS observatory 1-min H and Z (Stennis, MS by default).
  QW.fetchGeomag = async (station, hours = 6) => {
    const end = new Date(), start = new Date(end - hours * HOUR);
    const iso = d => d.toISOString().slice(0, 19) + 'Z';
    const d = await getJSON(`https://geomag.usgs.gov/ws/data/?id=${station}&elements=H,Z&sampling_period=60&format=json&starttime=${iso(start)}&endtime=${iso(end)}`);
    const times = d.times.map(ts);
    for (const el of d.values) {
      const pts = [];
      el.values.forEach((v, i) => v != null && pts.push([times[i], v]));
      await QW.putSamples('geo.' + el.id, pts);
    }
  };

  // 3. Ionosphere: NOAA GloTEC total electron content + anomaly, averaged over Florida.
  async function glotecFile(url) {
    const d = await getJSON(SWPC + url);
    const pts = d.features.filter(f => inFL(f.geometry.coordinates)).map(f => f.properties);
    if (!pts.length) return;
    const t = ts(d.time_tag);
    await QW.putSamples('iono.TEC', [[t, mean(pts.map(p => p.tec))]]);
    await QW.putSamples('iono.dTEC', [[t, mean(pts.map(p => p.anomaly))]]);
  }
  QW.fetchIono = async () => {
    const l = await getJSON(`${SWPC}/products/glotec/geojson_2d_urt.json`);
    const last = l[l.length - 1];
    if (await QW.getMeta('iono.last') === last.url) return;
    await glotecFile(last.url);
    await QW.setMeta('iono.last', last.url);
  };

  // 4. Space-weather context: separates sun-driven disturbances from local ones.
  QW.fetchSpace = async () => {
    const [kp, dst, wind, mag] = await Promise.allSettled([
      getJSON(`${SWPC}/products/noaa-planetary-k-index.json`),
      getJSON(`${SWPC}/products/kyoto-dst.json`),
      getJSON(`${SWPC}/json/rtsw/rtsw_wind_1m.json`),
      getJSON(`${SWPC}/json/rtsw/rtsw_mag_1m.json`),
    ]);
    if (kp.value) await QW.putSamples('sw.Kp', kp.value.map(r => [ts(r.time_tag), +r.Kp]));
    if (dst.value) await QW.putSamples('sw.Dst', dst.value.map(r => [ts(r.time_tag), +r.dst]));
    if (wind.value) await QW.putSamples('sw.speed', wind.value.filter(r => r.active).map(r => [ts(r.time_tag), r.proton_speed]));
    if (mag.value) await QW.putSamples('sw.Bz', mag.value.filter(r => r.active).map(r => [ts(r.time_tag), r.bz_gsm]));
  };

  // 5. Ground truth: USGS earthquakes within the watch radius (last 30 days).
  QW.fetchQuakes = async (radiusKm) => {
    const start = new Date(Date.now() - 30 * DAY).toISOString().slice(0, 10);
    const d = await getJSON(`https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&latitude=${QW.FL.lat}&longitude=${QW.FL.lon}&maxradiuskm=${radiusKm}&starttime=${start}&minmagnitude=1`);
    const known = new Set((await QW.getQuakes()).map(q => q.id));
    const qs = d.features.map(f => ({
      id: f.id, t: f.properties.time, mag: f.properties.mag, place: f.properties.place,
      url: f.properties.url, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], depth: f.geometry.coordinates[2],
    }));
    await QW.putQuakes(qs);
    return qs.filter(q => !known.has(q.id));
  };

  // One-time / on-demand backfill of the heavy gridded products (≈1–2.5 MB per file).
  QW.backfill = async (onProgress = () => {}) => {
    const l = await getJSON(`${SWPC}/products/glotec/geojson_2d_urt.json`);
    const g = l.filter((x, i) => (l.length - 1 - i) % 6 === 0).slice(-24); // hourly, last 24 h
    const e = (await efieldList()).filter((x, i, a) => (a.length - 1 - i) % 30 === 0).slice(-24); // every 30 min
    const jobs = [...g.map(x => () => glotecFile(x.url)), ...e.map(n => async () => storeE(await efieldFile(n)))];
    for (let i = 0; i < jobs.length; i++) {
      try { await jobs[i](); } catch (err) { console.warn(err); }
      onProgress(i + 1, jobs.length);
    }
  };

  // ---------- Analysis ----------
  const median = a => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  function robustZ(value, baseline) {
    if (baseline.length < 12) return null;
    const m = median(baseline);
    const mad = median(baseline.map(v => Math.abs(v - m))) * 1.4826 || 1e-9;
    return (value - m) / mad;
  }
  // Rolling 60-min std of 1-min first differences (ULF-band activity proxy).
  function ulfStd(pts, endT) {
    const w = pts.filter(p => p[0] > endT - HOUR && p[0] <= endT);
    if (w.length < 30) return null;
    const d = w.slice(1).map((p, i) => p[1] - w[i][1]);
    const m = mean(d);
    return Math.sqrt(mean(d.map(x => (x - m) ** 2)));
  }
  // Z/H polarization ratio — the ULF "precursor" metric used by Hayakawa et al.
  QW.polarization = function (H, Z, step = 30 * MIN) {
    if (!H.length) return [];
    const out = [];
    for (let t = H[0][0] + HOUR; t <= H[H.length - 1][0]; t += step) {
      const sh = ulfStd(H, t), sz = ulfStd(Z, t);
      if (sh && sz) out.push([t, sz / sh]);
    }
    return out;
  };

  /* Score every local signal against its own trailing 7-day baseline (excluding the last hour).
   * Returns { scores:{name:{z,value}}, index, storm, level, reason }. */
  QW.analyze = async function () {
    const now = Date.now(), from = now - 8 * DAY;
    const scores = {};
    const scoreSeries = (name, pts, recentWindow = HOUR) => {
      const recent = pts.filter(p => p[0] > now - recentWindow);
      const base = pts.filter(p => p[0] <= now - HOUR).map(p => p[1]);
      if (!recent.length) return;
      const v = recent[recent.length - 1][1];
      scores[name] = { value: v, z: robustZ(v, base), n: base.length };
    };
    scoreSeries('Telluric |E|', await QW.getSeries('tell.E', from), 30 * MIN);
    scoreSeries('TEC anomaly', await QW.getSeries('iono.dTEC', from), 2 * HOUR);
    const [H, Z] = await Promise.all([QW.getSeries('geo.H', from), QW.getSeries('geo.Z', from)]);
    scoreSeries('ULF Z/H ratio', QW.polarization(H, Z), 2 * HOUR);

    const kp = (await QW.getSeries('sw.Kp', now - DAY)).pop();
    const dst = (await QW.getSeries('sw.Dst', now - DAY)).pop();
    const storm = (kp && kp[1] >= 5) || (dst && dst[1] <= -50);

    const zs = Object.values(scores).map(s => s.z).filter(z => z != null).map(Math.abs);
    const index = zs.length ? Math.sqrt(mean(zs.map(z => z * z))) : null; // RMS of |z|
    const st = await QW.settings();
    let level = 'baseline', reason = 'Collecting baseline (needs a few hours of history per signal).';
    if (index != null) {
      if (index >= st.anomalyThreshold) { level = storm ? 'storm' : 'elevated'; }
      else if (index >= st.anomalyThreshold * 0.66) level = storm ? 'storm' : 'watch';
      else level = 'quiet';
      reason = {
        quiet: 'Local signals within normal range.',
        watch: 'Local signals drifting from baseline.',
        elevated: 'Multiple local signals strongly off baseline with quiet space weather.',
        storm: 'Signals disturbed, but a geomagnetic storm is in progress — likely solar-driven, not local.',
      }[level];
    }
    return { scores, index, storm, kp: kp && kp[1], dst: dst && dst[1], level, reason, t: now };
  };

  // ---------- Full collection cycle ----------
  QW.collect = async function ({ full = false } = {}) {
    const st = await QW.settings();
    const lastGeo = await QW.getMeta('geo.last', 0);
    const geoHours = lastGeo ? Math.min(7 * 24, Math.ceil((Date.now() - lastGeo) / HOUR) + 1) : 7 * 24;
    const res = await Promise.allSettled([
      QW.fetchTelluric(),
      QW.fetchGeomag(st.magStation, geoHours).then(() => QW.setMeta('geo.last', Date.now())),
      QW.fetchIono(),
      QW.fetchSpace(),
      QW.fetchQuakes(st.radiusKm),
    ]);
    const names = ['telluric', 'magnetic', 'ionosphere', 'space', 'quakes'];
    const errors = res.map((r, i) => r.status === 'rejected' ? names[i] + ': ' + r.reason.message : null).filter(Boolean);
    const newQuakes = res[4].status === 'fulfilled' ? res[4].value : [];
    const a = await QW.analyze();
    const alerts = [];
    if (a.index != null) await QW.putSamples('idx', [[a.t, a.index]]);

    const firstRun = !(await QW.getMeta('initialized', false));
    await QW.setMeta('initialized', true);
    if (!firstRun) {
      for (const q of newQuakes.filter(q => q.mag >= st.minMag && q.t > Date.now() - 2 * DAY))
        alerts.push({ kind: 'quake', title: `M${q.mag.toFixed(1)} earthquake`, body: q.place, ref: q.id });
    }
    const prev = await QW.getMeta('lastLevel', 'baseline');
    if (a.level === 'elevated' && prev !== 'elevated')
      alerts.push({ kind: 'anomaly', title: 'Precursor index elevated', body: `Index ${a.index.toFixed(2)} — ${a.reason}` });
    await QW.setMeta('lastLevel', a.level);
    for (const al of alerts) await QW.addAlert(al);
    await QW.setMeta('lastCollect', Date.now());
    return { analysis: a, alerts, errors, newQuakes };
  };
})(self);
