/**
 * Email subsystem.
 *
 * Wraps nodemailer with a simple send interface.
 * Configure via environment variables or by calling `configureMailer()`.
 */

import nodemailer, { type Transporter, type SendMailOptions } from 'nodemailer';

export interface MailerOptions {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  from: string;
}

export interface SendMailInput {
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
}

export class Mailer {
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor(options: MailerOptions) {
    this.from = options.from;
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

  async send(input: SendMailInput): Promise<void> {
    const mailOptions: SendMailOptions = {
      from: this.from,
      to: Array.isArray(input.to) ? input.to.join(', ') : input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
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
  const host = process.env.SMTP_HOST?.trim();
  const user = process.env.SMTP_USER?.trim();
  const password = process.env.SMTP_PASSWORD?.trim();
  const from = process.env.SMTP_FROM?.trim();

  if (!host || !user || !password || !from) {
    return null;
  }

  return new Mailer({
    host,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: (process.env.SMTP_SECURE ?? 'false').toLowerCase() === 'true',
    user,
    password,
    from,
  });
}
