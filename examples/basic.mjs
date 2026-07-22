import { AspMemory, createJsonExtractor } from "asp-mem";

// Bring any model/provider. It only needs to turn a prompt into text.
const extractor = createJsonExtractor(async (_prompt) =>
  JSON.stringify([
    {
      kind: "preference",
      content: "The user prefers concise answers.",
      importance: 0.7,
    },
  ]),
);

const memory = new AspMemory();

await memory.captureTurn({
  ownerId: "user-123",
  userMessage: "Please keep your answers concise.",
  assistantMessage: "Will do.",
  extractor,
  source: { type: "chat", id: "conversation-456" },
});

const context = await memory.context("user-123");
console.log(context);
