// Screen access. Lives in the settings window (a normal, focusable window, so
// the system picker can appear over it); the island only shows the indicator
// and a Stop button, and talks to this module through window events.
//
// Rules this module enforces:
//   · it never starts on its own — only from a click, after a consent dialog,
//     through the system picker where the user chooses what to share;
//   · while it runs, the island says SCREEN ACCESS ACTIVE, with Stop;
//   · stopping from anywhere (Settings, the island, the system's own "Stop
//     sharing", revoking the grant) ends it everywhere;
//   · nothing is recorded or sent; a screenshot leaves only on a second
//     explicit request, into the chat, where it still waits for you to send.

import { Bridge, onEvent, sendTo, type DroppedFile } from "./bridge";
import { Consent } from "./capabilities";
import type { ScreenAccess } from "./state";

/** Claude's vision input is most efficient at this long edge (larger is downscaled anyway). */
const MAX_EDGE = 1568;

type Listener = (state: ScreenAccess) => void;

export type StartResult =
  | { ok: true }
  | { ok: false; reason: "unsupported" | "declined" | "cancelled" | "error"; message: string };

class ScreenShareController {
  private stream: MediaStream | null = null;
  private state: ScreenAccess = { active: false, label: null, since: null };
  private listeners = new Set<Listener>();
  private wired = false;

  /** getDisplayMedia exists here. Whether it is allowed is only known on use. */
  get supported(): boolean {
    return typeof navigator.mediaDevices?.getDisplayMedia === "function";
  }

  get current(): ScreenAccess {
    return { ...this.state };
  }

  get mediaStream(): MediaStream | null {
    return this.stream;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Listens for Stop pressed in the island. Call once, in the settings window. */
  wire() {
    if (this.wired) return;
    this.wired = true;
    void onEvent<null>("screen-share-stop", () => this.stop());
    // The island may have restarted: tell it the truth again.
    void onEvent<null>("screen-share-query", () => this.broadcast());
    Consent.onRevoke("screen.capture", () => this.stop());
  }

  async start(): Promise<StartResult> {
    if (this.stream) return { ok: true };
    if (!this.supported) {
      return { ok: false, reason: "unsupported", message: "This system's webview doesn't offer screen capture." };
    }
    const allowed = await Consent.request(
      "screen.capture",
      "You'll pick a screen or a window next. Coucou only sees what you pick, until you press Stop.",
    );
    if (!allowed) return { ok: false, reason: "declined", message: "Screen access was not allowed." };

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        // A slow frame rate is plenty for a preview and stills, and costs little.
        video: { frameRate: { ideal: 5, max: 10 } },
        audio: false,
      });
    } catch (err) {
      Consent.release("screen.capture");
      const name = (err as DOMException)?.name;
      if (name === "NotAllowedError" || name === "AbortError") {
        return { ok: false, reason: "cancelled", message: "Nothing was shared." };
      }
      if (name === "NotSupportedError" || name === "NotFoundError") {
        return { ok: false, reason: "unsupported", message: "Screen capture isn't available in this webview." };
      }
      return { ok: false, reason: "error", message: String((err as Error)?.message ?? err) };
    }

    const track = stream.getVideoTracks()[0];
    this.stream = stream;
    // The system's own "Stop sharing" bar ends the track: follow it.
    track?.addEventListener("ended", () => this.stop());
    this.state = { active: true, label: track?.label || "Screen", since: Date.now() };
    this.broadcast();
    return { ok: true };
  }

  stop() {
    if (!this.stream && !this.state.active) return;
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = null;
    this.state = { active: false, label: null, since: null };
    Consent.release("screen.capture");
    this.broadcast();
  }

  /** One still frame, downscaled, as JPEG bytes. Only while sharing. */
  async still(): Promise<Uint8Array> {
    const track = this.stream?.getVideoTracks()[0];
    if (!track) throw new Error("Not sharing a screen.");
    const video = document.createElement("video");
    video.muted = true;
    video.srcObject = new MediaStream([track]);
    await video.play();
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) throw new Error("The shared screen has no picture yet.");
    const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    canvas.getContext("2d")!.drawImage(video, 0, 0, canvas.width, canvas.height);
    video.pause();
    video.srcObject = null;
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.86));
    if (!blob) throw new Error("Could not encode the screenshot.");
    return new Uint8Array(await blob.arrayBuffer());
  }

  /**
   * Takes a still and attaches it to the island's chat. Asks first; nothing
   * goes to Claude until the user writes and sends a message about it.
   */
  async askClaude(): Promise<DroppedFile> {
    const ok = await Consent.request(
      "screen.ask-claude",
      "One still image of what you're sharing will be attached to the chat. It's sent to Claude only when you send a message.",
    );
    if (!ok) throw new Error("Not attached.");
    const bytes = await this.still();
    const file = await Bridge.ingestScreenshot(bytes);
    await sendTo("island", "chat-attach", { name: file.name, path: file.path });
    return file;
  }

  private broadcast() {
    for (const fn of this.listeners) fn(this.current);
    void sendTo("island", "screen-share", this.current);
  }
}

export const ScreenShare = new ScreenShareController();
