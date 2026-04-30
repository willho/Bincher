import { db } from "./db";
import { users } from "@shared/schema";
import { eq } from "drizzle-orm";

export interface EmailProvider {
  send(options: EmailOptions): Promise<boolean>;
}

export interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

interface SmtpConfig {
  host: string;
  port: number;
  user?: string;
  pass?: string;
  secure?: boolean;
}

class ResendProvider implements EmailProvider {
  constructor(private apiKey: string, private fromAddress: string) {}

  async send(options: EmailOptions): Promise<boolean> {
    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          from: this.fromAddress,
          to: options.to,
          subject: options.subject,
          html: options.html,
          text: options.text
        })
      });
      return response.ok;
    } catch (error) {
      console.error("Resend error:", error);
      return false;
    }
  }
}

class SendGridProvider implements EmailProvider {
  constructor(private apiKey: string, private fromAddress: string) {}

  async send(options: EmailOptions): Promise<boolean> {
    try {
      const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: options.to }] }],
          from: { email: this.fromAddress },
          subject: options.subject,
          content: [
            { type: "text/plain", value: options.text || options.subject },
            { type: "text/html", value: options.html }
          ]
        })
      });
      return response.ok;
    } catch (error) {
      console.error("SendGrid error:", error);
      return false;
    }
  }
}

class MailgunProvider implements EmailProvider {
  constructor(private apiKey: string, private fromAddress: string) {}

  async send(options: EmailOptions): Promise<boolean> {
    try {
      const domain = this.fromAddress.split("@")[1];
      const formData = new URLSearchParams();
      formData.append("from", this.fromAddress);
      formData.append("to", options.to);
      formData.append("subject", options.subject);
      formData.append("html", options.html);
      if (options.text) formData.append("text", options.text);

      const response = await fetch(`https://api.mailgun.net/v3/${domain}/messages`, {
        method: "POST",
        headers: {
          "Authorization": `Basic ${Buffer.from(`api:${this.apiKey}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: formData.toString()
      });
      return response.ok;
    } catch (error) {
      console.error("Mailgun error:", error);
      return false;
    }
  }
}

class SmtpProvider implements EmailProvider {
  constructor(private config: SmtpConfig, private fromAddress: string) {}

  async send(options: EmailOptions): Promise<boolean> {
    try {
      const nodemailer = await import("nodemailer");
      const transporter = nodemailer.createTransport({
        host: this.config.host,
        port: this.config.port,
        secure: this.config.secure ?? this.config.port === 465,
        auth: this.config.user && this.config.pass ? {
          user: this.config.user,
          pass: this.config.pass
        } : undefined
      });

      await transporter.sendMail({
        from: this.fromAddress,
        to: options.to,
        subject: options.subject,
        html: options.html,
        text: options.text
      });
      return true;
    } catch (error) {
      console.error("SMTP error:", error);
      return false;
    }
  }
}

export class EmailService {
  private static providers = new Map<number, EmailProvider>();

  static async getProviderForUser(userId: number): Promise<EmailProvider | null> {
    const cached = this.providers.get(userId);
    if (cached) return cached;

    const [user] = await db.select({
      emailProvider: users.emailProvider,
      emailApiKey: users.emailApiKey,
      emailFromAddress: users.emailFromAddress,
      smtpConfig: users.smtpConfig
    }).from(users).where(eq(users.id, userId));

    if (!user || !user.emailProvider || !user.emailFromAddress) {
      return null;
    }

    let provider: EmailProvider | null = null;

    switch (user.emailProvider) {
      case "resend":
        if (user.emailApiKey) {
          provider = new ResendProvider(user.emailApiKey, user.emailFromAddress);
        }
        break;
      case "sendgrid":
        if (user.emailApiKey) {
          provider = new SendGridProvider(user.emailApiKey, user.emailFromAddress);
        }
        break;
      case "mailgun":
        if (user.emailApiKey) {
          provider = new MailgunProvider(user.emailApiKey, user.emailFromAddress);
        }
        break;
      case "smtp":
        if (user.smtpConfig) {
          const config = user.smtpConfig as SmtpConfig;
          provider = new SmtpProvider(config, user.emailFromAddress);
        }
        break;
    }

    if (provider) {
      this.providers.set(userId, provider);
    }
    return provider;
  }

  static async sendAlert(userId: number, subject: string, html: string, text?: string): Promise<boolean> {
    const [user] = await db.select({
      recoveryEmail: users.recoveryEmail
    }).from(users).where(eq(users.id, userId));

    if (!user?.recoveryEmail) {
      console.log("No recovery email configured for user", userId);
      return false;
    }

    const provider = await this.getProviderForUser(userId);
    if (!provider) {
      console.log("No email provider configured for user", userId);
      return false;
    }

    return provider.send({
      to: user.recoveryEmail,
      subject,
      html,
      text
    });
  }

  static clearCache(userId: number) {
    this.providers.delete(userId);
  }
}
