import type { AgentDefinition } from "../core/graph";
import { createCandidaturesAgent } from "./candidatures";
import { createSeoAgent } from "./seo";
import { supportClausifyAgent } from "./support-clausify";

const seoAgent = createSeoAgent();
const candidaturesAgent = createCandidaturesAgent();

export const agents: Record<string, AgentDefinition> = {
  [supportClausifyAgent.id]: supportClausifyAgent,
  [seoAgent.id]: seoAgent,
  [candidaturesAgent.id]: candidaturesAgent,
};
