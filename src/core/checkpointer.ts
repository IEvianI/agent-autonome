import { MemorySaver, type BaseCheckpointSaver } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

export async function createCheckpointer(): Promise<BaseCheckpointSaver> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.warn("DATABASE_URL absente : état en mémoire, une pause ne survivra pas à un redémarrage.");
    return new MemorySaver();
  }
  const saver = PostgresSaver.fromConnString(url);
  await saver.setup();
  return saver;
}
