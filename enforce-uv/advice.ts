// Builds the educational block message shown to the model (and human) when a
// pip/pipx violation is detected. Kept separate from detection so the prose can
// be rich without bloating the wiring.

import { OVERRIDE_ENV, PIPX_TO_UV, type Violation } from "./detect";

// The uv playbook that replaces a global pip install. Referenced by several kinds.
const UV_ALTERNATIVES = [
  "Pick the uv-native path instead:",
  "  • One-off script → PEP 723 inline metadata, then run with uv (it builds the env):",
  "      uv add --script <file>.py <pkg>     # writes the # /// script deps block",
  "      uv run <file>.py",
  "  • Project → declare deps in pyproject.toml:",
  "      uv init            # only if the project doesn't exist yet",
  "      uv add <pkg>       # then: uv run <entrypoint>",
  `  • Raw pip semantics into a venv (last resort) → ${OVERRIDE_ENV}=1 uv pip install <pkg>`,
  "  • CLI tool, run once → uvx <pkg>",
  "  • CLI tool, keep on PATH → uv tool install <pkg>",
  '  • Tool with optional features (extras) → uvx "<pkg>[extra1,extra2]"',
  '      e.g. uvx "yt-dlp[default,curl-cffi]"   (works with uv tool install too)',
  "  • Extra deps alongside a tool → uvx --with <extra-pkg> <pkg>",
  "  • Command name ≠ package name → uvx --from <pkg> <command>",
  "  • Pin a Python version → add --python 3.12 to uv run / uvx / uv venv",
];

export function buildReason(v: Violation): string {
  const seg = `Command: ${v.segment}`;

  switch (v.kind) {
    case "pip-install":
      return [
        `enforce-uv: don't reach for pip when uv is available (rule 1).`,
        seg,
        "",
        "Use a uv-native workflow, not pip:",
        "",
        ...UV_ALTERNATIVES,
        "",
        "If you genuinely need real pip here, re-run in an interactive session and confirm the prompt.",
      ].join("\n");

    case "uv-pip":
      return [
        "enforce-uv: pause before `uv pip install` (rule 1).",
        seg,
        "",
        "`uv pip install` imperatively mutates a venv — it's the pip-compatibility",
        "escape hatch and usually the wrong first move. Prefer a declarative setup:",
        "",
        "  • One-off / simple script → PEP 723 inline dependencies, run with uv:",
        "      uv add --script <file>.py <pkg>     # writes the # /// script deps block",
        "      uv run <file>.py",
        "  • Complex / multi-file project → declare deps in pyproject.toml:",
        "      uv init            # only if the project doesn't exist yet",
        "      uv add <pkg>       # then: uv run <entrypoint>",
        "  • CLI tool → uvx <pkg> (once)  /  uv tool install <pkg> (persist)",
        "  • Live/stateful interpreter (e.g. omp's eval IPython kernel) → this IS the",
        "    right tool; there's no file to declare deps in. Best done *inside* the kernel",
        "    with `!uv pip install <pkg>` in a `py` cell (or `%pip install <pkg>` if uv is",
        "    unavailable) — that path isn't guarded. Only if you must install from bash,",
        "    use the override:",
        "",
        "Override — re-run with the flag as a prefix on this same command:",
        `      ${OVERRIDE_ENV}=1 ${v.segment}`,
        `(A human can instead launch omp with ${OVERRIDE_ENV}=1 already exported to allow it session-wide.`,
        " A bare 'export' inside a bash call won't work — it only affects that child shell.)",
      ].join("\n");

    case "pip-other":
      return [
        `enforce-uv: uv reimplements this pip subcommand — use it instead (rule 1).`,
        seg,
        "",
        `  pip ${v.sub} …  →  uv pip ${v.sub} …`,
        "",
        "uv pip covers list / freeze / show / tree / check / sync / compile against the",
        `active environment. uv has its own option surface — see \`uv pip ${v.sub} --help\` for equivalents.`,
      ].join("\n");

    case "pip-global": {
      const how = v.sudo
        ? "via sudo"
        : `via ${v.globalFlags.join(" ")}`;
      return [
        `enforce-uv: refusing a global/system pip install (${how}) — rule 3.`,
        seg,
        "",
        "Modern interpreters mark their environment externally-managed (PEP 668) and reject",
        "this; the bypass you used (--break-system-packages / --user / sudo) mutates the system",
        "Python and breaks OS packages. It is almost never what you want.",
        "",
        ...UV_ALTERNATIVES,
      ].join("\n");
    }

    case "pipx": {
      const target = (v.sub && PIPX_TO_UV[v.sub]) ?? "the matching `uv tool` subcommand";
      return [
        `enforce-uv: use uv's tool runner instead of pipx (rule 2).`,
        seg,
        "",
        `  pipx ${v.sub} …  →  ${target}`,
        "",
        "  • Run a CLI once, no install → uvx <pkg>",
        "  • Install a CLI onto PATH → uv tool install <pkg>",
        '  • With extras → uvx "<pkg>[extra]"   or   uv tool install "<pkg>[extra]"',
        "  • Add deps to an installed tool (≈ pipx inject) → uv tool install <tool-pkg> --with <extra-pkg>",
        "  • List / upgrade / uninstall installed tools → uv tool list|upgrade|uninstall",
        "  • Command name ≠ package → uvx --from <pkg> <command>",
      ].join("\n");
    }

    case "uv-global": {
      const what = v.globalFlags.length
        ? `\`uv pip install ${v.globalFlags.join(" ")}\``
        : "`uv pip install` under sudo";
      return [
        `enforce-uv: refusing ${what} — rule 3.`,
        seg,
        "",
        "That targets the system / externally-managed interpreter (or runs the install as",
        "root), the exact global install we avoid. Scope it to an environment instead:",
        "",
        "  • uv venv && uv pip install <pkg>        # explicit local venv",
        "  • uv add <pkg>                           # inside a uv project",
        "  • uv add --script <file>.py <pkg>        # for a standalone script",
        "  • uvx <pkg> / uv tool install <pkg>      # for CLI tools",
      ].join("\n");
    }
  }
}
