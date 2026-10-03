// Settings window — the place where anything that writes to disk is confirmed.
//
// Same contracts as before the redesign:
//   · settings.json for Claude Code is only written after the user has seen the
//     exact diff, and only if the file still matches that preview (fingerprint);
//   · keys go straight to the OS vault through Rust and never come back — the
//     window can only ask whether one exists;
//   · preferences are saved through Bridge.saveSettings, which tells the island.

import "./settings.css";
import { Bridge, onEvent, type HookStatus } from "../core/bridge";
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
  return h("section", { class: "card" }, head, ...children);
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
  let confirmTimer: number | null = null;

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
    if (removeBtn.dataset.confirm !== "1") {
      removeBtn.dataset.confirm = "1";
      setBtnLabel(removeBtn, "Click to confirm");
      removeBtn.classList.add("confirm");
      if (confirmTimer != null) window.clearTimeout(confirmTimer);
      confirmTimer = window.setTimeout(resetRemove, 3200);
      return;
    }
    resetRemove();
    setBtnState(removeBtn, "busy");
    try {
      await Bridge.secretClear(def.key);
      present[def.key] = false;
      setBtnState(removeBtn, "idle");
      msg.show(notice("info", "Removed."));
      paint();
      onChange?.();
    } catch (err) {
      setBtnState(removeBtn, "failed");
      msg.show(notice("err", `Could not remove: ${String(err).replace(/^Error:\s*/, "")}`));
    }
  }

  function resetRemove() {
    if (confirmTimer != null) window.clearTimeout(confirmTimer);
    confirmTimer = null;
    delete removeBtn.dataset.confirm;
    removeBtn.classList.remove("confirm");
    setBtnLabel(removeBtn, "Remove");
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
    refreshNav,
  );

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
    card("API key", `Used by the chat in the island. It lives in ${VAULT}; the island can only ask whether it exists.`, key),
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
  return [
    card(
      "Island",
      null,
      row(
        "Auto-close",
        "How long the open island waits after the pointer leaves. Requests that need you never auto-close.",
        slider(5, 120, 1, Math.round(settings.autoCloseInterval), (v) => `${v}s`, (v) => {
          settings.autoCloseInterval = v;
          saveSoon();
        }, "Auto-close delay"),
      ),
    ),
    card(
      "Using the island",
      null,
      h(
        "dl",
        { class: "keys" },
        h("dt", { text: "Top-centre of the screen" }), h("dd", { text: "Mochi peeks out" }),
        h("dt", { text: "Click the small island" }), h("dd", { text: "It opens" }),
        h("dt", { text: "Esc" }), h("dd", { text: "Closes it (not while a request waits for you)" }),
        h("dt", { text: "Drag a file onto it" }), h("dd", { text: "Mochi swallows it and you can ask about it" }),
        h("dt", { text: "Tray icon" }), h("dd", { text: "Open, Settings…, Pause, Quit" }),
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
