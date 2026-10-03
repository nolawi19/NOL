// Chat view — DOM port of PromptView / ChatBubble / TypingDotsView from
// IslandViewContent.swift, with animated messages, light formatting, copy and
// a "new conversation" action.

import { h, clear } from "./dom";
import { ICONS, LINE } from "./icons";
import { Bridge, type ChatContext } from "../core/bridge";
import { Sound } from "../core/sound";
import { State, type ChatMessage } from "../core/state";
import { icon, setIcon } from "./ui";
import type { ViewHost } from "./views";

let nextId = 1;

/**
 * Renders a reply with just enough structure to read well: fenced code
 * blocks, `inline code` and **bold**. Built from text nodes only — model output
 * never reaches innerHTML.
 */
function formatReply(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const parts = text.split(/```/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      // Fenced block: drop the language tag on the first line.
      const body = part.replace(/^[\w+-]*\n/, "").replace(/\n$/, "");
      frag.append(h("pre", { class: "reply-code", text: body }));
      return;
    }
    if (!part) return;
    const tokens = part.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/);
    for (const tok of tokens) {
      if (!tok) continue;
      if (tok.startsWith("`") && tok.endsWith("`") && tok.length > 2) {
        frag.append(h("code", { text: tok.slice(1, -1) }));
      } else if (tok.startsWith("**") && tok.endsWith("**") && tok.length > 4) {
        frag.append(h("strong", { text: tok.slice(2, -2) }));
      } else {
        frag.append(document.createTextNode(tok));
      }
    }
  });
  return frag;
}

function copyButton(text: string): HTMLElement {
  const glyph = icon(LINE.copy, 11, 2);
  const btn = h("button", { class: "copy-btn", type: "button", title: "Copy", "aria-label": "Copy reply" }, glyph);
  btn.addEventListener("click", async () => {
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
  });
  return btn;
}

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
    h("div", { class: "typing", "aria-label": "Claude is typing" }, h("i"), h("i"), h("i")),
  );
}

/** The coloured chip showing what the question is about (a dropped file). */
function contextChip(label: string): HTMLElement {
  const chip = h(
    "div",
    { class: "chip" },
    h("i", { class: "chip-dot" }),
    icon(ICONS.doc, 10, 0),
    h("span", { text: label }),
  );
  requestAnimationFrame(() => chip.classList.add("settled"));
  return chip;
}

function emptyState(): HTMLElement {
  return h(
    "div",
    { class: "chat-empty" },
    h("span", { class: "chat-empty-icon" }, icon(LINE.sparkle, 14, 1.8)),
    h("span", { text: "Ask anything — Claude can search the web, and reads the file you dropped." }),
  );
}

export function buildPrompt(onHeightChange: () => void): ViewHost {
  const chipRow = h("div", { class: "chip-row" });
  const newChat = h(
    "button",
    { class: "new-chat", type: "button", title: "New conversation" },
    icon(LINE.compose, 11, 2),
    h("span", { text: "New" }),
  );
  const top = h("div", { class: "chat-top" }, chipRow, h("span", { class: "grow" }), newChat);
  const log = h("div", { class: "chat-log", role: "log", "aria-live": "polite" });
  const input = h("input", {
    type: "text",
    class: "chat-input",
    placeholder: "Ask me anything…",
    spellcheck: "false",
    "aria-label": "Message Claude",
  }) as HTMLInputElement;
  const sendIcon = icon(ICONS.arrowUp, 11, 0);
  const send = h("button", { class: "send-btn", type: "button", title: "Send", "aria-label": "Send" }, sendIcon, h("i", { class: "spinner" }));
  const bar = h("div", { class: "chat-bar" }, input, send);

  const shell = h("div", { class: "card wash chat-card" }, h("div", { class: "chat-body" }, top, log, bar));
  shell.style.setProperty("--wash", "rgba(99,102,241,0.5)");
  const el = h("div", { class: "view chat" }, shell);

  let sending = false;
  let renderedCount = -1;
  let renderedIds = new Set<number>();

  function updateSendState() {
    send.classList.toggle("ready", input.value.trim().length > 0 && !sending);
    send.classList.toggle("busy", sending);
    bar.classList.toggle("busy", sending);
  }

  async function submit() {
    const query = input.value.trim();
    if (!query || sending) return;
    input.value = "";
    sending = true;
    updateSendState();
    Sound.play("send");

    State.chatHistory.push({ id: nextId++, role: "user", content: query });
    State.stateOverride = "thinking";
    State.notify();
    onHeightChange();

    const file = State.droppedFile;
    const context: ChatContext | null =
      State.chatHistory.length === 1 && file ? { kind: "file", name: file.name, path: file.path } : null;

    try {
      const reply = await Bridge.chatSend(query, context);
      State.chatHistory.push({ id: nextId++, role: "assistant", content: reply.text });
      State.stateOverride = null;
      Sound.play("finish");
    } catch (err) {
      State.stateOverride = null;
      State.noteMessage = String(err).replace(/^Error:\s*/, "");
      State.view = "note";
      Sound.play("error");
    } finally {
      sending = false;
      updateSendState();
      State.notify();
      onHeightChange();
      input.focus();
    }
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
      newChat.classList.toggle("off", State.chatHistory.length === 0 && !file);

      const thinking = State.stateOverride === "thinking";
      const count = State.chatHistory.length + (thinking ? 0.5 : 0);
      if (count !== renderedCount) {
        renderedCount = count;
        clear(log);
        const seen = new Set<number>();
        for (const m of State.chatHistory) {
          // Only messages that are new since the last render animate in.
          log.append(bubble(m, !renderedIds.has(m.id)));
          seen.add(m.id);
        }
        renderedIds = seen;
        if (thinking) log.append(typingDots());
        if (State.chatHistory.length === 0 && !thinking) log.append(emptyState());
        log.scrollTop = log.scrollHeight;
      }

      input.placeholder = State.chatHistory.length === 0
        ? file ? `Ask about ${file.name}…` : "Ask me anything…"
        : "Continue…";
      input.disabled = sending;
      updateSendState();
    },
    focus() {
      input.focus();
      input.select();
    },
  };
}
