import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryHistory, type SentApplication } from "./history";
import { createLaBonneBoiteClient, type LaBonneBoiteClient } from "./labonneboite";
import type { Email, Mailer } from "./mailer";
import { createCandidaturesTools } from "./tools";

function fakeMailer() {
  const outbox: Email[] = [];
  const mailer: Mailer = {
    from: "evan@example.com",
    async send(email) {
      outbox.push(email);
      return { messageId: `<${outbox.length}@test>` };
    },
  };
  return { mailer, outbox };
}

const noSearch: LaBonneBoiteClient = {
  async search() {
    throw new Error("search non prévu");
  },
};

function setup(sent: SentApplication[] = [], maxPerDay = 10) {
  const { mailer, outbox } = fakeMailer();
  const history = memoryHistory(sent);
  const tools = createCandidaturesTools({
    laBonneBoite: noSearch,
    mailer,
    history,
    readProfile: async () => "profil",
    cvPath: "data/cv.pdf",
    maxPerDay,
    now: () => new Date("2026-10-23T09:00:00Z"),
  });
  const sendApplication = tools.find((tool) => tool.name === "send_application")!;
  return { sendApplication, outbox, history };
}

const application = {
  siret: "12345678900012",
  companyName: "Studio Web Nantais",
  to: "jobs@studio.example",
  contactSource: "https://studio.example/carrieres",
  subject: "Candidature spontanée — développeur web",
  body: "Bonjour, ".padEnd(400, "x"),
};

const sentEntry = (overrides: Partial<SentApplication> = {}): SentApplication => ({
  siret: "99999999900011",
  companyName: "Autre",
  to: "rh@autre.example",
  subject: "…",
  sentAt: "2026-10-01T10:00:00.000Z",
  ...overrides,
});

test("le résumé montre le destinataire, la source de l'adresse et la lettre entière", async () => {
  const { sendApplication } = setup();

  const summary = await sendApplication.summarize(application, {});

  assert.match(summary, /Candidature à Studio Web Nantais/);
  assert.match(summary, /De : evan@example\.com {2}→ {2}À : jobs@studio\.example/);
  assert.match(summary, /Adresse trouvée sur : https:\/\/studio\.example\/carrieres/);
  assert.ok(summary.includes(application.body));
  assert.match(summary, /\(400\/1500 caractères\)/);
});

test("une candidature approuvée part avec le CV et entre dans l'historique", async () => {
  const { sendApplication, outbox, history } = setup();

  const result = await sendApplication.execute(application, {});

  assert.deepEqual(outbox, [
    { to: application.to, subject: application.subject, text: application.body, attachmentPath: "data/cv.pdf" },
  ]);
  assert.deepEqual(result, { sent: true, messageId: "<1@test>", remainingToday: 9 });
  assert.equal((await history.list()).at(-1)?.siret, application.siret);
});

test("une entreprise déjà contactée, même par un autre établissement, ne reçoit rien", async () => {
  // Même SIREN (9 premiers chiffres), autre établissement.
  const { sendApplication, outbox } = setup([sentEntry({ siret: "12345678900099" })]);

  await assert.rejects(sendApplication.execute(application, {}), /déjà reçu une candidature le 2026-10-01/);
  assert.equal(outbox.length, 0);
  assert.match(await sendApplication.summarize(application, {}), /⚠ Déjà contactée/);
});

test("la même adresse e-mail n'est pas réutilisée, quelle que soit la casse", async () => {
  const { sendApplication, outbox } = setup([sentEntry({ to: "JOBS@studio.example" })]);

  await assert.rejects(sendApplication.execute(application, {}), /déjà reçu/);
  assert.equal(outbox.length, 0);
});

test("la limite quotidienne bloque l'envoi", async () => {
  const today = sentEntry({ sentAt: "2026-10-23T08:00:00.000Z" });
  const { sendApplication, outbox } = setup([today], 1);

  await assert.rejects(sendApplication.execute(application, {}), /Limite de 1 candidatures par jour/);
  assert.equal(outbox.length, 0);
});

test("une lettre trop longue est refusée par le schéma", () => {
  const { sendApplication } = setup();
  assert.equal(sendApplication.schema.safeParse({ ...application, body: "x".repeat(1501) }).success, false);
});

test("le client La Bonne Boîte s'authentifie une fois puis interroge /recherche", async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    requests.push({ url, init });
    if (url.includes("access_token")) return Response.json({ access_token: "tok", expires_in: 1499 });
    return Response.json({ hits: 1, items: [{ siret: "12345678900012", company_name: "STUDIO" }] });
  }) as typeof fetch;
  const client = createLaBonneBoiteClient({ clientId: "id", clientSecret: "secret" }, fakeFetch);

  await client.search({ rome: ["M1805"], location: "Nantes" });
  const result = await client.search({ rome: ["M1805"], location: "Nantes", page: 2 });

  assert.equal(requests.filter((r) => r.url.includes("access_token")).length, 1, "token réutilisé");
  const tokenBody = new URLSearchParams(String(requests[0].init?.body));
  assert.equal(tokenBody.get("scope"), "api_labonneboitev2 search office");
  assert.equal(
    requests[1].url,
    "https://api.francetravail.io/partenaire/labonneboite/v2/recherche?rome=M1805&location=Nantes&page=1&page_size=20",
  );
  assert.deepEqual(requests[1].init?.headers, { Authorization: "Bearer tok", Accept: "application/json" });
  assert.equal(result.hits, 1);
});
