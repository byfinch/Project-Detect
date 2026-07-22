/**
 * SendGrid v3 mail helper (native fetch — no extra npm dependency).
 * API key: SENDGRID_API_KEY or config.report.sendgridApiKey
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { logger } from "../logger.js";

export interface SendGridAttachment {
  path: string;
  /** mime type */
  type?: string;
  filename?: string;
}

export interface SendReportMailOpts {
  apiKey: string;
  from: string;
  to: string[];
  subject: string;
  html: string;
  text?: string;
  attachments?: SendGridAttachment[];
}

function guessMime(filename: string): string {
  if (filename.endsWith(".csv")) return "text/csv";
  if (filename.endsWith(".json")) return "application/json";
  if (filename.endsWith(".txt")) return "text/plain";
  if (filename.endsWith(".html")) return "text/html";
  return "application/octet-stream";
}

export async function sendViaSendGrid(opts: SendReportMailOpts): Promise<{
  ok: boolean;
  status: number;
  body: string;
}> {
  if (!opts.apiKey) {
    return { ok: false, status: 0, body: "SENDGRID_API_KEY missing" };
  }
  if (!opts.to.length) {
    return { ok: false, status: 0, body: "no recipients" };
  }

  const attachments =
    opts.attachments?.map((a) => {
      const buf = readFileSync(a.path);
      const filename = a.filename || basename(a.path);
      return {
        content: buf.toString("base64"),
        filename,
        type: a.type || guessMime(filename),
        disposition: "attachment",
      };
    }) ?? [];

  const payload = {
    personalizations: [
      {
        to: opts.to.map((email) => ({ email: email.trim() })).filter((t) => t.email),
      },
    ],
    from: { email: opts.from },
    subject: opts.subject,
    content: [
      ...(opts.text ? [{ type: "text/plain", value: opts.text }] : []),
      { type: "text/html", value: opts.html },
    ],
    ...(attachments.length ? { attachments } : {}),
  };

  const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const body = await res.text().catch(() => "");
  if (!res.ok) {
    logger.warn({ status: res.status, body: body.slice(0, 400) }, "SendGrid send failed");
  } else {
    logger.info({ to: opts.to, subject: opts.subject }, "SendGrid mail sent");
  }
  return { ok: res.ok, status: res.status, body };
}
