# Changelog

## Unreleased — Windows and Linux

- **No more auto-close.** The island never closes, collapses or hides on a timer — not after Claude finishes, not after a permission, not when idle, not after the launch greeting. Only Esc, the new collapse / hide buttons, Done, the tray (new "Hide island") or Pause make it smaller. The Auto-close setting is gone. Idle costs nothing: no animation runs, and the cursor is reported to the island 10 times a second instead of 60 when the pointer is far from it
- First-launch introduction and setup checklist in the island (dark start, energy core, tour, live status of hooks and API key); interrupted setup resumes next launch; replay from Settings → About
- Energy core around Mochi: halo, rings, orbiting particles and a sweep that move differently for thinking, reading, editing, running, searching, browsing, subagents, permissions, questions, finished and errors — all from real hook and chat state; idle is still
- Liquid-glass cards, cursor spotlight under the glass, parallax, a scan sweep on state changes, an aurora rim while a request waits, liquid edge fillets that swell as the island pours out; a shared effects engine (`src/design/effects.css`, `src/fx/pointer.ts`)
- Permissions show only what the backend confirmed: `approval_decision` now reports whether Claude Code was still waiting, so a late click reads "Too late — answer in the terminal" instead of "Allowed"; the countdown matches the relay's 108 s window and the card hands the request back to the terminal when it ends
- Command center tab: live activity timeline (hook events, permissions and decisions, integrations, chat), Claude Code, chat/API, requests, screen access, this computer and devices
- Chat: syntax-highlighted code blocks with copy, inline error with Retry, "Anthropic API · model" badge separating it from Claude Code and claude.ai
- Settings → Claude: connection status with Test connection (the key is tried against the Models API in Rust; no tokens spent, the key never leaves Rust); confirmation dialogs for removing keys
- Settings → Screen: share a screen or window after a consent dialog and the system picker, with a live preview, SCREEN ACCESS ACTIVE + Stop in the island, and "Ask Claude about this" (one still, second consent, attached to the chat). Hiding the island while sharing only collapses it; Pause stops sharing
- Settings → Devices: this computer's identity (WebCrypto P-256, non-extractable key); phone pairing and handoff are architecture-ready and clearly marked as needing Coucou Mobile — nothing is shown as connected. Protocol in `docs/DEVICES.md`
- Settings → Permissions: active grants with Revoke, and the full capability matrix (risk, status, what each waits on) — `docs/CAPABILITIES.md`

- A redesigned island and settings window, built on one design system (`windows/src/design/tokens.css`): type scale, spacing, radii, layered surfaces, elevation, blur, status colours, durations, easings and real spring curves
- The island now flows out of the top edge of the screen, casts a soft shadow, and lights up with what Claude is doing: an underglow and a light running along its bottom edge while it works, a breathing rim when a request waits for you
- Claude's activity in plain words, everywhere: Thinking, Reading files, Editing code, Running a command, Searching, Browsing the web, Needs your permission, Waiting for you, Finished, Stopped on an error — in the overview, in a status capsule in the header, and in the compact island, which widens to spell it out
- Permission card: the exact command or path on two lines with "Show all" for long ones, a ring that counts down until the terminal takes the question back, and the button you click turns into its answer. The Y / N hints are gone: the island never takes the keyboard, and a permission is only ever approved with a click
- Integration events (a Vercel deploy, an n8n failure) slide into the compact island for a few seconds
- Chat: messages animate in, code and bold text are formatted, replies can be copied, and "New" starts a fresh conversation
- Error cards offer a real way forward: Open in VS Code / Open n8n and Dismiss (the old Retry and Open in n8n buttons did nothing); chat errors about a missing key link straight to Settings
- Quick settings in the island show whether an API key is really saved (it used to show red regardless)
- Settings: a sidebar with Claude Code, Claude, Integrations, General, Sound, Display, Startup and About; save buttons show saving, saved and failed states; keys are checked as you type; removing a key asks for a second click; Claude Opus 5.5 and Sonnet 5.5 join the model list
- With reduced motion turned on, the island resizes in one step and interface transitions and loops are cut to a single frame (Mochi still blinks); a hidden island still runs no animation at all
- `npm run dev` serves `dev/island-preview.html`, which replays Claude Code hook events and integration updates through the real handlers to check every state in a browser

## 0.1.4 — October 3, 2026

- See what Claude is editing, live: each file edit shows up in the session ticker with its +N −M lines, and a click opens the diff right in the notch (#177)
- When Claude finishes, the session card shows its final message instead of the last step, without the shimmer (#177, #179)
- GitHub pill: your open pull requests with their CI status, the pull requests waiting for your review, and the CI of the default branch of your recent repos. Click a row for the list, then an item to open it on github.com (#181)
- GitHub alerts: a badge and a sound when the CI of one of your pull requests turns red or green, when a default branch breaks, or when someone requests your review. Fast CI runs are caught too, and the card refreshes when you open it (#181, #185)
- Your GitHub contribution grid: the last 7 days in the GitHub card header, click it for the past 23 weeks, and click a day for its count (#187)
- The GitHub token needs read access to pull requests and CI: a classic token with the repo scope, or a fine-grained token with read access to Pull requests, Commit statuses and Actions (#181)
- The finished view no longer overflows the card (#179)

## 0.1.3 — October 3, 2026

- Answer Claude's questions from the notch: when Claude Code asks a multiple-choice question, pick an option or type your own answer right in the island, and Reply in terminal hands it back. Update your hooks in Settings to turn it on (#165) — thanks @Vega8991 for the idea (#94)
- Claude plan usage (GitHub build): turn on Settings → Agents → Plan usage to see your 5-hour and weekly limits in a small pill in the notch header, and click it for the details and reset times. Pro and Max plans; your current status line keeps working (#159)
- Chat with local models through Ollama or LM Studio, no API key needed: connect them in Settings → Chat → Local models. Answers stream in, and thinking blocks stay hidden (#156)
- Markdown in chat answers: bold, lists, headings, quotes, and code blocks with a copy button. Links open only when they are web links (#156)
- Apple Music (GitHub build): see what is playing in the notch, play, pause and skip on hover, and Mochi dances along (#144, #153)
- Settings are now organized in a sidebar (#153)
- The chat greets you by your own first name (#154)

## 0.1.2 — October 2, 2026

- Codex support (GitHub build): sessions show up live on the Codex pill, and permission requests get Allow and Deny in the notch. Install from Settings → Codex Hooks, then trust the hooks once with /hooks in Codex (#130) — thanks @lacatu5
- Cursor: Claude Code started in Cursor's terminal shows up on the Cursor pill, and you can answer its permission requests from the notch (#120).
- Pick your main coding tool in Settings → Active pills: VS Code, Cursor, Codex or Antigravity (Codex and Antigravity: GitHub build). It stays on and no longer takes one of the 4 slots (#120).
- The permission card stays in the notch until you answer it: the mouse no longer folds it, and reopening the island shows the request again (#117).
- The permission card also shows when the island is already open, and the pill you were on comes back once you answer (#120).

## 0.1.1 — October 2, 2026

- Declare the tools you use in Settings: Gemini CLI, Antigravity, Anthropic, Google AI and OpenAI pills join the existing ones (Cursor and Codex pills are coming soon), and you pick the main pill.
- Chat now supports Google AI (Gemini) and OpenAI in addition to Anthropic; switch provider and model by clicking the model name in the chat view, on macOS.
- Linux version: the Tauri app now builds for Linux too (AppImage, .deb, .rpm), with the island as a layer-shell overlay on Wayland and Claude Code hooks over a private Unix socket (#21) — thanks @Davy133
- Compact island on screens without a notch (#22) — thanks @Kamasoutra
- Only web links (http/https) open from the notch; other kinds of links from Claude or integrations are ignored (#16) — thanks @Cris1670
- Hook socket limited to your own user account, with size and time limits; logs no longer keep commands, n8n data or full URLs, and stay under 1 MB (#16) — thanks @Cris1670 and @Vignesh-Thangamariappan
- The island always reopens after folding, and Settings opens below it, resizable — thanks @rouderz
- Choose the Claude model for the chat in Settings; the list comes from your Anthropic account, and Claude Sonnet 4.6 stays the default — thanks @rouderz
- Windows build artifacts are now downloadable from a manual CI run — thanks @MysJofR
- Any agent can talk to Mochi: tag a hook payload with `coucou_agent` (e.g. `nb-hook --agent my-agent`) and it gets its own pill in the island (#7, #9) — thanks @lacatu5
- Gemini CLI and Antigravity (agy) hook support on macOS: install from Settings and their sessions show up in the island — thanks @corefusiion
