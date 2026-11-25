/* Background collector: runs the same js/core.js the app uses, in Node, with an in-memory
 * IndexedDB restored from / saved to a state file. Sends each alert to an ntfy topic.
 *
 * env: NTFY_TOPIC (required to send), NTFY_SERVER (default https://ntfy.sh),
 *      STATE_FILE (default ./state/state.json.gz), QW_SETTINGS (optional JSON overrides),
 *      DRY_RUN=1 (print instead of sending)
 */
import 'fake-indexeddb/auto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const STATE = resolve(process.env.STATE_FILE || `${here}/state/state.json.gz`);
const SERVER = (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '');
const TOPIC = process.env.NTFY_TOPIC;
const DRY = process.env.DRY_RUN === '1';
const APP_URL = process.env.APP_URL || '';
const KEEP_MS = 10 * 864e5; // keep 10 days of raw samples (index needs 7-day baselines)
const KEEP_LONG = { idx: 400 * 864e5, storm: 400 * 864e5 }; // the self-tuner replays these
const CALIBRATION = resolve(process.env.CALIBRATION_FILE || `${here}/../calibration.json`);

globalThis.self = globalThis;
vm.runInThisContext(await readFile(`${here}/../js/core.js`, 'utf8'), { filename: 'core.js' });
const QW = globalThis.QW;

// ---------- state in/out ----------
function storeAll(name) {
  return QW.db().then(d => new Promise((res, rej) => {
    const t = d.transaction(name, 'readonly'), st = t.objectStore(name), out = [];
    const c = st.openCursor();
    c.onsuccess = () => { const cur = c.result; if (!cur) return res(out); out.push([cur.key, cur.value]); cur.continue(); };
    c.onerror = () => rej(c.error);
  }));
}
function putRaw(name, rows, withKey) {
  return QW.db().then(d => new Promise((res, rej) => {
    const t = d.transaction(name, 'readwrite'), st = t.objectStore(name);
    for (const [k, v] of rows) withKey ? st.put(v, k) : st.put(v);
    t.oncomplete = res; t.onerror = () => rej(t.error);
  }));
}
async function load() {
  let s;
  try { s = JSON.parse(gunzipSync(await readFile(STATE)).toString()); }
  catch { console.log('No saved state; starting fresh.'); return; }
  await putRaw('samples', s.samples.map(([se, t, v]) => [null, { s: se, t, v }]));
  await putRaw('quakes', s.quakes.map(q => [null, q]));
  await putRaw('alerts', s.alerts.map(a => [null, a]));
  await putRaw('forecasts', s.forecasts.map(f => [null, f]));
  await putRaw('meta', s.meta, true);
  console.log(`Restored ${s.samples.length} samples, ${s.forecasts.length} forecasts.`);
}
async function save() {
  const cut = Date.now() - KEEP_MS;
  const samples = (await storeAll('samples')).map(([, r]) => r).filter(r => r.t >= (KEEP_LONG[r.s] ? Date.now() - KEEP_LONG[r.s] : cut)).map(r => [r.s, r.t, r.v]);
  const quakes = (await storeAll('quakes')).map(([, q]) => q).filter(q => q.t >= Date.now() - 60 * 864e5);
  const alerts = (await storeAll('alerts')).map(([, a]) => a).sort((x, y) => y.t - x.t).slice(0, 300);
  const forecasts = (await storeAll('forecasts')).map(([, f]) => f);
  const meta = await storeAll('meta');
  await mkdir(dirname(STATE), { recursive: true });
  await writeFile(STATE, gzipSync(JSON.stringify({ v: 1, saved: Date.now(), samples, quakes, alerts, forecasts, meta })));
  console.log(`Saved ${samples.length} samples.`);
}

// ---------- ntfy ----------
const STYLE = {
  forecast:    { priority: 'high',    tags: 'crystal_ball' },
  coincidence: { priority: 'high',    tags: 'sunny,warning' },
  anomaly:     { priority: 'default', tags: 'zap' },
  quake:       { priority: 'high',    tags: 'rotating_light' },
  verify:      { priority: 'default', tags: 'white_check_mark' },
};
async function send(a) {
  const st = STYLE[a.kind] || { priority: 'default', tags: 'bell' };
  if (DRY || !TOPIC) { console.log(`[${DRY ? 'dry-run' : 'no NTFY_TOPIC'}] ${a.title} — ${a.body}`); return; }
  const headers = { Title: a.title, Priority: st.priority, Tags: st.tags };
  if (APP_URL) headers.Click = APP_URL;
  const r = await fetch(`${SERVER}/${encodeURIComponent(TOPIC)}`, { method: 'POST', body: a.body || a.title, headers });
  if (!r.ok) throw new Error(`ntfy ${r.status}: ${await r.text()}`);
}

// ---------- run ----------
await load();
if (process.env.QW_SETTINGS) {
  const cur = await QW.getMeta('settings', {});
  await QW.setMeta('settings', Object.assign(cur, JSON.parse(process.env.QW_SETTINGS)));
}
if (process.argv.includes('--test')) {
  await send({ kind: 'verify', title: 'Quake Watch test', body: 'Background alerts are connected.' });
} else {
  const r = await QW.collect();
  if (r.errors.length) console.warn('Source errors:', r.errors.join('; '));
  const a = r.analysis;
  console.log(`Level ${a.level}, index ${a.index == null ? '—' : a.index.toFixed(2)}, solar: ${a.solarWhy.join(', ') || 'normal'}, quakes 3d: ${a.q3}`);
  for (const al of r.alerts) await send(al);
  console.log(`${r.alerts.length} alert(s).`);
  // Re-tune once a day and publish the result for the phone app (the workflow commits it if it changed).
  const cal = await QW.getMeta('calibration');
  if (!cal || Date.now() - cal.t > 864e5 || process.argv.includes('--calibrate')) {
    try {
      const c = await QW.calibrate();
      console.log(`Calibration: ${c.status} — ${c.note}`);
      await writeFile(CALIBRATION, JSON.stringify(c, null, 1) + '\n');
    } catch (err) { console.warn('Calibration failed:', err.message); }
  }
}
await save();
