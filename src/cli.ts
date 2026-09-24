import "dotenv/config";
import { randomUUID } from "node:crypto";
import readline from "node:readline/promises";
import type Anthropic from "@anthropic-ai/sdk";
import { Command } from "@langchain/langgraph";
import { agents } from "./agents";
import { createCheckpointer } from "./core/checkpointer";
import {
  createAgentGraph,
  formatAuditEntry,
  getAuditLog,
  getPendingApprovals,
  type ApprovalDecision,
} from "./core/graph";

// Usage : npm run chat -- [agentId] [threadId]
// Relancer avec le même threadId (et DATABASE_URL) reprend une conversation en pause.
const [agentId = "support-clausify", threadId = randomUUID()] = process.argv.slice(2);
const agent = agents[agentId];
if (!agent) {
  console.error(`Agent inconnu : ${agentId}. Disponibles : ${Object.keys(agents).join(", ")}`);
  process.exit(1);
}

const graph = createAgentGraph(agent, { checkpointer: await createCheckpointer() });
const config = { configurable: { thread_id: threadId } };
// En production, ce contexte vient de la session JWT, jamais du chat.
const context = { userEmail: process.env.SESSION_USER_EMAIL ?? "evan@example.com" };
// Idem pour l'administrateur qui valide : son identité vient de sa session, pas de ce qu'il tape.
const admin = process.env.ADMIN_EMAIL ?? "admin@example.com";
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function printBlock(block: Anthropic.Beta.BetaContentBlockParam) {
  if (block.type === "text") console.log(`\nAgent > ${block.text}`);
  if (block.type === "tool_use") console.log(`  🔧 ${block.name} ${JSON.stringify(block.input)}`);
  if (block.type === "tool_result") console.log(`  ↳ ${String(block.content).slice(0, 200)}`);
}

async function run(input: Parameters<typeof graph.stream>[0]) {
  const stream = await graph.stream(input, { ...config, streamMode: "updates" });
  for await (const update of stream) {
    for (const nodeUpdate of Object.values(update as Record<string, { messages?: Anthropic.Beta.BetaMessageParam[] }>)) {
      for (const message of nodeUpdate?.messages ?? []) {
        if (typeof message.content === "string") console.log(`\nAgent > ${message.content}`);
        else message.content.forEach(printBlock);
      }
    }
  }
}

async function resolveApprovals() {
  let requests = await getPendingApprovals(graph, threadId);
  while (requests.length > 0) {
    const decisions: Record<string, ApprovalDecision> = {};
    for (const request of requests) {
      console.log(`\n⏸  Validation requise : ${request.summary}`);
      const answer = (await rl.question("   Approuver ? [o/N] > ")).trim().toLowerCase();
      if (answer === "o" || answer === "oui") {
        decisions[request.toolUseId] = { approved: true, by: admin };
      } else {
        const comment = (await rl.question("   Motif du refus (optionnel) > ")).trim();
        decisions[request.toolUseId] = { approved: false, comment: comment || undefined, by: admin };
      }
    }
    await run(new Command({ resume: decisions }));
    requests = await getPendingApprovals(graph, threadId);
  }
}

console.log(
  `${agent.name} · thread ${threadId} · session ${context.userEmail} · admin ${admin}` +
    `  (« audit » pour le journal, « exit » pour quitter)`,
);
await resolveApprovals();

while (true) {
  const text = (await rl.question("\nVous > ")).trim();
  if (text === "exit") break;
  if (text === "audit") {
    const entries = await getAuditLog(graph, threadId);
    console.log(entries.length ? entries.map(formatAuditEntry).join("\n") : "Aucune action critique sur ce thread.");
    continue;
  }
  if (!text) continue;
  await run({ messages: [{ role: "user", content: text }], context });
  await resolveApprovals();
}

rl.close();
process.exit(0);
