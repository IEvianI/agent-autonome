import { basename } from "node:path";
import nodemailer, { type Transporter } from "nodemailer";

export type Email = { to: string; subject: string; text: string; attachmentPath?: string };

export type Mailer = {
  /** Adresse d'envoi, affichée à l'administrateur avant validation. */
  from: string;
  send(email: Email): Promise<{ messageId: string }>;
};

/**
 * Envoi par SMTP depuis la boîte du candidat (Gmail : mot de passe d'application,
 * https://myaccount.google.com/apppasswords). Les réponses arrivent donc directement chez lui.
 */
export function mailerFromEnv(): Mailer {
  const { SMTP_HOST = "smtp.gmail.com", SMTP_PORT = "465", SMTP_USER, SMTP_PASSWORD, SMTP_FROM_NAME } = process.env;
  let transport: Transporter | undefined;

  return {
    from: SMTP_USER ?? "(SMTP_USER non configuré)",
    async send(email) {
      if (!SMTP_USER || !SMTP_PASSWORD) {
        throw new Error("Envoi d'e-mails non configuré : SMTP_USER et SMTP_PASSWORD sont requis.");
      }
      transport ??= nodemailer.createTransport({
        host: SMTP_HOST,
        port: Number(SMTP_PORT),
        secure: Number(SMTP_PORT) === 465,
        auth: { user: SMTP_USER, pass: SMTP_PASSWORD },
      });
      const info = await transport.sendMail({
        from: SMTP_FROM_NAME ? { name: SMTP_FROM_NAME, address: SMTP_USER } : SMTP_USER,
        to: email.to,
        subject: email.subject,
        text: email.text,
        attachments: email.attachmentPath
          ? [{ filename: basename(email.attachmentPath), path: email.attachmentPath }]
          : undefined,
      });
      return { messageId: info.messageId };
    },
  };
}
