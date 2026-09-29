// Server-only: emails form submissions to the team inbox through Resend
// (resend.com), so every inquiry and application arrives even if Crelate
// rejects it.
//
// Configuration (Vercel → Settings → Environment Variables):
//   RESEND_API_KEY  required to send; from resend.com → API Keys
//   MAIL_TO         optional; defaults to site.email (info@technicalsource.com)
//   RESEND_API_URL  local testing only (a stand-in server)
//   MAIL_FROM       optional; defaults to Resend's test sender. Until the
//                   technicalsource.com domain is verified in Resend, the test
//                   sender can only deliver to the email the Resend account
//                   was created with, so sign up with MAIL_TO's address.
import { site } from './data/site';

export const mailConfigured = () => Boolean(process.env.RESEND_API_KEY);

export async function sendMail(msg: {
  subject: string;
  text: string;
  replyTo?: string;
  attachments?: { filename: string; content: ArrayBuffer }[];
}): Promise<void> {
  const res = await fetch(process.env.RESEND_API_URL || 'https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.MAIL_FROM || 'Technical Source Website <onboarding@resend.dev>',
      to: (process.env.MAIL_TO || site.email).split(',').map((s) => s.trim()).filter(Boolean),
      subject: msg.subject,
      text: msg.text,
      ...(msg.replyTo && { reply_to: msg.replyTo }),
      ...(msg.attachments?.length && {
        attachments: msg.attachments.map((a) => ({ filename: a.filename, content: Buffer.from(a.content).toString('base64') })),
      }),
    }),
  });
  if (!res.ok) throw new Error(`Resend responded ${res.status}: ${(await res.text()).slice(0, 300)}`);
}
