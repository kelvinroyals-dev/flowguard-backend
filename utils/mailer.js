// utils/mailer.js — email delivery via Resend HTTP API (POC: free tier, no SDK)
// All FlowGuard automated email flows live here.

const API_KEY    = process.env.RESEND_API_KEY || '';
const FROM_EMAIL = process.env.MAIL_FROM || 'onboarding@resend.dev';
const FROM_NAME  = process.env.MAIL_FROM_NAME || 'FlowGuard';
const OPS_EMAIL  = process.env.OPS_EMAIL || 'info@flowguard.ng';
const PORTAL_URL = process.env.PORTAL_URL || 'https://app.flowguard.ng';

const ready = !!API_KEY;
if (!ready) console.warn('[mailer] RESEND_API_KEY not set — emails will be logged, not sent.');

async function sendEmail({ to, subject, html, text, replyTo, attachments }) {
  if (!ready) { console.log(`[mailer] (no key) would send to ${to}: "${subject}"`); return false; }
  try {
    const payload = {
      from: `${FROM_NAME} <${FROM_EMAIL}>`,
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      text: text || html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    };
    if (replyTo) payload.reply_to = replyTo;
    // Resend accepts attachments as { filename, content: base64 }.
    if (Array.isArray(attachments) && attachments.length) {
      payload.attachments = attachments.map(a => ({
        filename: a.filename,
        content: Buffer.isBuffer(a.content) ? a.content.toString('base64') : a.content,
      }));
    }
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.ok) { console.log(`[mailer] sent "${subject}" to ${to}`); return true; }
    let detail = `HTTP ${res.status}`;
    try { const b = await res.json(); detail = b.message || b.error || JSON.stringify(b); } catch (e) {}
    console.error(`[mailer] failed to send to ${to}: ${detail}`);
    return false;
  } catch (err) {
    console.error(`[mailer] failed to send to ${to}: ${err.message}`);
    return false;
  }
}

const LOGO_URL = process.env.MAIL_LOGO_URL || 'https://app.flowguard.ng/fg-logo-light.png';

// ── Branded shell — logo top-left (always visible), clean white card ──
function shell(title, bodyHtml) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#eef2f4;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef2f4;padding:32px 0;">
    <tr><td align="center">
      <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 12px 32px rgba(18,34,43,.08);">
        <tr><td style="padding:24px 32px 0 32px;">
          <img src="${LOGO_URL}" alt="FlowGuard" height="34" style="height:34px;width:auto;display:block;border:0;">
        </td></tr>
        <tr><td style="padding:24px 32px 8px 32px;">
          <h1 style="margin:0;font-family:'Space Grotesk',Segoe UI,sans-serif;font-size:22px;font-weight:700;color:#12222b;letter-spacing:-.01em;">${title}</h1>
        </td></tr>
        <tr><td style="padding:8px 32px 28px 32px;">
          ${bodyHtml}
        </td></tr>
        <tr><td style="padding:20px 32px;border-top:1px solid #e2e9ed;">
          <p style="margin:0;font-size:12px;color:#8399a4;line-height:1.5;">© 2026 FlowGuard Solutions · Stratum Infrastructure Group<br>You received this email because an action was requested on your FlowGuard account.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function btn(url, label) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0;"><tr><td style="border-radius:100px;background:#0891b2;">
    <a href="${url}" style="display:inline-block;padding:13px 32px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;font-family:'Space Grotesk',Segoe UI,sans-serif;border-radius:100px;">${label}</a>
  </td></tr></table>`;
}
function p(txt) { return `<p style="margin:0 0 14px;font-size:14px;color:#4a626d;line-height:1.6;">${txt}</p>`; }
function muted(txt) { return `<p style="margin:0;font-size:13px;color:#8399a4;line-height:1.6;">${txt}</p>`; }

// ── 1. Password reset request ──────────────────────────────────
async function sendPasswordReset(to, resetUrl) {
  const body = p('We received a request to reset the password for your FlowGuard account. Click below to choose a new password. This link expires in <strong>1 hour</strong>.')
    + btn(resetUrl, 'Reset my password')
    + `<p style="margin:0 0 8px;font-size:13px;color:#4a626d;">If the button doesn't work, paste this link:</p><p style="margin:0 0 16px;font-size:12px;color:#0891b2;word-break:break-all;">${resetUrl}</p>`
    + muted("If you didn't request this, you can safely ignore this email — your password won't change.");
  return sendEmail({ to, subject: 'Reset your FlowGuard password', html: shell('Reset your password', body) });
}

// ── 2. Password changed confirmation (security) ────────────────
async function sendPasswordChanged(to, name) {
  const body = p(`Hi ${name || 'there'},`)
    + p('This is a confirmation that the password for your FlowGuard account was just changed.')
    + p("If you made this change, no action is needed.")
    + muted("If you did <strong>not</strong> change your password, your account may be at risk — please reset it immediately and contact us at info@flowguard.ng.");
  return sendEmail({ to, subject: 'Your FlowGuard password was changed', html: shell('Password changed', body) });
}

// ── 3. Welcome (on signup) — marketing welcome ─────────────────
async function sendWelcome(to, name) {
  const first = (name || '').split(' ')[0] || 'there';
  const body = p(`Hi ${first}, welcome to FlowGuard — we're glad you're here. 🎉`)
    + p("FlowGuard is Nigeria's first <strong>Drainage-as-a-Service</strong> platform. We keep your estates and communities flood-free through three connected layers: a <strong>Sentinel Network</strong> of IoT sensors that watch your drainage in real time, <strong>bio-enzyme treatment</strong> that prevents blockages before they start, and <strong>heavy-plant dispatch</strong> when the ground team is needed.")
    + `<p style="margin:0 0 10px;font-size:14px;font-weight:600;color:#12222b;">Here's where to start:</p>
       <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 18px;">
         <tr><td style="padding:8px 0;font-size:14px;color:#4a626d;line-height:1.5;">📍 <strong style="color:#12222b;">Add your first area</strong> — register an estate or property so we can begin assessment.</td></tr>
         <tr><td style="padding:8px 0;font-size:14px;color:#4a626d;line-height:1.5;">📊 <strong style="color:#12222b;">Explore live monitoring</strong> — see how flood-risk and sensor data appear once your devices are online.</td></tr>
         <tr><td style="padding:8px 0;font-size:14px;color:#4a626d;line-height:1.5;">🗺️ <strong style="color:#12222b;">Check the flood-risk map</strong> — view verified flood-prone zones across the Lekki–Ajah corridor.</td></tr>
       </table>`
    + btn(PORTAL_URL, 'Go to my portal')
    + p("<strong style=\"color:#12222b;\">What's coming:</strong> As your Sentinel devices come online, you'll get real-time flood alerts, automated inspection reports, and SLA-backed dispatch — all from your dashboard.")
    + muted("Questions or want a walkthrough? Just reply to this email or reach us at info@flowguard.ng — a real person will get back to you.");
  return sendEmail({ to, subject: `Welcome to FlowGuard, ${first} 🌊`, html: shell('Welcome to FlowGuard', body), replyTo: OPS_EMAIL });
}

// ── 4. Email verification ──────────────────────────────────────
async function sendVerification(to, verifyUrl) {
  const body = p('Thanks for signing up! Please confirm your email address to finish setting up your FlowGuard account.')
    + btn(verifyUrl, 'Verify my email')
    + `<p style="margin:0 0 8px;font-size:13px;color:#4a626d;">Or paste this link:</p><p style="margin:0 0 16px;font-size:12px;color:#0891b2;word-break:break-all;">${verifyUrl}</p>`
    + muted("If you didn't create a FlowGuard account, you can ignore this email.");
  return sendEmail({ to, subject: 'Confirm your FlowGuard email', html: shell('Verify your email', body) });
}

// ── 5. Property received (client confirmation) ─────────────────
async function sendPropertyReceived(to, name, propertyName, propertyId) {
  const link = propertyId ? `${PORTAL_URL}/#property/${encodeURIComponent(propertyId)}` : PORTAL_URL;
  const body = p(`Hi ${name || 'there'},`)
    + p(`We've received your submission for <strong>${propertyName || 'your property'}</strong>. Our operations team will review it and schedule an assessment shortly.`)
    + p("You can track its status any time from your portal.")
    + btn(link, 'View this property')
    + muted("We'll email you as your property moves through inspection, reporting, and deployment.");
  return sendEmail({ to, subject: `We received your submission — ${propertyName || 'your property'}`, html: shell('Submission received', body), replyTo: OPS_EMAIL });
}

// ── 6. Property status update (pipeline) ───────────────────────
const STATUS_COPY = {
  inspection_scheduled:  { t: 'Inspection scheduled',   m: 'Our team has scheduled an inspection for your property.' },
  inspection_ongoing:    { t: 'Inspection underway',    m: 'Our field team is currently assessing your property.' },
  report_ready:          { t: 'Your report is ready',   m: 'The assessment report for your property is now available.' },
  quote_sent:            { t: 'Quote sent',             m: 'We\'ve prepared a service quote for your property.' },
  payment_pending:       { t: 'Payment pending',        m: 'Your service quote is ready — complete payment to activate monitoring for your property.' },
  payment_completed:     { t: 'Payment confirmed',      m: 'Thank you — your payment has been confirmed.' },
  deployment_scheduled:  { t: 'Deployment scheduled',   m: 'Your Sentinel deployment has been scheduled.' },
  active:                { t: 'Monitoring active',      m: 'Your drainage monitoring is now live.' },
  suspended:             { t: 'Monitoring paused',      m: 'Monitoring for your property has been paused. Please contact us if this is unexpected.' },
  cancelled:             { t: 'Service cancelled',      m: 'Your FlowGuard service for this property has been cancelled.' },
};
async function sendStatusUpdate(to, name, propertyName, status, propertyId) {
  const c = STATUS_COPY[status] || { t: 'Status updated', m: `Your property status is now: ${status}.` };
  const link = propertyId ? `${PORTAL_URL}/#property/${encodeURIComponent(propertyId)}` : PORTAL_URL;
  const body = p(`Hi ${name || 'there'},`)
    + p(`<strong>${propertyName || 'Your property'}</strong>: ${c.m}`)
    + btn(link, 'View this property')
    + muted('Log in to your portal for full details.');
  return sendEmail({ to, subject: `${c.t} — ${propertyName || 'your property'}`, html: shell(c.t, body), replyTo: OPS_EMAIL });
}

// ── 7. Ops-team alert: new signup ──────────────────────────────
async function sendOpsNewSignup(user) {
  const body = p('<strong>New client signup</strong>')
    + `<table style="width:100%;font-size:13px;color:#4a626d;border-collapse:collapse;">
        <tr><td style="padding:4px 0;color:#8399a4;">Name</td><td style="padding:4px 0;">${user.full_name || '—'}</td></tr>
        <tr><td style="padding:4px 0;color:#8399a4;">Email</td><td style="padding:4px 0;">${user.email}</td></tr>
        <tr><td style="padding:4px 0;color:#8399a4;">Phone</td><td style="padding:4px 0;">${user.phone || '—'}</td></tr>
      </table>`;
  return sendEmail({ to: OPS_EMAIL, subject: `New signup: ${user.full_name || user.email}`, html: shell('New client signup', body) });
}

// ── 8. Ops-team alert: new property ────────────────────────────
async function sendOpsNewProperty(prop, submitter) {
  const body = p('<strong>New property / area submitted</strong>')
    + `<table style="width:100%;font-size:13px;color:#4a626d;border-collapse:collapse;">
        <tr><td style="padding:4px 0;color:#8399a4;">Property</td><td style="padding:4px 0;">${prop.property_name || '—'}</td></tr>
        <tr><td style="padding:4px 0;color:#8399a4;">Location</td><td style="padding:4px 0;">${prop.city || '—'}, ${prop.state || '—'}</td></tr>
        <tr><td style="padding:4px 0;color:#8399a4;">Submitted by</td><td style="padding:4px 0;">${submitter || '—'}</td></tr>
      </table>`
    + btn('https://neon.flowguard.ng', 'Open Ops Center');
  return sendEmail({ to: OPS_EMAIL, subject: `New property: ${prop.property_name || 'unnamed'}`, html: shell('New property submitted', body) });
}

// ── 9. Invoice issued to client (with PDF attached + pay CTA) ──
//   inv: { invoiceId, propertyName, total, balanceDue, dueDate, currency }
//   pdf: Buffer (optional) — attached as <invoiceId>.pdf
async function sendInvoice(to, name, inv, pdfBuffer) {
  const cur = inv.currency || '₦';
  const money = n => cur + Number(n || 0).toLocaleString('en-US');
  const payUrl = `${PORTAL_URL}/#billing`;
  const due = inv.dueDate ? new Date(inv.dueDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : null;
  const balance = inv.balanceDue != null ? inv.balanceDue : inv.total;
  const body = p(`Hi ${name || 'there'},`)
    + p(`Please find your FlowGuard invoice <strong>${inv.invoiceId}</strong>${inv.propertyName ? ` for <strong>${inv.propertyName}</strong>` : ''}${due ? `, due <strong>${due}</strong>` : ''}.`)
    + `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:6px 0 4px;border:1px solid #e2e9ed;border-radius:12px;">
         <tr><td style="padding:12px 16px;font-size:14px;color:#4a626d;">Total</td><td style="padding:12px 16px;font-size:14px;color:#12222b;font-weight:700;text-align:right;">${money(inv.total)}</td></tr>
         <tr><td style="padding:12px 16px;border-top:1px solid #eef2f4;font-size:14px;color:#4a626d;">Balance due</td><td style="padding:12px 16px;border-top:1px solid #eef2f4;font-size:14px;color:${balance > 0 ? '#d9463c' : '#1f9d5b'};font-weight:700;text-align:right;">${money(balance)}</td></tr>
       </table>`
    + btn(payUrl, 'Log in to make payment')
    + p(`${pdfBuffer ? 'A PDF copy of this invoice is attached. ' : ''}You can also review it and pay securely from your portal.`)
    + muted('Payment queries? Reply to this email or reach us at info@flowguard.ng.');
  return sendEmail({
    to,
    subject: `Invoice ${inv.invoiceId} from FlowGuard`,
    html: shell('Your invoice is ready', body),
    replyTo: OPS_EMAIL,
    attachments: pdfBuffer ? [{ filename: `${inv.invoiceId}.pdf`, content: pdfBuffer }] : undefined,
  });
}

// ── Email verification code (multi-step signup, before account exists) ──
async function sendEmailCode(to, code) {
  const codeHtml = `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0;"><tr>
    <td style="background:#f0fdfa;border:1px solid #cdeee9;border-radius:14px;padding:18px 28px;">
      <div style="font-family:'JetBrains Mono',Menlo,monospace;font-size:34px;font-weight:700;letter-spacing:10px;color:#0d9488;text-align:center;">${code}</div>
    </td></tr></table>`;
  const body = p('Use the code below to confirm your email address and continue creating your FlowGuard account.')
    + codeHtml
    + p('This code expires in <strong>10 minutes</strong>.')
    + muted("If you didn't start a FlowGuard signup, you can safely ignore this email.");
  return sendEmail({ to, subject: `${code} is your FlowGuard verification code`, html: shell('Verify your email', body) });
}

// ── Staff invite (role-based) ──────────────────────────────────
// Sent when an admin adds an internal team member. Portal + login URL are chosen
// by role: field technicians (field_lead) land in the Field Operations app;
// everyone else in the Operations Center.
async function sendStaffInvite(to, { fullName, roleLabel, portalName, portalUrl, setupUrl, inviterName } = {}) {
  const body = p(`Hi ${fullName || 'there'},`)
    + p(`${inviterName || 'Your team'} has added you to FlowGuard as <strong>${roleLabel || 'a team member'}</strong>. Your workspace is the <strong>${portalName}</strong>.`)
    + p('First, set your password:')
    + btn(setupUrl, 'Set your password')
    + p('Then sign in to your portal:')
    + `<p style="margin:0 0 16px;font-size:14px;"><a href="${portalUrl}" style="color:#0891b2;font-weight:600;word-break:break-all;">${portalUrl}</a></p>`
    + muted('This invite link expires in 7 days. If you weren’t expecting this, you can ignore this email.');
  return sendEmail({ to, subject: `You’ve been added to ${portalName}`, html: shell(`Welcome to ${portalName}`, body), replyTo: OPS_EMAIL });
}

module.exports = {
  sendEmail, shell,
  sendPasswordReset, sendPasswordChanged,
  sendWelcome, sendVerification, sendEmailCode,
  sendPropertyReceived, sendStatusUpdate,
  sendOpsNewSignup, sendOpsNewProperty,
  sendInvoice, sendStaffInvite,
};
