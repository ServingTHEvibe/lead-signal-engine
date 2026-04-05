/**
 * matcher.js — Keyword intent matching engine
 *
 * Checks incoming text against a client's keyword_packs.
 * Returns the first (highest-priority) match with intent.
 *
 * Intent priority: HOT > WARM > COLD
 * Future: swap matchText() with a semantic embedding call.
 */

const db = require('./db');

// Intent priority order (higher index = lower priority)
const INTENT_ORDER = ['HOT', 'WARM', 'COLD'];

/**
 * Score raw text against all keyword phrases for a given client.
 *
 * @param {number} clientId
 * @param {string} text  - raw scraped content
 * @returns {{ matched: boolean, keyword: string|null, intent: string|null }}
 */
function matchText(clientId, text) {
  if (!text || !clientId) return { matched: false, keyword: null, intent: null };

  // Load all keyword phrases for this client
  const phrases = db
    .prepare('SELECT phrase, intent FROM keyword_packs WHERE client_id = ?')
    .all(clientId);

  if (!phrases.length) return { matched: false, keyword: null, intent: null };

  const lowerText = text.toLowerCase();

  // Collect all matches then return highest-priority one
  const matches = [];

  for (const row of phrases) {
    if (lowerText.includes(row.phrase.toLowerCase())) {
      matches.push({ keyword: row.phrase, intent: row.intent });
    }
  }

  if (!matches.length) return { matched: false, keyword: null, intent: null };

  // Sort by intent priority (HOT first)
  matches.sort(
    (a, b) => INTENT_ORDER.indexOf(a.intent) - INTENT_ORDER.indexOf(b.intent)
  );

  const best = matches[0];
  return { matched: true, keyword: best.keyword, intent: best.intent };
}

/**
 * Generate a simple rule-based outreach reply suggestion.
 * Replace this function body with an AI/LLM API call later.
 *
 * @param {string} intent  - HOT | WARM | COLD
 * @param {string} keyword - matched keyword phrase
 * @param {string} niche   - client niche label
 * @returns {string}
 */
function generateReply(intent, keyword, niche) {
  const templates = {
    HOT: `Hi! I saw you're looking for help with "${keyword}" in the ${niche || 'industry'} space. We specialize in exactly that — would love to show you how we can help. Free to chat this week?`,
    WARM: `Hey! Noticed you mentioned "${keyword}". We work with ${niche || 'businesses'} on this all the time. Happy to share some ideas if you'd like — no pressure.`,
    COLD: `Hi there! Came across your post about "${keyword}". If you ever need support in the ${niche || 'space'}, feel free to reach out. We'd be glad to help.`,
  };

  // TODO: Replace with Claude / OpenAI API call:
  // const reply = await openai.chat.completions.create({ ... })
  // return reply.choices[0].message.content;

  return templates[intent] || templates['COLD'];
}

module.exports = { matchText, generateReply };
