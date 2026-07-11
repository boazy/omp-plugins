import { describe, expect, test } from "bun:test";
import { analyzeCommand, type ViolationKind } from "./detect";
import { buildReason } from "./advice";

const WITH_UV = { uvAvailable: true };
const NO_UV = { uvAvailable: false };

function kind(cmd: string, opts = WITH_UV): ViolationKind | null {
  return analyzeCommand(cmd, opts)?.kind ?? null;
}

describe("rule 1 — pip → uv", () => {
  test.each([
    "pip install requests",
    "pip3 install requests",
    "pip3.12 install requests",
    "python3 -m pip install requests",
    "python -m pip install 'flask>=3'",
    "py -m pip install requests",
  ])("blocks %s as pip-install", (cmd) => {
    expect(kind(cmd)).toBe("pip-install");
  });

  test.each(["pip list", "pip freeze", "pip show requests", "pip tree", "pip check"])(
    "maps read-ish subcommand %s to pip-other",
    (cmd) => {
      expect(kind(cmd)).toBe("pip-other");
    },
  );

  test.each(["pip download foo", "pip wheel foo", "pip config list", "pip cache dir"])(
    "leaves parity-less subcommand %s alone",
    (cmd) => {
      expect(kind(cmd)).toBeNull();
    },
  );

  test("uninstall is a pip-install-class violation", () => {
    expect(kind("pip uninstall requests")).toBe("pip-install");
  });
});

describe("rule 2 — pipx → uvx / uv tool", () => {
  test.each([
    "pipx install black",
    "pipx run black",
    "pipx upgrade black",
    "pipx upgrade-all",
    "pipx inject black rich",
    "pipx ensurepath",
    "python3 -m pipx install black",
  ])("blocks %s as pipx", (cmd) => {
    expect(kind(cmd)).toBe("pipx");
  });

  test.each(["pipx runpip black list", "pipx environment", "pipx interpreter list", "pipx"])(
    "leaves pipx-only subcommand %s alone",
    (cmd) => {
      expect(kind(cmd)).toBeNull();
    },
  );
});

describe("rule 3 — no global installs", () => {
  test.each([
    "pip install --break-system-packages foo",
    "pip install --user foo",
    "sudo pip install foo",
    "sudo -H pip3 install foo",
    "python3 -m pip install --user foo",
    "doas pip install foo",
    "sudo -u root pip install foo",
  ])("blocks %s as pip-global", (cmd) => {
    expect(kind(cmd)).toBe("pip-global");
  });

  test.each([
    "uv pip install --system foo",
    "uv pip install --break-system-packages foo",
    "sudo uv pip install foo",
    "sudo -H uv pip install foo",
    "doas uv pip install foo",
    "sudo -u root uv pip install foo",
  ])("blocks %s as uv-global", (cmd) => {
    expect(kind(cmd)).toBe("uv-global");
  });
});

describe("uv-native commands are allowed", () => {
  test.each([
    "uvx black",
    'uvx "yt-dlp[default,curl-cffi]"',
    "uv tool install ruff",
    "uv add requests",
    "uv add --script script.py httpx",
    "uv run script.py",
    "uv venv",
  ])("allows %s", (cmd) => {
    expect(kind(cmd)).toBeNull();
  });
});

describe("uv pip install is soft-blocked (rule 1)", () => {
  test.each([
    "uv pip install requests",
    "uv pip install -r requirements.txt",
    "uv pip install --python /tmp/.venv/bin/python ruamel.yaml",
    "bash -c 'uv pip install foo'",
  ])("blocks %s as uv-pip", (cmd) => {
    expect(kind(cmd)).toBe("uv-pip");
  });

  test.each([
    "OMP_ALLOW_UV_PIP_INSTALL=1 uv pip install foo",
    "OMP_ALLOW_UV_PIP_INSTALL=true uv pip install foo",
    "OMP_ALLOW_UV_PIP_INSTALL=yes uv pip install foo",
    "OMP_ALLOW_UV_PIP_INSTALL=1 uv pip install --python /tmp/.venv/bin/python ruamel.yaml",
    "OMP_ALLOW_UV_PIP_INSTALL=1 bash -c 'uv pip install foo'",
  ])("override prefix allows %s", (cmd) => {
    expect(kind(cmd)).toBeNull();
  });

  test.each(["OMP_ALLOW_UV_PIP_INSTALL=0 uv pip install foo", "FOO=1 uv pip install foo"])(
    "non-truthy / unrelated assignment stays blocked: %s",
    (cmd) => {
      expect(kind(cmd)).toBe("uv-pip");
    },
  );

  test("process-env override allows it", () => {
    expect(
      analyzeCommand("uv pip install foo", { uvAvailable: true, envOverride: true }),
    ).toBeNull();
  });

  test("override never bypasses a global/system install", () => {
    expect(kind("OMP_ALLOW_UV_PIP_INSTALL=1 sudo uv pip install foo")).toBe("uv-global");
    expect(kind("OMP_ALLOW_UV_PIP_INSTALL=1 uv pip install --system foo")).toBe("uv-global");
    expect(
      analyzeCommand("sudo uv pip install foo", { uvAvailable: true, envOverride: true })?.kind,
    ).toBe("uv-global");
  });
});

describe("no false positives on unrelated commands", () => {
  test.each([
    'echo "pip install foo"',
    'git commit -m "fix pip install docs"',
    "grep -r 'pipx' .",
    "cat requirements.txt",
  ])("ignores %s", (cmd) => {
    expect(kind(cmd)).toBeNull();
  });
});

describe("compound commands", () => {
  test("flags the offending segment across && chains", () => {
    expect(kind("cd /tmp && pip install foo && echo done")).toBe("pip-install");
  });
  test("flags pip on the receiving end of a pipe", () => {
    expect(kind("cat req.txt | pip install -r -")).toBe("pip-install");
  });
});

describe("shell -c wrappers are unwrapped", () => {
  test.each<[string, ViolationKind]>([
    ["bash -c 'pip install foo'", "pip-install"],
    ["sh -c 'pipx run black'", "pipx"],
    ["bash -lc 'sudo pip install foo'", "pip-global"],
    ['zsh -c "pip list"', "pip-other"],
    ["env bash -c 'pip install foo'", "pip-install"],
    ["bash -c 'cd /tmp && pip install foo'", "pip-install"],
    ["sh -c 'uv pip install foo'", "uv-pip"],
    ["bash -c 'uv pip install foo'", "uv-pip"],
  ])("unwraps %s → %s", (cmd, expected) => {
    expect(kind(cmd)).toBe(expected);
  });

  test.each(["bash -c 'echo pip install'", "bash script.sh"])(
    "leaves %s alone",
    (cmd) => {
      expect(kind(cmd)).toBeNull();
    },
  );
});

describe("without uv on PATH", () => {
  test("rule 1 (pip install) is not enforced", () => {
    expect(kind("pip install foo", NO_UV)).toBeNull();
  });
  test("rule 1 (pip-other) is not enforced", () => {
    expect(kind("pip list", NO_UV)).toBeNull();
  });
  test("rule 2 (pipx) is not enforced", () => {
    expect(kind("pipx install black", NO_UV)).toBeNull();
  });
  test("rule 3 (global install) is STILL enforced", () => {
    expect(kind("sudo pip install foo", NO_UV)).toBe("pip-global");
    expect(kind("pip install --break-system-packages foo", NO_UV)).toBe("pip-global");
    expect(kind("uv pip install --system foo", NO_UV)).toBe("uv-global");
  });
});

describe("buildReason", () => {
  test.each<[string, RegExp]>([
    ["pip install foo", /rule 1/],
    ["pip list", /uv pip list/],
    ["sudo pip install foo", /rule 3/],
    ["pipx run black", /uvx <pkg>/],
    ["uv pip install --system foo", /rule 3/],
    ["pipx inject black rich", /uv tool install <tool-pkg> --with <extra-pkg>/],
    ["uv pip install ruamel.yaml", /OMP_ALLOW_UV_PIP_INSTALL=1/],
    ["uv pip install foo", /pyproject\.toml/],
    ["uv pip install foo", /%pip install/],
  ])("%s → reason matches %s", (cmd, re) => {
    const v = analyzeCommand(cmd, WITH_UV);
    expect(v).not.toBeNull();
    if (v) expect(buildReason(v)).toMatch(re);
  });

  test("every reason names the offending command", () => {
    const v = analyzeCommand("pip install requests", WITH_UV);
    expect(v).not.toBeNull();
    if (v) expect(buildReason(v)).toContain("pip install requests");
  });
});
