// Answers from Claude that the user asked for: a session summary, an
// explanation of a command or an error. One at a time; the island's insight
// view shows the latest. Uses the stored API key through Rust (the key never
// reaches this window) and never touches the chat's history.

import { Bridge, IS_TAURI } from "./bridge";
import { State } from "./state";

export type InsightKind = "summary" | "explain" | "error";

export interface InsightResult {
  status: "idle" | "loading" | "ready" | "error";
  kind: InsightKind;
  title: string;
  text: string;
  project: string | null;
  at: number;
}

let seq = 0;

export const Insight = {
  current: { status: "idle", kind: "summary", title: "", text: "", project: null, at: 0 } as InsightResult,

  /** Resolves with the text, or throws with a message fit for the UI. */
  async run(kind: InsightKind, title: string, prompt: string, project: string | null): Promise<string> {
    const id = ++seq;
    this.current = { status: "loading", kind, title, text: "", project, at: Date.now() };
    State.notify();
    try {
      if (!IS_TAURI) throw new Error("Claude is only reachable inside the Coucou app.");
      if (State.apiKeyPresent === false) throw new Error("No Anthropic API key saved. Add one in Settings → Claude.");
      const reply = await Bridge.claudeInsight(prompt);
      if (id === seq) this.current = { status: "ready", kind, title, text: reply.text.trim(), project, at: Date.now() };
      State.notify();
      return reply.text.trim();
    } catch (err) {
      const message = String((err as Error)?.message ?? err) || "Claude couldn't be reached.";
      if (id === seq) this.current = { status: "error", kind, title, text: message, project, at: Date.now() };
      State.notify();
      throw new Error(message);
    }
  },
};
