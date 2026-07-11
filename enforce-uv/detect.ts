// Pure detection logic for the enforce-uv plugin.
//
// Scans a bash command string for pip / pipx misuse and classifies it.
// No I/O, no side effects — trivially unit-testable.

export type ViolationKind =
  | "pip-install" // plain `pip install` while uv is available (rule 1)
  | "pip-global" // pip install into the global/system env (rule 3)
  | "pip-other" // other pip subcommand with a `uv pip` equivalent (rule 1)
  | "pipx" // pipx used where uvx / `uv tool` fits (rule 2)
  | "uv-global"; // `uv pip install --system/--break-system-packages`

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
}

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

/** Split a compound command into simple-command segments. */
export function splitSegments(cmd: string): string[] {
  return cmd
    .split(/&&|\|\||[;\n|]|&(?!&)/)
    .map((s) => s.trim())
    .filter(Boolean);
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
  rest: string[];
}

/** Strip leading env assignments and command wrappers; detect sudo. */
function stripHead(tokens: string[]): Head {
  let sudo = false;
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
      i++;
      continue;
    }
    if (WRAPPERS[t]) {
      if (t === "sudo" || t === "doas") sudo = true;
      i++;
      while (i < tokens.length && tokens[i].startsWith("-")) i++; // skip wrapper flags
      continue;
    }
    break;
  }
  return { sudo, rest: tokens.slice(i) };
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
  const { sudo, rest } = stripHead(tokenize(segment));
  if (rest.length === 0) return null;

  // Shell wrappers (`bash -c '<script>'`) hide the real command word inside a
  // quoted argument. Recurse into that script so the wrap doesn't dodge the guard.
  if (SHELLS[rest[0]]) {
    const ci = rest.findIndex((t, i) => i > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(t));
    return ci >= 0 && rest[ci + 1] ? analyzeCommand(rest[ci + 1], opts) : null;
  }

  const tool = identifyTool(rest);
  if (!tool) return null;

  const flags = tool.args.filter((a) => a.startsWith("-"));
  const positionals = tool.args.filter((a) => !a.startsWith("-"));

  if (tool.kind === "uv") {
    // uv/uvx are the blessed path; only a privileged or system/managed bypass is
    // a violation (`uv pip install --system/--break-system-packages`, or under sudo).
    if (rest[0] === "uv" && positionals[0] === "pip" && positionals[1] === "install") {
      const bad = flags.filter(
        (f) => f === "--system" || f === "--break-system-packages",
      );
      if (sudo || bad.length > 0)
        return {
          kind: "uv-global",
          segment,
          tool: "uv pip",
          sub: "install",
          sudo,
          globalFlags: bad,
        };
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
      if (opts.uvAvailable)
        return { kind: "pip-install", segment, tool: tool.label, sub, sudo, globalFlags };
      return null;
    }
    if (sub && UV_PIP_PARITY[sub] && opts.uvAvailable)
      return { kind: "pip-other", segment, tool: tool.label, sub, sudo, globalFlags };
    return null; // download/wheel/config/cache/hash/index — no clean uv parity
  }

  // pipx: only subcommands with a real uv equivalent (see PIPX_TO_UV).
  if (tool.kind === "pipx" && opts.uvAvailable && sub && PIPX_TO_UV[sub])
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
