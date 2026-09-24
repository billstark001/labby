/**
 * Email subsystem.
 *
 * Wraps nodemailer with a simple send interface.
 * Configure via environment variables or by calling `configureMailer()`.
 */

import nodemailer, { type Transporter, type SendMailOptions } from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer';

import { fetchGoogleAccessToken, resolveGoogleOAuthCredentials } from './google.js';

const GMAIL_API_TIMEOUT_MS = 60_000;
const GMAIL_API_BASE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me';

export interface SmtpMailerOptions {
  mode: 'smtp';
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  from: string;
}

export interface GmailMailerOptions {
  mode: 'gmail' | 'gmail-api';
  user: string;
  from: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export type MailerOptions = SmtpMailerOptions | GmailMailerOptions;

export interface MailAttachment {
  filename: string;
  content: Buffer | string;
  contentType?: string;
}

export interface SendMailInput {
  to: string | string[];
  subject: string;
  fromName?: string;
  text?: string;
  html?: string;
  attachments?: MailAttachment[];
}

export class Mailer {
  private readonly transporter?: Transporter;
  private readonly gmailApi?: GmailMailerOptions;
  private readonly from: string;

  constructor(options: MailerOptions) {
    this.from = options.from;
    if (options.mode === 'gmail-api') {
      this.gmailApi = options;
    } else if (options.mode === 'gmail') {
      this.transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          type: 'OAuth2',
          user: options.user,
          clientId: options.clientId,
          clientSecret: options.clientSecret,
          refreshToken: options.refreshToken,
        },
      });
    } else if (options.mode === 'smtp') {
      this.transporter = nodemailer.createTransport({
        host: options.host,
        port: options.port,
        secure: options.secure,
        auth: {
          user: options.user,
          pass: options.password,
        },
      });
    }
  }

  private async gmailAccessToken(signal: AbortSignal): Promise<string> {
    const credentials = this.gmailApi;
    if (!credentials) throw new Error('Gmail API mailer is not configured');
    return fetchGoogleAccessToken({
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      refreshToken: credentials.refreshToken,
      signal,
    });
  }

  async send(input: SendMailInput): Promise<void> {
    const mailOptions: SendMailOptions = {
      from: buildFromHeader(this.from, input.fromName),
      to: Array.isArray(input.to) ? input.to.join(', ') : input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
      attachments: input.attachments,
    };
    if (this.gmailApi) {
      const signal = AbortSignal.timeout(GMAIL_API_TIMEOUT_MS);
      const raw = await new MailComposer(mailOptions).compile().build();
      const accessToken = await this.gmailAccessToken(signal);
      const response = await fetch(`${GMAIL_API_BASE_URL}/messages/send`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ raw: raw.toString('base64url') }),
        signal,
      });
      if (!response.ok) {
        throw new Error(`Gmail API send failed with status ${response.status}`);
      }
      return;
    }
    await this.transporter!.sendMail(mailOptions);
  }

  /** Verify the configured mail transport without sending a message. */
  async verify(): Promise<boolean> {
    try {
      if (this.gmailApi) {
        const signal = AbortSignal.timeout(GMAIL_API_TIMEOUT_MS);
        const accessToken = await this.gmailAccessToken(signal);
        const response = await fetch(`${GMAIL_API_BASE_URL}/profile`, {
          headers: { authorization: `Bearer ${accessToken}` },
          signal,
        });
        if (!response.ok) return false;
        const profile = await response.json() as { emailAddress?: string };
        return profile.emailAddress?.toLowerCase() === this.gmailApi.user.toLowerCase();
      }
      await this.transporter!.verify();
      return true;
    } catch {
      return false;
    }
  }
}

function extractFromAddress(from: string): string {
  const trimmed = from.trim();
  const angleMatch = trimmed.match(/<([^<>]+)>/);
  if (angleMatch?.[1]) {
    return angleMatch[1].trim();
  }
  return trimmed;
}

function escapeDisplayName(input: string): string {
  return input.replace(/"/g, '\\"').trim();
}

function buildFromHeader(defaultFrom: string, fromName: string | undefined): string {
  const normalizedName = fromName?.trim();
  if (!normalizedName) {
    return defaultFrom;
  }

  const address = extractFromAddress(defaultFrom);
  return `"${escapeDisplayName(normalizedName)}" <${address}>`;
}

/** Create a Mailer instance from environment variables. Returns null if mail is not configured. */
export function createMailerFromEnv(): Mailer | null {
  const provider = (process.env.SMTP_PROVIDER ?? '').trim().toLowerCase();
  const gmailUser = process.env.GMAIL_USER?.trim() ?? process.env.SMTP_USER?.trim();
  const smtpHost = process.env.SMTP_HOST?.trim();
  const googleTokenConfigured = Boolean(
    process.env.GMAIL_REFRESH_TOKEN?.trim()
    || process.env.GOOGLE_OAUTH_REFRESH_TOKEN?.trim()
    || process.env.GOOGLE_OAUTH_REFRESH_TOKEN_PATH?.trim(),
  );
  const useGmail = provider === 'gmail' || provider === 'gmail-api' || (!smtpHost && gmailUser && googleTokenConfigured);

  if (useGmail) {
    const googleCredentials = resolveGoogleOAuthCredentials({
      refreshTokenKeys: ['GMAIL_REFRESH_TOKEN', 'GOOGLE_OAUTH_REFRESH_TOKEN'],
    });
    const from = process.env.SMTP_FROM?.trim() ?? gmailUser;

    if (!gmailUser || !googleCredentials || !from) {
      return null;
    }


    return new Mailer({
      mode: provider === 'gmail-api' ? 'gmail-api' : 'gmail',
      user: gmailUser,
      from,
      clientId: googleCredentials.clientId,
      clientSecret: googleCredentials.clientSecret,
      refreshToken: googleCredentials.refreshToken,
    });
  }

  const host = smtpHost;
  const user = process.env.SMTP_USER?.trim();
  const password = process.env.SMTP_PASSWORD?.trim();
  const from = process.env.SMTP_FROM?.trim();

  if (!host || !user || !password || !from) {
    return null;
  }

  return new Mailer({
    mode: 'smtp',
    host,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: (process.env.SMTP_SECURE ?? 'false').toLowerCase() === 'true',
    user,
    password,
    from,
  });
}
