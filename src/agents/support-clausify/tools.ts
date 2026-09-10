import { z } from "zod";
import { defineTool, type ToolContext } from "../../core/tool";
import { db, outbox, stripe } from "./fake-backend";

function sessionUser(ctx: ToolContext) {
  const user = db.users.find((u) => u.email === ctx.userEmail);
  if (!user) throw new Error("Aucun compte Clausify pour l'utilisateur de la session.");
  return user;
}

export const getAccount = defineTool({
  name: "get_account",
  description:
    "Lit le compte Clausify de l'utilisateur connecté : plan actuel et nombre de documents encore filigranés.",
  schema: z.object({}),
  execute: async (_input, ctx) => {
    const user = sessionUser(ctx);
    return { email: user.email, plan: user.plan, watermarkedDocuments: user.watermarkedDocuments };
  },
});

export const getStripeSubscription = defineTool({
  name: "get_stripe_subscription",
  description:
    "Lit l'abonnement Stripe de l'utilisateur connecté : statut, plan payé et metadata du checkout. " +
    "Le webhook n'active le compte que si userId et plan figurent dans ces metadata.",
  schema: z.object({}),
  execute: async (_input, ctx) => {
    const sub = stripe.subscriptions.find((s) => s.customerEmail === ctx.userEmail);
    if (!sub) return { found: false };
    return { found: true, status: sub.status, plan: sub.plan, checkoutMetadata: sub.checkoutMetadata };
  },
});

export const fixUserEntitlements = defineTool({
  name: "fix_user_entitlements",
  description:
    "Aligne le compte Clausify sur l'abonnement Stripe payé : applique le plan et retire les filigranes. " +
    "Action critique soumise à validation humaine.",
  schema: z.object({
    plan: z.enum(["PRO", "BUSINESS"]),
    reason: z.string().describe("Diagnostic en une phrase, lu par l'administrateur qui valide."),
  }),
  requiresApproval: true,
  summarize: ({ plan, reason }, ctx) =>
    `Passer ${ctx.userEmail} en ${plan} et retirer ses filigranes. Motif : ${reason}`,
  execute: async ({ plan }, ctx) => {
    const user = sessionUser(ctx);
    // Même validé par un humain, on n'accorde jamais un plan que Stripe ne confirme pas.
    const sub = stripe.subscriptions.find((s) => s.customerEmail === user.email && s.status === "active");
    if (sub?.plan !== plan) {
      throw new Error(`Refusé : aucun abonnement ${plan} actif sur Stripe pour ce compte.`);
    }
    user.plan = plan;
    user.watermarkedDocuments = 0;
    return { email: user.email, plan: user.plan, watermarkedDocuments: user.watermarkedDocuments };
  },
});

export const sendEmailToUser = defineTool({
  name: "send_email_to_user",
  description: "Envoie un e-mail à l'utilisateur connecté. Le destinataire est imposé par la session.",
  schema: z.object({ subject: z.string(), body: z.string() }),
  execute: async ({ subject, body }, ctx) => {
    outbox.push({ to: ctx.userEmail, subject, body });
    return { sent: true, to: ctx.userEmail };
  },
});
