// What Coucou may do on this computer, how risky each thing is, and whether it
// actually exists yet. This is the single place the UI reads that from, so a
// feature can never look more finished than it is.
//
// Every sensitive action goes through the consent broker below. Grants are
// per session (never persisted), visible in Settings → Permissions, and
// revocable at any time.

export type Risk = "low" | "medium" | "high";

/**
 * Where a capability stands today. The dependency matrix in
 * docs/CAPABILITIES.md uses the same categories.
 */
export type Availability =
  | "available" // fully working now
  | "needs-permission" // works, behind an explicit OS / user grant each time
  | "architecture-ready" // types, policy and UI slots exist; no executor yet
  | "needs-mobile-app" // waits on Coucou Mobile
  | "needs-backend" // waits on a relay / server Coucou doesn't run
  | "platform-limited" // the OS or the webview doesn't offer it
  | "not-implemented";

export type CapabilityId =
  | "claude-code.observe"
  | "claude-code.approve"
  | "files.read-dropped"
  | "chat.anthropic"
  | "screen.capture"
  | "screen.ask-claude"
  | "app.awareness"
  | "files.write"
  | "terminal.run"
  | "input.mouse"
  | "input.keyboard"
  | "devices.pair"
  | "devices.handoff";

export interface Capability {
  id: CapabilityId;
  title: string;
  risk: Risk;
  availability: Availability;
  /** What it does, in one sentence. */
  summary: string;
  /** What it waits on, when it isn't available. */
  blocker?: string;
}

export const CAPABILITIES: Capability[] = [
  {
    id: "claude-code.observe", title: "Watch Claude Code sessions", risk: "low", availability: "available",
    summary: "Tool calls, prompts and session events arrive through the hooks you installed.",
  },
  {
    id: "claude-code.approve", title: "Answer permission requests", risk: "medium", availability: "available",
    summary: "Allow or deny a Claude Code request — only ever with a click, never by default.",
  },
  {
    id: "files.read-dropped", title: "Read files you drop", risk: "low", availability: "available",
    summary: "A dropped file is copied to a private inbox and only sent to Claude when you ask about it.",
  },
  {
    id: "chat.anthropic", title: "Chat through the Anthropic API", risk: "low", availability: "available",
    summary: "Messages go to api.anthropic.com with your own key, held by the OS vault.",
  },
  {
    id: "screen.capture", title: "See your screen", risk: "high", availability: "needs-permission",
    summary: "You choose a screen or window in the system picker; a banner stays up while Coucou can see it.",
  },
  {
    id: "screen.ask-claude", title: "Ask Claude about a screenshot", risk: "high", availability: "needs-permission",
    summary: "One still frame, taken when you click, attached to the chat. Nothing is sent until you send a message.",
  },
  {
    id: "app.awareness", title: "Know which app is in front", risk: "low", availability: "architecture-ready",
    summary: "Would give the chat the name and title of the focused window.",
    blocker: "Needs a Rust reader for the foreground window (GetForegroundWindow on Windows; not possible on Wayland).",
  },
  {
    id: "files.write", title: "Create and edit files", risk: "medium", availability: "architecture-ready",
    summary: "Would let Coucou write files after showing you the change. Claude Code already does this, under its own permissions.",
    blocker: "No executor yet: every write would need a preview-and-confirm path first.",
  },
  {
    id: "terminal.run", title: "Run commands", risk: "medium", availability: "architecture-ready",
    summary: "Coucou approves the commands Claude Code wants to run; it does not run commands of its own.",
    blocker: "Deliberately not implemented in Coucou itself.",
  },
  {
    id: "input.mouse", title: "Move and click the mouse", risk: "high", availability: "architecture-ready",
    summary: "Would require approval for every action, with a visible indicator and a stop control.",
    blocker: "Not implemented. Needs SendInput (Windows) behind per-action consent; impossible on Wayland by design.",
  },
  {
    id: "input.keyboard", title: "Type on your behalf", risk: "high", availability: "architecture-ready",
    summary: "Same rules as the mouse: per-action approval, visible, stoppable.",
    blocker: "Not implemented.",
  },
  {
    id: "devices.pair", title: "Pair a phone", risk: "high", availability: "needs-mobile-app",
    summary: "This computer has a device identity ready; pairing needs Coucou Mobile on the other end.",
    blocker: "Coucou Mobile does not exist yet. Protocol: docs/DEVICES.md.",
  },
  {
    id: "devices.handoff", title: "Hand a session to your phone", risk: "medium", availability: "needs-mobile-app",
    summary: "Move a conversation and its task between devices with its context intact.",
    blocker: "Needs Coucou Mobile, and a relay for when both devices aren't on the same network.",
  },
];

export function capability(id: CapabilityId): Capability {
  return CAPABILITIES.find((c) => c.id === id)!;
}

export const RISK_LABEL: Record<Risk, string> = { low: "Low risk", medium: "Medium risk", high: "High risk" };

export const AVAILABILITY_LABEL: Record<Availability, string> = {
  "available": "Working",
  "needs-permission": "Asks each time",
  "architecture-ready": "Architecture ready",
  "needs-mobile-app": "Needs Coucou Mobile",
  "needs-backend": "Needs a server",
  "platform-limited": "Not on this system",
  "not-implemented": "Not implemented",
};

// ── Consent ─────────────────────────────────────────────────────────────────

export interface Grant {
  capability: CapabilityId;
  /** What exactly was approved ("Entire screen 1", "screen-…jpg"). */
  detail: string;
  at: number;
}

export interface ConsentRequest {
  capability: Capability;
  /** Specific description of this request. */
  detail: string;
}

/** Shows the request to the user; resolves true only on an explicit "Allow". */
export type ConsentPrompt = (req: ConsentRequest) => Promise<boolean>;

type GrantListener = (grants: Grant[]) => void;

/**
 * Asks before anything sensitive happens, remembers per-session grants, and
 * lets them be revoked. A capability that isn't available can never be
 * granted, whatever the caller asks.
 */
class ConsentBroker {
  private prompt: ConsentPrompt | null = null;
  private grants: Grant[] = [];
  private listeners = new Set<GrantListener>();
  private revokers = new Map<CapabilityId, () => void>();

  /** Each window registers how it asks (a dialog in Settings). */
  setPrompt(fn: ConsentPrompt) {
    this.prompt = fn;
  }

  async request(id: CapabilityId, detail: string): Promise<boolean> {
    const cap = capability(id);
    if (cap.availability !== "available" && cap.availability !== "needs-permission") return false;
    // Low-risk, already-available capabilities are covered by setup (hooks
    // installed, key saved). Everything else is asked, every time.
    if (cap.risk === "low" && cap.availability === "available") return true;
    if (!this.prompt) return false;
    const ok = await this.prompt({ capability: cap, detail });
    if (ok) this.record({ capability: id, detail, at: Date.now() });
    return ok;
  }

  /** Called by the feature itself when its access ends on its own. */
  release(id: CapabilityId) {
    this.grants = this.grants.filter((g) => g.capability !== id);
    this.revokers.delete(id);
    this.emit();
  }

  /** The user pulled the plug: stop the feature, forget the grant. */
  revoke(id: CapabilityId) {
    const stop = this.revokers.get(id);
    this.release(id);
    stop?.();
  }

  /** A feature that keeps access open registers how to stop it. */
  onRevoke(id: CapabilityId, stop: () => void) {
    this.revokers.set(id, stop);
  }

  get active(): Grant[] {
    return [...this.grants];
  }

  subscribe(fn: GrantListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private record(grant: Grant) {
    this.grants = [grant, ...this.grants.filter((g) => g.capability !== grant.capability)];
    this.emit();
  }

  private emit() {
    for (const fn of this.listeners) fn(this.active);
  }
}

export const Consent = new ConsentBroker();

// ── Future computer actions ─────────────────────────────────────────────────

/**
 * The shape every future action on the computer must take. Nothing executes
 * these yet: `policyFor` only says what an executor would have to require, so
 * that when one is written it cannot skip the rules.
 */
export type ComputerAction =
  | { kind: "read-file"; path: string }
  | { kind: "write-file"; path: string; preview: string }
  | { kind: "run-command"; command: string; cwd: string }
  | { kind: "click"; x: number; y: number; display: number }
  | { kind: "type"; text: string }
  | { kind: "key"; combo: string };

export interface ActionPolicy {
  capability: CapabilityId;
  risk: Risk;
  /** Must the user approve this specific action (not just the capability)? */
  perAction: boolean;
  /** Must a visible indicator be up while it runs? */
  indicator: boolean;
}

export function policyFor(action: ComputerAction): ActionPolicy {
  switch (action.kind) {
    case "read-file":
      return { capability: "files.read-dropped", risk: "low", perAction: false, indicator: false };
    case "write-file":
      return { capability: "files.write", risk: "medium", perAction: true, indicator: false };
    case "run-command":
      return { capability: "terminal.run", risk: "medium", perAction: true, indicator: true };
    case "click":
      return { capability: "input.mouse", risk: "high", perAction: true, indicator: true };
    case "type":
    case "key":
      return { capability: "input.keyboard", risk: "high", perAction: true, indicator: true };
  }
}
