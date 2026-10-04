# Coucou for Windows and Linux — capabilities and their dependencies

This is the dependency matrix for everything the Tauri build does, or is being
prepared to do. The code reads the same table: `windows/src/core/capabilities.ts`
drives Settings → Security center, so the app can never claim more than this file.
The complete feature inventory, including everything that isn't
security-relevant, is [`FEATURES.md`](FEATURES.md).

Categories:

1. **Fully supported now** — works in this build.
2. **OS / user permission required** — works, behind an explicit grant each time.
3. **Mobile application required** — waits on Coucou Mobile.
4. **Backend / server required** — waits on a service Coucou does not run.
5. **Third-party API required** — depends on an external API.
6. **Platform limitation** — the OS or the webview does not offer it.
7. **Architecture prepared, implementation blocked** — types, policy and UI slots exist; no executor.

| Capability | Risk | Category | Where it lives | Notes |
|---|---|---|---|---|
| Watch Claude Code sessions | Low | 1 | `island/hooks.ts`, `src-tauri/src/pipe.rs`, `hook/` | Hook events over the named pipe / Unix socket. |
| Answer permission requests | Medium | 1 | `island/island.ts` (decide), `pipe.rs` (`answer`) | Click only. `approval_decision` now returns whether the relay was still waiting; a late click is shown as late, never as allowed. |
| Chat with Claude | Low | 1 + 5 | `views/chat.ts`, `src-tauri/src/claude.rs` | Anthropic Messages API with the user's key. |
| Test the API key | Low | 1 + 5 | `claude.rs` `check_key` | `GET /v1/models?limit=1` (no tokens spent). 401/403 → rejected, 429 → accepted but throttled, 5xx/network → unreachable. The key never leaves Rust. |
| Read dropped files | Low | 1 | `src-tauri/src/files.rs` | Copied to a private inbox, sent only with a chat message. |
| See the screen | High | 2 + 6 | `core/screen.ts`, Settings → Screen | `getDisplayMedia` behind a consent dialog and the system picker; SCREEN ACCESS ACTIVE in the island with Stop. Depends on the webview exposing screen capture: WebView2 (Windows) does; WebKitGTK support varies — the page says so when it's missing. **Needs testing on real Windows.** |
| Ask Claude about a screenshot | High | 2 + 5 | `core/screen.ts` `askClaude`, `files.rs` `ingest_screenshot` | Second consent, one JPEG still (≤ 1568 px long edge), saved to the inbox and attached to the chat; sent only when the user sends a message. Raw-bytes IPC, JPEG/PNG magic checked in Rust, 12 MB cap. |
| Know the focused app | Low | 7 | — | Needs a Rust reader for the foreground window (`GetForegroundWindow`); impossible on Wayland by design (category 6 there). |
| Create / edit files | Medium | 7 | `core/capabilities.ts` (`ComputerAction`, `policyFor`) | Policy: per-action preview and confirm. No executor. Claude Code already does this under its own permissions. |
| Run commands | Medium | 7 | same | Coucou approves Claude Code's commands; it runs no command that Claude, a web page or the user wrote. It only starts a few read-only helpers with fixed arguments, on a click: `docker ps`, and on Linux `gsettings` (wallpaper) and `gdbus` (MPRIS media). |
| Dictation (push to talk) | High | 2 | `platform/windows.rs` `dictate`, chat mic button | Windows speech recognition, one sentence per click, text goes into the field (never sent by itself). Needs Windows' microphone and online-speech privacy switches. Not available on Linux. |
| Read aloud | Low | 1 | insight view | The system's own voices (`speechSynthesis`). |
| Wallpaper match | Low | 1 | `desktop.rs` `wallpaper`, `core/wallpaper.ts` | On a click; image ≤ 40 MB, image formats only, sampled locally, never sent. |
| Now playing / media keys | Low | 1 | `platform/*` `now_playing`, `media_control` | Windows media session or Linux MPRIS; read while the Desk is open; play/pause/next on a click. |
| Docker containers | Low | 1 | `desktop.rs` `docker_ps` | `docker ps --all` on a click, read-only. |
| Weather | Low | 1 + 5 | `desktop.rs` `weather` | Open-Meteo, only after the user picks a place; sends that place's coordinates only. |
| Claude Code cost | Low | 1 | `hook/` `--statusline` | Only when Coucou can be the status line (none set); forwards cost, duration, lines, model — not the transcript. |
| Panic / hold | — | 1 | `core/guard.ts` | Denies the request on screen (the click) and returns every new one to the terminal; never approves. |
| Approval counts | Low | 1 | `core/guard.ts` | SHA-256 of tool + target with allow/deny counts; no command text. Clear in Security center. |
| Security log | Medium | 1 | `core/guard.ts` | Off by default; scrubbed request lines for 90 days, on this computer; weekly report. |
| Mouse control | High | 7 (+6 on Wayland) | same | Policy: per-action approval, visible indicator, stop control. Would need `SendInput` on Windows. Not implemented. |
| Keyboard control | High | 7 (+6 on Wayland) | same | As above. Not implemented. |
| Device identity | — | 1 | `core/devices.ts` | ECDSA P-256 key pair from WebCrypto, private key non-extractable, kept in IndexedDB. Fingerprint shown in Settings → Devices and the command center. |
| Pair a phone | High | 3 (+4 off-LAN) | `core/devices.ts` (types, offer), `docs/DEVICES.md` | Protocol and state machines written; disabled in the UI because Coucou Mobile doesn't exist. |
| Session handoff | Medium | 3 + 4 | `core/devices.ts` (`HandoffEnvelope`) | Envelope, signing and states written; not connected. |
| Revoke a paired device | — | 1 | `core/devices.ts` `revokeDevice` | Works on the (currently empty) paired list. |
| Risk reading of a permission request | — | 1 | `core/risk.ts` | Pattern matching on the request text only; nothing is run or opened. Advisory: it never approves, denies or hides a request. |
| Explain a request / summarise a session with Claude | Low | 1 + 5 | `claude.rs` `insight`, `core/insight.ts` | Only on a click (or a summary automation the user wrote). Request text and timeline lines, scrubbed of key-shaped strings. Never touches the chat history. |
| System stats (CPU, memory, battery, uptime) | Low | 1 | `src-tauri/src/system.rs`, `platform/*` | Read from `/proc`, `/sys`, `GetSystemTimes`, `GlobalMemoryStatusEx`, `GetSystemPowerStatus`. Only while the command center is on screen. |
| Project name and git branch | Low | 1 | `system.rs` `probe_project` | Absolute folder only; reads `.git/HEAD` and nothing else; marker files are checked for existence, never opened. |
| Automations | Medium | 1 | `core/automation.ts` | Triggers are real events; actions are flash, open, sound, webhook, summary. No action can answer a permission, run a command or change a file. 10 s gap and 30 runs/hour per rule; every run on the timeline. |
| Webhooks (ntfy, Discord, Slack, JSON) | Medium | 1 + 5 | `src-tauri/src/webhook.rs` | Addresses are secrets in the vault (`webhook-1..3`), https only, never echoed in errors or logs. Only the event and project are sent unless the rule includes details. |
| Memory | Low | 1 | `core/memory.ts` | Off by default; items saved with a click; secrets scrubbed; IndexedDB on this machine; list / delete / export / clear in Settings → Memory. |

## Security gates

Every capability above in category 2 or 7 goes through `Consent` in
`core/capabilities.ts`:

- a capability that isn't available can never be granted;
- high-risk access is asked for every time, in a dialog whose default focus is
  the safe choice;
- grants are per session, listed in Settings → Security center, revocable — and
  revoking screen access stops the capture;
- screen access can't be made invisible: hiding the island while sharing only
  collapses it to the compact island, which then says SCREEN ACCESS ACTIVE;
  Pause stops sharing.

## Not done on purpose

- No hidden or background capture, no recording.
- No remote control of any kind.
- No telemetry.
