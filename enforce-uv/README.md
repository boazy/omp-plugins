# enforce-uv

An [oh-my-pi](https://github.com/can1357/oh-my-pi) extension that intercepts `bash` tool
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

Plus a **soft block** on plain `uv pip install …` (rule 1): it is the
pip-compatibility escape hatch and usually the wrong first move versus a PEP 723
script or a `pyproject.toml`. Unlike the hard blocks above it can be overridden
(see [Override](#override)).

Detection is command-aware: it splits on `&&`, `||`, `;`, `|`, and newlines,
strips leading env assignments and wrappers (`sudo`, `doas`, `env`, `nohup`, …),
and understands `python -m pip`. So `echo "pip install x"` and
`git commit -m "fix pip"` are **not** flagged, but `cat req.txt | pip install -r -`
is.

### What is *not* blocked

- uv-native project/tool commands: `uv add`, `uv run`, `uvx`, `uv tool …`, `uv venv`
  (plain `uv pip install` is soft-blocked — see rule 1 above).
- pip subcommands with no clean uv parity: `pip download`, `pip wheel`,
  `pip config`, `pip cache`, `pip hash`, `pip index`.
- pipx-only subcommands with no uv counterpart: `pipx runpip`, `pipx environment`,
  `pipx interpreter`, `pipx pin`. Only mappable subcommands are blocked (rule 2 is
  conditional).
- If `uv` is **not** on `PATH`, rules 1 and 2 stand down (there is no uv to steer
  to). Rule 3 — the global-install guard — stays on regardless, because a
  system-wide pip install is dangerous either way.
- Anything run through omp's `eval` tool (the stateful IPython `py` kernel). The
  guard only intercepts the `bash` tool, so an in-kernel install with
  `!uv pip install <pkg>` (or `%pip install <pkg>` — `python -m pip` — only when
  uv is unavailable) is never touched. That is correct **only when the kernel is
  backed by an isolated venv** (an active/project `.venv`, or the managed
  `~/.omp/python-env`). If the kernel fell back to the system interpreter, create
  or select a venv first — otherwise an in-kernel install mutates system Python
  (rule 3), a path this bash-only guard cannot see.

## Override

The hard blocks — rules 2–3 and `pip install` — have **no bypass**: they are
always blocked and the reason is returned to the model so it can pick a correct
uv alternative. (There is deliberately no interactive prompt — it could hang in
non-interactive/agent contexts, and a safety rule shouldn't be waved through by a
hurried confirmation.)

The one **soft** block — plain `uv pip install` — is overridable so a deliberate
install can proceed:

- **Per command:** prefix it — `OMP_ALLOW_UV_PIP_INSTALL=1 uv pip install <pkg>`.
- **Session-wide:** launch omp with `OMP_ALLOW_UV_PIP_INSTALL=1` already exported.

A bare `export …` *inside* a bash tool call does **not** work — it only affects
that child shell, not omp's environment. And a privileged/system variant
(`sudo uv pip install`, `--system`, `--break-system-packages`) is rule 3: the
override does not apply to it.

## The uv playbook (what to do instead)

| You wanted to… | Do this |
|---|---|
| pip-install for a one-off script | Add [PEP 723](https://peps.python.org/pep-0723/) inline metadata, then run with uv:<br>`uv add --script script.py <pkg>` → `uv run script.py` |
| pip-install for a project | Declare deps in `pyproject.toml`:<br>`uv init` (if new) → `uv add <pkg>` → `uv run <entrypoint>` |
| Raw pip semantics into a venv (last resort) | `uv venv`, then `OMP_ALLOW_UV_PIP_INSTALL=1 uv pip install <pkg>` |
| Run a CLI tool once | `uvx <pkg>` |
| Install a CLI tool onto `PATH` | `uv tool install <pkg>` |
| A tool with optional features (extras) | `uvx "<pkg>[extra1,extra2]"` — e.g. `uvx "yt-dlp[default,curl-cffi]"` (works with `uv tool install` too) |
| Extra deps for an installed tool (≈ `pipx inject`) | Persistent: `uv tool install <tool-pkg> --with <extra-pkg>`; one-off: `uvx --with <extra-pkg> <tool-pkg>` |
| The command name ≠ the package name | `uvx --from <pkg> <command>` |
| Pin the interpreter | Add `--python 3.12` to `uv run` / `uvx` / `uv venv` |
| `pip list/freeze/show/tree/check` | `uv pip list/freeze/show/tree/check` (its own flag surface — see `uv pip <sub> --help`) |
| List / upgrade / remove installed tools | `uv tool list` / `uv tool upgrade` / `uv tool uninstall` |

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
  index.ts          # extension entry: tool_call bash interceptor (always block + reason)
  detect.ts         # pure command analysis (segment split, tokenize, classify)
  advice.ts         # builds the educational block message per violation kind
  detect.test.ts    # bun test — detection + advice suite
```

## Develop

```sh
bun test                       # run the detection suite
bun build ./index.ts --target=node > /dev/null   # transpile check
```

Detection logic lives in `detect.ts` and is side-effect-free, so new cases are
one line in `detect.test.ts`.
