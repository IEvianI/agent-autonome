import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

/**
 * Données de confiance injectées par le serveur (ex : l'utilisateur de la session JWT).
 * Le LLM ne peut ni les choisir ni les modifier : un outil qui a besoin de savoir
 * « pour qui » il agit les lit ici, jamais dans ses arguments.
 */
export type ToolContext = Record<string, string>;

export interface AgentTool {
  name: string;
  description: string;
  schema: z.ZodObject;
  /** Outil critique : le graphe se met en pause et attend une validation humaine avant de l'exécuter. */
  requiresApproval: boolean;
  /** Phrase lue par l'administrateur qui valide l'action. */
  summarize(input: unknown, ctx: ToolContext): string;
  execute(input: unknown, ctx: ToolContext): Promise<unknown>;
}

type ToolConfig<Schema extends z.ZodObject> = {
  name: string;
  description: string;
  schema: Schema;
  requiresApproval?: boolean;
  summarize?: (input: z.infer<Schema>, ctx: ToolContext) => string;
  execute: (input: z.infer<Schema>, ctx: ToolContext) => Promise<unknown>;
};

export function defineTool<Schema extends z.ZodObject>(config: ToolConfig<Schema>): AgentTool {
  return {
    name: config.name,
    description: config.description,
    schema: config.schema,
    requiresApproval: config.requiresApproval ?? false,
    // Le graphe valide l'input avec le schéma avant d'appeler ces fonctions, d'où les casts.
    summarize: (input, ctx) =>
      config.summarize
        ? config.summarize(input as z.infer<Schema>, ctx)
        : `${config.name} ${JSON.stringify(input)}`,
    execute: (input, ctx) => config.execute(input as z.infer<Schema>, ctx),
  };
}

export function toAnthropicTool(tool: AgentTool): Anthropic.Beta.BetaTool {
  const { $schema, ...inputSchema } = z.toJSONSchema(tool.schema);
  return {
    name: tool.name,
    description: tool.description,
    input_schema: inputSchema as Anthropic.Beta.BetaTool.InputSchema,
  };
}
