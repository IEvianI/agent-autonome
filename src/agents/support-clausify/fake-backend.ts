// Simulation de la BDD Clausify et de Stripe pour l'étape 1.
// Le scénario reproduit un vrai trou du webhook Clausify : checkout payé mais
// metadata.userId absente, le webhook répond 200 sans rien faire, le compte reste en FREE.

export type Plan = "FREE" | "PRO" | "BUSINESS";

type FakeUser = { id: string; email: string; plan: Plan; watermarkedDocuments: number };

type FakeSubscription = {
  customerEmail: string;
  status: "active" | "canceled";
  plan: Exclude<Plan, "FREE">;
  checkoutMetadata: Record<string, string>;
};

export const db = { users: [] as FakeUser[] };
export const stripe = { subscriptions: [] as FakeSubscription[] };
export const outbox: { to: string; subject: string; body: string }[] = [];

export function resetFakeBackend() {
  db.users = [
    { id: "usr_evan", email: "evan@example.com", plan: "FREE", watermarkedDocuments: 3 },
    { id: "usr_lea", email: "lea@example.com", plan: "FREE", watermarkedDocuments: 1 },
  ];
  stripe.subscriptions = [
    { customerEmail: "evan@example.com", status: "active", plan: "PRO", checkoutMetadata: {} },
  ];
  outbox.length = 0;
}

resetFakeBackend();
