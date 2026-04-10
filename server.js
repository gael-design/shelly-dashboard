'use strict';

const express    = require('express');
const http       = require('http');
const httpClient = require('http');
const WebSocket  = require('ws');
const fs         = require('fs');
const path       = require('path');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

const PORT          = process.env.PORT      || 3000;
const SHELLY_IP     = process.env.SHELLY_IP || '10.0.0.22';
const POLL_INTERVAL = 2000;
const STORE_EVERY   = 10000;
const DATA_DIR      = process.env.SHELLY_DATA_DIR || __dirname;
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
const DATA_FILE     = path.join(DATA_DIR, 'readings.json');
const DB_FILE       = path.join(DATA_DIR, 'readings.db');
const CFG_FILE      = path.join(DATA_DIR, 'settings.json');
const KEEP_DAYS     = 365;
const KEEP_MS       = KEEP_DAYS * 86400000;

// ─── Storage abstraction (SQLite preferred, JSON fallback) ──────────────────

let Database;
try { Database = require('better-sqlite3'); } catch (_) { Database = null; }

const store = Database ? createSQLiteStore() : createJSONStore();

function createSQLiteStore() {
  const db = new Database(DB_FILE);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  db.exec(`CREATE TABLE IF NOT EXISTS readings (
    ts      INTEGER PRIMARY KEY,
    c0w     REAL DEFAULT 0, c0v  REAL DEFAULT 0, c0a  REAL DEFAULT 0, c0pf REAL DEFAULT 0,
    c1w     REAL DEFAULT 0, c1v  REAL DEFAULT 0, c1a  REAL DEFAULT 0, c1pf REAL DEFAULT 0,
    tw      REAL DEFAULT 0,
    eImp    REAL,
    eExp    REAL
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ts ON readings(ts)`);

  const stmts = {
    insert:     db.prepare('INSERT OR REPLACE INTO readings (ts,c0w,c0v,c0a,c0pf,c1w,c1v,c1a,c1pf,tw,eImp,eExp) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'),
    prune:      db.prepare('DELETE FROM readings WHERE ts < ?'),
    count:      db.prepare('SELECT COUNT(*) as n FROM readings'),
    cntFirst:   db.prepare('SELECT eImp, eExp FROM readings WHERE ts >= ? AND eImp IS NOT NULL ORDER BY ts ASC  LIMIT 1'),
    cntLast:    db.prepare('SELECT eImp, eExp FROM readings WHERE ts >= ? AND eImp IS NOT NULL ORDER BY ts DESC LIMIT 1'),
    integRows:  db.prepare('SELECT ts, tw FROM readings WHERE ts >= ? ORDER BY ts'),
    dayStats:   db.prepare('SELECT MIN(tw) as min, MAX(tw) as max, AVG(tw) as avg, COUNT(*) as n FROM readings WHERE ts >= ?'),
    histRows:   db.prepare('SELECT ts, tw, c0w, c1w FROM readings WHERE ts >= ? ORDER BY ts'),
  };

  // Migrate from JSON if DB is empty
  const n = stmts.count.get().n;
  if (n === 0 && fs.existsSync(DATA_FILE)) {
    try {
      const old = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (Array.isArray(old) && old.length > 0) {
        const ins = db.transaction((rows) => {
          for (const r of rows) {
            stmts.insert.run(
              r.ts, r.c0w||0, r.c0v||0, r.c0a||0, r.c0pf||0,
              r.c1w||0, r.c1v||0, r.c1a||0, r.c1pf||0,
              r.tw||0, r.eImp ?? null, r.eExp ?? null
            );
          }
        });
        ins(old);
        console.log(`  Migration JSON -> SQLite: ${old.length} points`);
      }
    } catch (_) {}
  }

  console.log(`  Storage: SQLite (${DB_FILE}, ${KEEP_DAYS} jours, ${stmts.count.get().n} points)`);

  return {
    type: 'sqlite',
    add(row) {
      stmts.insert.run(
        row.ts, row.c0w, row.c0v, row.c0a, row.c0pf,
        row.c1w, row.c1v, row.c1a, row.c1pf,
        row.tw, row.eImp ?? null, row.eExp ?? null
      );
    },
    prune() {
      stmts.prune.run(Date.now() - KEEP_MS);
    },
    save() { /* WAL handles it */ },
    close() { db.close(); },
    count() { return stmts.count.get().n; },

    // Stats helpers — run in DB for efficiency
    counterImpExp(fromTs) {
      const first = stmts.cntFirst.get(fromTs);
      const last  = stmts.cntLast.get(fromTs);
      if (!first || !last || first.eImp === last.eImp && first.eExp === last.eExp) return null;
      return {
        imp: Math.max(0, last.eImp - first.eImp) / 1000,
        exp: Math.max(0, (last.eExp || 0) - (first.eExp || 0)) / 1000,
      };
    },
    integrateImpExp(fromTs) {
      const rows = stmts.integRows.all(fromTs);
      let imp = 0, exp = 0;
      for (let i = 1; i < rows.length; i++) {
        const dtH = (rows[i].ts - rows[i - 1].ts) / 3600000;
        const p = rows[i - 1].tw;
        if (p >= 0) imp += p * dtH;
        else        exp += -p * dtH;
      }
      return { imp: imp / 1000, exp: exp / 1000 };
    },
    impExp(fromTs) {
      return this.counterImpExp(fromTs) || this.integrateImpExp(fromTs);
    },
    dayStats(fromTs) {
      return stmts.dayStats.get(fromTs);
    },
    historyRows(fromTs) {
      return stmts.histRows.all(fromTs);
    },
  };
}

function createJSONStore() {
  let readings = [];

  // Load existing
  try {
    if (fs.existsSync(DATA_FILE)) {
      readings = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (_) { readings = []; }

  console.log(`  Storage: JSON (${DATA_FILE}, ${Math.round(KEEP_MS/86400000)} jours, ${readings.length} points)`);

  return {
    type: 'json',
    add(row) { readings.push(row); },
    prune() {
      const cutoff = Date.now() - KEEP_MS;
      readings = readings.filter(r => r.ts >= cutoff);
    },
    save() {
      try { fs.writeFileSync(DATA_FILE, JSON.stringify(readings)); } catch (_) {}
    },
    close() { this.save(); },
    count() { return readings.length; },

    counterImpExp(fromTs) {
      const rows = readings
        .filter(r => r.ts >= fromTs && typeof r.eImp === 'number')
        .sort((a, b) => a.ts - b.ts);
      if (rows.length < 2) return null;
      const first = rows[0], last = rows[rows.length - 1];
      return {
        imp: Math.max(0, last.eImp - first.eImp) / 1000,
        exp: Math.max(0, (last.eExp || 0) - (first.eExp || 0)) / 1000,
      };
    },
    integrateImpExp(fromTs) {
      const rows = readings.filter(r => r.ts >= fromTs).sort((a, b) => a.ts - b.ts);
      let imp = 0, exp = 0;
      for (let i = 1; i < rows.length; i++) {
        const dtH = (rows[i].ts - rows[i - 1].ts) / 3600000;
        const p = rows[i - 1].tw;
        if (p >= 0) imp += p * dtH;
        else        exp += -p * dtH;
      }
      return { imp: imp / 1000, exp: exp / 1000 };
    },
    impExp(fromTs) {
      return this.counterImpExp(fromTs) || this.integrateImpExp(fromTs);
    },
    dayStats(fromTs) {
      const powers = readings.filter(r => r.ts >= fromTs).map(r => r.tw);
      if (!powers.length) return { min: 0, max: 0, avg: 0, n: 0 };
      return {
        min: Math.min(...powers),
        max: Math.max(...powers),
        avg: powers.reduce((s, v) => s + v, 0) / powers.length,
        n: powers.length,
      };
    },
    historyRows(fromTs) {
      return readings.filter(r => r.ts >= fromTs).sort((a, b) => a.ts - b.ts);
    },
  };
}

// Periodic prune + save (JSON only writes to disk, SQLite WAL auto-flushes)
setInterval(() => { store.prune(); store.save(); }, 60000);
process.on('SIGINT',  () => { store.save(); store.close && store.close(); process.exit(0); });
process.on('SIGTERM', () => { store.save(); store.close && store.close(); process.exit(0); });

// ─── Settings ────────────────────────────────────────────────────────────────

let settings = { alert_threshold: 5000 };
function loadSettings() {
  try {
    if (fs.existsSync(CFG_FILE))
      settings = { ...settings, ...JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')) };
  } catch (_) {}
}
function saveSettings() {
  try { fs.writeFileSync(CFG_FILE, JSON.stringify(settings, null, 2)); } catch (_) {}
}

// ─── Shelly HTTP helper ──────────────────────────────────────────────────────

function shellyGet(urlPath) {
  return new Promise((resolve, reject) => {
    const req = httpClient.get(
      { hostname: SHELLY_IP, path: urlPath, port: 80, headers: { 'Accept': 'application/json' } },
      (res) => {
        let raw = '';
        res.on('data', chunk => { raw += chunk; });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            return reject(new Error(`HTTP ${res.statusCode} (${urlPath})`));
          }
          try {
            const cleaned = raw.replace(/:\s*(-?NaN|-?Infinity)\b/g, ': null');
            resolve(JSON.parse(cleaned));
          } catch (e) {
            const preview = raw.slice(0, 90).replace(/\s+/g, ' ').trim();
            reject(new Error(`JSON invalide (${urlPath}) HTTP ${res.statusCode}: ${preview || '(vide)'}`));
          }
        });
      }
    );
    req.setTimeout(3000, () => { req.destroy(); reject(new Error('Timeout reseau')); });
    req.on('error', (e) => reject(new Error(`Connexion: ${e.code || e.message}`)));
  });
}

// ─── Fetch + normalise (Shelly EM Gen3 2-channel / EM3 / Gen1) ──────────────

let deviceInfoCache = null;
async function getDeviceInfo() {
  if (deviceInfoCache) return deviceInfoCache;
  try {
    const info = await shellyGet('/rpc/Shelly.GetDeviceInfo');
    deviceInfoCache = {
      model: info.model || null,
      gen:   info.gen   || null,
      fw:    info.ver   || null,
      mac:   info.mac   || null,
      id:    info.id    || null,
    };
  } catch (_) {}
  return deviceInfoCache;
}

async function fetchShellyData() {
  // ── Primary: Shelly EM Gen3 via Shelly.GetStatus (single aggregated call)
  try {
    const s = await shellyGet('/rpc/Shelly.GetStatus');
    const c0 = s && s['em1:0'];
    if (c0 && typeof c0.act_power === 'number') {
      const c1 = s['em1:1'];
      const d0 = s['em1data:0'];
      const d1 = s['em1data:1'];
      const sw0 = s['switch:0'];

      const channels = {
        '0': {
          w: c0.act_power, v: c0.voltage, a: c0.current,
          pf: c0.pf, va: c0.aprt_power,
        },
      };
      if (c1 && typeof c1.act_power === 'number') {
        channels['1'] = {
          w: c1.act_power, v: c1.voltage, a: c1.current,
          pf: c1.pf, va: c1.aprt_power,
        };
      }
      const total_w = (c0.act_power || 0) + (c1?.act_power || 0);
      const total_a = (c0.current   || 0) + (c1?.current   || 0);

      const dev = await getDeviceInfo();
      return {
        type: 'em1-gen3',
        channels,
        total_w,
        total_a,
        freq: c0.freq ?? null,
        energy_wh: {
          '0':       d0?.total_act_energy,
          '1':       d1?.total_act_energy,
          total_imp: (d0?.total_act_energy     || 0) + (d1?.total_act_energy     || 0),
          total_exp: (d0?.total_act_ret_energy || 0) + (d1?.total_act_ret_energy || 0),
        },
        device: {
          temp_c:       sw0?.temperature?.tC ?? null,
          wifi_rssi:    s.wifi?.rssi  ?? null,
          wifi_ssid:    s.wifi?.ssid  ?? null,
          wifi_ip:      s.wifi?.sta_ip ?? null,
          uptime_s:     s.sys?.uptime ?? null,
          cloud:        !!s.cloud?.connected,
          fw_current:   dev?.fw || null,
          fw_available: s.sys?.available_updates?.stable?.version ?? null,
          restart_req:  !!s.sys?.restart_required,
          model:        dev?.model || null,
        },
      };
    }
  } catch (_) { /* try next */ }

  // ── Fallback: Gen2 Pro 3EM (3-phase EM component)
  try {
    const em     = await shellyGet('/rpc/EM.GetStatus?id=0');
    const emData = await shellyGet('/rpc/EMData.GetStatus?id=0').catch(() => null);
    if (typeof em.a_act_power === 'number') {
      return {
        type: 'em3-gen2',
        channels: {
          '0': { w: em.a_act_power, v: em.a_voltage, a: em.a_current, pf: em.a_pf, va: em.a_aprt_power },
          '1': { w: em.b_act_power, v: em.b_voltage, a: em.b_current, pf: em.b_pf, va: em.b_aprt_power },
          '2': { w: em.c_act_power, v: em.c_voltage, a: em.c_current, pf: em.c_pf, va: em.c_aprt_power },
        },
        total_w: em.total_act_power,
        total_a: em.total_current,
        energy_wh: {
          '0': emData?.a_total_act_energy,
          '1': emData?.b_total_act_energy,
          '2': emData?.c_total_act_energy,
          total: emData?.total_act,
        },
      };
    }
  } catch (_) { /* try next */ }

  // ── Fallback: Gen1 Shelly EM / EM3 (/status endpoint)
  const st = await shellyGet('/status');
  if (!Array.isArray(st.emeters) || st.emeters.length < 1)
    throw new Error('Format Shelly inconnu — verifier l\'IP et que le device est un EM');

  const channels = {};
  st.emeters.forEach((em, i) => {
    channels[String(i)] = {
      w: em.power, v: em.voltage, a: em.current, pf: em.pf,
      va: (em.voltage || 0) * (em.current || 0),
    };
  });
  return {
    type: 'em-gen1',
    channels,
    total_w: st.total_power ?? st.emeters.reduce((s, e) => s + (e.power || 0), 0),
    total_a: st.emeters.reduce((s, e) => s + (e.current || 0), 0),
    energy_wh: {
      total: st.emeters.reduce((s, e) => s + (e.total || 0), 0),
    },
  };
}

// ─── Polling loop ────────────────────────────────────────────────────────────

let lastData    = null;
let lastStore   = 0;
let detectedLog = false;

async function poll() {
  try {
    const raw = await fetchShellyData();
    const now = Date.now();

    if (!detectedLog) {
      console.log(`  Device detecte: ${raw.type} (${Object.keys(raw.channels).length} voie(s))`);
      detectedLog = true;
    }

    const payload = { ts: now, ok: true, ...raw };

    if (now - lastStore >= STORE_EVERY) {
      const c0 = raw.channels['0'] || {};
      const c1 = raw.channels['1'] || {};
      const row = {
        ts: now,
        c0w: c0.w || 0, c0v: c0.v || 0, c0a: c0.a || 0, c0pf: c0.pf || 0,
        c1w: c1.w || 0, c1v: c1.v || 0, c1a: c1.a || 0, c1pf: c1.pf || 0,
        tw: raw.total_w || 0,
      };
      if (raw.energy_wh && typeof raw.energy_wh.total_imp === 'number') {
        row.eImp = raw.energy_wh.total_imp;
        row.eExp = raw.energy_wh.total_exp || 0;
      }
      store.add(row);
      lastStore = now;
    }

    lastData = payload;
    broadcast({ type: 'live', data: payload });
  } catch (err) {
    broadcast({ type: 'error', msg: err.message });
  }
}

setInterval(poll, POLL_INTERVAL);
poll();

// ─── REST API ────────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public'), {
  etag: false, lastModified: false,
  setHeaders: (res) => { res.set('Cache-Control', 'no-store'); },
}));
app.use(express.json());

app.get('/api/stats', (_req, res) => {
  const midnight   = new Date(); midnight.setHours(0, 0, 0, 0);
  const weekStart  = new Date(midnight); weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  const monthStart = new Date(midnight); monthStart.setDate(1);

  const todayIE = store.impExp(midnight.getTime());
  const weekIE  = store.impExp(weekStart.getTime());
  const monthIE = store.impExp(monthStart.getTime());

  const ds = store.dayStats(midnight.getTime());

  res.json({
    kwh_today:     +(todayIE.imp - todayIE.exp).toFixed(3),
    kwh_week:      +(weekIE.imp  - weekIE.exp).toFixed(3),
    kwh_month:     +(monthIE.imp - monthIE.exp).toFixed(3),
    kwh_imp_today: +todayIE.imp.toFixed(3),
    kwh_exp_today: +todayIE.exp.toFixed(3),
    kwh_imp_week:  +weekIE.imp.toFixed(3),
    kwh_imp_month: +monthIE.imp.toFixed(3),
    kwh_exp_week:  +weekIE.exp.toFixed(3),
    kwh_exp_month: +monthIE.exp.toFixed(3),
    today_min:     +(ds.min || 0).toFixed(0),
    today_max:     +(ds.max || 0).toFixed(0),
    today_avg:     +(ds.avg || 0).toFixed(0),
  });
});

app.get('/api/history', (_req, res) => {
  const since = Date.now() - 86400000;
  const rows  = store.historyRows(since);

  const buckets = {};
  for (const r of rows) {
    const key = Math.floor(r.ts / 60000) * 60000;
    if (!buckets[key]) buckets[key] = { total: [], c0: [], c1: [] };
    buckets[key].total.push(r.tw);
    buckets[key].c0.push(r.c0w);
    buckets[key].c1.push(r.c1w);
  }
  const avg = arr => arr.reduce((s, v) => s + v, 0) / arr.length;
  const out = Object.entries(buckets)
    .sort(([a], [b]) => a - b)
    .map(([minute, g]) => ({
      minute: +minute,
      total: +avg(g.total).toFixed(0),
      c0:    +avg(g.c0).toFixed(0),
      c1:    +avg(g.c1).toFixed(0),
    }));
  res.json(out);
});

app.get('/api/settings', (_req, res) => res.json(settings));

app.post('/api/settings', (req, res) => {
  const { alert_threshold } = req.body;
  if (typeof alert_threshold === 'number' && alert_threshold > 0) {
    settings.alert_threshold = alert_threshold;
    saveSettings();
  }
  res.json({ ok: true });
});

// ─── WebSocket ───────────────────────────────────────────────────────────────

function broadcast(msg) {
  const str = JSON.stringify(msg);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(str); });
}
wss.on('connection', ws => {
  if (lastData) ws.send(JSON.stringify({ type: 'live', data: lastData }));
});

// ─── Init ────────────────────────────────────────────────────────────────────

loadSettings();

const ready = new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(PORT, () => {
    server.removeListener('error', reject);
    console.log(`\n  Compteur Electrique -> http://localhost:${PORT}`);
    console.log(`  Shelly EM            -> http://${SHELLY_IP}`);
    console.log(`  Donnees              -> ${store.type === 'sqlite' ? DB_FILE : DATA_FILE}\n`);
    resolve();
  });
});
ready.catch(() => {});

function saveReadings() { store.save(); }
module.exports = { ready, saveReadings, port: PORT };
