import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { Command, MemorySaver } from "@langchain/langgraph";
import { supportClausifyAgent } from "../agents/support-clausify";
import { db, outbox, resetFakeBackend } from "../agents/support-clausify/fake-backend";
import { createAgentGraph, getAuditLog, getPendingApprovals } from "./graph";

// Faux modèle qui rejoue un scénario écrit à l'avance : on teste la mécanique du graphe
// (pause, reprise, refus) de façon déterministe, sans clé ni coût d'API.
function scriptedModel(turns: Anthropic.Beta.BetaContentBlock[][]) {
  let turn = 0;
  return async () => {
    const content = turns[turn++];
    if (!content) throw new Error("Le scénario n'a plus de tour prévu.");
    const stop_reason = content.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn";
    return { content, stop_reason } as Anthropic.Beta.BetaMessage;
  };
}

const toolUse = (id: string, name: string, input: object) =>
  ({ type: "tool_use", id, name, input }) as Anthropic.Beta.BetaContentBlock;
const text = (value: string) => ({ type: "text", text: value }) as Anthropic.Beta.BetaContentBlock;

const diagnosis = [toolUse("t1", "get_account", {}), toolUse("t2", "get_stripe_subscription", {})];
const fix = [toolUse("t3", "fix_user_entitlements", { plan: "PRO", reason: "Stripe actif, compte en FREE" })];

function startThread(threadId: string, userEmail: string, turns: Anthropic.Beta.BetaContentBlock[][]) {
  const graph = createAgentGraph(supportClausifyAgent, {
    checkpointer: new MemorySaver(),
    callModel: scriptedModel(turns),
  });
  const config = { configurable: { thread_id: threadId } };
  const firstMessage = graph.invoke(
    { messages: [{ role: "user", content: "J'ai payé le Pro mais j'ai toujours le filigrane." }], context: { userEmail } },
    config,
  );
  return { graph, config, firstMessage };
}

function lastToolResult(messages: Anthropic.Beta.BetaMessageParam[]) {
  const results = messages.flatMap((m) =>
    typeof m.content === "string" ? [] : m.content.filter((b) => b.type === "tool_result"),
  );
  return results.at(-1) as Anthropic.Beta.BetaToolResultBlockParam;
}

const user = (email: string) => db.users.find((u) => u.email === email)!;

beforeEach(resetFakeBackend);

test("l'action critique met le graphe en pause, puis s'exécute une fois approuvée", async () => {
  const { graph, config, firstMessage } = startThread("approve", "evan@example.com", [
    diagnosis,
    fix,
    [toolUse("t4", "send_email_to_user", { subject: "Votre plan Pro est actif", body: "..." })],
    [text("C'est réglé, votre plan Pro est actif.")],
  ]);
  await firstMessage;

  const [request] = await getPendingApprovals(graph, "approve");
  assert.equal(request?.toolName, "fix_user_entitlements");
  assert.equal(user("evan@example.com").plan, "FREE", "rien ne doit bouger pendant la pause");

  await graph.invoke(
    new Command({ resume: { [request.toolUseId]: { approved: true, by: "admin@example.com" } } }),
    config,
  );

  assert.equal(user("evan@example.com").plan, "PRO");
  assert.equal(user("evan@example.com").watermarkedDocuments, 0);
  assert.deepEqual(outbox.map((mail) => mail.to), ["evan@example.com"]);
  assert.deepEqual(await getPendingApprovals(graph, "approve"), []);
});

test("un refus de l'admin est renvoyé au modèle et rien n'est modifié", async () => {
  const { graph, config, firstMessage } = startThread("refuse", "evan@example.com", [
    diagnosis,
    fix,
    [text("Un conseiller va examiner votre dossier.")],
  ]);
  await firstMessage;

  const [request] = await getPendingApprovals(graph, "refuse");
  const final = await graph.invoke(
    new Command({ resume: { [request!.toolUseId]: { approved: false, comment: "Vérifier la facture" } } }),
    config,
  );

  assert.equal(user("evan@example.com").plan, "FREE");
  assert.equal(outbox.length, 0);
  assert.match(String(lastToolResult(final.messages).content), /refusée.*Vérifier la facture/);
});

test("le journal retient qui a validé, quand, et ce que l'action a donné", async () => {
  const { graph, config, firstMessage } = startThread("audit-ok", "evan@example.com", [
    diagnosis,
    fix,
    [toolUse("t4", "send_email_to_user", { subject: "Votre plan Pro est actif", body: "..." })],
    [text("C'est réglé.")],
  ]);
  await firstMessage;

  const before = new Date().toISOString();
  const [request] = await getPendingApprovals(graph, "audit-ok");
  await graph.invoke(
    new Command({ resume: { [request!.toolUseId]: { approved: true, by: "chef@clausify.fr" } } }),
    config,
  );

  const journal = await getAuditLog(graph, "audit-ok");
  const decision = journal.find((entry) => entry.type === "decision");
  assert.equal(decision?.by, "chef@clausify.fr");
  assert.equal(decision?.approved, true);
  assert.equal(decision?.toolName, "fix_user_entitlements");
  assert.ok(decision!.at >= before, "la décision doit être horodatée au moment de la reprise");
  assert.ok(decision!.summary.length > 0, "le journal garde ce que l'admin avait sous les yeux");

  const execution = journal.find((entry) => entry.type === "execution");
  assert.equal(execution?.status, "ok");
  // Les lectures et l'envoi d'e-mail ne sont pas des actions critiques : le journal ne retient qu'elles.
  assert.deepEqual(journal.map((entry) => entry.type), ["decision", "execution"]);
});

test("une action refusée laisse une trace nominative et n'est pas exécutée", async () => {
  const { graph, config, firstMessage } = startThread("audit-refus", "evan@example.com", [
    diagnosis,
    fix,
    [text("Un conseiller va examiner votre dossier.")],
  ]);
  await firstMessage;

  const [request] = await getPendingApprovals(graph, "audit-refus");
  await graph.invoke(
    new Command({
      resume: { [request!.toolUseId]: { approved: false, comment: "Facture à vérifier", by: "chef@clausify.fr" } },
    }),
    config,
  );

  const journal = await getAuditLog(graph, "audit-refus");
  assert.deepEqual(
    journal.map((entry) => (entry.type === "decision" ? [entry.by, entry.approved, entry.comment] : entry.status)),
    [["chef@clausify.fr", false, "Facture à vérifier"], "skipped"],
  );
  assert.equal(user("evan@example.com").plan, "FREE");
});

test("une décision sans administrateur identifié est tracée comme telle", async () => {
  const { graph, config, firstMessage } = startThread("audit-anonyme", "evan@example.com", [
    diagnosis,
    fix,
    [text("Un conseiller va examiner votre dossier.")],
  ]);
  await firstMessage;

  const [request] = await getPendingApprovals(graph, "audit-anonyme");
  await graph.invoke(new Command({ resume: { [request!.toolUseId]: { approved: false } } }), config);

  const journal = await getAuditLog(graph, "audit-anonyme");
  assert.equal(journal.find((entry) => entry.type === "decision")?.by, "inconnu");
});

test("même approuvée, l'action échoue si Stripe ne confirme pas le paiement", async () => {
  const { graph, config, firstMessage } = startThread("unpaid", "lea@example.com", [
    diagnosis,
    fix,
    [text("Je ne trouve pas de paiement associé à votre compte.")],
  ]);
  await firstMessage;

  const [request] = await getPendingApprovals(graph, "unpaid");
  const final = await graph.invoke(new Command({ resume: { [request!.toolUseId]: { approved: true } } }), config);

  assert.equal(user("lea@example.com").plan, "FREE");
  const result = lastToolResult(final.messages);
  assert.equal(result.is_error, true);
  assert.match(String(result.content), /aucun abonnement PRO actif/);
});
