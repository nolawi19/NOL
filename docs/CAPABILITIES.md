# Coucou for Windows and Linux — capabilities and their dependencies

This is the dependency matrix for everything the Tauri build does, or is being
prepared to do. The code reads the same table: `windows/src/core/capabilities.ts`
drives Settings → Permissions, so the app can never claim more than this file.

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
| Run commands | Medium | 7 | same | Coucou approves Claude Code's commands; it deliberately runs none of its own. |
| Mouse control | High | 7 (+6 on Wayland) | same | Policy: per-action approval, visible indicator, stop control. Would need `SendInput` on Windows. Not implemented. |
| Keyboard control | High | 7 (+6 on Wayland) | same | As above. Not implemented. |
| Device identity | — | 1 | `core/devices.ts` | ECDSA P-256 key pair from WebCrypto, private key non-extractable, kept in IndexedDB. Fingerprint shown in Settings → Devices and the command center. |
| Pair a phone | High | 3 (+4 off-LAN) | `core/devices.ts` (types, offer), `docs/DEVICES.md` | Protocol and state machines written; disabled in the UI because Coucou Mobile doesn't exist. |
| Session handoff | Medium | 3 + 4 | `core/devices.ts` (`HandoffEnvelope`) | Envelope, signing and states written; not connected. |
| Revoke a paired device | — | 1 | `core/devices.ts` `revokeDevice` | Works on the (currently empty) paired list. |

## Security gates

Every capability above in category 2 or 7 goes through `Consent` in
`core/capabilities.ts`:

- a capability that isn't available can never be granted;
- high-risk access is asked for every time, in a dialog whose default focus is
  the safe choice;
- grants are per session, listed in Settings → Permissions, revocable — and
  revoking screen access stops the capture;
- screen access can't be made invisible: hiding the island while sharing only
  collapses it to the compact island, which then says SCREEN ACCESS ACTIVE;
  Pause stops sharing.

## Not done on purpose

- No hidden or background capture, no recording.
- No remote control of any kind.
- No telemetry.
