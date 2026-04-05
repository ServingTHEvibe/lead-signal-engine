# Lead Signal Engine

A multi-client lead monitoring SaaS engine that scrapes content from web sources, detects buyer-intent keywords, scores leads as HOT / WARM / COLD, and sends SMS + email alerts — all from a single Node.js server.

---

## What it does

| Feature | Detail |
|---|---|
| Multi-client | Each client gets their own keyword pack, sources, and leads |
| Keyword matching | Case-insensitive phrase matching with HOT / WARM / COLD intent scoring |
| Deduplication | Same content + source combo is never saved twice |
| AI reply | Each matched lead gets a suggested outreach message (template-based; swap for LLM later) |
| Scheduler | Cron job runs every 5 minutes, scans all active sources |
| Source types | `website`, `facebook_group`, `reddit`, `directory` — each with its own scraper hook |
| Oxylabs | Full Oxylabs Web Scraper API integration with safe mock fallback |
| Alerts | SMS via Twilio + Email via Nodemailer — owner or client mode |
| Dashboard | Dark SaaS UI, auto-refreshes every 5 s, filters by client / intent / status |

---

## File structure

```
lead-signal-engine/
├── index.js          ← Express server + all API routes
├── db.js             ← SQLite schema setup
├── matcher.js        ← Keyword intent matching + AI reply generator
├── notifier.js       ← Twilio SMS + Nodemailer email
├── scheduler.js      ← Cron job + source-type scan logic
├── oxylabs.js        ← Oxylabs API client with mock fallback
├── package.json
├── .env.example
├── leads.db          ← SQLite database (auto-created on first run)
└── public/
    └── dashboard.html ← Lead management dashboard
```

---

## Install dependencies

```bash
npm install
```

---

## Environment variables

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

| Variable | Description |
|---|---|
| `PORT` | Server port (default: 3000) |
| `EMAIL_FROM` | Gmail address to send alerts from |
| `EMAIL_TO` | Owner email for alert delivery |
| `EMAIL_PASS` | Gmail App Password (not your main password) |
| `TWILIO_SID` | Twilio Account SID |
| `TWILIO_AUTH` | Twilio Auth Token |
| `TWILIO_FROM` | Your Twilio phone number |
| `TWILIO_TO` | Phone number to receive SMS alerts |
| `ALERT_MODE` | `owner` (all alerts → you) or `client` (alerts → each client) |
| `OXYLABS_USER` | Oxylabs username (optional — uses mock data if blank) |
| `OXYLABS_PASS` | Oxylabs password (optional) |

### Gmail App Password setup

1. Enable 2-factor auth on your Google account
2. Go to myaccount.google.com → Security → App Passwords
3. Generate a password for "Mail" and paste into `EMAIL_PASS`

---

## Run in Replit

1. Fork or upload the project to a Replit Node.js repl
2. In the Replit **Secrets** panel, add each `.env` variable
3. Make sure `package.json` `main` is `index.js`
4. Click **Run** — the server starts and the scheduler begins

Dashboard URL: `https://your-repl-name.repl.co/dashboard.html`

---

## Run locally

```bash
node index.js
# or for hot reload:
npx nodemon index.js
```

---

## API reference

### Health check
```
GET /
```

### Create a client
```
POST /api/clients
Content-Type: application/json

{
  "name":  "Plumber Pro",
  "niche": "plumbing",
  "email": "client@example.com",
  "phone": "+15559876543"
}
```

### Add keyword phrases
```
POST /api/keywords
Content-Type: application/json

{ "client_id": 1, "phrase": "need a plumber",   "intent": "HOT"  }
{ "client_id": 1, "phrase": "pipe repair",       "intent": "WARM" }
{ "client_id": 1, "phrase": "plumbing advice",   "intent": "COLD" }
```

### Add monitored source
```
POST /api/sources
Content-Type: application/json

{
  "client_id":   1,
  "source_name": "Local Facebook Group",
  "source_type": "facebook_group",
  "source_url":  "https://facebook.com/groups/localhomeowners"
}
```

source_type options: `website` | `facebook_group` | `reddit` | `directory`

### Manual ingest (test matching)
```
POST /api/ingest
Content-Type: application/json

{
  "client_id": 1,
  "text": "Hi, I need a plumber urgently — burst pipe in the bathroom!",
  "source": "test"
}
```

### Get leads (with filters)
```
GET /api/leads
GET /api/leads?intent=HOT
GET /api/leads?client_id=1&intent=WARM
GET /api/leads?status=new
```

### Update lead status
```
PATCH /api/leads/42/status
Content-Type: application/json

{ "status": "contacted" }
```

Status values: `new` | `contacted` | `sold` | `dismissed`

---

## How the scheduler works

Every 5 minutes the cron job:
1. Loads all sources where `active = 1`
2. Routes each source to its scan function (`scanWebsite`, `scanFacebookGroup`, etc.)
3. Calls `scrapeUrl()` in `oxylabs.js` — uses real Oxylabs if credentials are set, otherwise returns mock data
4. Passes each scraped text record through `matchText()` in `matcher.js`
5. Skips duplicates (same content + source)
6. Saves matched leads with `ai_reply` pre-populated
7. Sends SMS + email for HOT and WARM leads

---

## Plugging in Oxylabs

1. Sign up at oxylabs.io and get credentials
2. Add to `.env`:
   ```
   OXYLABS_USER=your_username
   OXYLABS_PASS=your_password
   ```
3. Restart the server — the mock fallback is automatically disabled

`oxylabs.js` uses the **Realtime API** with `source: "universal"` and JS rendering enabled. To change the source type per scrape target, edit the `buildWebsitePayload()` function or add new builder functions for Amazon, Google, etc.

---

## Future expansion hooks

| What | Where |
|---|---|
| Swap template replies for LLM (OpenAI, Claude) | `matcher.js` → `generateReply()` |
| Add Apify actor per source type | `scheduler.js` → `scanFacebookGroup()`, `scanReddit()` |
| Add JWT auth + user accounts | `index.js` — add middleware before API routes |
| Add Stripe subscription billing | Add `stripe.js` + `POST /api/stripe/checkout` |
| Add Apify integration | `scheduler.js` → replace `scrapeUrl()` calls with Apify SDK |
| Semantic keyword matching | `matcher.js` → `matchText()` — replace `includes()` with embedding similarity |

---

## Database tables

| Table | Key fields |
|---|---|
| `clients` | id, name, niche, email, phone, status |
| `keyword_packs` | id, client_id, phrase, intent |
| `sources` | id, client_id, source_name, source_type, source_url, active |
| `leads` | id, client_id, keyword, content, source, intent, status, assigned_to, ai_reply, created_at |
