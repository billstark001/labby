/**
 * Email subsystem.
 *
 * Wraps nodemailer with a simple send interface.
 * Configure via environment variables or by calling `configureMailer()`.
 */

import nodemailer, { type Transporter, type SendMailOptions } from 'nodemailer';

import { loadGoogleOAuthClientFromFile } from './google.js';

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
  mode: 'gmail';
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
  text?: string;
  html?: string;
  attachments?: MailAttachment[];
}

export class Mailer {
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor(options: MailerOptions) {
    this.from = options.from;
    this.transporter = options.mode === 'gmail'
      ? nodemailer.createTransport({
        service: 'gmail',
        auth: {
          type: 'OAuth2',
          user: options.user,
          clientId: options.clientId,
          clientSecret: options.clientSecret,
          refreshToken: options.refreshToken,
        },
      })
      : nodemailer.createTransport({
        host: options.host,
        port: options.port,
        secure: options.secure,
        auth: {
          user: options.user,
          pass: options.password,
        },
      });
  }

  async send(input: SendMailInput): Promise<void> {
    const mailOptions: SendMailOptions = {
      from: this.from,
      to: Array.isArray(input.to) ? input.to.join(', ') : input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
      attachments: input.attachments,
    };
    await this.transporter.sendMail(mailOptions);
  }

  /** Verify the SMTP connection (useful for startup health checks). */
  async verify(): Promise<boolean> {
    try {
      await this.transporter.verify();
      return true;
    } catch {
      return false;
    }
  }
}

/** Create a Mailer instance from environment variables. Returns null if SMTP is not configured. */
export function createMailerFromEnv(): Mailer | null {
  const provider = (process.env.SMTP_PROVIDER ?? '').trim().toLowerCase();
  const googleOAuthJsonPath = process.env.GOOGLE_OAUTH_JSON_PATH?.trim();
  const gmailUser = process.env.GMAIL_USER?.trim() ?? process.env.SMTP_USER?.trim();
  const gmailRefreshToken = process.env.GMAIL_REFRESH_TOKEN?.trim() ?? process.env.GOOGLE_OAUTH_REFRESH_TOKEN?.trim();

  if (provider === 'gmail' || (!process.env.SMTP_HOST?.trim() && gmailUser && gmailRefreshToken)) {
    const googleClient = googleOAuthJsonPath ? loadGoogleOAuthClientFromFile(googleOAuthJsonPath) : null;
    const clientId = googleClient?.clientId;
    const clientSecret = googleClient?.clientSecret;
    const from = process.env.SMTP_FROM?.trim() ?? gmailUser;

    if (!gmailUser || !gmailRefreshToken || !clientId || !clientSecret || !from) {
      return null;
    }

    return new Mailer({
      mode: 'gmail',
      user: gmailUser,
      from,
      clientId,
      clientSecret,
      refreshToken: gmailRefreshToken,
    });
  }

  const host = process.env.SMTP_HOST?.trim();
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
