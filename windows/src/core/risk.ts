// What a permission request would actually do, read from the request itself.
//
// Pattern matching on the command or path Claude Code sent — nothing is run,
// opened or looked up. It is a reading aid for the person about to click, not
// a security boundary: it can miss things, so the card never turns a request
// into "safe", and nothing here ever answers a request on its own.

export type RiskLevel = "low" | "medium" | "high" | "critical";

export type RiskFlagId =
  | "destructive"
  | "history"
  | "privileged"
  | "network"
  | "pipe-shell"
  | "deploy"
  | "publish"
  | "install"
  | "secrets"
  | "system-path"
  | "outside-project"
  | "env-change"
  | "process";

export interface RiskFlag {
  id: RiskFlagId;
  label: string;
  /** One sentence: why this matters. */
  why: string;
  weight: number;
}

export type Reversibility = "reversible" | "partly" | "irreversible" | "unknown";

export interface RiskReport {
  level: RiskLevel;
  flags: RiskFlag[];
  /** Paths the request names (files, folders), at most 6. */
  paths: string[];
  reversibility: Reversibility;
  /** Plain-language reading of the request. */
  summary: string;
  /** Command class, for shell requests. */
  commandClass: CommandClass | null;
}

const FLAG: Record<RiskFlagId, Omit<RiskFlag, "id">> = {
  destructive: { label: "Deletes or overwrites", why: "Removes files or data; there may be no undo.", weight: 3 },
  history: { label: "Rewrites git history", why: "Force pushes, hard resets and cleans can lose commits or uncommitted work.", weight: 3 },
  privileged: { label: "Elevated privileges", why: "Runs as administrator / root, or changes permissions.", weight: 3 },
  network: { label: "Network access", why: "Talks to another machine on the internet or the network.", weight: 1 },
  "pipe-shell": { label: "Runs downloaded code", why: "Pipes something from the network straight into a shell.", weight: 4 },
  deploy: { label: "Deploys", why: "Changes something running for other people.", weight: 2 },
  publish: { label: "Publishes", why: "Publishes a package or release; usually can't be taken back.", weight: 3 },
  install: { label: "Installs software", why: "Downloads and runs install scripts from a package registry.", weight: 1 },
  secrets: { label: "Touches secrets", why: "Reads or prints credentials, keys or environment files.", weight: 2 },
  "system-path": { label: "System location", why: "Targets operating-system folders or settings.", weight: 3 },
  "outside-project": { label: "Outside the project", why: "Targets a path outside the folder Claude Code is working in.", weight: 1 },
  "env-change": { label: "Changes the environment", why: "Edits PATH, the registry, shell profiles or scheduled tasks.", weight: 2 },
  process: { label: "Stops processes", why: "Kills running programs.", weight: 1 },
};

export type CommandClass = "test" | "build" | "install" | "git" | "deploy" | "lint" | "run" | "other";

export const COMMAND_CLASS_LABEL: Record<CommandClass, string> = {
  test: "Tests",
  build: "Build",
  install: "Install",
  git: "Git",
  deploy: "Deploy",
  lint: "Lint / format",
  run: "Run",
  other: "Command",
};

const CLASS_RULES: [CommandClass, RegExp][] = [
  ["deploy", /\b(vercel(\s+deploy)?\s+--prod|netlify\s+deploy|fly\s+deploy|flyctl\s+deploy|firebase\s+deploy|wrangler\s+(deploy|publish)|kubectl\s+(apply|rollout)|terraform\s+apply|pulumi\s+up|helm\s+(install|upgrade)|npm\s+publish|cargo\s+publish|gh\s+release\s+create|serverless\s+deploy|sls\s+deploy|heroku\s+.*deploy|railway\s+up)\b/i],
  ["install", /\b(npm|pnpm|yarn|bun)\s+(install|i|add|ci)\b|\bpip3?\s+install\b|\b(cargo\s+(install|add)|go\s+get|gem\s+install|composer\s+(install|require)|apt(-get)?\s+install|brew\s+install|winget\s+install|choco\s+install|scoop\s+install|uv\s+(add|pip\s+install)|poetry\s+add)\b/i],
  ["test", /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\b(vitest|jest|mocha|ava|pytest|playwright\s+test|cypress\s+run|phpunit|rspec)\b|\b(cargo|go|dotnet|mvn|gradle|deno)\s+test\b|\bpython\s+-m\s+(pytest|unittest)\b/i],
  ["lint", /\b(eslint|prettier|biome|ruff|black|flake8|pylint|rustfmt|clippy|stylelint|tsc\s+--noEmit)\b|\b(cargo\s+(fmt|clippy))\b|\b(npm|pnpm|yarn|bun)\s+(run\s+)?(lint|format|fmt)\b/i],
  ["build", /\b(npm|pnpm|yarn|bun)\s+(run\s+)?build\b|\b(cargo|go|dotnet|swift)\s+build\b|\b(tsc|vite\s+build|webpack|esbuild|rollup|make|cmake|gradle\s+build|mvn\s+(package|compile)|xcodebuild|tauri\s+build)\b/i],
  ["git", /^\s*git\s/i],
  ["run", /\b(npm|pnpm|yarn|bun)\s+(run|start|dev|exec)\b|\b(node|python3?|deno|ruby|cargo\s+run|go\s+run|dotnet\s+run|npx|bunx)\b/i],
];

export function classifyCommand(command: string): CommandClass {
  for (const [cls, re] of CLASS_RULES) if (re.test(command)) return cls;
  return "other";
}

const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const READ_TOOLS = new Set(["Read", "LS", "Glob", "Grep", "NotebookRead"]);

const RULES: [RiskFlagId, RegExp][] = [
  ["destructive", /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+|\brm\s+--(recursive|force)\b|\brmdir\s+\/s\b|\bdel\s+(\/[sqf]\s*)+|\bRemove-Item\b[^|;]*-(Recurse|Force)\b|\brd\s+\/s\b|\bshred\b|\bmkfs(\.\w+)?\b|\bformat\s+[a-z]:|\bdd\s+[^|;]*\bof=|\btruncate\s+-s\b|\bDROP\s+(TABLE|DATABASE|SCHEMA)\b|\bTRUNCATE\s+TABLE\b|\bDELETE\s+FROM\s+\w+\s*(;|$)|\bfind\b[^|;]*\s-delete\b|>\s*\/dev\/sd[a-z]/i],
  ["history", /\bgit\s+push\b[^|;&]*(\s--force\b|\s-f\b|\s--force-with-lease\b|\s\+\S)|\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+-[a-zA-Z]*f|\bgit\s+checkout\s+--\s|\bgit\s+restore\s+(?!--staged)|\bgit\s+branch\s+-D\b|\bgit\s+filter-(branch|repo)\b|\bgit\s+rebase\b|\bgit\s+stash\s+(drop|clear)\b/i],
  ["privileged", /(^|[;&|]\s*)sudo\b|\bdoas\b|\brunas\b|\bStart-Process\b[^|;]*-Verb\s+RunAs|\bSet-ExecutionPolicy\b|\bchmod\s+(-R\s+)?[0-7]*7[0-7]{2}\b|\bchmod\s+[ugoa]*\+s\b|\bchown\b|\bicacls\b|\btakeown\b/i],
  ["pipe-shell", /\b(curl|wget|iwr|Invoke-WebRequest|Invoke-RestMethod|irm)\b[^;&]*\|\s*(sudo\s+(-\S+\s+)*)?(sh|bash|zsh|python3?|node|iex|Invoke-Expression|pwsh|powershell)\b|\biex\s*\(\s*(New-Object\s+Net\.WebClient|\(?\s*(iwr|irm|Invoke-WebRequest|Invoke-RestMethod))/i],
  ["network", /\b(curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod|ssh|scp|sftp|rsync|ftp|nc|ncat|telnet|git\s+(push|pull|fetch|clone)|npm\s+publish|docker\s+(push|pull)|gh\s+\w+)\b|https?:\/\//i],
  ["deploy", /\b(vercel(\s+deploy)?\s+--prod|netlify\s+deploy\s+--prod|fly\s+deploy|flyctl\s+deploy|firebase\s+deploy|wrangler\s+(deploy|publish)|kubectl\s+(apply|delete|rollout)|terraform\s+(apply|destroy)|pulumi\s+(up|destroy)|helm\s+(install|upgrade|uninstall)|serverless\s+deploy|railway\s+up|heroku\s+\S*deploy)\b/i],
  ["publish", /\b(npm|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b|\bgem\s+push\b|\bgh\s+release\s+create\b|\bdocker\s+push\b/i],
  ["install", /\b(npm|pnpm|yarn|bun)\s+(install|i|add)\s+(-{1,2}[\w-]+\s+)*[@\w]|\bpip3?\s+install\b|\b(cargo\s+install|gem\s+install|apt(-get)?\s+install|brew\s+install|winget\s+install|choco\s+install|scoop\s+install)\b/i],
  ["secrets", /(^|[\s"'\/\\])\.env(\.[\w.-]+)?\b|\bid_(rsa|ed25519|ecdsa)\b|\.ssh[\/\\]|\.aws[\/\\]credentials|\.npmrc\b|\.netrc\b|\.git-credentials\b|\bprintenv\b|^\s*env\s*$|\bGet-ChildItem\s+env:|\bdir\s+env:|\bsecrets?\.(json|ya?ml|toml)\b|credentials\.json\b|\.pem\b|\.p12\b|\.pfx\b|\bkeychain\b|\bcmdkey\b/i],
  ["system-path", /(^|[\s"'=])\/(etc|usr|bin|sbin|boot|lib|var\/lib|System|Library)\b|[a-z]:\\windows\b|\\system32\b|\bHKLM:|\bHKEY_LOCAL_MACHINE\b|\breg\s+(add|delete)\s+HKLM/i],
  ["env-change", /\bsetx\b|\[Environment\]::SetEnvironmentVariable|\breg\s+(add|delete|import)\b|\bSet-ItemProperty\b[^;]*HK(CU|LM):|\bschtasks\s+\/create\b|\bcrontab\s+(-e|-r|\S+)|>>?\s*~?\/?[\w\/.-]*\.(bashrc|zshrc|profile|bash_profile)\b|\$PROFILE\b|\bsystemctl\s+(enable|disable|mask)\b/i],
  ["process", /\b(kill|pkill|killall|taskkill|Stop-Process)\b/i],
];

/** Paths named in a shell command: tokens that look like files or folders. */
function pathsInCommand(command: string): string[] {
  const out: string[] = [];
  const tokens = command.match(/"[^"]+"|'[^']+'|\S+/g) ?? [];
  for (let t of tokens) {
    t = t.replace(/^["']|["']$/g, "").replace(/[;,)]+$/, "");
    if (t.length < 2 || t.length > 260 || t.startsWith("-") || /^https?:/i.test(t)) continue;
    const looksLikePath =
      /^(~|\.{1,2})?[\/\\]/.test(t) || /^[a-z]:[\\\/]/i.test(t) || /^[\w.@-]+[\/\\][\w.@\/\\*-]*$/.test(t) ||
      /^[\w@-][\w.@-]*\.[a-z0-9]{1,8}$/i.test(t) && !/^\d+(\.\d+)+$/.test(t);
    if (looksLikePath && !out.includes(t)) out.push(t);
    if (out.length >= 6) break;
  }
  return out;
}

function norm(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function isOutside(path: string, cwd: string | null): boolean {
  if (!cwd) return false;
  const abs = /^([a-z]:)?[\/\\]/i.test(path) || path.startsWith("~");
  if (!abs) return /(^|[\/\\])\.\.([\/\\]|$)/.test(path);
  return !norm(path).startsWith(norm(cwd));
}

function levelOf(score: number): RiskLevel {
  if (score >= 6) return "critical";
  if (score >= 3) return "high";
  if (score >= 1) return "medium";
  return "low";
}

const str = (input: Record<string, unknown>, k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");

/**
 * Reads a permission request. `input` is the tool_input Claude Code sent;
 * `cwd` the folder the session runs in.
 */
export function analyzeRisk(tool: string, input: Record<string, unknown>, cwd: string | null): RiskReport {
  const found = new Set<RiskFlagId>();
  let paths: string[] = [];
  let summary = "";
  let reversibility: Reversibility = "unknown";
  let commandClass: CommandClass | null = null;

  if (SHELL_TOOLS.has(tool) || str(input, "command")) {
    const command = str(input, "command");
    commandClass = classifyCommand(command);
    for (const [id, re] of RULES) if (re.test(command)) found.add(id);
    // "network" is implied by these; listing it as well adds nothing.
    if (found.has("pipe-shell") || found.has("publish")) found.delete("network");
    if (found.has("publish")) found.delete("deploy");
    paths = pathsInCommand(command);
    if (paths.some((p) => isOutside(p, cwd))) found.add("outside-project");
    const description = str(input, "description");
    summary = description
      ? description
      : `${COMMAND_CLASS_LABEL[commandClass]} command${paths.length ? ` touching ${paths.slice(0, 2).join(", ")}` : ""}.`;
    reversibility =
      found.has("destructive") || found.has("history") || found.has("publish") || found.has("pipe-shell") ? "irreversible"
      : found.has("deploy") || found.has("install") || found.has("env-change") || found.has("privileged") ? "partly"
      : commandClass === "test" || commandClass === "lint" || commandClass === "build" ? "reversible"
      : "unknown";
  } else if (WRITE_TOOLS.has(tool)) {
    const file = str(input, "file_path") || str(input, "notebook_path");
    if (file) paths = [file];
    for (const id of ["secrets", "system-path", "env-change"] as const) {
      const re = RULES.find(([r]) => r === id)![1];
      if (file && re.test(file)) found.add(id);
    }
    if (file && isOutside(file, cwd)) found.add("outside-project");
    summary = tool === "Write" ? `Creates or replaces ${basename(file)}.` : `Edits ${basename(file)}.`;
    // An edit inside a git project can be undone with git; a Write over an
    // existing file without git can't. We don't look at the disk to find out.
    reversibility = found.has("outside-project") || found.has("system-path") ? "unknown" : tool === "Write" ? "partly" : "reversible";
  } else if (READ_TOOLS.has(tool)) {
    const target = str(input, "file_path") || str(input, "path") || str(input, "pattern");
    if (target) paths = [target];
    const re = RULES.find(([r]) => r === "secrets")![1];
    if (target && re.test(target)) found.add("secrets");
    if (target && isOutside(target, cwd)) found.add("outside-project");
    summary = `Reads ${target ? basename(target) : "files"} — nothing is changed.`;
    reversibility = "reversible";
  } else if (tool === "WebFetch" || tool === "WebSearch") {
    found.add("network");
    const url = str(input, "url");
    summary = url ? `Fetches ${url.replace(/^https?:\/\//, "").slice(0, 80)}.` : `Searches the web for “${str(input, "query").slice(0, 60)}”.`;
    reversibility = "reversible";
  } else if (tool.startsWith("mcp__")) {
    summary = `Calls the ${tool.split("__")[1] ?? "MCP"} server's ${tool.split("__").slice(2).join("__") || "tool"}.`;
  } else {
    summary = `${tool} request.`;
  }

  const flags = [...found].map((id) => ({ id, ...FLAG[id] })).sort((a, b) => b.weight - a.weight);
  const score = flags.reduce((n, f) => n + f.weight, 0);
  return { level: levelOf(score), flags, paths, reversibility, summary, commandClass };
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? p;
}

export const RISK_LEVEL_LABEL: Record<RiskLevel, string> = {
  low: "Low risk",
  medium: "Medium risk",
  high: "High risk",
  critical: "Critical",
};

export const REVERSIBILITY_LABEL: Record<Reversibility, string> = {
  reversible: "Can be undone",
  partly: "Partly reversible",
  irreversible: "Can't be undone",
  unknown: "Reversibility unknown",
};

export const RISK_COLOR: Record<RiskLevel, string> = {
  low: "#34D399",
  medium: "#F5A524",
  high: "#FB7185",
  critical: "#F4505E",
};
