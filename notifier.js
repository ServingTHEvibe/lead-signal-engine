/**
 * notifier.js — SMS (Twilio) and Email (Nodemailer) alert system
 *
 * ALERT_MODE=owner  → all alerts go to platform owner (EMAIL_TO / TWILIO_TO)
 * ALERT_MODE=client → alerts go to the matched client's email / phone
 *
 * Both SMS and email are attempted; failures are logged but don't crash the app.
 */

require('dotenv').config();
const nodemailer = require('nodemailer');
const twilio = require('twilio');

const ALERT_MODE = process.env.ALERT_MODE || 'owner';

// ─── Twilio setup ──────────────────────────────────────────────────────────────

let twilioClient = null;

if (process.env.TWILIO_SID && process.env.TWILIO_AUTH) {
  twilioClient = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH);
} else {
  console.warn('[Notifier] Twilio not configured — SMS alerts disabled.');
}

// ─── Nodemailer setup ──────────────────────────────────────────────────────────

let mailTransport = null;

if (process.env.EMAIL_FROM && process.env.EMAIL_PASS) {
  mailTransport = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_FROM,
      pass: process.env.EMAIL_PASS,
    },
  });
} else {
  console.warn('[Notifier] Email not configured — email alerts disabled.');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolve where alerts should go based on ALERT_MODE and client record.
 *
 * @param {object} client  - row from clients table (may be null)
 * @returns {{ toEmail: string, toPhone: string }}
 */
function resolveTargets(client) {
  if (ALERT_MODE === 'client' && client) {
    return {
      toEmail: client.email || process.env.EMAIL_TO,
      toPhone: client.phone || process.env.TWILIO_TO,
    };
  }
  // Default: owner mode
  return {
    toEmail: process.env.EMAIL_TO,
    toPhone: process.env.TWILIO_TO,
  };
}

/**
 * Build a concise alert message.
 *
 * @param {object} lead    - lead row
 * @param {object} client  - client row
 * @returns {{ subject: string, body: string, sms: string }}
 */
function buildMessage(lead, client) {
  const clientName = client?.name || `Client #${lead.client_id}`;
  const subject = `[${lead.intent}] New lead for ${clientName} — "${lead.keyword}"`;
  const body = `
Lead Signal Engine Alert
━━━━━━━━━━━━━━━━━━━━━━━━
Intent  : ${lead.intent}
Client  : ${clientName}
Keyword : ${lead.keyword}
Source  : ${lead.source}
Content : ${lead.content}
Created : ${lead.created_at}
━━━━━━━━━━━━━━━━━━━━━━━━
${lead.ai_reply ? `Suggested reply:\n${lead.ai_reply}` : ''}
`.trim();

  const sms = `[${lead.intent}] ${clientName} — "${lead.keyword}" via ${lead.source}. Check dashboard.`;

  return { subject, body, sms };
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Send SMS + email alerts for a lead.
 * Only called for HOT or WARM leads (caller's responsibility to filter).
 *
 * @param {object} lead    - lead row (with ai_reply populated)
 * @param {object} client  - client row (can be null)
 */
async function sendAlerts(lead, client) {
  const { toEmail, toPhone } = resolveTargets(client);
  const { subject, body, sms } = buildMessage(lead, client);

  await Promise.all([
    sendSMS(sms, toPhone),
    sendEmail(subject, body, toEmail),
  ]);
}

async function sendSMS(message, toPhone) {
  if (!twilioClient) return;
  if (!toPhone) {
    console.warn('[Notifier] No phone target for SMS.');
    return;
  }
  try {
    const msg = await twilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_FROM,
      to: toPhone,
    });
    console.log(`[Notifier] SMS sent → ${toPhone} (SID: ${msg.sid})`);
  } catch (err) {
    console.error('[Notifier] SMS failed:', err.message);
  }
}

async function sendEmail(subject, body, toEmail) {
  if (!mailTransport) return;
  if (!toEmail) {
    console.warn('[Notifier] No email target.');
    return;
  }
  try {
    await mailTransport.sendMail({
      from: process.env.EMAIL_FROM,
      to: toEmail,
      subject,
      text: body,
    });
    console.log(`[Notifier] Email sent → ${toEmail}`);
  } catch (err) {
    console.error('[Notifier] Email failed:', err.message);
  }
}

module.exports = { sendAlerts };
