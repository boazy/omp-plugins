# enforce-uv

An [oh-my-pi](https://github.com/oh-my-pi) extension that intercepts `bash` tool
calls and **blocks pip / pipx misuse**, redirecting the agent to `uv` / `uvx`.

It exists because documentation written by lazy authors — and LLMs trained on
outdated data — habitually reach for `pip install`, `pipx`, and global installs
that modern package managers (PEP 668) reject anyway. When one slips through, the
block message teaches the agent the correct uv-native workflow instead.

## Rules enforced

| # | Rule | Triggers a block on |
|---|------|---------------------|
| 1 | Never use pip when uv can do the job | `pip install` / `uninstall`, `python -m pip install …`, and `pip list/freeze/show/tree/check/sync/compile` (all have a `uv pip` equivalent) |
| 2 | Never use pipx when uvx / `uv tool` fits | `pipx install/run/upgrade/inject …`, `python -m pipx …` |
| 3 | Never install globally | `sudo pip install`, `pip install --user`, `pip install --break-system-packages`, and `uv pip install --system/--break-system-packages` |

Detection is command-aware: it splits on `&&`, `||`, `;`, `|`, and newlines,
strips leading env assignments and wrappers (`sudo`, `doas`, `env`, `nohup`, …),
and understands `python -m pip`. So `echo "pip install x"` and
`git commit -m "fix pip"` are **not** flagged, but `cat req.txt | pip install -r -`
is.

### What is *not* blocked

- Anything uv-native: `uv pip install`, `uv add`, `uv run`, `uvx`, `uv tool …`,
  `uv venv`.
- pip subcommands with no clean uv parity: `pip download`, `pip wheel`,
  `pip config`, `pip cache`, `pip hash`, `pip index`.
- pipx-only subcommands with no uv counterpart: `pipx runpip`, `pipx environment`,
  `pipx interpreter`, `pipx pin`. Only mappable subcommands are blocked (rule 2 is
  conditional).
- If `uv` is **not** on `PATH`, rules 1 and 2 stand down (there is no uv to steer
  to). Rule 3 — the global-install guard — stays on regardless, because a
  system-wide pip install is dangerous either way.

## Override

There is **no command-line escape hatch** (e.g. an env flag), on purpose: the
agent would just prepend it and defeat the guard. The only override is an
interactive human confirming the prompt. In headless / subagent runs (no UI) the
command is always blocked, and the block reason is returned to the model so it can
pick a correct alternative on its own.

## The uv playbook (what to do instead)

| You wanted to… | Do this |
|---|---|
| pip-install for a one-off script | Add [PEP 723](https://peps.python.org/pep-0723/) inline metadata, then run with uv:<br>`uv add --script script.py <pkg>` → `uv run script.py` |
| pip-install for a project | Declare deps in `pyproject.toml`:<br>`uv init` (if new) → `uv add <pkg>` → `uv run <entrypoint>` |
| pip-install into a throwaway/managed venv | `uv venv && uv pip install <pkg>` |
| Run a CLI tool once | `uvx <pkg>` |
| Install a CLI tool onto `PATH` | `uv tool install <pkg>` |
| A tool with optional features (extras) | `uvx "<pkg>[extra1,extra2]"` — e.g. `uvx "yt-dlp[default,curl-cffi]"` (works with `uv tool install` too) |
| Extra deps for an installed tool (≈ `pipx inject`) | Persistent: `uv tool install <tool-pkg> --with <extra-pkg>`; one-off: `uvx --with <extra-pkg> <tool-pkg>` |
| The command name ≠ the package name | `uvx --from <pkg> <command>` |
| Pin the interpreter | Add `--python 3.12` to `uv run` / `uvx` / `uv venv` |
| `pip list/freeze/show/tree/check` | `uv pip list/freeze/show/tree/check` (its own flag surface — see `uv pip <sub> --help`) |
| List / upgrade / remove installed tools | `uv tool list` / `uv tool upgrade` / `uv tool uninstall` |

`uv pip install` (into an active venv) is the literal drop-in when you just want
pip's behavior; the block message says so, but prefers a first-class uv workflow.

## Install

**Recommended — install the published plugin (npm):**

```sh
omp plugin install omp-enforce-uv
```

Enabled for all sessions immediately; manage it with `omp plugin list` /
`omp plugin disable omp-enforce-uv`. Update with `omp plugin install omp-enforce-uv@latest`.

### Other ways to load it

**Option A — user extensions directory:**

```sh
cp -r . ~/.omp/agent/extensions/enforce-uv
```

Restart `omp`. Active for all sessions.

**Option B — point config at it:**

```yaml
# ~/.omp/agent/config.yml
extensions:
  - ~/projects/personal/omp-plugins/enforce-uv
```

**Option C — load once via CLI flag:**

```sh
omp --extension ~/projects/personal/omp-plugins/enforce-uv
```

## Layout

```
enforce-uv/
  package.json      # omp.extensions manifest → ./index.ts
  index.ts          # extension entry: tool_call bash interceptor + confirm override
  detect.ts         # pure command analysis (segment split, tokenize, classify)
  advice.ts         # builds the educational block message per violation kind
  detect.test.ts    # bun test — 72 cases
```

## Develop

```sh
bun test                       # run the detection suite
bun build ./index.ts --target=node > /dev/null   # transpile check
```

Detection logic lives in `detect.ts` and is side-effect-free, so new cases are
one line in `detect.test.ts`.
