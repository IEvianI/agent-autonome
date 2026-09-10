import type { AgentDefinition } from "../core/graph";
import { seoAgent } from "./seo";
import { supportClausifyAgent } from "./support-clausify";

export const agents: Record<string, AgentDefinition> = {
  [supportClausifyAgent.id]: supportClausifyAgent,
  [seoAgent.id]: seoAgent,
};
