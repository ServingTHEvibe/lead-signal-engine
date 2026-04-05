/**
 * scheduler.js — Cron-based source scanner
 *
 * Runs every 5 minutes. For each active source:
 *   1. Calls the appropriate scraper (Oxylabs or mock fallback)
 *   2. Passes scraped text into the ingest pipeline
 *   3. Saves matched leads + triggers alerts
 *
 * Source types and their scan strategies:
 *   website        → full-page Oxylabs crawl
 *   facebook_group → Oxylabs universal render (JS-heavy page)
 *   reddit         → Oxylabs universal render of subreddit/post
 *   directory      → Oxylabs universal render of listing page
 *
 * [EXTEND] Replace scrapeUrl() with Apify actors per source type as needed.
 * [EXTEND] Add per-source crawl frequency overrides to the sources table.
 */

const cron = require('node-cron');
const db = require('./db');
const { matchText, generateReply } = require('./matcher');
const { sendAlerts } = require('./notifier');
const { scrapeUrl } = require('./oxylabs');

// ─── Lead deduplication ────────────────────────────────────────────────────────

/**
 * Check if a lead with the same content + source already exists for this client.
 * Prevents duplicate rows from repeated scans.
 *
 * @param {number} clientId
 * @param {string} content
 * @param {string} source
 * @returns {boolean}
 */
function isDuplicate(clientId, content, source) {
  const row = db
    .prepare(
      'SELECT id FROM leads WHERE client_id = ? AND content = ? AND source = ? LIMIT 1'
    )
    .get(clientId, content, source);
  return Boolean(row);
}

// ─── Ingest pipeline (shared with POST /api/ingest) ───────────────────────────

/**
 * Process a single text record against a client's keyword pack.
 * Saves a lead row and triggers alerts if intent is HOT or WARM.
 *
 * @param {number} clientId
 * @param {string} text       - raw scraped text
 * @param {string} sourceName - display name for the lead's source field
 */
async function processRecord(clientId, text, sourceName) {
  const { matched, keyword, intent } = matchText(clientId, text);
  if (!matched) return;

  // Dedup check
  if (isDuplicate(clientId, text, sourceName)) {
    console.log(`[Scheduler] Duplicate skipped → client=${clientId} source=${sourceName}`);
    return;
  }

  // Fetch client info for ai_reply niche context + alert routing
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);

  // Generate suggested outreach reply
  const ai_reply = generateReply(intent, keyword, client?.niche);

  // Persist the lead
  const insert = db.prepare(`
    INSERT INTO leads (client_id, keyword, content, source, intent, ai_reply)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const result = insert.run(clientId, keyword, text, sourceName, intent, ai_reply);
  const leadId = result.lastInsertRowid;

  console.log(`[Scheduler] Lead saved #${leadId} → ${intent} | "${keyword}" | client=${clientId}`);

  // Alert on HOT and WARM only
  if (intent === 'HOT' || intent === 'WARM') {
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
    await sendAlerts(lead, client);
  }
}

// ─── Source-type scan strategies ──────────────────────────────────────────────
// Each function handles scraping for its source type and feeds records
// into processRecord(). Add new types below as the platform expands.

/**
 * Scan a standard website.
 * Uses Oxylabs universal source with JS rendering.
 */
async function scanWebsite(source) {
  console.log(`[Scheduler] Scanning website → ${source.source_url}`);
  const records = await scrapeUrl(source.source_url, 'website');
  for (const rec of records) {
    await processRecord(source.client_id, rec.text, source.source_name);
  }
}

/**
 * Scan a Facebook group URL.
 * [EXTEND] Swap in an Apify Facebook Group Scraper actor here.
 * Actor: apify/facebook-groups-scraper
 */
async function scanFacebookGroup(source) {
  console.log(`[Scheduler] Scanning Facebook group → ${source.source_url}`);
  // [EXTEND] const records = await apify.run('apify/facebook-groups-scraper', { startUrls: [source.source_url] });
  const records = await scrapeUrl(source.source_url, 'facebook_group');
  for (const rec of records) {
    await processRecord(source.client_id, rec.text, source.source_name);
  }
}

/**
 * Scan a Reddit subreddit or thread.
 * [EXTEND] Swap in Apify Reddit Scraper or direct Reddit API calls.
 * Actor: trudax/reddit-scraper
 */
async function scanReddit(source) {
  console.log(`[Scheduler] Scanning Reddit → ${source.source_url}`);
  // [EXTEND] const records = await apify.run('trudax/reddit-scraper', { startUrls: [source.source_url] });
  const records = await scrapeUrl(source.source_url, 'reddit');
  for (const rec of records) {
    await processRecord(source.client_id, rec.text, source.source_name);
  }
}

/**
 * Scan a business directory listing page.
 * [EXTEND] Swap in Oxylabs E-Commerce or custom parsing logic.
 */
async function scanDirectory(source) {
  console.log(`[Scheduler] Scanning directory → ${source.source_url}`);
  const records = await scrapeUrl(source.source_url, 'directory');
  for (const rec of records) {
    await processRecord(source.client_id, rec.text, source.source_name);
  }
}

// ─── Scan dispatcher ──────────────────────────────────────────────────────────

/**
 * Route a source row to the correct scan function based on source_type.
 */
async function scanSource(source) {
  try {
    switch (source.source_type) {
      case 'facebook_group':
        await scanFacebookGroup(source);
        break;
      case 'reddit':
        await scanReddit(source);
        break;
      case 'directory':
        await scanDirectory(source);
        break;
      case 'website':
      default:
        await scanWebsite(source);
    }
  } catch (err) {
    console.error(`[Scheduler] Error scanning source #${source.id}:`, err.message);
  }
}

// ─── Scheduler entry point ────────────────────────────────────────────────────

function startScheduler() {
  console.log('[Scheduler] Starting — runs every 5 minutes.');

  // '*/5 * * * *' = every 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    console.log('[Scheduler] Tick →', new Date().toISOString());

    const sources = db
      .prepare('SELECT * FROM sources WHERE active = 1')
      .all();

    if (!sources.length) {
      console.log('[Scheduler] No active sources.');
      return;
    }

    console.log(`[Scheduler] Scanning ${sources.length} source(s)...`);

    // Scan sources sequentially to avoid hammering the scraper API
    for (const source of sources) {
      await scanSource(source);
    }

    console.log('[Scheduler] Cycle complete.');
  });
}

// Export processRecord so POST /api/ingest can reuse the same pipeline
module.exports = { startScheduler, processRecord };
