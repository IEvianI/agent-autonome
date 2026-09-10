import type { AgentDefinition } from "../core/graph";
import { createSeoAgent } from "./seo";
import { supportClausifyAgent } from "./support-clausify";

const seoAgent = createSeoAgent();

export const agents: Record<string, AgentDefinition> = {
  [supportClausifyAgent.id]: supportClausifyAgent,
  [seoAgent.id]: seoAgent,
};
