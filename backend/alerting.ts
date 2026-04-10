import http from 'http';
import https from 'https';
import { URL } from 'url';

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

interface Monitor {
  id: string;
  url: string;
  name: string | null;
  webhook_url: string | null;
  alert_email: string | null;
  telegram_chat_id: string | null;
  alert_channels: string;
}

/**
 * Process alerts for a monitor state change.
 * Called by the API server when consensus determines a state transition.
 */
export function processAlerts(monitor: Monitor, newStatus: string, locations: string[]): void {
  const channels = JSON.parse(monitor.alert_channels || '[]') as string[];
  const monitorName = monitor.name || monitor.url;
  const isDown = newStatus === 'down';

  const message = isDown
    ? `ALERT: ${monitorName} is DOWN. Affected locations: ${locations.join(', ')}`
    : `RECOVERED: ${monitorName} is back UP.`;

  console.log(`Alert: ${message}`);

  // Webhook
  if (channels.includes('webhook') && monitor.webhook_url) {
    sendWebhook(monitor.webhook_url, {
      event: isDown ? 'monitor.down' : 'monitor.up',
      monitor_id: monitor.id,
      monitor_name: monitorName,
      url: monitor.url,
      status: newStatus,
      locations,
      timestamp: new Date().toISOString()
    });
  }

  // Email via Resend
  if (channels.includes('email') && monitor.alert_email && RESEND_API_KEY) {
    sendEmail(
      monitor.alert_email,
      isDown ? `[DOWN] ${monitorName}` : `[UP] ${monitorName}`,
      message
    );
  }

  // Telegram
  if (channels.includes('telegram') && monitor.telegram_chat_id && TELEGRAM_BOT_TOKEN) {
    sendTelegram(monitor.telegram_chat_id, message);
  }
}

// --- Webhook ---
function sendWebhook(webhookUrl: string, payload: object): void {
  try {
    const data = JSON.stringify(payload);
    const url = new URL(webhookUrl);
    const client = url.protocol === 'https:' ? https : http;

    const req = client.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'User-Agent': 'Watchdog/1.0'
      },
      timeout: 10000
    });
    req.on('error', (err) => console.error(`Webhook error: ${err.message}`));
    req.write(data);
    req.end();
  } catch (err: any) {
    console.error(`Webhook send error: ${err.message}`);
  }
}

// --- Email via Resend ---
function sendEmail(to: string, subject: string, body: string): void {
  try {
    const data = JSON.stringify({
      from: 'Watchdog <alerts@watchdog.io>',
      to: [to],
      subject,
      text: body
    });

    const req = https.request('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Length': Buffer.byteLength(data)
      },
      timeout: 10000
    });
    req.on('error', (err) => console.error(`Email error: ${err.message}`));
    req.write(data);
    req.end();
  } catch (err: any) {
    console.error(`Email send error: ${err.message}`);
  }
}

// --- Telegram ---
function sendTelegram(chatId: string, text: string): void {
  try {
    const data = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' });
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      },
      timeout: 10000
    });
    req.on('error', (err) => console.error(`Telegram error: ${err.message}`));
    req.write(data);
    req.end();
  } catch (err: any) {
    console.error(`Telegram send error: ${err.message}`);
  }
}
