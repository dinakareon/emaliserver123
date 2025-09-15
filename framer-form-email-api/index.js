import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { Resend } from 'resend';

const app = express();

// --- security & basics ---
app.use(helmet());
app.use(express.json({ limit: '100kb' }));
app.use(cors({
  origin: process.env.CORS_ORIGIN?.split(',').map(s => s.trim()) || '*',
}));
app.set('trust proxy', 1);

const limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
});
app.use('/api/', limiter);

// --- health ---
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// --- payload schema ---
const Payload = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email(),
  subject: z.string().min(1).max(160),
  message: z.string().min(1).max(5000),
  page: z.string().optional(),
});

// --- email client ---
const resend = new Resend(process.env.RESEND_API_KEY);
const FROM = process.env.MAIL_FROM;
const TO = process.env.MAIL_TO;

// utility: escape HTML
const esc = (s) => String(s)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;');

app.post('/api/form/submit', async (req, res) => {
  try {
    const data = Payload.parse(req.body);

    // send owner notification
    const ownerHtml = `
      <div style="font-family:system-ui,Segoe UI,Arial,sans-serif">
        <h2>New form submission</h2>
        <p><b>Name:</b> ${esc(data.name)}</p>
        <p><b>Email:</b> ${esc(data.email)}</p>
        <p><b>Subject:</b> ${esc(data.subject)}</p>
        <p><b>Message:</b><br/>${esc(data.message).replaceAll('\n','<br/>')}</p>
        ${data.page ? `<p><b>From Page:</b> ${esc(data.page)}</p>`: ''}
      </div>`;

    await resend.emails.send({
      from: FROM,
      to: TO,
      replyTo: data.email,
      subject: `📝 New form submission: ${data.subject}`,
      html: ownerHtml,
    });

    // send auto-reply
    await resend.emails.send({
      from: FROM,
      to: data.email,
      subject: `We got your message: ${data.subject}`,
      html: `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif">
        <p>Hi ${esc(data.name)},</p>
        <p>Thanks for reaching out. We received your message and will get back to you shortly.</p>
        <hr>
        <p><b>Your message</b></p>
        <pre style="white-space:pre-wrap">${esc(data.message)}</pre>
        <p>— Team</p></div>`
    });

    res.json({ ok: true });
  } catch (err) {
    if (err?.name === 'ZodError') {
      return res.status(400).json({ ok: false, error: 'ValidationError', details: err.flatten() });
    }
    console.error(err);
    res.status(500).json({ ok: false, error: 'ServerError' });
  }
});

const port = Number(process.env.PORT || 10000);
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
