/**
 * index.js — Lead Signal Engine server
 *
 * Routes:
 *   GET    /                          health check
 *
 *   POST   /api/clients               create client
 *   GET    /api/clients               list clients
 *   PATCH  /api/clients/:id           update client (name, niche, email, phone, lead_limit, outreach_enabled)
 *   DELETE /api/clients/:id           delete client
 *
 *   POST   /api/keywords              add keyword
 *   GET    /api/keywords?client_id=X  list keywords for client
 *   DELETE /api/keywords/:id          delete keyword
 *
 *   POST   /api/sources               add source
 *   GET    /api/sources?client_id=X   list sources for client
 *   PATCH  /api/sources/:id           update source (name, type, url, active, max_leads)
 *   DELETE /api/sources/:id           delete source
 *
 *   POST   /api/ingest                run text through matcher, save lead, alert
 *   GET    /api/leads                 list leads (filters: intent, client_id, status)
 *   PATCH  /api/leads/:id/status      update lead status
 *   DELETE /api/leads/:id             delete lead
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isDuplicate(clientId, content, source) {
  const row = db
    .prepare('SELECT id FROM leads WHERE client_id = ? AND content = ? AND source = ? LIMIT 1')
    .get(clientId, content, source);
  return Boolean(row);
}

// ─── Health ───────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({ status: 'ok', app: 'Lead Signal Engine', version: '1.0.0' });
});

// ─── Clients ──────────────────────────────────────────────────────────────────

app.post('/api/clients', (req, res) => {
  const { name, niche, email, phone, lead_limit = 50, outreach_enabled = 1 } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  const result = db.prepare(
    'INSERT INTO clients (name, niche, email, phone, lead_limit, outreach_enabled) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(name, niche || null, email || null, phone || null, lead_limit, outreach_enabled ? 1 : 0);

  res.status(201).json(db.prepare('SELECT * FROM clients WHERE id = ?').get(result.lastInsertRowid));
});

app.get('/api/clients', (req, res) => {
  const clients = db.prepare("SELECT * FROM clients ORDER BY name").all();
  res.json(clients);
});

app.patch('/api/clients/:id', (req, res) => {
  const { id } = req.params;
  const { name, niche, email, phone, status, lead_limit, outreach_enabled } = req.body;

  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  db.prepare(`
    UPDATE clients SET
      name             = ?,
      niche            = ?,
      email            = ?,
      phone            = ?,
      status           = ?,
      lead_limit       = ?,
      outreach_enabled = ?
    WHERE id = ?
  `).run(
    name             ?? client.name,
    niche            ?? client.niche,
    email            ?? client.email,
    phone            ?? client.phone,
    status           ?? client.status,
    lead_limit       ?? client.lead_limit,
    outreach_enabled !== undefined ? (outreach_enabled ? 1 : 0) : client.outreach_enabled,
    id
  );

  res.json(db.prepare('SELECT * FROM clients WHERE id = ?').get(id));
});

app.delete('/api/clients/:id', (req, res) => {
  const result = db.prepare('DELETE FROM clients WHERE id = ?').run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Client not found' });
  res.json({ deleted: true });
});

// ─── Keywords ─────────────────────────────────────────────────────────────────

app.post('/api/keywords', (req, res) => {
  const { client_id, phrase, intent } = req.body;
  if (!client_id || !phrase) return res.status(400).json({ error: 'client_id and phrase required' });

  const validIntents = ['HOT', 'WARM', 'COLD'];
  const normalized = (intent || 'WARM').toUpperCase();
  if (!validIntents.includes(normalized)) return res.status(400).json({ error: 'intent must be HOT, WARM, or COLD' });

  const result = db.prepare(
    'INSERT INTO keyword_packs (client_id, phrase, intent) VALUES (?, ?, ?)'
  ).run(client_id, phrase.toLowerCase(), normalized);

  res.status(201).json({ id: result.lastInsertRowid, client_id, phrase, intent: normalized });
});

app.get('/api/keywords', (req, res) => {
  const { client_id } = req.query;
  if (!client_id) return res.status(400).json({ error: 'client_id required' });
  const keywords = db.prepare(
    'SELECT * FROM keyword_packs WHERE client_id = ? ORDER BY intent, phrase'
  ).all(client_id);
  res.json(keywords);
});

app.delete('/api/keywords/:id', (req, res) => {
  const result = db.prepare('DELETE FROM keyword_packs WHERE id = ?').run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Keyword not found' });
  res.json({ deleted: true });
});

// ─── Sources ──────────────────────────────────────────────────────────────────

app.post('/api/sources', (req, res) => {
  const { client_id, source_name, source_type = 'website', source_url, max_leads = 25 } = req.body;
  if (!client_id || !source_name) return res.status(400).json({ error: 'client_id and source_name required' });

  const result = db.prepare(
    'INSERT INTO sources (client_id, source_name, source_type, source_url, max_leads) VALUES (?, ?, ?, ?, ?)'
  ).run(client_id, source_name, source_type, source_url || null, max_leads);

  res.status(201).json(db.prepare('SELECT * FROM sources WHERE id = ?').get(result.lastInsertRowid));
});

app.get('/api/sources', (req, res) => {
  const { client_id } = req.query;
  const sources = client_id
    ? db.prepare('SELECT * FROM sources WHERE client_id = ? ORDER BY created_at DESC').all(client_id)
    : db.prepare('SELECT * FROM sources ORDER BY created_at DESC').all();
  res.json(sources);
});

app.patch('/api/sources/:id', (req, res) => {
  const { id } = req.params;
  const source = db.prepare('SELECT * FROM sources WHERE id = ?').get(id);
  if (!source) return res.status(404).json({ error: 'Source not found' });

  const { source_name, source_type, source_url, active, max_leads } = req.body;

  db.prepare(`
    UPDATE sources SET
      source_name = ?,
      source_type = ?,
      source_url  = ?,
      active      = ?,
      max_leads   = ?
    WHERE id = ?
  `).run(
    source_name ?? source.source_name,
    source_type ?? source.source_type,
    source_url  ?? source.source_url,
    active !== undefined ? (active ? 1 : 0) : source.active,
    max_leads   ?? source.max_leads,
    id
  );

  res.json(db.prepare('SELECT * FROM sources WHERE id = ?').get(id));
});

app.delete('/api/sources/:id', (req, res) => {
  const result = db.prepare('DELETE FROM sources WHERE id = ?').run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Source not found' });
  res.json({ deleted: true });
});

// ─── Ingest ───────────────────────────────────────────────────────────────────

app.post('/api/ingest', async (req, res) => {
  const { client_id, text, source } = req.body;
  if (!client_id || !text) return res.status(400).json({ error: 'client_id and text required' });

  const sourceName = source || 'manual';
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(client_id);

  // Enforce lead limit per client
  if (client?.lead_limit) {
    const count = db.prepare("SELECT COUNT(*) as c FROM leads WHERE client_id = ? AND status = 'new'").get(client_id);
    if (count.c >= client.lead_limit) {
      return res.json({ matched: false, message: `Lead limit reached (${client.lead_limit} new leads). Mark some as contacted or sold first.` });
    }
  }

  const { matched, keyword, intent } = matchText(client_id, text);
  if (!matched) return res.json({ matched: false, message: 'No keyword match found.' });

  if (isDuplicate(client_id, text, sourceName)) {
    return res.json({ matched: true, duplicate: true, message: 'Lead already exists.' });
  }

  // Generate outreach reply only if outreach is enabled for this client
  const outreach = client?.outreach_enabled !== 0;
  const ai_reply = outreach ? generateReply(intent, keyword, client?.niche) : null;

  const result = db.prepare(`
    INSERT INTO leads (client_id, keyword, content, source, intent, ai_reply)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(client_id, keyword, text, sourceName, intent, ai_reply);

  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(result.lastInsertRowid);

  if (outreach && (intent === 'HOT' || intent === 'WARM')) {
    sendAlerts(lead, client).catch(err => console.error('[Ingest] Alert error:', err.message));
  }

  res.status(201).json({ matched: true, lead });
});

// ─── Leads ────────────────────────────────────────────────────────────────────

app.get('/api/leads', (req, res) => {
  const { intent, client_id, status, limit = 200, offset = 0 } = req.query;

  let query = `
    SELECT l.*, c.name AS client_name, c.niche AS client_niche
    FROM leads l
    LEFT JOIN clients c ON l.client_id = c.id
    WHERE 1=1
  `;
  const params = [];

  if (intent)    { query += ' AND l.intent = ?';    params.push(intent.toUpperCase()); }
  if (client_id) { query += ' AND l.client_id = ?'; params.push(client_id); }
  if (status)    { query += ' AND l.status = ?';    params.push(status); }

  query += ' ORDER BY l.created_at DESC LIMIT ? OFFSET ?';
  params.push(Number(limit), Number(offset));

  res.json(db.prepare(query).all(...params));
});

app.patch('/api/leads/:id/status', (req, res) => {
  const { status } = req.body;
  const valid = ['new', 'contacted', 'sold', 'dismissed'];
  if (!valid.includes(status)) return res.status(400).json({ error: `status must be one of: ${valid.join(', ')}` });

  const result = db.prepare('UPDATE leads SET status = ? WHERE id = ?').run(status, req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Lead not found' });
  res.json(db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id));
});

app.delete('/api/leads/:id', (req, res) => {
  const result = db.prepare('DELETE FROM leads WHERE id = ?').run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Lead not found' });
  res.json({ deleted: true });
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n[Server] Lead Signal Engine running on port ${PORT}`);
  console.log(`[Server] Dashboard → http://localhost:${PORT}/dashboard.html`);
  console.log(`[Server] Alert mode → ${process.env.ALERT_MODE || 'owner'}\n`);
  startScheduler();
});

module.exports = app;
