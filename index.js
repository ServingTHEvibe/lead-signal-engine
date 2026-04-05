/**
 * index.js — Lead Signal Engine server
 *
 * Express app with REST API, static dashboard, and background scheduler.
 *
 * Routes:
 *   GET  /                        health check
 *   POST /api/clients             create a client
 *   POST /api/keywords            add keyword phrase for a client
 *   POST /api/sources             add monitored source for a client
 *   POST /api/ingest              manually ingest text and run matching
 *   GET  /api/leads               list leads (newest first, joined with client)
 *   GET  /api/clients             list all clients (for dashboard filter)
 *   PATCH /api/leads/:id/status   update lead status
 *
 * [EXTEND] Add auth middleware before API routes for multi-tenant access control.
 * [EXTEND] Add POST /api/stripe/checkout for subscription billing.
 */

require('dotenv').config();

const express = require('express');
const path = require('path');
const db = require('./db');
const { matchText, generateReply } = require('./matcher');
const { sendAlerts } = require('./notifier');
const { startScheduler } = require('./scheduler');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Deduplication helper ──────────────────────────────────────────────────────

function isDuplicate(clientId, content, source) {
  const row = db
    .prepare(
      'SELECT id FROM leads WHERE client_id = ? AND content = ? AND source = ? LIMIT 1'
    )
    .get(clientId, content, source);
  return Boolean(row);
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', app: 'Lead Signal Engine', version: '1.0.0' });
});

// ── Clients ──

/**
 * POST /api/clients
 * Body: { name, niche, email, phone }
 */
app.post('/api/clients', (req, res) => {
  const { name, niche, email, phone } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  const stmt = db.prepare(
    'INSERT INTO clients (name, niche, email, phone) VALUES (?, ?, ?, ?)'
  );
  const result = stmt.run(name, niche || null, email || null, phone || null);

  res.status(201).json({ id: result.lastInsertRowid, name, niche, email, phone });
});

/**
 * GET /api/clients
 * Returns all active clients — used by the dashboard filter.
 */
app.get('/api/clients', (req, res) => {
  const clients = db.prepare("SELECT * FROM clients WHERE status = 'active' ORDER BY name").all();
  res.json(clients);
});

// ── Keywords ──

/**
 * POST /api/keywords
 * Body: { client_id, phrase, intent }   intent: HOT | WARM | COLD
 */
app.post('/api/keywords', (req, res) => {
  const { client_id, phrase, intent } = req.body;
  if (!client_id || !phrase) {
    return res.status(400).json({ error: 'client_id and phrase are required' });
  }

  const validIntents = ['HOT', 'WARM', 'COLD'];
  const normalizedIntent = (intent || 'WARM').toUpperCase();
  if (!validIntents.includes(normalizedIntent)) {
    return res.status(400).json({ error: 'intent must be HOT, WARM, or COLD' });
  }

  const stmt = db.prepare(
    'INSERT INTO keyword_packs (client_id, phrase, intent) VALUES (?, ?, ?)'
  );
  const result = stmt.run(client_id, phrase.toLowerCase(), normalizedIntent);

  res.status(201).json({ id: result.lastInsertRowid, client_id, phrase, intent: normalizedIntent });
});

// ── Sources ──

/**
 * POST /api/sources
 * Body: { client_id, source_name, source_type, source_url }
 * source_type: website | facebook_group | reddit | directory
 */
app.post('/api/sources', (req, res) => {
  const { client_id, source_name, source_type, source_url } = req.body;
  if (!client_id || !source_name) {
    return res.status(400).json({ error: 'client_id and source_name are required' });
  }

  const stmt = db.prepare(
    'INSERT INTO sources (client_id, source_name, source_type, source_url) VALUES (?, ?, ?, ?)'
  );
  const result = stmt.run(client_id, source_name, source_type || 'website', source_url || null);

  res.status(201).json({
    id: result.lastInsertRowid,
    client_id,
    source_name,
    source_type: source_type || 'website',
    source_url,
  });
});

// ── Ingest ──

/**
 * POST /api/ingest
 * Body: { client_id, text, source }
 *
 * Runs the keyword matching engine on incoming text.
 * Saves matched leads and sends alerts for HOT/WARM.
 * Returns the saved lead or a 'no_match' status.
 */
app.post('/api/ingest', async (req, res) => {
  const { client_id, text, source } = req.body;
  if (!client_id || !text) {
    return res.status(400).json({ error: 'client_id and text are required' });
  }

  const sourceName = source || 'manual';

  // Run keyword matching
  const { matched, keyword, intent } = matchText(client_id, text);
  if (!matched) {
    return res.json({ matched: false, message: 'No keyword match found.' });
  }

  // Deduplication
  if (isDuplicate(client_id, text, sourceName)) {
    return res.json({ matched: true, duplicate: true, message: 'Lead already exists.' });
  }

  // Fetch client for context
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(client_id);

  // Generate outreach reply
  const ai_reply = generateReply(intent, keyword, client?.niche);

  // Save lead
  const insertStmt = db.prepare(`
    INSERT INTO leads (client_id, keyword, content, source, intent, ai_reply)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const result = insertStmt.run(client_id, keyword, text, sourceName, intent, ai_reply);
  const leadId = result.lastInsertRowid;

  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);

  // Alert for HOT/WARM
  if (intent === 'HOT' || intent === 'WARM') {
    sendAlerts(lead, client).catch(err =>
      console.error('[Ingest] Alert error:', err.message)
    );
  }

  res.status(201).json({ matched: true, lead });
});

// ── Leads ──

/**
 * GET /api/leads
 * Query params: intent (HOT|WARM|COLD), client_id, status, limit, offset
 * Returns leads joined with client name and niche, newest first.
 */
app.get('/api/leads', (req, res) => {
  const { intent, client_id, status, limit = 100, offset = 0 } = req.query;

  let query = `
    SELECT
      l.*,
      c.name  AS client_name,
      c.niche AS client_niche
    FROM leads l
    LEFT JOIN clients c ON l.client_id = c.id
    WHERE 1=1
  `;
  const params = [];

  if (intent) {
    query += ' AND l.intent = ?';
    params.push(intent.toUpperCase());
  }
  if (client_id) {
    query += ' AND l.client_id = ?';
    params.push(client_id);
  }
  if (status) {
    query += ' AND l.status = ?';
    params.push(status);
  }

  query += ' ORDER BY l.created_at DESC LIMIT ? OFFSET ?';
  params.push(Number(limit), Number(offset));

  const leads = db.prepare(query).all(...params);
  res.json(leads);
});

/**
 * PATCH /api/leads/:id/status
 * Body: { status }   status: new | contacted | sold | dismissed
 */
app.patch('/api/leads/:id/status', (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const validStatuses = ['new', 'contacted', 'sold', 'dismissed'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` });
  }

  const stmt = db.prepare('UPDATE leads SET status = ? WHERE id = ?');
  const result = stmt.run(status, id);

  if (!result.changes) {
    return res.status(404).json({ error: 'Lead not found' });
  }

  const updated = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
  res.json(updated);
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n[Server] Lead Signal Engine running on port ${PORT}`);
  console.log(`[Server] Dashboard → http://localhost:${PORT}/dashboard.html`);
  console.log(`[Server] Alert mode → ${process.env.ALERT_MODE || 'owner'}\n`);

  startScheduler();
});

module.exports = app;
