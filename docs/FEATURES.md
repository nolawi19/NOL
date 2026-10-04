# Coucou for Windows and Linux — feature inventory

Everything Coucou does, could do, or deliberately won't do, and what each item
depends on. This is the honest map behind the app: a feature listed as shipped
works in this build; anything else says exactly what it is waiting for. Nothing
in the app claims more than this file. The security-relevant subset, with its
consent rules, is in [`CAPABILITIES.md`](CAPABILITIES.md); the phone protocol is
in [`DEVICES.md`](DEVICES.md).

## The ten categories

| | Category | Meaning |
|---|---|---|
| ✅ | **Shipped** | Works in this build, no setup beyond installing hooks. |
| 🔐 | **Shipped, asks every time** | Works, behind an explicit per-use permission. |
| 🔑 | **Shipped, needs your setup** | Works once you add a key, a webhook or an integration. |
| 🧩 | **Architecture ready** | Types, policy and UI slots exist; no executor yet. |
| 📱 | **Needs Coucou Mobile** | Waits on a phone app that doesn't exist yet. |
| 🌐 | **Needs a backend** | Waits on a relay or service Coucou doesn't run. |
| 🔌 | **Needs an API not integrated** | A third-party API exists; Coucou doesn't talk to it yet. |
| 🖥 | **Platform-limited** | The OS or the webview doesn't expose it (or only on some systems). |
| 🧪 | **Possible, not built** | Nothing blocks it; it simply isn't in this build. |
| ⛔ | **Declined** | Not done on purpose — security, privacy or the user's control. |

## Dependency gates

Each feature lists the gates it passes through. A feature is only shown as
working when every gate is satisfied at runtime.

| Gate | Checked how |
|---|---|
| **C** Capability | `core/capabilities.ts` — availability per platform/webview. |
| **A** API | A key in the OS vault and a reachable API (`claude_check_key`, integration pollers). |
| **P** Permission | An explicit click or a `Consent` grant; high risk asks every time. |
| **S** Security | Secrets stay in Rust/the vault; risk reading; no auto-approval. |
| **B** Backend | A service Coucou would have to run (none today). |
| **M** Mobile | Coucou Mobile installed and paired. |
| **N** Network | Online, and only to services the user configured. |
| **H** Hardware | A battery, a camera, a microphone… present and exposed. |
| **F** Performance | 0 % CPU while hidden; polling only while a view is on screen. |
| **U** UX | Never steals focus or closes on its own; reduced motion respected. |

---

## 1. Claude Code awareness

| Feature | | Gates | Where / notes |
|---|---|---|---|
| Live session in the island (prompt, tool, step) | ✅ | F U | `island/hooks.ts`, hook relay over the named pipe / Unix socket |
| Ticker of tool calls with verbs (Run, Edit, Read…) | ✅ | U | `core/activity.ts` |
| Session clock and per-turn tool count | ✅ | F | overview stats |
| Pairing PreToolUse with PostToolUse / Failure | ✅ | — | `core/session.ts` (by `tool_use_id`, else oldest running call) |
| Command duration and outcome | ✅ | — | timeline "Done · … · 12s", terminal tile |
| Command classification (test, build, install, git, deploy, lint, run) | ✅ | — | `core/risk.ts` `classifyCommand` |
| Currently running command with live elapsed time | ✅ | F | command center → Now, Terminal tile |
| Work-mode inference (coding, debugging, testing, building, deploying, exploring, planning) | ✅ | — | `Session.workMode`, from the last 12 tool calls |
| Files changed this turn | ✅ | — | finished card, local summary |
| Local session summary (no network) | ✅ | — | `localSummary`; palette → "Copy a session summary" |
| Claude-written session summary | 🔑 | A N P | finished card → Summary, palette; uses `claude_insight`, scrubbed of secrets |
| Failure detail from PostToolUseFailure | ✅ | — | first line of `error` when Claude Code sends it |
| Multiple agents (`coucou_agent` tag) as pills | ✅ | — | unchanged |
| Question detection | ✅ | — | Notification ending in "?" |
| Rate-limit state | ✅ | — | Notification text |
| Project name and git branch | ✅ | S | `project_probe` reads only `.git/HEAD`; marker files checked for existence only |
| Project type markers (package.json, Cargo.toml…) | ✅ | S | existence only, contents never opened |
| Git status (dirty files, ahead/behind) | 🧪 | S F | would need running `git`; deliberately not done from the UI process yet |
| Reading Claude Code's transcript | ⛔ | S | the relay drops `transcript_path` on purpose |
| Reading tool output | ⛔ | S | the relay drops `tool_response` on purpose |
| Sessions from Gemini CLI / Codex in this build | 🧪 | — | macOS has them; the Tauri relay is Claude Code–shaped today |

## 2. Permissions

| Feature | | Gates | Where / notes |
|---|---|---|---|
| Allow / Deny from the island | ✅ | P S | click only; `approval_decision` reports delivered / late |
| Countdown to the terminal taking the question back | ✅ | U | 108 s ring |
| One request at a time; extras handed back to the terminal | ✅ | S | `hooks.ts` |
| Risk level (low / medium / high / critical) | ✅ | S | `analyzeRisk`, advisory only |
| Destructive command warning (rm -rf, del /s, DROP TABLE, dd…) | ✅ | S | flag "Deletes or overwrites" |
| Git history warnings (force push, reset --hard, clean -f…) | ✅ | S | |
| Privilege warnings (sudo, runas, chmod 777, Set-ExecutionPolicy…) | ✅ | S | |
| Network warnings (curl, ssh, git push, URLs…) | ✅ | S | |
| Pipe-to-shell detection (curl … \| sh, iex(iwr …)) | ✅ | S | highest weight |
| Deploy / publish detection | ✅ | S | |
| Secret exposure (.env, id_rsa, printenv, credentials.json…) | ✅ | S | |
| System locations (/etc, C:\Windows, HKLM…) | ✅ | S | |
| Paths outside the project | ✅ | S | compared with the session's `cwd` |
| Environment changes (setx, registry, shell profiles, cron) | ✅ | S | |
| Affected paths list | ✅ | — | up to 6, from the request text |
| Reversibility (can be undone / partly / can't) | ✅ | — | heuristic, shown as such |
| "Explain" with Claude | 🔑 | A N P | sends only the request text, scrubbed; never answers the request |
| Permission history | ✅ | — | timeline (Permissions filter), Settings → Security center |
| Auto-approve by rule or mode | ⛔ | S | never: every approval is a click |
| Approve from a phone | 📱 | M P S | protocol in DEVICES.md; explicit tap only |

## 3. The island

| Feature | | Gates | Where / notes |
|---|---|---|---|
| Hidden / compact / expanded, no timers | ✅ | U | `island/fsm.ts` — auto-close removed |
| Explicit close: Esc, ⌃, ⤒, tray | ✅ | U | |
| Compact status line ("Running · npm test") | ✅ | U | |
| Energy core reacting to activity | ✅ | F U | `island/core.ts` |
| Named core states: dormant, awakening, thinking, analyzing, executing, communicating, warning, permission, success, failure, cooling | ✅ | F | `Island.syncCoreState`, single-shot timers |
| Core reacts to CPU load | ✅ | F | `--energy`, only while the command center is open |
| Command palette (Ctrl+K, tray, header) | ✅ | U | `views/expansion.ts`; fuzzy search, keyboard |
| Timeline with filters, search, grouping by project | ✅ | — | 200 entries, in memory |
| Insight view (copy, save to memory) | 🔑 | A | |
| Startup check (relay, hooks, display, key, network) | ✅ | U | skippable; off with reduced motion |
| Mode chip in the header | ✅ | U | |
| Liquid glass, aurora rim, spotlight, scan lines | ✅ | F | `design/effects.css` |
| Radial / holographic desktop menu | 🧪 | U F | would need a second full-screen transparent window; the palette covers the need |
| Floating multi-panel desktop overlay | 🧪 | U F | same |
| Global hotkey while another app has focus | 🧪 | P | needs the global-shortcut plugin; the tray item works today |
| Voice "close" command | 🖥 | H P | no speech recognition in WebView2/WebKitGTK without a cloud service |

## 4. Command center

| Feature | | Gates | Where / notes |
|---|---|---|---|
| Now panel: core state, work mode, running command, project + branch | ✅ | F | `views/center.ts` |
| Live activity (12 latest) and link to the full timeline | ✅ | — | |
| Claude Code / Requests / Terminal / Chat / Screen tiles | ✅ | — | |
| System tile: CPU, RAM, battery, uptime, display | ✅ | F H | `system_stats`, polled every 2 s only while visible |
| Rules tile (automations, last run) | ✅ | — | |
| Devices tile (honest: no phone) | 📱 | M | |
| GPU usage, temperatures, fans | 🖥 | H | not exposed without vendor tools or admin drivers |
| Network throughput per app | 🖥 | P | needs ETW / root |
| Disk space | 🧪 | — | available via OS APIs; not shown yet |

## 5. Computer awareness

| Feature | | Gates | Where / notes |
|---|---|---|---|
| CPU usage (two-sample) | ✅ | F | `/proc/stat`, `GetSystemTimes` |
| Memory used / total | ✅ | F | `/proc/meminfo`, `GlobalMemoryStatusEx` |
| Battery level and charging | ✅ | H | `/sys/class/power_supply`, `GetSystemPowerStatus` |
| Uptime | ✅ | — | `/proc/uptime`, `GetTickCount64` |
| Display size and scale | ✅ | — | from Tauri at boot |
| Online / offline | ✅ | N | `navigator.onLine` |
| Focused application name | 🧩 | C P | Windows: `GetForegroundWindow` (not built); Wayland: impossible by design |
| Open windows list | 🖥 | P | Wayland forbids; Windows possible, not built |
| Idle time of the user | 🧪 | P | `GetLastInputInfo` / X11; not built |
| Clipboard reading | ⛔ | S P | not without an explicit per-use action |
| Keystroke monitoring | ⛔ | S | never |

## 6. Screen

| Feature | | Gates | Where / notes |
|---|---|---|---|
| Share a screen or window with consent | 🔐 | P C | `core/screen.ts`, system picker |
| SCREEN ACCESS ACTIVE indicator and Stop in the island | ✅ | S U | can't be hidden while active |
| One screenshot to ask Claude about | 🔐 | P A | second consent, JPEG ≤ 1568 px |
| Continuous screen understanding | ⛔ | S | no background analysis |
| Recording | ⛔ | S | never |
| OCR on device | 🧪 | F | would need a bundled model |
| Screen capture on WebKitGTK | 🖥 | C | varies by distribution; the page says when missing |

## 7. Devices and phone

| Feature | | Gates | Where / notes |
|---|---|---|---|
| Device identity (ECDSA P-256, non-extractable) | ✅ | S | `core/devices.ts` |
| Pairing offers, revoke list | 🧩 | M | |
| QR pairing, 6-digit confirmation | 📱 | M B | DEVICES.md |
| Activity on the phone | 📱 | M B N | |
| Approve from the phone | 📱 | M B P | |
| Chat handoff | 📱 | M B | signed envelope ready |
| Off-LAN relay | 🌐 | B | no server exists |
| Push notifications to a phone today | 🔑 | N | via an ntfy webhook automation (ntfy app on the phone) |

## 8. Automations

| Feature | | Gates | Where / notes |
|---|---|---|---|
| Rule builder (when / only if / then) | ✅ | U | Settings → Automations |
| Triggers: finished, failed, permission requested, question, tool failed, command failed, tests failed, build failed, deploy command succeeded, integration success / failure, chat replied | ✅ | — | all from real events |
| Condition: project contains | ✅ | — | |
| Action: flash the compact island | ✅ | U | |
| Action: open the island | ✅ | U | |
| Action: play a sound | ✅ | — | |
| Action: webhook (ntfy, Discord, Slack, JSON) | 🔑 | N S | addresses in the vault; https only; details only if the rule says so |
| Action: Claude summary | 🔑 | A N | |
| Rate limiting (10 s gap, 30/hour per rule) | ✅ | S F | |
| Every run on the timeline | ✅ | S | |
| Action: approve a permission | ⛔ | S | never |
| Action: run a command / script | ⛔ | S | Coucou runs none of its own commands |
| Action: send an email | 🔌 | A P | Resend key exists for reading; sending needs an explicit click (repo rule) |
| Time-based triggers (every morning…) | 🧪 | F | |
| Conditions on time of day, mode | 🧪 | — | |

## 9. AI companion

| Feature | | Gates | Where / notes |
|---|---|---|---|
| Chat with Claude (key in the vault) | 🔑 | A N | unchanged |
| Session summaries | 🔑 | A N | |
| Command / permission explanations | 🔑 | A N | |
| Error explanations | 🔑 | A N | via Explain on the request, or the chat |
| Secret scrubbing before anything is sent | ✅ | S | `memory.ts` `scrub` |
| Local (offline) summary | ✅ | — | |
| On-device model | 🧪 | F H | would need bundling a model |
| Proactive suggestions without a click | ⛔ | S N | nothing is sent to Claude unless you click or wrote a rule |

## 10. Memory

| Feature | | Gates | Where / notes |
|---|---|---|---|
| Off by default; on with an explicit switch | ✅ | P S | Settings → Memory |
| Save a summary / explanation | ✅ | P | "Save to memory" in the insight view |
| List, delete, delete everything, export JSON | ✅ | — | |
| Use in chat (first message, with a visible chip) | ✅ | P | |
| Secret scrubbing on save | ✅ | S | |
| Storage: this machine's webview IndexedDB | ✅ | S | never settings.json, never synced |
| Encrypted at rest with a vault key | 🧪 | S | possible with a vault-held key; today it relies on the user profile's protection |
| Sync between devices | 📱 | M B | |
| Automatic memory of everything | ⛔ | S | never silent collection |

## 11. Modes and personalisation

| Feature | | Gates | Where / notes |
|---|---|---|---|
| Normal, Focus, Silent, Presentation, Night | ✅ | U | `core/prefs.ts` `MODES` with real effects |
| Permission requests always shown in every mode | ✅ | S | |
| Glass, glow, particles | ✅ | F | CSS variables, no per-frame cost |
| Motion: follow system / reduced | ✅ | U | `.reduce-motion` mirrors the media query |
| Core style: orbit, pulse, minimal | ✅ | F | |
| Dormancy delay | ✅ | — | |
| Startup check on/off | ✅ | U | |
| Themes beyond dark | 🧪 | U | the island is designed for the dark top edge |
| Automatic mode by schedule / full-screen app | 🖥 🧪 | C | full-screen detection is OS-specific |

## 12. Sound

| Feature | | Gates | Where / notes |
|---|---|---|---|
| 28 sounds, volume | ✅ | — | unchanged |
| Per-event switches (7 categories) | ✅ | — | enforced in `Sound.play` |
| Previews per category | ✅ | — | play even when the category is off |
| Mode-aware (focus / silent / presentation / night) | ✅ | — | night = half volume |
| Sound packs | 🧪 | — | the engine loads by name; no second pack exists |
| Spatial / per-monitor audio | 🖥 | — | |

## 13. Notifications

| Feature | | Gates | Where / notes |
|---|---|---|---|
| Compact flash lines | ✅ | U | dropped in focus / presentation unless important |
| Pill badges (approval, finished, error) | ✅ | — | |
| Island opens for requests and (in normal mode) finishes | ✅ | U | |
| OS toast notifications | 🧪 | P | Tauri notification plugin; not added |
| Phone push | 🔑 | N | via an ntfy webhook today |

## 14. Integrations

| Feature | | Gates | Where / notes |
|---|---|---|---|
| Vercel, GitHub, Stripe, Resend, n8n, Notion, Cal.com pills | 🔑 | A N | unchanged pollers |
| Integration success / failure as automation triggers | ✅ | — | |
| Refresh from the palette | ✅ | N | |
| Linear, Jira, Sentry, Slack reading | 🔌 | A N | not integrated |
| GitHub Actions run status | 🔌 | A N | the GitHub token exists; this endpoint isn't polled |

## 15. Security center

| Feature | | Gates | Where / notes |
|---|---|---|---|
| Promises, permission history, saved-secret names | ✅ | S | Settings → Security center |
| Capability matrix with grants and revoke | ✅ | P S | unchanged |
| Secrets never in UI, logs or errors | ✅ | S | webhook errors never contain the URL |
| Audit log on disk | 🧪 | S | the Rust log has decisions; a dedicated audit file isn't written |

## 16. Discoverability and micro-interactions

| Feature | | Gates | Where / notes |
|---|---|---|---|
| Command palette with every action | ✅ | U | |
| Settings search (titles, descriptions, keywords) | ✅ | U | |
| Grouped, scrollable settings sidebar | ✅ | U | |
| Spring motion, staggered entrances, ripples | ✅ | F U | design tokens |
| Keyboard navigation (palette arrows, settings arrows, Esc) | ✅ | U | |
| Contextual tooltips on risk flags | ✅ | U | |

## 17. Performance

| Feature | | Gates | Where / notes |
|---|---|---|---|
| 0 running animations while hidden | ✅ | F | checked with Playwright |
| No polling while hidden or off-view | ✅ | F | system stats only while the center is open |
| Reduced motion: 0 running animations | ✅ | F U | |
| Cursor events throttled when far from the island | ✅ | F | `island.rs` |

---

## Never

Coucou will not, in any build: approve a permission without a click, run its own
commands, monitor keystrokes, record the screen, capture in the background, use
the microphone or camera silently, send private data anywhere you didn't
configure, collect memory silently, or show a feature as working when its
dependency is missing.
