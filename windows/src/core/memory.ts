// Coucou's memory: summaries and notes the user chose to keep.
//
// Off by default. While it is off nothing is written. Every item is something
// the user saved with a click (or an automation they wrote that says
// "summarise"): no background collection, no prompts or commands recorded on
// the side. It lives in this machine's webview storage (IndexedDB) — never in
// settings.json, never sent anywhere — and Settings → Memory lists, exports,
// deletes and clears it.
//
// What may be stored: short text. Secrets must not be: `scrub` removes
// anything shaped like a key or token before an item is saved.

export interface MemoryItem {
  id: string;
  kind: "summary" | "note" | "insight";
  title: string;
  text: string;
  project: string | null;
  at: number;
}

const DB = "coucou-memory";
const STORE = "items";
const MAX_TEXT = 4000;
const MAX_ITEMS = 300;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("Storage isn't available in this webview."));
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" }).createIndex("at", "at");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Couldn't open memory."));
  });
}

async function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await open();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = run(t.objectStore(STORE));
      t.oncomplete = () => resolve(req ? (req.result as T) : undefined);
      t.onerror = () => reject(t.error ?? new Error("Memory transaction failed."));
      t.onabort = () => reject(t.error ?? new Error("Memory transaction aborted."));
    });
  } finally {
    db.close();
  }
}

/** Removes anything that looks like a credential. Conservative on purpose. */
export function scrub(text: string): string {
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, "[key removed]")
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, "[token removed]")
    .replace(/\b(xox[abposr]-[A-Za-z0-9-]{10,})/g, "[token removed]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[key removed]")
    .replace(/\b(re_[A-Za-z0-9_]{16,}|rk_live_[A-Za-z0-9]{16,}|sk_live_[A-Za-z0-9]{16,}|pk_live_[A-Za-z0-9]{16,})/g, "[key removed]")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[private key removed]")
    .replace(/\b(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S+/gi, "$1=[removed]")
    .replace(/https:\/\/(discord(app)?\.com\/api\/webhooks|hooks\.slack\.com)\/\S+/gi, "[webhook removed]");
}

function newId(): string {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

type Listener = () => void;
const listeners = new Set<Listener>();
const changed = () => listeners.forEach((fn) => fn());

export const Memory = {
  subscribe(fn: Listener) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  async list(): Promise<MemoryItem[]> {
    const all = (await tx<MemoryItem[]>("readonly", (s) => s.getAll())) ?? [];
    return all.sort((a, b) => b.at - a.at);
  },

  async add(item: Omit<MemoryItem, "id" | "at">): Promise<MemoryItem> {
    const saved: MemoryItem = {
      ...item,
      id: newId(),
      at: Date.now(),
      title: scrub(item.title).slice(0, 120),
      text: scrub(item.text).slice(0, MAX_TEXT),
    };
    await tx("readwrite", (s) => s.put(saved));
    // Bounded: the oldest go first.
    const all = await this.list();
    if (all.length > MAX_ITEMS) {
      const extra = all.slice(MAX_ITEMS);
      await tx("readwrite", (s) => {
        for (const x of extra) s.delete(x.id);
      });
    }
    changed();
    return saved;
  },

  async remove(id: string) {
    await tx("readwrite", (s) => s.delete(id));
    changed();
  },

  async clear() {
    await tx("readwrite", (s) => s.clear());
    changed();
  },

  /** A JSON file's worth of everything, for the user to keep or inspect. */
  async exportJson(): Promise<string> {
    return JSON.stringify({ app: "coucou", exported: new Date().toISOString(), items: await this.list() }, null, 2);
  },

  /**
   * The context block the chat may prepend to the first message of a
   * conversation when "Use in chat" is on. Newest notes first, capped.
   */
  async chatContext(project: string | null, maxChars = 1800): Promise<{ text: string; count: number } | null> {
    const items = await this.list();
    const relevant = items.filter((i) => !project || !i.project || i.project === project);
    if (relevant.length === 0) return null;
    let text = "";
    let count = 0;
    for (const i of relevant) {
      const line = `- ${i.title}: ${i.text.replace(/\s+/g, " ").slice(0, 400)}\n`;
      if (text.length + line.length > maxChars) break;
      text += line;
      count++;
    }
    return count ? { text, count } : null;
  },
};
