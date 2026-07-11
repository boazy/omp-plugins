// enforce-uv — an oh-my-pi extension that blocks pip/pipx misuse and steers
// toward uv / uvx equivalents.
//
//   rule 1: never use pip when uv can do the job
//   rule 2: never use pipx when uvx / `uv tool` can do the job
//   rule 3: never install a package globally (no --break-system-packages,
//           --user, sudo pip, or `uv pip install --system`)
//
// Plain `uv pip install` is soft-blocked (rule 1) but can be opted into per
// command with `OMP_ALLOW_UV_PIP_INSTALL=1 …`, or session-wide by launching omp
// with that variable exported.
//
// The block reason is written for the model: it names the rule and lists the
// concrete uv workflow to use instead. In an interactive session the human can
// override via a confirm prompt; headless/subagent runs are always blocked.

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { analyzeCommand, OVERRIDE_ENV, OVERRIDE_TRUTHY } from "./detect";
import { buildReason } from "./advice";

let uvAvailableCache: boolean | undefined;

function uvAvailable(): boolean {
  if (uvAvailableCache === undefined) {
    uvAvailableCache =
      typeof Bun !== "undefined" && Bun.which("uv") !== null;
  }
  return uvAvailableCache;
}

export default function enforceUv(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;

    const input = event.input;
    if (!input || typeof input !== "object" || !("command" in input)) return;
    const command = input.command;
    if (typeof command !== "string" || command.length === 0) return;

    const envOverride =
      typeof process !== "undefined" && OVERRIDE_TRUTHY.test(process.env[OVERRIDE_ENV] ?? "");
    const violation = analyzeCommand(command, { uvAvailable: uvAvailable(), envOverride });
    if (!violation) return;

    const reason = buildReason(violation);

    // Interactive escape hatch: a present human may knowingly override. The
    // agent cannot self-approve — no UI means the command is blocked.
    if (ctx.hasUI) {
      const allow = await ctx.ui.confirm(
        "enforce-uv: pip/pipx blocked",
        `${reason}\n\nRun it anyway?`,
      );
      if (allow) return;
    }

    return { block: true, reason };
  });
}
