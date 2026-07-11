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
// Every violation is blocked and the reason is returned to the model — there is
// no interactive prompt (it could hang in non-interactive/agent contexts). The
// only sanctioned bypass is the OMP_ALLOW_UV_PIP_INSTALL override above, and only
// for plain `uv pip install`.

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
  pi.on("tool_call", (event) => {
    if (event.toolName !== "bash") return;

    const input = event.input;
    if (!input || typeof input !== "object" || !("command" in input)) return;
    const command = input.command;
    if (typeof command !== "string" || command.length === 0) return;

    const envOverride =
      typeof process !== "undefined" && OVERRIDE_TRUTHY.test(process.env[OVERRIDE_ENV] ?? "");
    const violation = analyzeCommand(command, { uvAvailable: uvAvailable(), envOverride });
    if (!violation) return;

    return { block: true, reason: buildReason(violation) };
  });
}
