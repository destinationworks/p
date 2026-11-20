/**
 * Task instruction prepended to queries before dense encoding.
 * Aligns query representation with code-document space per Qwen recommendations.
 * Every embedding backend must format queries identically, or query vectors drift
 * away from the stored document vectors.
 */
const QWEN3_QUERY_INSTRUCTION =
  "Given a natural-language description of software behaviour, " +
  "retrieve the relevant source-code functions, types, interfaces, " +
  "modules, and tool definitions.";

export function queryInstructionForModel(model: string): string | undefined {
  return model.toLowerCase().includes("qwen3-embedding") ? QWEN3_QUERY_INSTRUCTION : undefined;
}

export function formatEmbeddingQuery(instruction: string | undefined, text: string): string {
  return instruction ? `Instruct: ${instruction}\nQuery: ${text}` : text;
}
