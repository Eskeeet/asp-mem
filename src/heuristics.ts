export interface SemanticRecallHeuristicInput {
  message: string;
  hasPriorTurns: boolean;
  minimumCharacters?: number;
  minimumWordChunks?: number;
  minimumCjkCharacters?: number;
}

/** Avoids an embedding round-trip for very short, low-information follow-ups. */
export function shouldUseSemanticRecall(
  input: SemanticRecallHeuristicInput,
): boolean {
  const message = input.message.trim();
  if (!message) return false;
  if (!input.hasPriorTurns) return true;
  if (message.length >= (input.minimumCharacters ?? 40)) return true;

  const wordChunks = message.match(/[A-Za-z0-9]+/gu)?.length ?? 0;
  if (wordChunks >= (input.minimumWordChunks ?? 2)) return true;

  const cjkCharacters =
    message.match(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/gu)?.length ?? 0;
  return cjkCharacters >= (input.minimumCjkCharacters ?? 4);
}
