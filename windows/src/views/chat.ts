// Chat view — DOM port of PromptView / ChatBubble / TypingDotsView from
// IslandViewContent.swift, with animated messages, formatted code, copy, an
// inline error with Retry, and "New" for a fresh conversation.
//
// Three different Claudes meet in Coucou; this view is only one of them:
//   · this chat talks to the Anthropic API with the key saved in Settings;
//   · Claude Code sessions (the overview, permissions) run in your terminal
//     with their own login — Coucou only watches and answers for them;
//   · claude.ai is the web app — separate account, separate history.

import { h, clear } from "./dom";
import { ICONS, LINE } from "./icons";
import { Bridge, IS_TAURI, type ChatContext } from "../core/bridge";
import { Sound } from "../core/sound";
import { State, type ChatMessage } from "../core/state";
import { Memory } from "../core/memory";
import { Automation } from "../core/automation";
import { icon, setIcon } from "./ui";
import type { ViewHost } from "./views";

let nextId = 1;

const MODEL_NAMES: Record<string, string> = {
  "claude-opus-5-5": "Opus 5.5",
  "claude-sonnet-5-5": "Sonnet 5.5",
  "claude-opus-5": "Opus 5",
  "claude-sonnet-5": "Sonnet 5",
  "claude-haiku-4-5": "Haiku 4.5",
};

// ── Code ─────────────────────────────────────────────────────────────────────

const KEYWORDS = new Set(
  ("const let var function return if else for while do switch case break continue new class extends " +
    "import from export default async await try catch finally throw typeof instanceof in of null undefined " +
    "true false this super def lambda pass None True False elif with as yield fn pub mut impl struct enum " +
    "match use mod trait where loop self Self func go type interface package defer range map chan select " +
    "echo then fi done esac local static void int bool string float double char").split(" "),
);

/**
 * A small, language-agnostic highlighter: comments, strings, numbers,
 * keywords and calls. Good enough to read structure at a glance; built from
 * text nodes and spans, never innerHTML.
 */
function highlight(code: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const re = /(\/\/[^\n]*|#(?!!)[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|(\b\d[\d_.]*(?:e[+-]?\d+)?\b)|([A-Za-z_][\w$]*)(?=\s*\()|([A-Za-z_][\w$]*)/g;
  let last = 0;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    if (m.index > last) frag.append(code.slice(last, m.index));
    const [tok, com, str, num, call, word] = m;
    const cls = com ? "tok-com" : str ? "tok-str" : num ? "tok-num" : call ? (KEYWORDS.has(call) ? "tok-kw" : "tok-fn") : word && KEYWORDS.has(word) ? "tok-kw" : null;
    frag.append(cls ? h("span", { class: cls, text: tok }) : tok);
    last = m.index + tok.length;
  }
  if (last < code.length) frag.append(code.slice(last));
  return frag;
}

async function copy(btn: HTMLElement, glyph: SVGSVGElement, text: string) {
  try {
    await navigator.clipboard.writeText(text);
    btn.classList.add("done");
    setIcon(glyph, LINE.check);
    window.setTimeout(() => {
      btn.classList.remove("done");
      setIcon(glyph, LINE.copy);
    }, 1400);
  } catch {
    btn.classList.add("failed");
    window.setTimeout(() => btn.classList.remove("failed"), 900);
  }
}

function copyButton(text: string, cls = "copy-btn", label?: string): HTMLElement {
  const glyph = icon(LINE.copy, 11, 2);
  const btn = h("button", { class: cls, type: "button", title: "Copy", "aria-label": "Copy" }, glyph);
  if (label) btn.append(h("span", { text: label }));
  btn.addEventListener("click", () => void copy(btn, glyph, text));
  return btn;
}

function codeBlock(lang: string, body: string): HTMLElement {
  const pre = h("pre", { class: "code-body" });
  pre.append(highlight(body));
  return h(
    "div",
    { class: "code-block" },
    h("div", { class: "code-head" }, h("span", { text: lang || "code" }), copyButton(body, "code-copy", "Copy")),
    pre,
  );
}

/**
 * Fenced code blocks, `inline code` and **bold**. Model output is only ever
 * placed in text nodes.
 */
function formatReply(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  text.split(/```/).forEach((part, i) => {
    if (i % 2 === 1) {
      const lang = (part.match(/^([\w+-]*)\n/)?.[1] ?? "").toLowerCase();
      const body = part.replace(/^[\w+-]*\n/, "").replace(/\n$/, "");
      frag.append(codeBlock(lang, body));
      return;
    }
    if (!part) return;
    for (const tok of part.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/)) {
      if (!tok) continue;
      if (tok.startsWith("`") && tok.endsWith("`") && tok.length > 2) frag.append(h("code", { text: tok.slice(1, -1) }));
      else if (tok.startsWith("**") && tok.endsWith("**") && tok.length > 4) frag.append(h("strong", { text: tok.slice(2, -2) }));
      else frag.append(document.createTextNode(tok));
    }
  });
  return frag;
}

// ── Rows ─────────────────────────────────────────────────────────────────────

function bubble(message: ChatMessage, animate: boolean): HTMLElement {
  if (message.role === "user") {
    return h(
      "div",
      { class: animate ? "chat-row user enter" : "chat-row user" },
      h("div", { class: "bubble", text: message.content }),
    );
  }
  const reply = h("div", { class: "reply" });
  reply.append(formatReply(message.content));
  return h(
    "div",
    { class: animate ? "chat-row assistant enter" : "chat-row assistant" },
    reply,
    copyButton(message.content),
  );
}

function typingDots(): HTMLElement {
  return h(
    "div",
    { class: "chat-row typing-row enter" },
    h("div", { class: "typing", "aria-label": "Claude is writing" }, h("i"), h("i"), h("i")),
    h("span", { class: "typing-label", text: "Claude is writing…" }),
  );
}

/** The coloured chip showing what the question is about (a dropped file or screenshot). */
function contextChip(label: string): HTMLElement {
  const chip = h(
    "div",
    { class: "chip" },
    h("i", { class: "chip-dot" }),
    icon(/^screen-/.test(label) ? LINE.screen : ICONS.doc, 10, /^screen-/.test(label) ? 2 : 0),
    h("span", { text: label }),
  );
  requestAnimationFrame(() => chip.classList.add("settled"));
  return chip;
}

function emptyState(fileName: string | null): HTMLElement {
  return h(
    "div",
    { class: "chat-empty" },
    h("span", { class: "chat-empty-icon" }, icon(LINE.sparkle, 14, 1.8)),
    h(
      "span",
      {},
      h("b", { text: fileName ? `Ask anything about ${fileName}.` : "Ask Claude anything." }),
      h("span", { text: " It can search the web. This chat uses your Anthropic API key — it is separate from Claude Code and claude.ai." }),
    ),
  );
}

// ── View ─────────────────────────────────────────────────────────────────────

export function buildPrompt(onHeightChange: () => void, openSettings: (page: string) => void): ViewHost {
  const chipRow = h("div", { class: "chip-row" });
  const source = h("span", { class: "chat-source", title: "Messages go to api.anthropic.com with your own key" });
  const newChat = h(
    "button",
    { class: "new-chat", type: "button", title: "New conversation" },
    icon(LINE.compose, 11, 2),
    h("span", { text: "New" }),
  );
  const top = h("div", { class: "chat-top" }, chipRow, h("span", { class: "grow" }), source, newChat);
  const log = h("div", { class: "chat-log", role: "log", "aria-live": "polite" });
  const input = h("input", {
    type: "text",
    class: "chat-input",
    placeholder: "Ask me anything…",
    spellcheck: "false",
    "aria-label": "Message Claude",
  }) as HTMLInputElement;
  const sendIcon = icon(ICONS.arrowUp, 11, 0);
  const send = h("button", { class: "send-btn fx-magnetic", type: "button", title: "Send", "aria-label": "Send" }, sendIcon, h("i", { class: "spinner" }));
  // Push to talk: one sentence through Windows speech recognition, into the
  // field — never sent on its own. Hidden where the OS has no recogniser.
  const mic = h("button", { class: "mic-btn", type: "button", title: "Speak (Windows speech recognition)", "aria-label": "Speak" }, icon(LINE.speaker, 11, 2.1));
  mic.hidden = !IS_TAURI || !/Windows/i.test(navigator.userAgent);
  mic.addEventListener("click", async () => {
    if (mic.classList.contains("listening")) return;
    mic.classList.add("listening");
    mic.title = "Listening… speak now";
    try {
      const text = await Bridge.dictate();
      if (text) {
        input.value = input.value ? `${input.value} ${text}` : text;
        updateSendState();
      }
    } catch (err) {
      failed = { query: input.value, message: String((err as Error)?.message ?? err).replace(/^Error:\s*/, "") };
      State.notify();
    } finally {
      mic.classList.remove("listening");
      mic.title = "Speak (Windows speech recognition)";
      input.focus();
    }
  });
  const bar = h("div", { class: "chat-bar" }, input, mic, send);

  const shell = h("div", { class: "card fx-glass wash chat-card" }, h("div", { class: "chat-body" }, top, log, bar));
  shell.style.setProperty("--wash", "rgba(99,102,241,0.5)");
  const el = h("div", { class: "view chat" }, shell);

  let sending = false;
  /** How many memory notes went with this conversation (0 = none). */
  let memoryUsed = 0;
  let renderedKey = "";
  let renderedIds = new Set<number>();
  /** The last message that didn't go through, shown inline with Retry. */
  let failed: { query: string; message: string } | null = null;

  function updateSendState() {
    send.classList.toggle("ready", input.value.trim().length > 0 && !sending);
    send.classList.toggle("busy", sending);
    bar.classList.toggle("busy", sending);
  }

  async function submit(text?: string) {
    const query = (text ?? input.value).trim();
    if (!query || sending) return;
    input.value = "";
    sending = true;
    failed = null;
    updateSendState();
    Sound.play("send");

    const message: ChatMessage = { id: nextId++, role: "user", content: query };
    State.chatHistory.push(message);
    State.stateOverride = "thinking";
    State.log({ text: "Asked Claude", detail: query.slice(0, 120), tone: "active", icon: LINE.compose, color: "#A78BFA", cat: "chat" });
    State.notify();
    onHeightChange();

    const file = State.droppedFile;
    const context: ChatContext | null =
      State.chatHistory.length === 1 && file ? { kind: "file", name: file.name, path: file.path } : null;

    // Memory, when the user turned on both switches: saved notes go with the
    // first message of a conversation only, and the chip above says so.
    let sent = query;
    const prefs = State.prefs;
    if (State.chatHistory.length === 1 && prefs.memory.enabled && prefs.memory.useInChat) {
      try {
        const project = State.tasks.find((t) => t.id === "integration_claude")?.name ?? null;
        const mem = await Memory.chatContext(project && project !== "VS Code" ? project : null);
        if (mem) {
          memoryUsed = mem.count;
          sent = `Notes I saved earlier in Coucou (use them only if relevant):\n${mem.text}---\n${query}`;
        }
      } catch {
        /* memory unavailable: send the message as typed */
      }
    }

    try {
      const reply = await Bridge.chatSend(sent, context);
      State.chatHistory.push({ id: nextId++, role: "assistant", content: reply.text });
      State.apiConnected = true;
      State.log({ text: "Claude replied", detail: reply.text.slice(0, 120), tone: "success", icon: LINE.sparkle, color: "#34D399", cat: "chat" });
      Automation.fire("chat-replied", { project: "Chat", text: "Claude replied", detail: reply.text.slice(0, 400), view: "prompt" });
      Sound.play("finish");
    } catch (err) {
      // Rust drops the turn from its history on failure; mirror that so a
      // retry sends the same conversation.
      State.chatHistory = State.chatHistory.filter((m) => m.id !== message.id);
      const text = String(err).replace(/^Error:\s*/, "");
      failed = { query, message: text };
      if (/key|401|403/i.test(text)) State.apiConnected = false;
      State.log({ text: "Chat failed", detail: text, tone: "error", icon: LINE.xCircle, color: "#F4505E", cat: "chat" });
      Sound.play("error");
    } finally {
      State.stateOverride = null;
      sending = false;
      updateSendState();
      State.notify();
      onHeightChange();
      input.focus();
    }
  }

  function errorRow(f: { query: string; message: string }): HTMLElement {
    const retry = h("button", { class: "err-btn", type: "button" }, icon(LINE.refresh, 11, 2), h("span", { text: "Retry" }));
    retry.addEventListener("click", () => void submit(f.query));
    const row = h(
      "div",
      { class: "chat-row error enter", role: "alert" },
      h("span", { class: "err-icon" }, icon(LINE.xCircle, 13, 2)),
      h("div", { class: "err-text" }, h("b", { text: "Not sent" }), h("span", { text: f.message }), h("i", { text: `“${f.query.slice(0, 80)}”` })),
      retry,
    );
    if (/key|settings|401|403/i.test(f.message)) {
      const fix = h("button", { class: "err-btn", type: "button" }, icon(LINE.key, 11, 2), h("span", { text: "API key" }));
      fix.addEventListener("click", () => openSettings("claude"));
      row.append(fix);
    }
    return row;
  }

  send.addEventListener("click", () => void submit());
  input.addEventListener("input", updateSendState);
  input.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") {
      e.preventDefault();
      void submit();
    }
    e.stopPropagation(); // Escape closes the island, not the chat
  });
  newChat.addEventListener("click", () => {
    if (sending) return;
    State.chatHistory = [];
    State.droppedFile = null;
    State.promptContext = null;
    failed = null;
    void Bridge.chatReset();
    Sound.play("blip");
    State.notify();
    onHeightChange();
    input.focus();
  });

  return {
    el,
    sync() {
      const file = State.droppedFile;
      const wantChip = file?.name ?? "";
      if (chipRow.dataset.label !== wantChip) {
        chipRow.dataset.label = wantChip;
        clear(chipRow);
        if (wantChip) chipRow.append(contextChip(wantChip));
      }
      newChat.classList.toggle("off", State.chatHistory.length === 0 && !file && !failed);
      const model = State.settings.model;
      source.textContent = `Anthropic API · ${MODEL_NAMES[model] ?? model}${memoryUsed && State.chatHistory.length ? ` · memory (${memoryUsed})` : ""}`;
      source.title = memoryUsed && State.chatHistory.length
        ? `Messages go to api.anthropic.com with your own key. ${memoryUsed} saved note${memoryUsed === 1 ? "" : "s"} went with the first message (Settings → Memory).`
        : "Messages go to api.anthropic.com with your own key";
      source.classList.toggle("bad", State.apiConnected === false);

      const thinking = State.stateOverride === "thinking";
      const key = `${State.chatHistory.length}:${thinking}:${failed?.query ?? ""}:${file?.name ?? ""}`;
      if (key !== renderedKey) {
        renderedKey = key;
        clear(log);
        const seen = new Set<number>();
        for (const m of State.chatHistory) {
          // Only messages new since the last render animate in.
          log.append(bubble(m, !renderedIds.has(m.id)));
          seen.add(m.id);
        }
        renderedIds = seen;
        if (thinking) log.append(typingDots());
        if (failed && !thinking) log.append(errorRow(failed));
        if (State.chatHistory.length === 0 && !thinking && !failed) log.append(emptyState(file?.name ?? null));
        log.scrollTop = log.scrollHeight;
      }

      input.placeholder = State.chatHistory.length === 0
        ? file ? `Ask about ${file.name}…` : "Ask me anything…"
        : "Continue…";
      input.disabled = sending;
      updateSendState();
    },
    focus() {
      if (State.chatDraft) {
        input.value = State.chatDraft;
        State.chatDraft = "";
        updateSendState();
      }
      input.focus();
      input.select();
    },
  };
}
