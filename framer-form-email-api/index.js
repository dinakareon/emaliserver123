// index.js
import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { Resend } from 'resend';

const app = express();

/* ---------- Security & basics ---------- */
app.use(helmet());

// Accept JSON and URL-encoded payloads (Framer can send either)
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true }));

// Simple CORS: allow your Framer site(s) or allow all if not provided
const corsOrigins =
  process.env.CORS_ORIGIN?.split(',').map(s => s.trim()).filter(Boolean);
app.use(
  cors({
    origin: corsOrigins?.length ? corsOrigins : '*',
  })
);

// Helpful if behind a proxy (Render)
app.set('trust proxy', 1);

// Rate limit to avoid spam
app.use(
  '/api/',
  rateLimit({
    windowMs: 60 * 1000,
    limit: 30, // 30 req/min/IP
    standardHeaders: true,
    legacyHeaders: false,
  })
);

/* ---------- Health & root ---------- */
app.get('/', (req, res) => res.send('API is running'));
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

/* ---------- Email client ---------- */
const resendKey = process.env.RESEND_API_KEY;
const FROM = process.env.MAIL_FROM; // e.g., onboarding@resend.dev (for testing)
const TO = process.env.MAIL_TO;     // where owner notification goes

if (!resendKey || !FROM || !TO) {
  console.warn(
    '[WARN] Missing one of RESEND_API_KEY / MAIL_FROM / MAIL_TO in environment variables.'
  );
}
const resend = new Resend(resendKey);

/* ---------- Utils ---------- */
// Escape minimal HTML
const esc = s =>
  String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

// Normalize incoming keys to lowercase (Name → name, Email → email, etc.)
const normalize = obj => {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    const kk = String(k).toLowerCase();
    out[kk] = typeof v === 'string' ? v : JSON.stringify(v);
  }
  return out;
};

/* ---------- Flexible schema (works with Name/Email/Location only) ---------- */
const Payload = z
  .object({
    name: z.string().min(1).max(120).optional(),
    email: z.string().email(),
    subject: z.string().max(160).optional(),
    message: z.string().max(5000).optional(),
    page: z.string().optional(),
    location: z.string().optional(),
  })
  .passthrough(); // keep any extra fields the form might send

/* ---------- Main endpoint ---------- */
app.post('/api/form/submit', async (req, res) => {
  try {
    // Uncomment to inspect raw payload in logs during debugging:
    // console.log('[Incoming body]', req.headers['content-type'], req.body);

    const body = normalize(req.body);
    const data = Payload.parse(body);

    const subject = (data.subject || 'Website Inquiry').trim();
    const name = (data.name || 'Visitor').trim();

    // Build a message: if `message` absent, compile all submitted fields
    const message =
      (data.message && data.message.trim()) ||
      Object.entries(body)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n');

    // Owner email (to your inbox)
    const ownerHtml = `
      <div style="font-family:system-ui,Segoe UI,Arial,sans-serif">
        <h2>New form submission</h2>
        <p><b>Name:</b> ${esc(name)}</p>
        <p><b>Email:</b> ${esc(data.email)}</p>
        ${data.location ? `<p><b>Location:</b> ${esc(data.location)}</p>` : ''}
        ${data.page ? `<p><b>Page:</b> ${esc(data.page)}</p>` : ''}
        <p><b>Subject:</b> ${esc(subject)}</p>
        <p><b>Message / Fields:</b><br/>${esc(message).replaceAll('\n','<br/>')}</p>
      </div>`;

    await resend.emails.send({
      from: FROM,
      to: TO,
      replyTo: data.email, // use 'replyTo' (works with the 'resend' npm client)
      subject: `📝 New form submission: ${subject}`,
      html: ownerHtml,
    });

    // Auto-reply to the user
    const userHtml = `
      <div style="font-family:system-ui,Segoe UI,Arial,sans-serif">
        <p>Hi ${esc(name)},</p>
        <p>Thanks for reaching out. We received your submission and will get back to you shortly.</p>
        <hr>
        <p><b>Your submission</b></p>
        <pre style="white-space:pre-wrap">${esc(message)}</pre>
        <p>— Team</p>
      </div>`;

    await resend.emails.send({
      from: FROM,
      to: data.email,
      subject: `We got your message: ${subject}`,
      html: userHtml,
    });

    res.json({ ok: true });
  } catch (err) {
    if (err?.name === 'ZodError') {
      return res
        .status(400)
        .json({ ok: false, error: 'ValidationError', details: err.flatten() });
    }
    console.error('[ServerError]', err);
    res.status(500).json({ ok: false, error: 'ServerError' });
  }
});

/* ---------- Start server ---------- */
const port = Number(process.env.PORT || 10000);
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
