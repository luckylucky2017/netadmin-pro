// Polls the alerts table for new rows and fans them out to Telegram/SMTP per notification_rules —
// the single hook point for outbound notifications, so none of the ~12 files that INSERT INTO alerts
// (ssh-security-collector.js, nginx-waf-collector.js, crowdsec-collector.js, alert-engine.js, etc.)
// need to know notifications exist at all. Cursor-based polling, same shape as crowdsec-collector.js's
// pollAlerts()/last_alert_id.
//
// Best-effort by design: a failed Telegram/SMTP send is logged and the cursor still advances — a
// notification is an FYI channel, not a security control, so there's no retry queue like
// fail2ban-collector.js's retryUnbannedSshAlerts. A permanently-broken channel would otherwise
// silently stall every notification behind it forever.
const db = require('./database');
const nodemailer = require('nodemailer');

// alert_rules (alert-engine.js) let the category be admin-chosen freely, so cpu/ram/disk alerts
// can't be matched by category — only by metric, same as every other type here.
function typeKeyFor(alert) {
  return alert.metric || null;
}

async function sendTelegram(settings, alert) {
  const res = await fetch(`https://api.telegram.org/bot${settings.telegram_bot_token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: settings.telegram_chat_id,
      text: formatMessage(alert),
      parse_mode: 'HTML',
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Telegram API trả về ${res.status}: ${body.slice(0, 200)}`);
  }
}

function buildSmtpTransport(settings) {
  return nodemailer.createTransport({
    host: settings.smtp_host,
    port: settings.smtp_port || 587,
    secure: !!settings.smtp_secure,
    auth: settings.smtp_user ? { user: settings.smtp_user, pass: settings.smtp_password } : undefined,
  });
}

async function sendSmtp(settings, alert) {
  const transport = buildSmtpTransport(settings);
  await transport.sendMail({
    from: settings.smtp_from || settings.smtp_user,
    to: settings.smtp_to,
    subject: `[NetAdmin Pro] ${alert.title}`,
    text: formatMessage(alert, false),
  });
}

function formatMessage(alert, html = true) {
  const lines = [
    html ? `<b>${escapeHtml(alert.title)}</b>` : alert.title,
    alert.message || '',
    alert.source_name ? `Nguồn: ${alert.source_name}` : null,
    `Mức độ: ${alert.severity}`,
    `Thời gian: ${new Date(alert.created_at).toLocaleString('vi-VN')}`,
  ].filter(Boolean);
  return lines.join('\n');
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

async function dispatchOne(settings, rulesByKey, alert) {
  const key = typeKeyFor(alert);
  const rule = key ? rulesByKey.get(key) : null;
  if (!rule) return;

  if (rule.telegram_enabled && settings.telegram_bot_token && settings.telegram_chat_id) {
    try {
      await sendTelegram(settings, alert);
    } catch (e) {
      console.error(`[notify] Gửi Telegram lỗi cho alert #${alert.id} (${key}): ${e.message}`);
    }
  }
  if (rule.smtp_enabled && settings.smtp_host && settings.smtp_to) {
    try {
      await sendSmtp(settings, alert);
    } catch (e) {
      console.error(`[notify] Gửi email lỗi cho alert #${alert.id} (${key}): ${e.message}`);
    }
  }
}

async function poll() {
  const settings = await db.prepare('SELECT * FROM app_settings WHERE id = 1').get();
  if (!settings) return;
  const hasTelegram = settings.telegram_bot_token && settings.telegram_chat_id;
  const hasSmtp = settings.smtp_host && settings.smtp_to;
  if (!hasTelegram && !hasSmtp) return; // nothing configured yet — skip the query entirely

  const alerts = await db.prepare('SELECT * FROM alerts WHERE id > ? ORDER BY id ASC LIMIT 200').all(settings.notif_last_alert_id || 0);
  if (!alerts.length) return;

  const rules = await db.prepare('SELECT * FROM notification_rules').all();
  const rulesByKey = new Map(rules.map(r => [r.type_key, r]));

  let maxId = settings.notif_last_alert_id || 0;
  for (const alert of alerts) {
    await dispatchOne(settings, rulesByKey, alert);
    if (alert.id > maxId) maxId = alert.id;
  }
  if (maxId !== settings.notif_last_alert_id) {
    await db.prepare('UPDATE app_settings SET notif_last_alert_id = ? WHERE id = 1').run(maxId);
  }
}

function start(intervalMs = 30000) {
  const tick = () => poll().catch(e => console.error(`[notify] poll lỗi: ${e.message}`));
  tick();
  return setInterval(tick, intervalMs);
}

module.exports = { start, poll, sendTelegram, sendSmtp, buildSmtpTransport, formatMessage };
