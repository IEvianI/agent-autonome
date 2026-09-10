import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { Command, MemorySaver } from "@langchain/langgraph";
import { supportClausifyAgent } from "../agents/support-clausify";
import { db, outbox, resetFakeBackend } from "../agents/support-clausify/fake-backend";
import { createAgentGraph, getPendingApprovals } from "./graph";

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

  await graph.invoke(new Command({ resume: { [request.toolUseId]: { approved: true } } }), config);

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
