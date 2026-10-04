// Settings window — the place where anything that writes to disk is confirmed.
//
// Same contracts as before the redesign:
//   · settings.json for Claude Code is only written after the user has seen the
//     exact diff, and only if the file still matches that preview (fingerprint);
//   · keys go straight to the OS vault through Rust and never come back — the
//     window can only ask whether one exists;
//   · preferences are saved through Bridge.saveSettings, which tells the island.

import "./settings.css";
import { Bridge, onEvent, sendTo, type HookStatus, type KeyCheck } from "../core/bridge";
import { AVAILABILITY_LABEL, CAPABILITIES, Consent, RISK_LABEL, type ConsentRequest } from "../core/capabilities";
import { pairedDevices, revokeDevice, shortFingerprint, thisDevice, type PairedDevice } from "../core/devices";
import { ScreenShare } from "../core/screen";
import { installPointerFx } from "../fx/pointer";
import { Sound } from "../core/sound";
import { DEFAULT_SETTINGS, type Settings } from "../core/state";
import { h, clear, svg } from "../views/dom";
import { LINE } from "../views/icons";
import appIcon from "../../src-tauri/icons/128x128.png";

let settings: Settings = { ...DEFAULT_SETTINGS };
let version = "";
let hookStatus: HookStatus = { installed: false, settingsPath: "", hookPath: "", hookReady: false };
const present: Record<string, boolean> = {};

const IS_WINDOWS = /Windows/i.test(navigator.userAgent);
const VAULT = IS_WINDOWS ? "Windows Credential Manager" : "your system keyring";
const LOG_PATH = IS_WINDOWS ? "%LOCALAPPDATA%\\Coucou\\coucou.log" : "~/.local/share/coucou/coucou.log";

const root = document.getElementById("settings-root")!;

// ── Persistence ───────────────────────────────────────────────────────────────

let saveTimer: number | null = null;

async function save() {
  if (saveTimer != null) {
    window.clearTimeout(saveTimer);
    saveTimer = null;
  }
  await Bridge.saveSettings(settings);
  refreshNav();
}

/** Sliders save once the hand stops moving, not on every pixel. */
function saveSoon() {
  if (saveTimer != null) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void save(), 220);
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private storage unavailable — the window still works */
  }
}

function recall(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

// ── Primitives ────────────────────────────────────────────────────────────────

function ico(path: string, size = 16, stroke = 1.9): SVGSVGElement {
  const el = svg(path, size, { stroke });
  el.classList.add("ico");
  return el;
}

type BtnKind = "primary" | "secondary" | "ghost" | "danger";

function btn(label: string, kind: BtnKind, onClick?: () => void, icon?: string): HTMLButtonElement {
  const el = h("button", { class: `btn btn-${kind}`, type: "button" }) as HTMLButtonElement;
  if (icon) el.append(ico(icon, 14, 2));
  el.append(h("span", { class: "btn-label", text: label }), h("i", { class: "spinner" }));
  if (onClick) el.addEventListener("click", () => !el.disabled && onClick());
  return el;
}

function setBtnLabel(el: HTMLButtonElement, label: string) {
  (el.querySelector(".btn-label") as HTMLElement).textContent = label;
}

/** idle → busy (spinner) → done (✓, green) / failed (shake, red) → idle */
function setBtnState(el: HTMLButtonElement, state: "idle" | "busy" | "done" | "failed") {
  el.dataset.state = state;
  el.disabled = state === "busy";
  if (state === "failed") {
    el.classList.remove("shake");
    void el.offsetWidth;
    el.classList.add("shake");
  }
}

function toggle(on: boolean, label: string, onChange: (v: boolean) => boolean | void): HTMLButtonElement {
  const el = h("button", {
    class: on ? "switch on" : "switch",
    type: "button",
    role: "switch",
    "aria-checked": String(on),
    "aria-label": label,
  }) as HTMLButtonElement;
  el.addEventListener("click", () => {
    const next = !el.classList.contains("on");
    // A handler may refuse (returns false): the switch shakes instead of moving.
    if (onChange(next) === false) {
      el.classList.remove("shake");
      void el.offsetWidth;
      el.classList.add("shake");
      return;
    }
    el.classList.toggle("on", next);
    el.setAttribute("aria-checked", String(next));
  });
  return el;
}

function pill(ok: boolean | null, text: string): HTMLElement {
  const tone = ok == null ? "neutral" : ok ? "ok" : "off";
  return h("span", { class: `pill ${tone}` }, h("i"), h("span", { text }));
}

function notice(kind: "ok" | "err" | "warn" | "info", text: string): HTMLElement {
  const path = kind === "ok" ? LINE.checkCircle : kind === "err" ? LINE.xCircle : kind === "warn" ? LINE.shield : LINE.info;
  return h("div", { class: `notice ${kind}`, role: kind === "err" ? "alert" : "status" }, ico(path, 15, 2), h("span", { text }));
}

/** A message slot that animates its height as messages come and go. */
function messageSlot(): { el: HTMLElement; show(node: HTMLElement | null): void } {
  const inner = h("div", { class: "slot-inner" });
  const el = h("div", { class: "slot" }, inner);
  return {
    el,
    show(node) {
      clear(inner);
      if (node) inner.append(node);
      el.classList.toggle("open", node != null);
    },
  };
}

function card(title: string, desc: string | null, ...children: Node[]): HTMLElement {
  const head = h("header", { class: "card-head" }, h("h2", { text: title }));
  if (desc) head.append(h("p", { text: desc }));
  return h("section", { class: "card fx-glass fx-spotlight" }, h("i", { class: "fx-spot" }), head, ...children);
}

// ── Dialog ────────────────────────────────────────────────────────────────────

interface DialogOptions {
  title: string;
  body: string;
  confirm: string;
  cancel?: string;
  danger?: boolean;
  icon?: string;
  /** Extra line in a box: what exactly is being approved. */
  detail?: string;
  /** Risk chip, for consent requests. */
  risk?: string;
}

/** A modal that resolves true only on the confirm button. Esc / Cancel → false. */
function confirmDialog(o: DialogOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const dlg = h("dialog", { class: o.danger ? "dialog danger" : "dialog" }) as HTMLDialogElement;
    const ok = btn(o.confirm, o.danger ? "danger" : "primary");
    const no = btn(o.cancel ?? "Cancel", "secondary");
    const head = h("div", { class: "dialog-head" }, h("span", { class: "dialog-icon" }, ico(o.icon ?? (o.danger ? LINE.trash : LINE.shield), 20, 1.9)));
    const titleRow = h("div", {}, h("h3", { text: o.title }));
    if (o.risk) titleRow.append(h("span", { class: "risk", text: o.risk }));
    head.append(titleRow);
    dlg.append(head, h("p", { text: o.body }));
    if (o.detail) dlg.append(h("div", { class: "dialog-detail", text: o.detail }));
    dlg.append(h("div", { class: "actions end" }, no, ok));
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      dlg.classList.add("closing");
      window.setTimeout(() => {
        dlg.close();
        dlg.remove();
      }, 160);
      resolve(v);
    };
    ok.addEventListener("click", () => finish(true));
    no.addEventListener("click", () => finish(false));
    dlg.addEventListener("cancel", (e) => {
      e.preventDefault();
      finish(false);
    });
    document.body.append(dlg);
    dlg.showModal();
    // Safe default: focus lands on Cancel, never on the risky choice.
    no.focus();
  });
}

/** How a capability asks for consent in this window. */
function consentPrompt(req: ConsentRequest): Promise<boolean> {
  return confirmDialog({
    title: req.capability.title,
    body: req.capability.summary,
    detail: req.detail,
    confirm: "Allow",
    cancel: "Don't allow",
    icon: LINE.shield,
    risk: RISK_LABEL[req.capability.risk],
  });
}

function row(label: string, hint: string | null, ...controls: Node[]): HTMLElement {
  const text = h("div", { class: "row-text" }, h("div", { class: "row-label", text: label }));
  if (hint) text.append(h("div", { class: "row-hint", text: hint }));
  return h("div", { class: "row" }, text, h("div", { class: "row-control" }, ...controls));
}

function slider(
  min: number, max: number, step: number, value: number,
  format: (v: number) => string,
  onInput: (v: number) => void,
  label: string,
): HTMLElement {
  const input = h("input", {
    type: "range", min: String(min), max: String(max), step: String(step), value: String(value),
    "aria-label": label,
  }) as HTMLInputElement;
  const out = h("output", { class: "slider-value" });
  const paint = () => {
    const v = Number(input.value);
    input.style.setProperty("--val", `${((v - min) / (max - min)) * 100}%`);
    out.textContent = format(v);
  };
  input.addEventListener("input", () => {
    paint();
    onInput(Number(input.value));
  });
  paint();
  return h("div", { class: "slider" }, input, out);
}

// ── Secret fields ─────────────────────────────────────────────────────────────

interface FieldDef {
  key: string;
  label: string;
  placeholder: string;
  secret: boolean;
  /** Returns an error (blocks saving) or a warning (allows it). */
  validate?: (value: string) => { level: "error" | "warn"; msg: string } | null;
}

function secretField(def: FieldDef, onChange?: () => void): HTMLElement {
  const statusEl = h("span", { class: "field-status" });
  const input = h("input", {
    type: def.secret ? "password" : "text",
    autocomplete: "off",
    spellcheck: "false",
    "aria-label": def.label,
  }) as HTMLInputElement;
  const wrap = h("div", { class: "input-wrap" }, ico(def.secret ? LINE.key : LINE.globe, 14, 1.9), input);

  if (def.secret) {
    const eyeIcon = ico(LINE.eye, 14, 1.9);
    const reveal = h("button", { class: "reveal", type: "button", title: "Show what you typed", "aria-label": "Show what you typed" }, eyeIcon);
    reveal.addEventListener("click", () => {
      const shown = input.type === "text";
      input.type = shown ? "password" : "text";
      eyeIcon.querySelector("path")?.setAttribute("d", shown ? LINE.eye : LINE.eyeOff);
      input.focus();
    });
    wrap.append(reveal);
  }

  const saveBtn = btn("Save", "primary");
  const removeBtn = btn("Remove", "ghost", undefined, LINE.trash);
  const msg = messageSlot();

  function paint() {
    const has = present[def.key] ?? false;
    clear(statusEl);
    statusEl.append(pill(has, has ? "Stored" : "Not set"));
    input.placeholder = has ? "••••••••••••  stored — type to replace" : def.placeholder;
    removeBtn.hidden = !has;
    validate();
  }

  function validate(): boolean {
    const value = input.value.trim();
    const verdict = value && def.validate ? def.validate(value) : null;
    wrap.classList.toggle("invalid", verdict?.level === "error");
    wrap.classList.toggle("warn", verdict?.level === "warn");
    saveBtn.disabled = !value || verdict?.level === "error";
    if (verdict) msg.show(notice(verdict.level === "error" ? "err" : "warn", verdict.msg));
    else if (wrap.classList.contains("had-verdict")) msg.show(null);
    wrap.classList.toggle("had-verdict", verdict != null);
    return verdict?.level !== "error";
  }

  async function doSave() {
    const value = input.value.trim();
    if (!value || !validate()) return;
    setBtnState(saveBtn, "busy");
    const started = performance.now();
    try {
      await Bridge.secretSet(def.key, value);
      // Long enough to read as "something happened", never longer.
      const wait = Math.max(0, 380 - (performance.now() - started));
      await new Promise((r) => window.setTimeout(r, wait));
      present[def.key] = true;
      input.value = "";
      if (def.secret) input.type = "password";
      setBtnState(saveBtn, "done");
      setBtnLabel(saveBtn, "Saved");
      msg.show(notice("ok", `Saved to ${VAULT}. It never touches disk and never comes back to this window.`));
      wrap.classList.remove("had-verdict");
      paint();
      void sendTo("island", "secrets-changed", null);
      onChange?.();
      window.setTimeout(() => {
        setBtnState(saveBtn, "idle");
        setBtnLabel(saveBtn, "Save");
        validate();
      }, 1800);
    } catch (err) {
      setBtnState(saveBtn, "failed");
      setBtnLabel(saveBtn, "Retry");
      saveBtn.disabled = false;
      msg.show(notice("err", `Could not save: ${String(err).replace(/^Error:\s*/, "")}`));
    }
  }

  async function doRemove() {
    const ok = await confirmDialog({
      title: `Remove ${def.label.toLowerCase()}?`,
      body: `It will be deleted from ${VAULT}. Anything that uses it stops working until you add it again.`,
      confirm: "Remove",
      danger: true,
    });
    if (!ok) return;
    setBtnState(removeBtn, "busy");
    try {
      await Bridge.secretClear(def.key);
      present[def.key] = false;
      setBtnState(removeBtn, "idle");
      msg.show(notice("info", "Removed."));
      paint();
      void sendTo("island", "secrets-changed", null);
      onChange?.();
    } catch (err) {
      setBtnState(removeBtn, "failed");
      msg.show(notice("err", `Could not remove: ${String(err).replace(/^Error:\s*/, "")}`));
    }
  }

  saveBtn.addEventListener("click", () => void doSave());
  removeBtn.addEventListener("click", () => void doRemove());
  input.addEventListener("input", () => {
    if (saveBtn.dataset.state === "failed") {
      setBtnState(saveBtn, "idle");
      setBtnLabel(saveBtn, "Save");
    }
    validate();
  });
  input.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") void doSave();
  });

  paint();
  return h(
    "div",
    { class: "field" },
    h("div", { class: "field-head" }, h("label", { text: def.label }), statusEl),
    h("div", { class: "input-row" }, wrap, saveBtn, removeBtn),
    msg.el,
  );
}

// ── Pages ─────────────────────────────────────────────────────────────────────

interface Page {
  id: string;
  title: string;
  subtitle: string;
  icon: string;
  render(): HTMLElement[];
  /** Small status dot in the sidebar. */
  status?(): boolean | null;
}

function renderDiff(text: string): HTMLElement {
  const box = h("div", { class: "diff" });
  text.split("\n").forEach((line, i) => {
    const cls = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
    const el = h("div", { class: `diff-line ${cls}` }, h("span", { class: "gutter", text: cls === "add" ? "+" : cls === "del" ? "−" : "" }), h("span", { text: line.replace(/^[+-]/, "") || " " }));
    el.style.setProperty("--i", String(Math.min(i, 40)));
    box.append(el);
  });
  return box;
}

// Claude Code ─────────────────────────────────────────────────────────────────

function claudeCodePage(): HTMLElement[] {
  const body = h("div", { class: "stack-12" });
  const hero = h("div", { class: "hero" });

  async function rebuild() {
    const fresh = await Bridge.hooksStatus();
    if (fresh) hookStatus = fresh;
    settings.hooksInstalled = hookStatus.installed;
    refreshNav();
    draw();
  }

  function drawHero() {
    clear(hero);
    const ok = hookStatus.installed;
    hero.className = `hero ${ok ? "ok" : "off"}`;
    hero.append(
      h("div", { class: "hero-icon" }, ico(ok ? LINE.shieldCheck : LINE.plug, 22, 1.8)),
      h(
        "div",
        { class: "hero-text" },
        h("b", { text: ok ? "Connected to Claude Code" : "Not connected yet" }),
        h("span", {
          text: ok
            ? "Tool calls, questions and permission requests show up in the island, and you can answer them there."
            : "Install the hooks to watch your Claude Code sessions in the island and approve permissions without leaving what you are doing.",
        }),
      ),
    );
  }

  function draw() {
    drawHero();
    clear(body);
    body.append(
      h(
        "div",
        { class: "kv" },
        h("span", { text: "settings.json" }),
        h("code", { text: hookStatus.settingsPath || "—" }),
        h("span", { text: "Relay" }),
        h("div", { class: "kv-value" }, h("code", { text: hookStatus.hookPath || "—" }), pill(hookStatus.hookReady, hookStatus.hookReady ? "Ready" : "Missing")),
      ),
    );
    if (!hookStatus.hookReady) {
      body.append(notice("warn", `${IS_WINDOWS ? "coucou-hook.exe" : "coucou-hook"} is not in place yet. Restart Coucou; if it still fails, build it with \`cargo build -p coucou-hook\`.`));
    }
    const install = btn(hookStatus.installed ? "Reinstall hooks…" : "Install hooks…", "primary", () => void showPreview(true), LINE.bolt);
    // Writing hook commands that point at a relay which isn't there would give
    // every Claude Code session a broken hook and nothing to show for it.
    if (!hookStatus.hookReady) {
      install.disabled = true;
      install.title = "The relay isn't installed yet.";
    }
    const actions = h("div", { class: "actions" }, install);
    if (hookStatus.installed) {
      actions.append(btn("Uninstall hooks…", "danger", () => void showPreview(false), LINE.trash));
    }
    body.append(actions);
  }

  async function showPreview(install: boolean) {
    let preview;
    try {
      preview = await Bridge.hooksPreview(install);
    } catch (err) {
      // An unreadable or invalid settings.json stops here rather than being
      // treated as empty and written over.
      clear(body);
      body.append(
        notice("err", String(err).replace(/^Error:\s*/, "")),
        h("div", { class: "actions" }, btn("Back", "secondary", draw, LINE.arrowLeft)),
      );
      return;
    }
    if (!preview) return;
    clear(body);
    const confirm = btn(install ? "Back up and write" : "Back up and remove", install ? "primary" : "danger");
    const msg = messageSlot();
    body.append(
      notice(
        "info",
        install
          ? "This is exactly what will change in your settings.json. Your own hooks are left untouched."
          : "This removes Coucou's entries only. Your own hooks are left untouched.",
      ),
      renderDiff(preview.diff),
      h("div", { class: "kv" }, h("span", { text: "Backup" }), h("code", { text: preview.backup })),
      h("div", { class: "actions" }, confirm, btn("Cancel", "secondary", draw)),
      msg.el,
    );
    confirm.addEventListener("click", async () => {
      setBtnState(confirm, "busy");
      try {
        const backup = await Bridge.hooksApply(install, preview.fingerprint);
        setBtnState(confirm, "done");
        setBtnLabel(confirm, install ? "Written" : "Removed");
        msg.show(notice("ok", `Done. Previous settings saved as ${backup}. Open a new Claude Code session to pick the hooks up.`));
        window.setTimeout(() => void rebuild(), 2600);
      } catch (err) {
        setBtnState(confirm, "failed");
        confirm.disabled = false;
        msg.show(notice("err", `Could not write: ${String(err).replace(/^Error:\s*/, "")}`));
      }
    });
  }

  draw();
  return [
    hero,
    card("Hooks", "Coucou adds its relay to each Claude Code hook event. Nothing is written until you have seen the diff.", body),
    card(
      "Never in the way",
      null,
      h(
        "ul",
        { class: "bullets" },
        h("li", { text: "The relay gives Coucou 300 ms to answer, then lets Claude Code carry on — a closed or busy Coucou never blocks a session." }),
        h("li", { text: "A permission is only ever approved by a click on Allow. If nobody answers in time, Claude Code asks in the terminal as usual." }),
        h("li", { text: "It works from any terminal: Windows Terminal, PowerShell, VS Code, Git Bash." }),
      ),
    ),
  ];
}

// Claude ──────────────────────────────────────────────────────────────────────

const MODELS: { id: string; name: string; note: string }[] = [
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", note: "Most capable Opus" },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", note: "Fast and very capable" },
  { id: "claude-opus-5", name: "Claude Opus 5", note: "Previous Opus" },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", note: "Previous Sonnet" },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", note: "Quickest and lightest" },
];

function claudePage(): HTMLElement[] {
  const key = secretField(
    {
      key: "anthropic-api-key",
      label: "Anthropic API key",
      placeholder: "sk-ant-…",
      secret: true,
      validate: (v) =>
        /\s/.test(v)
          ? { level: "error", msg: "Keys never contain spaces — check what was pasted." }
          : !v.startsWith("sk-ant-")
            ? { level: "warn", msg: "Anthropic keys usually start with sk-ant-. You can still save this one." }
            : null,
    },
    () => {
      refreshNav();
      void runCheck();
    },
  );

  // Connection: the key is tried against the Models API (no tokens spent).
  const conn = h("div", { class: "conn" });
  const testBtn = btn("Test connection", "secondary", () => void runCheck(), LINE.refresh);
  let checking = false;
  function paintConn(state: KeyCheck["status"] | "checking" | "unknown", detail: string) {
    clear(conn);
    const ok = state === "connected";
    const bad = state === "rejected" || state === "unreachable" || state === "error";
    conn.className = `conn ${ok ? "ok" : bad ? "bad" : state === "checking" ? "busy" : "off"}`;
    conn.append(
      h("span", { class: "conn-orb" }, h("i"), h("i")),
      h(
        "div",
        { class: "conn-text" },
        h("b", {
          text: ok ? "Connected" : state === "checking" ? "Checking…" : state === "missing" ? "Not connected"
            : state === "rejected" ? "Key rejected" : state === "unreachable" ? "Can't reach Anthropic" : state === "unknown" ? "Not checked yet" : "Something went wrong",
        }),
        h("span", { text: detail }),
      ),
      testBtn,
    );
    testBtn.disabled = state === "checking" || state === "missing";
  }
  async function runCheck() {
    if (checking) return;
    if (!present["anthropic-api-key"]) {
      paintConn("missing", "Add a key below to use the chat.");
      return;
    }
    checking = true;
    paintConn("checking", "Asking api.anthropic.com…");
    const res = await Bridge.claudeCheckKey();
    checking = false;
    if (!res) paintConn("unknown", "Only works inside the Coucou app.");
    else paintConn(res.status, res.detail);
  }
  paintConn(present["anthropic-api-key"] ? "unknown" : "missing", present["anthropic-api-key"] ? "Click Test connection to try your key." : "Add a key below to use the chat.");
  if (present["anthropic-api-key"]) void runCheck();

  const list = h("div", { class: "choices", role: "radiogroup", "aria-label": "Chat model" });
  const models = MODELS.some((m) => m.id === settings.model)
    ? MODELS
    : [...MODELS, { id: settings.model, name: settings.model, note: "Custom" }];
  const items = models.map((m) => {
    const item = h(
      "button",
      { class: "choice", type: "button", role: "radio", "data-id": m.id },
      h("span", { class: "radio" }, h("i")),
      h("span", { class: "choice-text" }, h("b", { text: m.name }), h("span", { text: m.note })),
      h("code", { class: "choice-id", text: m.id }),
    );
    item.addEventListener("click", () => {
      settings.model = m.id;
      paint();
      void save();
    });
    return item;
  });
  list.append(...items);
  function paint() {
    for (const it of items) {
      const on = it.dataset.id === settings.model;
      it.classList.toggle("on", on);
      it.setAttribute("aria-checked", String(on));
    }
  }
  paint();

  return [
    card("Connection", "The island's chat talks to the Anthropic API with your own key.", conn),
    card("API key", `It lives in ${VAULT}; neither window can read it back — they can only ask whether it exists.`, key),
    card(
      "Which Claude is this?",
      null,
      h(
        "dl",
        { class: "keys" },
        h("dt", { text: "Chat in the island" }), h("dd", { text: "The Anthropic API, billed to the key above." }),
        h("dt", { text: "Claude Code" }), h("dd", { text: "Runs in your terminal with its own login. Coucou watches it and answers its permission requests; no key needed here." }),
        h("dt", { text: "claude.ai" }), h("dd", { text: "The web and desktop app — a separate account and history. Coucou doesn't connect to it." }),
      ),
    ),
    card("Chat model", "Applies to the next message you send.", list),
  ];
}

// Integrations ────────────────────────────────────────────────────────────────

interface IntegrationDef {
  id: string;
  name: string;
  color: string;
  blurb: string;
  fields: FieldDef[];
}

const httpUrl = (v: string) => {
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:"
      ? null
      : { level: "error" as const, msg: "Use an http:// or https:// address." };
  } catch {
    return { level: "error" as const, msg: "That isn't a full address — include https://." };
  }
};

const INTEGRATIONS: IntegrationDef[] = [
  { id: "integration_stripe", name: "Stripe", color: "#0570DE", blurb: "Balance and latest payments",
    fields: [{ key: "stripe-api-key", label: "Secret key", placeholder: "sk_live_…", secret: true }] },
  { id: "integration_github", name: "GitHub", color: "#F4505E", blurb: "Stars and repositories",
    fields: [{ key: "github-token", label: "Token", placeholder: "ghp_…", secret: true }] },
  { id: "integration_vercel", name: "Vercel", color: "#7C5CFF", blurb: "Deployments as they land",
    fields: [{ key: "vercel-token", label: "Token", placeholder: "…", secret: true }] },
  { id: "integration_n8n", name: "n8n", color: "#F29B38", blurb: "Workflow successes and failures",
    fields: [
      { key: "n8n-url", label: "Instance URL", placeholder: "https://n8n.example.com", secret: false, validate: httpUrl },
      { key: "n8n-api-key", label: "API key", placeholder: "…", secret: true },
    ] },
  { id: "integration_resend", name: "Resend", color: "#22C55E", blurb: "Emails sent and delivered",
    fields: [{ key: "resend-api-key", label: "API key", placeholder: "re_…", secret: true }] },
  { id: "integration_notion", name: "Notion", color: "#8C8C8C", blurb: "Recently edited pages",
    fields: [{ key: "notion-api-key", label: "Integration token", placeholder: "ntn_…", secret: true }] },
  { id: "integration_calcom", name: "Cal.com", color: "#C9956A", blurb: "Upcoming bookings",
    fields: [{ key: "calcom-api-key", label: "API key", placeholder: "cal_…", secret: true }] },
];

const MAX_ACTIVE = 4;

function integrationsPage(): HTMLElement[] {
  const meterBar = h("div", { class: "meter" }, ...Array.from({ length: MAX_ACTIVE }, () => h("i")));
  const meterText = h("span", { class: "meter-text" });
  const meterMsg = messageSlot();

  function paintMeter() {
    const used = settings.activeIntegrations.length;
    meterBar.querySelectorAll("i").forEach((seg, i) => seg.classList.toggle("on", i < used));
    meterText.textContent = `${used} of ${MAX_ACTIVE} pills next to Mochi`;
  }

  const grid = h("div", { class: "int-grid" });
  INTEGRATIONS.forEach((def, idx) => {
    const configured = () => def.fields.every((f) => present[f.key]);
    const statusSlot = h("span");
    const paintStatus = () => {
      clear(statusSlot);
      statusSlot.append(pill(configured(), configured() ? "Connected" : "Needs a key"));
    };
    const sw = toggle(settings.activeIntegrations.includes(def.id), `Show ${def.name} in the island`, (on) => {
      if (on) {
        if (settings.activeIntegrations.length >= MAX_ACTIVE) {
          meterMsg.show(notice("warn", `Up to ${MAX_ACTIVE} pills fit next to Mochi — turn one off first.`));
          meterBar.classList.remove("shake");
          void meterBar.offsetWidth;
          meterBar.classList.add("shake");
          return false;
        }
        settings.activeIntegrations = [...settings.activeIntegrations, def.id];
      } else {
        settings.activeIntegrations = settings.activeIntegrations.filter((x) => x !== def.id);
      }
      meterMsg.show(null);
      paintMeter();
      void save();
    });

    const fields = h("div", { class: "int-fields" }, ...def.fields.map((f) => secretField(f, paintStatus)));
    const drawer = h("div", { class: "drawer" }, h("div", { class: "drawer-inner" }, fields));
    const chevron = ico(LINE.chevronDown, 14, 2.2);
    const expand = h("button", { class: "expand", type: "button", "aria-expanded": "false" }, h("span", { text: "Keys" }), chevron);
    const setOpen = (open: boolean) => {
      drawer.classList.toggle("open", open);
      expand.classList.toggle("open", open);
      expand.setAttribute("aria-expanded", String(open));
    };
    expand.addEventListener("click", () => setOpen(!drawer.classList.contains("open")));
    paintStatus();
    // Unconfigured integrations start open: that is where the work is.
    setOpen(!configured());

    const avatar = h("span", { class: "avatar", style: `--c:${def.color}`, text: def.name.slice(0, 1) });
    const item = h(
      "div",
      { class: "int-item", style: `--c:${def.color};--i:${idx}` },
      h(
        "div",
        { class: "int-head" },
        avatar,
        h("div", { class: "int-title" }, h("b", { text: def.name }), h("span", { text: def.blurb })),
        statusSlot,
        expand,
        sw,
      ),
      drawer,
    );
    grid.append(item);
  });

  paintMeter();
  return [
    card(
      "Pills",
      "Pick which integrations sit next to Mochi. Each one polls only the service you configure.",
      h("div", { class: "meter-row" }, meterBar, meterText),
      meterMsg.el,
    ),
    card("Services", `Keys are stored in ${VAULT}, never on disk.`, grid),
  ];
}

// General ─────────────────────────────────────────────────────────────────────

function generalPage(): HTMLElement[] {
  const island = (cmd: string) => () => void sendTo("island", "tray", cmd);
  return [
    card(
      "The island stays put",
      "Coucou never closes, collapses or hides on a timer — not when Claude finishes, not when nothing is happening. It changes size only when you ask.",
      row("Open it", null, btn("Show island", "secondary", island("open"), LINE.chevronDown)),
      row("Make it small", "The compact island keeps Claude's status in view.", btn("Collapse", "secondary", island("collapse"), LINE.chevronUp)),
      row("Put it away", "It retracts into the top edge; move the pointer to the top-centre to bring it back.", btn("Hide", "secondary", island("hide"), LINE.retract)),
    ),
    card(
      "Using the island",
      null,
      h(
        "dl",
        { class: "keys" },
        h("dt", { text: "Top-centre of the screen" }), h("dd", { text: "Mochi peeks out" }),
        h("dt", { text: "Click the small island" }), h("dd", { text: "It opens" }),
        h("dt", { text: "Esc, or the ⌃ button" }), h("dd", { text: "Collapses it (not while a request waits for you)" }),
        h("dt", { text: "Drag a file onto it" }), h("dd", { text: "Mochi swallows it and you can ask about it" }),
        h("dt", { text: "Tray icon" }), h("dd", { text: "Open, Hide island, Settings…, Pause, Quit" }),
      ),
    ),
  ];
}

// Sound ───────────────────────────────────────────────────────────────────────

function soundPage(): HTMLElement[] {
  const volume = slider(0, 0.2, 0.005, settings.soundVolume, (v) => `${Math.round((v / 0.2) * 100)}%`, (v) => {
    settings.soundVolume = v;
    saveSoon();
  }, "Volume");
  volume.classList.toggle("disabled", !settings.soundEnabled);

  const sample = btn("Play a sample", "secondary", async () => {
    sample.classList.add("playing");
    await Sound.preload();
    Sound.setEnabled(true);
    Sound.setVolume(settings.soundVolume);
    Sound.resume();
    Sound.play("finish");
    window.setTimeout(() => sample.classList.remove("playing"), 700);
  }, LINE.speaker);

  return [
    card(
      "Sound",
      "Mochi's 28 little sounds — peeks, approvals, finishes and errors.",
      row("Sounds", null, toggle(settings.soundEnabled, "Sounds", (v) => {
        settings.soundEnabled = v;
        volume.classList.toggle("disabled", !v);
        void save();
      })),
      row("Volume", null, volume),
      row("Preview", "Plays at the volume above.", sample),
    ),
  ];
}

// Display ─────────────────────────────────────────────────────────────────────

function displayPage(): HTMLElement[] {
  const option = (value: Settings["screen"], title: string, desc: string) => {
    const art = h(
      "div",
      { class: `monitors ${value}` },
      h("i", { class: "mon a" }, h("b")),
      h("i", { class: "mon b" }, h("b")),
      value === "cursor" ? h("i", { class: "cursor" }, ico(LINE.pointer, 13, 1.8)) : null,
    );
    const el = h(
      "button",
      { class: "choice big", type: "button", role: "radio", "data-id": value },
      art,
      h("span", { class: "choice-text" }, h("b", { text: title }), h("span", { text: desc })),
      h("span", { class: "radio" }, h("i")),
    );
    el.addEventListener("click", () => {
      settings.screen = value;
      paint();
      void save();
    });
    return el;
  };
  const items = [
    option("primary", "Main display", IS_WINDOWS ? "Always on the display Windows calls main." : "Always on the display your desktop calls primary."),
    option("cursor", "Display under the cursor", "Follows you: the display your pointer is on when the island opens."),
  ];
  function paint() {
    for (const it of items) {
      const on = it.dataset.id === settings.screen;
      it.classList.toggle("on", on);
      it.setAttribute("aria-checked", String(on));
    }
  }
  paint();
  return [
    card("Where the island lives", "Scaling, resolution changes and monitors coming and going are picked up on their own.", h("div", { class: "choices two", role: "radiogroup" }, ...items)),
  ];
}

// Startup ─────────────────────────────────────────────────────────────────────

function startupPage(): HTMLElement[] {
  return [
    card(
      "Startup",
      null,
      row(
        "Launch at sign-in",
        "Start Coucou quietly in the notification area when you sign in.",
        toggle(settings.autostart, "Launch at sign-in", (v) => {
          settings.autostart = v;
          void save();
        }),
      ),
    ),
  ];
}

// About ───────────────────────────────────────────────────────────────────────

function aboutPage(): HTMLElement[] {
  return [
    h(
      "div",
      { class: "about-hero" },
      h("img", { src: appIcon, alt: "", width: "64", height: "64" }),
      h("div", {}, h("b", { text: "Coucou" }), h("span", { text: version ? `Version ${version}` : "Development build" })),
    ),
    card(
      "Privacy",
      null,
      h(
        "ul",
        { class: "bullets" },
        h("li", { text: "No telemetry. Network requests only go to the services you configure yourself." }),
        h("li", { text: `Keys live in ${VAULT} — never on disk and never in the interface.` }),
        h("li", { text: "Dropped files are copied to a private inbox on this machine and only sent to Claude when you ask about them." }),
      ),
    ),
    card("Log", "Hook events, permission decisions and poller problems. It stays on your machine.", h("code", { class: "block", text: LOG_PATH })),
    card(
      "Introduction",
      null,
      row("Replay the introduction", "Shows the first-launch tour and setup checklist in the island again.", btn("Replay", "secondary", () => void sendTo("island", "show-welcome", null), LINE.sparkle)),
    ),
  ];
}

// Screen ──────────────────────────────────────────────────────────────────────

function screenPage(): HTMLElement[] {
  const st = ScreenShare.current;
  const status = h(
    "div",
    { class: `hero ${st.active ? "live" : "off"}` },
    h("div", { class: "hero-icon" }, ico(LINE.screen, 22, 1.8)),
    h(
      "div",
      { class: "hero-text" },
      h("b", { text: st.active ? "SCREEN ACCESS ACTIVE" : "Screen access is off" }),
      h("span", {
        text: st.active
          ? `Coucou can see “${st.label ?? "your screen"}” since ${new Date(st.since ?? Date.now()).toLocaleTimeString()}. Nothing is recorded or sent.`
          : "Coucou can't see your screen. You choose what to share, and it stays visible in the island until you stop.",
      }),
    ),
  );
  const msg = messageSlot();
  const blocks: HTMLElement[] = [status];

  if (!ScreenShare.supported) {
    blocks.push(card("Not available here", null, notice("warn", "This system's webview doesn't offer screen capture, so Coucou can't see your screen on it.")));
    return blocks;
  }

  const actions = h("div", { class: "actions" });
  if (!st.active) {
    const share = btn("Share screen…", "primary", async () => {
      setBtnState(share, "busy");
      const res = await ScreenShare.start();
      setBtnState(share, "idle");
      if (!res.ok) msg.show(notice(res.reason === "cancelled" ? "info" : res.reason === "declined" ? "info" : "err", res.message));
    }, LINE.screen);
    actions.append(share);
  } else {
    actions.append(btn("Stop sharing", "danger", () => ScreenShare.stop(), LINE.x));
    const ask = btn("Ask Claude about this", "primary", async () => {
      setBtnState(ask, "busy");
      try {
        const file = await ScreenShare.askClaude();
        setBtnState(ask, "done");
        setBtnLabel(ask, "Attached");
        msg.show(notice("ok", `${file.name} is attached to the chat in the island. Write your question there.`));
      } catch (err) {
        setBtnState(ask, "idle");
        const text = String((err as Error)?.message ?? err);
        if (text !== "Not attached.") msg.show(notice("err", `Couldn't attach a screenshot: ${text}`));
      }
    }, LINE.sparkle);
    actions.append(ask);
  }

  const preview = h("div", { class: "screen-preview" });
  if (st.active && ScreenShare.mediaStream) {
    const video = h("video", { autoplay: true, muted: true, playsinline: true }) as HTMLVideoElement;
    video.srcObject = ScreenShare.mediaStream;
    preview.append(video, h("span", { class: "rec-tag" }, h("i"), h("span", { text: "LIVE · only you can see this" })));
  } else {
    preview.append(h("div", { class: "screen-empty" }, ico(LINE.eyeOff, 22, 1.7), h("span", { text: "No preview — nothing is being shared." })));
  }

  blocks.push(
    card("Share", "You pick the screen or window in the system picker. Stop here, in the island, or from the system's own sharing bar.", preview, actions, msg.el),
    card(
      "What Coucou does with it",
      null,
      h(
        "ul",
        { class: "bullets" },
        h("li", { text: "Shows a live preview here, and nothing else, while you share." }),
        h("li", { text: "“Ask Claude about this” takes one still image after a second confirmation and attaches it to the chat; it reaches Claude only when you send a message." }),
        h("li", { text: "Nothing is recorded, uploaded in the background, or kept after you stop." }),
      ),
    ),
  );
  return blocks;
}

// Devices ─────────────────────────────────────────────────────────────────────

function devicesPage(): HTMLElement[] {
  const me = h("div", { class: "device me" }, h("div", { class: "device-icon" }, ico(LINE.monitor, 20, 1.8)), h("div", { class: "device-text" }, h("b", { text: "This computer" }), h("span", { text: "Creating this device's identity…" })));
  const fp = h("code", { class: "fp" });
  const meCard = card("This computer", "Each Coucou device has its own key pair. Paired devices recognise each other by it.", me, fp);
  void thisDevice()
    .then((d) => {
      clear(me);
      me.append(
        h("div", { class: "device-icon" }, ico(LINE.monitor, 20, 1.8)),
        h("div", { class: "device-text" }, h("b", { text: d.name }), h("span", { text: `${d.platform === "windows" ? "Windows" : d.platform === "macos" ? "macOS" : "Linux"} · identity created ${new Date(d.createdAt).toLocaleDateString()}` })),
        pill(true, "This device"),
      );
      fp.textContent = `Fingerprint ${shortFingerprint(d.fingerprint)} · ECDSA P-256 · private key can't be exported`;
    })
    .catch(() => {
      fp.textContent = "Couldn't create a device identity in this webview.";
    });

  const list = h("div", { class: "device-list" });
  const drawList = (devices: PairedDevice[]) => {
    clear(list);
    if (devices.length === 0) {
      list.append(
        h(
          "div",
          { class: "device phone empty" },
          h("div", { class: "device-icon" }, ico(LINE.phone, 20, 1.8)),
          h("div", { class: "device-text" }, h("b", { text: "No phone paired" }), h("span", { text: "Pairing needs Coucou Mobile, which isn't available yet." })),
          (() => {
            const b = btn("Pair a phone", "secondary", undefined, LINE.plug);
            b.disabled = true;
            b.title = "Needs Coucou Mobile";
            return b;
          })(),
        ),
      );
      return;
    }
    for (const d of devices) {
      list.append(
        h(
          "div",
          { class: "device phone" },
          h("div", { class: "device-icon" }, ico(LINE.phone, 20, 1.8)),
          h("div", { class: "device-text" }, h("b", { text: d.identity.name }), h("span", { text: `Last active ${d.lastSeen ? new Date(d.lastSeen).toLocaleString() : "never"} · ${shortFingerprint(d.identity.fingerprint)}` })),
          btn("Revoke", "danger", async () => {
            const ok = await confirmDialog({ title: `Revoke ${d.identity.name}?`, body: "It will no longer be able to connect to this computer until you pair it again.", confirm: "Revoke", danger: true });
            if (!ok) return;
            await revokeDevice(d.identity.id);
            drawList(await pairedDevices());
          }, LINE.trash),
        ),
      );
    }
  };
  void pairedDevices().then(drawList).catch(() => drawList([]));

  const handoff = h(
    "div",
    { class: "handoff" },
    h("div", { class: "handoff-end" }, ico(LINE.monitor, 22, 1.7), h("span", { text: "Computer" })),
    h("div", { class: "handoff-link" }, h("i"), h("i"), h("i")),
    h("div", { class: "handoff-end dim" }, ico(LINE.phone, 22, 1.7), h("span", { text: "Phone" })),
  );

  return [
    meCard,
    card("Phones", "A paired phone could follow Claude's activity and answer permission requests away from your desk.", list),
    card(
      "Handoff",
      "Moving a chat or a watched Claude Code session between devices, with its context. Architecture ready — it needs Coucou Mobile on the other end, so nothing here is connected.",
      handoff,
      h(
        "dl",
        { class: "keys" },
        h("dt", { text: "What travels" }), h("dd", { text: "Conversation, current task and state, session id, both device identities — signed by this computer's key." }),
        h("dt", { text: "Pairing" }), h("dd", { text: "QR code with a one-time secret, then the same 6-digit code on both screens. Expires after 2 minutes." }),
        h("dt", { text: "Connection" }), h("dd", { text: "Same network first, a relay otherwise; heartbeat every 15 s, reconnect with backoff, duplicates ignored." }),
        h("dt", { text: "Specification" }), h("dd", { text: "docs/DEVICES.md in the Coucou repository." }),
      ),
    ),
  ];
}

// Permissions ─────────────────────────────────────────────────────────────────

function permissionsPage(): HTMLElement[] {
  const grants = h("div", { class: "grants" });
  const drawGrants = () => {
    clear(grants);
    const active = Consent.active;
    if (active.length === 0) {
      grants.append(h("div", { class: "grant empty" }, ico(LINE.shieldCheck, 16, 1.9), h("span", { text: "Nothing is allowed right now beyond Claude Code hooks and the keys you saved." })));
      return;
    }
    for (const g of active) {
      const cap = CAPABILITIES.find((c) => c.id === g.capability)!;
      grants.append(
        h(
          "div",
          { class: "grant" },
          h("span", { class: `risk-dot ${cap.risk}` }),
          h("div", { class: "grant-text" }, h("b", { text: cap.title }), h("span", { text: `${g.detail} · since ${new Date(g.at).toLocaleTimeString()}` })),
          btn("Revoke", "danger", () => Consent.revoke(g.capability), LINE.x),
        ),
      );
    }
  };
  drawGrants();

  const matrix = h(
    "div",
    { class: "caps" },
    ...CAPABILITIES.map((c) =>
      h(
        "div",
        { class: `cap ${c.availability}` },
        h("div", { class: "cap-head" }, h("b", { text: c.title }), h("span", { class: `chip risk ${c.risk}`, text: RISK_LABEL[c.risk] }), h("span", { class: `chip avail ${c.availability}`, text: AVAILABILITY_LABEL[c.availability] })),
        h("p", { text: c.summary }),
        c.blocker ? h("p", { class: "cap-blocker", text: c.blocker }) : null,
      ),
    ),
  );

  return [
    card("Allowed right now", "Grants last until you revoke them or quit Coucou. High-risk access is asked for every time.", grants),
    card("What Coucou can do", "Everything Coucou can or might do on this computer, how risky it is, and whether it exists yet. Nothing on this list acts without the permission shown.", matrix),
  ];
}

const PAGES: Page[] = [
  { id: "claude-code", title: "Claude Code", subtitle: "Watch sessions and answer permission requests from the island.", icon: LINE.terminal, render: claudeCodePage, status: () => hookStatus.installed },
  { id: "claude", title: "Claude", subtitle: "Chat with Claude from the island.", icon: LINE.sparkle, render: claudePage, status: () => present["anthropic-api-key"] ?? false },
  { id: "integrations", title: "Integrations", subtitle: "Your services, as little Mochis next to the big one.", icon: LINE.plug, render: integrationsPage },
  { id: "general", title: "General", subtitle: "How the island behaves.", icon: LINE.sliders, render: generalPage },
  { id: "sound", title: "Sound", subtitle: "What Mochi sounds like.", icon: LINE.speaker, render: soundPage, status: () => (settings.soundEnabled ? null : false) },
  { id: "display", title: "Display", subtitle: "Which screen the island lives on.", icon: LINE.monitor, render: displayPage },
  { id: "startup", title: "Startup", subtitle: "When Coucou starts.", icon: LINE.power, render: startupPage },
  { id: "screen", title: "Screen", subtitle: "Let Coucou see your screen — only when you say so.", icon: LINE.screen, render: screenPage, status: () => (ScreenShare.current.active ? true : null) },
  { id: "devices", title: "Devices", subtitle: "This computer, and the phones it may one day pair with.", icon: LINE.phone, render: devicesPage },
  { id: "permissions", title: "Permissions", subtitle: "What Coucou may do, and what you've allowed.", icon: LINE.shield, render: permissionsPage },
  { id: "about", title: "About", subtitle: "Privacy, files and version.", icon: LINE.info, render: aboutPage },
];

// ── Shell ─────────────────────────────────────────────────────────────────────

/** Pages made only of preferences, safe to redraw when the island changes one. */
const REDRAW_ON_EXTERNAL_CHANGE = new Set(["general", "sound", "display", "startup"]);

let current = recall("coucou.settings.page") ?? PAGES[0].id;
const navButtons = new Map<string, HTMLButtonElement>();
const navIndicator = h("i", { class: "nav-indicator" });
const pageEl = h("main", { class: "page", tabindex: "-1" });
let leaving: number | null = null;

function refreshNav() {
  for (const p of PAGES) {
    const b = navButtons.get(p.id);
    if (!b) continue;
    b.classList.toggle("on", p.id === current);
    b.setAttribute("aria-current", p.id === current ? "page" : "false");
    const dotEl = b.querySelector(".nav-dot") as HTMLElement | null;
    const s = p.status?.();
    if (dotEl) {
      dotEl.className = `nav-dot ${s == null ? "" : s ? "ok" : "off"}`;
    }
  }
  const active = navButtons.get(current);
  if (active) {
    navIndicator.style.transform = `translate3d(0, ${active.offsetTop}px, 0)`;
    navIndicator.style.height = `${active.offsetHeight}px`;
  }
}

function renderPage(animate: boolean) {
  const page = PAGES.find((p) => p.id === current) ?? PAGES[0];
  const draw = () => {
    clear(pageEl);
    const head = h("header", { class: "page-head" }, h("h1", { text: page.title }), h("p", { text: page.subtitle }));
    const blocks = page.render();
    pageEl.append(head, ...blocks);
    [head, ...blocks].forEach((el, i) => el.style.setProperty("--i", String(i)));
    pageEl.classList.remove("leaving");
    pageEl.classList.toggle("entering", animate);
    pageEl.scrollTop = 0;
  };
  if (!animate) return draw();
  if (leaving != null) window.clearTimeout(leaving);
  pageEl.classList.add("leaving");
  leaving = window.setTimeout(() => {
    leaving = null;
    draw();
  }, 120);
}

function go(id: string) {
  if (id === current) return;
  current = id;
  store("coucou.settings.page", id);
  refreshNav();
  renderPage(true);
}

function buildShell(): HTMLElement {
  const nav = h("nav", { class: "nav-list", "aria-label": "Settings sections" }, navIndicator);
  for (const p of PAGES) {
    const b = h(
      "button",
      { class: "nav-item", type: "button", "data-id": p.id },
      ico(p.icon, 16, 1.9),
      h("span", { text: p.title }),
      h("i", { class: "nav-dot" }),
    ) as HTMLButtonElement;
    b.addEventListener("click", () => go(p.id));
    navButtons.set(p.id, b);
    nav.append(b);
  }
  // Up / down arrows move between sections.
  nav.addEventListener("keydown", (e) => {
    const k = (e as KeyboardEvent).key;
    if (k !== "ArrowDown" && k !== "ArrowUp") return;
    e.preventDefault();
    const i = PAGES.findIndex((p) => p.id === current);
    const next = PAGES[(i + (k === "ArrowDown" ? 1 : PAGES.length - 1)) % PAGES.length];
    go(next.id);
    navButtons.get(next.id)?.focus();
  });

  const side = h(
    "aside",
    { class: "side" },
    h(
      "div",
      { class: "brand" },
      h("img", { src: appIcon, alt: "", width: "34", height: "34" }),
      h("div", {}, h("b", { text: "Coucou" }), h("span", { text: version ? `v${version}` : "dev" })),
    ),
    nav,
    h("div", { class: "side-foot" }, ico(LINE.lock, 13, 2), h("span", { text: "No telemetry" })),
  );
  return h("div", { class: "shell" }, side, pageEl);
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function main() {
  const boot = await Bridge.boot();
  if (boot) {
    settings = { ...settings, ...boot.settings };
    version = boot.version;
  }
  hookStatus = (await Bridge.hooksStatus()) ?? hookStatus;

  const keys = [
    "anthropic-api-key", "stripe-api-key", "github-token", "vercel-token",
    "n8n-url", "n8n-api-key", "resend-api-key", "notion-api-key", "calcom-api-key",
  ];
  await Promise.all(keys.map(async (k) => {
    present[k] = (await Bridge.secretPresent(k)) ?? false;
  }));

  if (!PAGES.some((p) => p.id === current)) current = PAGES[0].id;
  installPointerFx();
  Consent.setPrompt(consentPrompt);
  ScreenShare.wire();
  // Screen access and grants change from elsewhere (the island's Stop, the
  // system bar): keep those pages truthful.
  ScreenShare.subscribe(() => {
    refreshNav();
    if (current === "screen" || current === "permissions") renderPage(false);
  });
  Consent.subscribe(() => {
    if (current === "permissions") renderPage(false);
  });
  // The island asks for a specific page ("Set up", "API key", "Screen"…).
  void onEvent<string>("settings-page", (id) => {
    if (PAGES.some((p) => p.id === id)) go(id);
  });
  clear(root);
  root.append(buildShell());
  document.body.classList.add("ready");
  renderPage(false);
  requestAnimationFrame(refreshNav);
  window.addEventListener("resize", refreshNav);

  // The island changes sound and auto-close too: follow it, but never yank a
  // page out from under someone typing into it.
  void onEvent<Settings>("settings-changed", (s) => {
    const next = { ...settings, ...s };
    // Our own saves come back as this event too: nothing to redraw then, and
    // redrawing would cut short the switch that was just flipped.
    if (JSON.stringify(next) === JSON.stringify(settings)) return;
    settings = next;
    hookStatus.installed = settings.hooksInstalled;
    refreshNav();
    const editing = document.activeElement instanceof HTMLInputElement;
    if (!editing && REDRAW_ON_EXTERNAL_CHANGE.has(current)) renderPage(false);
  });
}

void main();
