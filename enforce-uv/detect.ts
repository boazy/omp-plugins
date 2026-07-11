// Pure detection logic for the enforce-uv plugin.
//
// Scans a bash command string for pip / pipx misuse and classifies it.
// No I/O, no side effects — trivially unit-testable.

export type ViolationKind =
  | "pip-install" // plain `pip install` while uv is available (rule 1)
  | "pip-global" // pip install into the global/system env (rule 3)
  | "pip-other" // other pip subcommand with a `uv pip` equivalent (rule 1)
  | "pipx" // pipx used where uvx / `uv tool` fits (rule 2)
  | "uv-global" // `uv pip install --system/--break-system-packages` or under sudo (rule 3)
  | "uv-pip"; // plain `uv pip install` — soft-blocked, overridable (rule 1)

export interface Violation {
  kind: ViolationKind;
  /** The offending simple-command segment, verbatim. */
  segment: string;
  /** Human label for the invoked tool, e.g. `pip`, `python3 -m pip`, `uv pip`. */
  tool: string;
  /** Detected subcommand (install / uninstall / run / …), if any. */
  sub?: string;
  /** Whether the segment ran through sudo/doas. */
  sudo: boolean;
  /** Global-install flags that were present (`--user`, `--break-system-packages`, …). */
  globalFlags: string[];
}

export interface DetectOptions {
  /** Whether `uv` is on PATH. When false, rule 1/2 (pip→uv, pipx→uvx) are skipped. */
  uvAvailable: boolean;
  /** Set when the override env var is present in the process environment. */
  envOverride?: boolean;
}

/** Env var that opts into `uv pip install` after the first block. */
export const OVERRIDE_ENV = "OMP_ALLOW_UV_PIP_INSTALL";

/** Env values that count as "on" (`1` / `true` / `yes`, case-insensitive). */
export const OVERRIDE_TRUTHY = /^(1|true|yes)$/i;

// Command wrappers that precede the real command word.
const WRAPPERS: Record<string, true> = {
  sudo: true,
  doas: true,
  command: true,
  exec: true,
  time: true,
  nice: true,
  nohup: true,
  stdbuf: true,
  setsid: true,
  env: true,
};

// sudo/doas options that consume a following argument (`sudo -u root cmd`), so
// the argument isn't mistaken for the command word.
const SUDO_VALUE_OPTS: Record<string, true> = {
  "-u": true,
  "--user": true,
  "-g": true,
  "--group": true,
  "-h": true,
  "--host": true,
  "-p": true,
  "--prompt": true,
  "-C": true,
  "--close-from": true,
  "-r": true,
  "--role": true,
  "-t": true,
  "--type": true,
  "-U": true,
  "--other-user": true,
  "-R": true,
  "--chroot": true,
  "-D": true,
  "--chdir": true,
  "-a": true,
};

// Shells that take a `-c <script>` argument we must recurse into.
const SHELLS: Record<string, true> = {
  sh: true,
  bash: true,
  zsh: true,
  dash: true,
  ash: true,
  ksh: true,
  mksh: true,
};

const PIP_GLOBAL_FLAGS: Record<string, true> = {
  "--user": true,
  "--break-system-packages": true,
};

// pip subcommands uv reimplements as `uv pip <sub>`. install/uninstall are
// handled separately (they carry the global-install nuance); the rest map 1:1.
const UV_PIP_PARITY: Record<string, true> = {
  list: true,
  freeze: true,
  show: true,
  tree: true,
  check: true,
  sync: true,
  compile: true,
};

// pipx subcommands with a concrete uv equivalent. Only these are blocked (rule 2
// is conditional); pipx-only operations (runpip, environment, interpreter, …)
// have no uv counterpart and are left alone. Verified against uv 0.11.
export const PIPX_TO_UV: Record<string, string> = {
  install: "uv tool install <pkg>",
  uninstall: "uv tool uninstall <pkg>",
  "uninstall-all": "uv tool uninstall --all",
  reinstall: "uv tool upgrade --reinstall <pkg>",
  "reinstall-all": "uv tool upgrade --reinstall --all",
  upgrade: "uv tool upgrade <pkg>",
  "upgrade-all": "uv tool upgrade --all",
  inject:
    "uv tool install <tool-pkg> --with <extra-pkg>  (persistent; uvx --with <extra-pkg> <tool-pkg> for a one-off)",
  run: "uvx <pkg>",
  list: "uv tool list",
  ensurepath: "uv tool update-shell",
};

/**
 * Split a compound command into simple-command segments on `&&`, `||`, `;`, `|`,
 * `&`, and newlines — but never inside single/double quotes (so a grep/regex
 * argument like `"pip install|foo"` stays one segment), and never on the `&` of a
 * redirection (`2>&1`, `&>`, `>&`).
 */
export function splitSegments(cmd: string): string[] {
  const segments: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    // Backslash escapes the next char, except inside single quotes (bash keeps it
    // literal there). Copy both so an escaped quote/separator can't mis-split.
    if (c === "\\" && quote !== "'") {
      cur += c;
      if (i + 1 < cmd.length) {
        cur += cmd[i + 1];
        i++;
      }
      continue;
    }
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === ";" || c === "\n") {
      segments.push(cur);
      cur = "";
      continue;
    }
    if (c === "|") {
      if (cmd[i + 1] === "|") i++; // ||
      segments.push(cur);
      cur = "";
      continue;
    }
    if (c === "&") {
      if (cmd[i + 1] === "&") {
        i++; // &&
      } else if (cmd[i - 1] === ">" || cmd[i + 1] === ">") {
        cur += c; // redirection (2>&1, &>, >&) — not a separator
        continue;
      }
      segments.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  segments.push(cur);
  return segments.map((s) => s.trim()).filter(Boolean);
}

/** Tokenize a segment, honoring simple single/double quotes. */
export function tokenize(segment: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(segment)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3] ?? "");
  }
  return out;
}

interface Head {
  sudo: boolean;
  override: boolean;
  rest: string[];
}

/** Strip leading env assignments and command wrappers; detect sudo and the override. */
function stripHead(tokens: string[]): Head {
  let sudo = false;
  let override = false;
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    const assign = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(t);
    if (assign) {
      if (assign[1] === OVERRIDE_ENV && OVERRIDE_TRUTHY.test(assign[2])) override = true;
      i++;
      continue;
    }
    if (WRAPPERS[t]) {
      const isSudo = t === "sudo" || t === "doas";
      if (isSudo) sudo = true;
      i++;
      while (i < tokens.length && tokens[i].startsWith("-")) {
        const opt = tokens[i];
        i++;
        if (isSudo && SUDO_VALUE_OPTS[opt] && i < tokens.length && !tokens[i].startsWith("-"))
          i++; // consume the option's argument (e.g. `-u root`)
      }
      continue;
    }
    break;
  }
  return { sudo, override, rest: tokens.slice(i) };
}

type Tool = { kind: "pip" | "pipx" | "uv"; label: string; args: string[] } | null;

/** Identify the invoked tool from the command word (handles `python -m pip`). */
function identifyTool(rest: string[]): Tool {
  const word = rest[0];
  const args = rest.slice(1);
  if (/^pip[0-9.]*$/.test(word)) return { kind: "pip", label: word, args };
  if (word === "pipx") return { kind: "pipx", label: "pipx", args };
  if (word === "uv" || word === "uvx") return { kind: "uv", label: word, args };
  if (/^python[0-9.]*$/.test(word) || word === "py") {
    const mi = args.indexOf("-m");
    const mod = mi >= 0 ? args[mi + 1] : undefined;
    if (mod === "pip")
      return { kind: "pip", label: `${word} -m pip`, args: args.slice(mi + 2) };
    if (mod === "pipx")
      return { kind: "pipx", label: `${word} -m pipx`, args: args.slice(mi + 2) };
  }
  return null;
}

function analyzeSegment(segment: string, opts: DetectOptions): Violation | null {
  const { sudo, override, rest } = stripHead(tokenize(segment));
  if (rest.length === 0) return null;

  // A command-scoped override (`OMP_ALLOW_UV_PIP_INSTALL=1 …`) opts the whole
  // segment in, including anything reached through a shell wrapper.
  const effectiveOpts = override ? { ...opts, envOverride: true } : opts;

  // Shell wrappers (`bash -c '<script>'`) hide the real command word inside a
  // quoted argument. Recurse into that script so the wrap doesn't dodge the guard.
  if (SHELLS[rest[0]]) {
    const ci = rest.findIndex((t, i) => i > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(t));
    return ci >= 0 && rest[ci + 1] ? analyzeCommand(rest[ci + 1], effectiveOpts) : null;
  }

  const tool = identifyTool(rest);
  if (!tool) return null;

  const flags = tool.args.filter((a) => a.startsWith("-"));
  const positionals = tool.args.filter((a) => !a.startsWith("-"));

  if (tool.kind === "uv") {
    // uvx / uv add / uv run are always fine. `uv pip install` is the pip-compat
    // escape hatch: soft-blocked so the model considers a script/project first;
    // a privileged/system variant is a hard rule-3 block the override can't bypass.
    if (tool.label === "uv" && positionals[0] === "pip" && positionals[1] === "install") {
      const bad = flags.filter(
        (f) => f === "--system" || f === "--break-system-packages",
      );
      if (sudo || bad.length > 0)
        return { kind: "uv-global", segment, tool: "uv pip", sub: "install", sudo, globalFlags: bad };
      if (effectiveOpts.envOverride) return null;
      return { kind: "uv-pip", segment, tool: "uv pip", sub: "install", sudo, globalFlags: [] };
    }
    return null;
  }

  const globalFlags = flags.filter((f) => PIP_GLOBAL_FLAGS[f]);
  const isGlobal = sudo || globalFlags.length > 0;
  const sub = positionals[0];

  if (tool.kind === "pip") {
    if (sub === "install" || sub === "uninstall") {
      if (isGlobal)
        return { kind: "pip-global", segment, tool: tool.label, sub, sudo, globalFlags };
      if (effectiveOpts.uvAvailable)
        return { kind: "pip-install", segment, tool: tool.label, sub, sudo, globalFlags };
      return null;
    }
    if (sub && UV_PIP_PARITY[sub] && effectiveOpts.uvAvailable)
      return { kind: "pip-other", segment, tool: tool.label, sub, sudo, globalFlags };
    return null; // download/wheel/config/cache/hash/index — no clean uv parity
  }

  // pipx: only subcommands with a real uv equivalent (see PIPX_TO_UV).
  if (tool.kind === "pipx" && effectiveOpts.uvAvailable && sub && PIPX_TO_UV[sub])
    return { kind: "pipx", segment, tool: tool.label, sub, sudo, globalFlags };

  return null;
}

/** Analyze a full bash command; returns the first violation found, or null. */
export function analyzeCommand(cmd: string, opts: DetectOptions): Violation | null {
  for (const segment of splitSegments(cmd)) {
    const v = analyzeSegment(segment, opts);
    if (v) return v;
  }
  return null;
}
