const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3210;
const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function ensureDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify({ settings: null, days: {} }, null, 2));
  }
}
function readDb() {
  ensureDb();
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}
function writeDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}
function uid() {
  return Math.random().toString(36).slice(2, 10);
}
function pad(n) { return String(n).padStart(2, '0'); }
function todayISOServer() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
// Persian week order: 0=Saturday ... 6=Friday
function jsDowToPersianIndex(jsDow) {
  return (jsDow + 1) % 7;
}
function computeRecurringApplicable(r, dateStr) {
  if (!r.anchorDate || !r.everyDays || r.everyDays < 1) return false;
  const anchor = new Date(r.anchorDate + 'T00:00:00');
  const target = new Date(dateStr + 'T00:00:00');
  if (target < anchor) return false;
  const diffDays = Math.round((target - anchor) / 86400000);
  return diffDays % r.everyDays === 0;
}

// Builds a brand-new day's item list from settings (template + recurring).
function generateDay(db, dateStr) {
  if (db.days[dateStr]) return db.days[dateStr];
  const items = [];
  if (db.settings) {
    const { fixedWeekdays, template, recurring } = db.settings;
    const dow = jsDowToPersianIndex(new Date(dateStr + 'T00:00:00').getDay());
    if (fixedWeekdays.includes(dow)) {
      (template[dow] || []).forEach(t => {
        items.push({
          id: uid(), text: t.text, done: false, priority: !!t.priority,
          time: t.time || '', tag: t.tag || null, duration: t.duration || null,
          templateId: t.id
        });
      });
    }
    (recurring || []).forEach(r => {
      if (computeRecurringApplicable(r, dateStr)) {
        items.push({
          id: uid(), text: r.text, done: false, priority: !!r.priority,
          time: r.time || '', tag: r.tag || null, duration: r.duration || null,
          recurringId: r.id
        });
      }
    });
  }
  const day = { items, note: '' };
  db.days[dateStr] = day;
  return day;
}

// Syncs already-generated present/future days with the current template &
// recurring rules: adds new rule items, updates edited ones (by stable id,
// keeping `done`/manual edits to unrelated fields intact), and removes items
// whose rule was deleted or no longer applies. Never touches past days.
function reconcile(db) {
  if (!db.settings) return;
  const todayISO = todayISOServer();
  const { fixedWeekdays, template, recurring } = db.settings;

  const validTemplateIds = {};
  Object.keys(template || {}).forEach(dow => {
    validTemplateIds[dow] = new Set((template[dow] || []).map(t => t.id));
  });
  const validRecurringIds = new Set((recurring || []).map(r => r.id));

  Object.keys(db.days).forEach(dateStr => {
    if (dateStr < todayISO) return;
    const day = db.days[dateStr];
    const dow = jsDowToPersianIndex(new Date(dateStr + 'T00:00:00').getDay());

    // Drop items tied to a rule that was deleted / no longer applies to this weekday
    let items = day.items.filter(it => {
      if (it.templateId) {
        if (!fixedWeekdays.includes(dow)) return false;
        if (!validTemplateIds[dow] || !validTemplateIds[dow].has(it.templateId)) return false;
      }
      if (it.recurringId && !validRecurringIds.has(it.recurringId)) return false;
      return true;
    });

    // Sync fixed-day template items
    if (fixedWeekdays.includes(dow)) {
      (template[dow] || []).forEach(t => {
        const existing = items.find(i => i.templateId === t.id);
        if (existing) {
          existing.text = t.text; existing.time = t.time || ''; existing.priority = !!t.priority;
          existing.tag = t.tag || null; existing.duration = t.duration || null;
        } else {
          items.push({
            id: uid(), text: t.text, done: false, priority: !!t.priority,
            time: t.time || '', tag: t.tag || null, duration: t.duration || null,
            templateId: t.id
          });
        }
      });
    }

    // Sync recurring items
    (recurring || []).forEach(r => {
      const applicable = computeRecurringApplicable(r, dateStr);
      const existing = items.find(i => i.recurringId === r.id);
      if (applicable) {
        if (existing) {
          existing.text = r.text; existing.time = r.time || ''; existing.priority = !!r.priority;
          existing.tag = r.tag || null; existing.duration = r.duration || null;
        } else {
          items.push({
            id: uid(), text: r.text, done: false, priority: !!r.priority,
            time: r.time || '', tag: r.tag || null, duration: r.duration || null,
            recurringId: r.id
          });
        }
      } else if (existing) {
        items = items.filter(i => i !== existing);
      }
    });

    day.items = items;
  });
}

/* ---------------- routes ---------------- */

app.get('/api/settings', (req, res) => {
  res.json(readDb().settings);
});

app.put('/api/settings', (req, res) => {
  const db = readDb();
  db.settings = req.body;
  reconcile(db);
  writeDb(db);
  res.json({ ok: true });
});

// GET /api/days?start=YYYY-MM-DD&end=YYYY-MM-DD
app.get('/api/days', (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'start and end required' });
  const db = readDb();
  const result = {};
  let d = new Date(start + 'T00:00:00');
  const endD = new Date(end + 'T00:00:00');
  let changed = false;
  let guard = 0;
  while (d <= endD && guard < 500) {
    const iso = d.toISOString().slice(0, 10);
    const existed = !!db.days[iso];
    result[iso] = generateDay(db, iso);
    if (!existed) changed = true;
    d.setDate(d.getDate() + 1);
    guard++;
  }
  if (changed) writeDb(db);
  res.json(result);
});

app.put('/api/day/:date', (req, res) => {
  const db = readDb();
  db.days[req.params.date] = {
    items: req.body.items || [],
    note: req.body.note || ''
  };
  writeDb(db);
  res.json({ ok: true });
});

app.get('/api/search', (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);
  const db = readDb();
  const results = [];
  Object.keys(db.days).sort().reverse().forEach(dateStr => {
    db.days[dateStr].items.forEach(it => {
      if (it.text.includes(q)) results.push({ date: dateStr, text: it.text, done: it.done });
    });
  });
  res.json(results.slice(0, 200));
});

app.get('/api/export', (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="planner-backup.json"');
  res.json(readDb());
});

app.post('/api/import', (req, res) => {
  const incoming = req.body;
  if (!incoming || typeof incoming !== 'object' || typeof incoming.days !== 'object') {
    return res.status(400).json({ error: 'invalid backup file' });
  }
  writeDb({ settings: incoming.settings || null, days: incoming.days || {} });
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Weekly planner running at http://localhost:${PORT}`);
});
