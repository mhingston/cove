export type SubagentTask = {
  id: string;
  prompt: string;
  model?: string;
};

export type SubagentResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

export type SubagentSession = {
  subscribe(handler: (event: unknown) => void): () => void;
  prompt(message: string): Promise<void>;
  state: {
    messages: Array<{
      role: string;
      content: unknown;
    }>;
  };
};
