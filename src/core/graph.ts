import Anthropic from "@anthropic-ai/sdk";
import {
  Annotation,
  END,
  START,
  StateGraph,
  interrupt,
  type BaseCheckpointSaver,
} from "@langchain/langgraph";
import { toAnthropicTool, type AgentTool, type ToolContext } from "./tool";

/** Tout ce qui distingue un agent d'un autre. Le graphe, lui, est le même pour tous. */
export type AgentDefinition = {
  id: string;
  name: string;
  systemPrompt: string;
  tools: AgentTool[];
  model?: string;
};

export type ApprovalRequest = {
  toolUseId: string;
  toolName: string;
  input: unknown;
  summary: string;
};

export type ApprovalDecision = { approved: boolean; comment?: string };

type MessageParam = Anthropic.Beta.BetaMessageParam;
type ToolUse = Anthropic.Beta.BetaToolUseBlockParam;
type CallModel = (
  params: Anthropic.Beta.MessageCreateParamsNonStreaming,
) => Promise<Anthropic.Beta.BetaMessage>;

const DEFAULT_MODEL = "claude-opus-5";

export const AgentState = Annotation.Root({
  // Historique au format natif de l'API Claude. Les nœuds ajoutent, rien n'est réécrit.
  messages: Annotation<MessageParam[]>({
    reducer: (current, update) => current.concat(update),
    default: () => [],
  }),
  // Posé par le serveur au démarrage du thread et persisté avec le reste : quand l'admin
  // reprend le graphe depuis sa propre session, les outils agissent toujours pour le bon utilisateur.
  context: Annotation<ToolContext>({
    reducer: (_, update) => update,
    default: () => ({}),
  }),
  // Réponses de l'admin pour le tour d'outils en cours, indexées par tool_use_id.
  decisions: Annotation<Record<string, ApprovalDecision>>({
    reducer: (_, update) => update,
    default: () => ({}),
  }),
});

type State = typeof AgentState.State;

function pendingToolUses(state: State): ToolUse[] {
  const last = state.messages.at(-1);
  if (last?.role !== "assistant" || typeof last.content === "string") return [];
  return last.content.filter((block): block is ToolUse => block.type === "tool_use");
}

function defaultCallModel(): CallModel {
  const client = new Anthropic();
  return (params) => client.beta.messages.create(params);
}

export function createAgentGraph(
  agent: AgentDefinition,
  options: { checkpointer: BaseCheckpointSaver; callModel?: CallModel },
) {
  const toolsByName = new Map(agent.tools.map((tool) => [tool.name, tool]));
  const anthropicTools = agent.tools.map(toAnthropicTool);
  const model = agent.model ?? DEFAULT_MODEL;
  const callModel = options.callModel ?? defaultCallModel();

  async function callAgent(state: State) {
    const params: Anthropic.Beta.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: 16000,
      system: agent.systemPrompt,
      tools: anthropicTools,
      messages: state.messages,
      cache_control: { type: "ephemeral" },
    };
    if (model === "claude-opus-5") {
      // Si les filtres de sécurité d'Opus 5 déclinent la requête, l'API la rejoue sur un autre modèle.
      params.betas = ["server-side-fallback-2026-07-01"];
      params.fallbacks = "default";
    }

    const response = await callModel(params);

    if (response.stop_reason === "refusal") {
      return {
        messages: [
          {
            role: "assistant" as const,
            content: "Je ne peux pas traiter cette demande. Un membre de l'équipe va reprendre votre ticket.",
          },
        ],
      };
    }
    return { messages: [{ role: "assistant" as const, content: response.content }] };
  }

  async function describeAction(tool: AgentTool, input: unknown, ctx: ToolContext) {
    try {
      return await tool.summarize(input, ctx);
    } catch (error) {
      // Si le résumé échoue (API indisponible…), l'admin voit quand même les arguments bruts.
      const reason = error instanceof Error ? error.message : String(error);
      return `${tool.name} ${JSON.stringify(input)} (résumé indisponible : ${reason})`;
    }
  }

  async function reviewCriticalActions(state: State) {
    const requests: ApprovalRequest[] = [];
    for (const call of pendingToolUses(state)) {
      const tool = toolsByName.get(call.name);
      const parsed = tool?.schema.safeParse(call.input);
      // Un appel invalide n'est pas soumis à l'admin : le nœud suivant renverra l'erreur au modèle.
      if (!tool?.requiresApproval || !parsed?.success) continue;
      requests.push({
        toolUseId: call.id,
        toolName: call.name,
        input: parsed.data,
        summary: await describeAction(tool, parsed.data, state.context),
      });
    }

    if (requests.length === 0) return { decisions: {} };

    // Le graphe s'arrête ici et le checkpointer sauvegarde l'état.
    // À la reprise (new Command({ resume })), LangGraph ré-exécute ce nœud depuis le début
    // et interrupt() renvoie cette fois la réponse de l'admin. D'où la règle : aucun effet
    // de bord ici (les lectures faites pour les résumés sont simplement refaites),
    // les outils s'exécutent dans le nœud suivant.
    const decisions = interrupt<ApprovalRequest[], Record<string, ApprovalDecision>>(requests);
    return { decisions };
  }

  async function runTool(call: ToolUse, state: State): Promise<{ content: string; is_error?: boolean }> {
    const tool = toolsByName.get(call.name);
    if (!tool) return { content: `Outil inconnu : ${call.name}`, is_error: true };

    const parsed = tool.schema.safeParse(call.input);
    if (!parsed.success) {
      return { content: `Arguments invalides : ${parsed.error.message}`, is_error: true };
    }

    if (tool.requiresApproval) {
      const decision = state.decisions[call.id];
      if (!decision?.approved) {
        const comment = decision?.comment ? ` Commentaire : ${decision.comment}` : "";
        return { content: `Action refusée par un administrateur humain.${comment} Ne la retente pas.` };
      }
    }

    try {
      return { content: JSON.stringify(await tool.execute(parsed.data, state.context)) };
    } catch (error) {
      return { content: error instanceof Error ? error.message : String(error), is_error: true };
    }
  }

  async function runTools(state: State) {
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    // Séquentiel : si le modèle enchaîne « corriger » puis « envoyer l'e-mail », l'ordre compte.
    for (const call of pendingToolUses(state)) {
      results.push({ type: "tool_result", tool_use_id: call.id, ...(await runTool(call, state)) });
    }
    return { messages: [{ role: "user" as const, content: results }], decisions: {} };
  }

  return new StateGraph(AgentState)
    .addNode("agent", callAgent)
    .addNode("review", reviewCriticalActions)
    .addNode("tools", runTools)
    .addEdge(START, "agent")
    .addConditionalEdges("agent", (state) => (pendingToolUses(state).length > 0 ? "review" : END))
    .addEdge("review", "tools")
    .addEdge("tools", "agent")
    .compile({ checkpointer: options.checkpointer });
}

export type AgentGraph = ReturnType<typeof createAgentGraph>;

/** Validations en attente sur un thread (vide si le graphe n'est pas en pause). */
export async function getPendingApprovals(graph: AgentGraph, threadId: string): Promise<ApprovalRequest[]> {
  const snapshot = await graph.getState({ configurable: { thread_id: threadId } });
  return snapshot.tasks.flatMap((task) =>
    task.interrupts.flatMap((pending) => pending.value as ApprovalRequest[]),
  );
}
