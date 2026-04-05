/**
 * oxylabs.js — Oxylabs Web Scraper API client
 *
 * Provides a reusable scrapeUrl() function that fetches rendered HTML
 * from Oxylabs and returns normalized plain-text records.
 *
 * If OXYLABS_USER / OXYLABS_PASS are not set, falls back to mock data
 * so the scheduler keeps running in dev/demo environments.
 *
 * Plug-in points for future source types are labelled with: // [EXTEND]
 */

require('dotenv').config();
const fetch = require('node-fetch');

const OXYLABS_USER = process.env.OXYLABS_USER || '';
const OXYLABS_PASS = process.env.OXYLABS_PASS || '';
const OXYLABS_ENDPOINT = 'https://realtime.oxylabs.io/v1/queries';

const oxylabsConfigured = Boolean(OXYLABS_USER && OXYLABS_PASS);

if (!oxylabsConfigured) {
  console.warn('[Oxylabs] Credentials not set — using mock data fallback.');
}

// ─── Source-type payload builders ─────────────────────────────────────────────
// Each function returns the POST body Oxylabs expects for that source type.
// [EXTEND] Add new source types here as the platform grows.

function buildWebsitePayload(url) {
  return {
    source: 'universal',
    url,
    render: 'html',       // use headless rendering for JS-heavy pages
    parse: false,
  };
}

function buildGooglePayload(query) {
  return {
    source: 'google_search',
    query,
    parse: true,
  };
}

// [EXTEND] function buildAmazonPayload(asin) { ... }
// [EXTEND] function buildRedditPayload(url)   { ... }

// ─── Response normalizer ───────────────────────────────────────────────────────

/**
 * Extract plain-text content from an Oxylabs API response.
 * Returns an array of { text, url } objects ready for the matching engine.
 *
 * @param {object} apiResponse  - parsed JSON from Oxylabs
 * @param {string} sourceUrl
 * @returns {Array<{ text: string, url: string }>}
 */
function normalizeResponse(apiResponse, sourceUrl) {
  const results = [];

  try {
    const pages = apiResponse?.results || [];
    for (const page of pages) {
      // Rendered HTML path
      if (page.content) {
        // Strip HTML tags to get readable text
        const text = page.content
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (text) results.push({ text, url: sourceUrl });
      }
      // Parsed structured results path (e.g. Google SERP)
      if (page.results?.organic) {
        for (const item of page.results.organic) {
          const text = [item.title, item.desc].filter(Boolean).join('. ');
          if (text) results.push({ text, url: item.url || sourceUrl });
        }
      }
    }
  } catch (err) {
    console.error('[Oxylabs] Normalize error:', err.message);
  }

  return results;
}

// ─── Mock data fallback ────────────────────────────────────────────────────────

const MOCK_RECORDS = [
  { text: 'Looking for someone to help with social media marketing for my small restaurant. Budget ready.', url: 'mock://facebook-group/1' },
  { text: 'Anyone know a good plumber near me? Need emergency pipe repair today!', url: 'mock://reddit/2' },
  { text: 'Need a logo designer ASAP — launching next week.', url: 'mock://directory/3' },
  { text: 'Thinking about switching CRM systems. Recommendations for real estate?', url: 'mock://forum/4' },
  { text: 'Our website traffic has tanked. Need SEO help urgently.', url: 'mock://website/5' },
];

function getMockRecords() {
  // Return a random subset to simulate fresh content each cycle
  const count = Math.floor(Math.random() * 3) + 1;
  return MOCK_RECORDS.slice(0, count);
}

// ─── Main scrape function ──────────────────────────────────────────────────────

/**
 * Scrape a URL using Oxylabs (or return mock data if not configured).
 *
 * @param {string} url         - target URL to scrape
 * @param {string} sourceType  - 'website' | 'facebook_group' | 'reddit' | 'directory'
 * @returns {Promise<Array<{ text: string, url: string }>>}
 */
async function scrapeUrl(url, sourceType = 'website') {
  if (!oxylabsConfigured) {
    console.log(`[Oxylabs] Mock → ${url}`);
    return getMockRecords();
  }

  // Choose payload based on source type
  // [EXTEND] Add new branches for Apify, custom scrapers, etc.
  let payload;
  switch (sourceType) {
    case 'reddit':
    case 'facebook_group':
    case 'directory':
    case 'website':
    default:
      payload = buildWebsitePayload(url);
  }

  try {
    console.log(`[Oxylabs] Scraping (${sourceType}) → ${url}`);

    const credentials = Buffer.from(`${OXYLABS_USER}:${OXYLABS_PASS}`).toString('base64');

    const response = await fetch(OXYLABS_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${credentials}`,
      },
      body: JSON.stringify(payload),
      timeout: 30000,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errText}`);
    }

    const json = await response.json();
    const records = normalizeResponse(json, url);

    console.log(`[Oxylabs] Got ${records.length} record(s) from ${url}`);
    return records;

  } catch (err) {
    console.error(`[Oxylabs] Scrape failed for ${url}:`, err.message);
    // Graceful degradation — return empty so the scheduler continues
    return [];
  }
}

module.exports = { scrapeUrl };
