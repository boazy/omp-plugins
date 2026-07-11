# omp-plugins

A collection of [oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`) plugins.

Each subdirectory is a self-contained plugin published as its own npm package;
this repo is the shared source of truth (a monorepo). Plugins are extension
modules — installed via `omp plugin install`, not the marketplace (marketplace
installs do not load `package.json` `omp.extensions`).

## Plugins

| Plugin | Package | Install | What it does |
|---|---|---|---|
| [`enforce-uv/`](./enforce-uv) | [`omp-enforce-uv`](https://www.npmjs.com/package/omp-enforce-uv) | `omp plugin install omp-enforce-uv` | Blocks pip/pipx misuse and steers toward `uv` / `uvx` |

## Layout

```
omp-plugins/
  <plugin>/
    package.json      # name, version, omp.extensions manifest, repository.directory
    index.ts          # extension entry (ExtensionAPI factory)
    …                 # supporting modules, tests
    README.md         # per-plugin docs
  README.md           # this file
```

Each package sets `repository.directory` to its own folder so npm links back to
the right subdirectory of this monorepo.

## Developing a plugin

Plugins are plain TypeScript loaded by omp's Bun runtime — no build step.

```sh
cd <plugin>
bun test                                   # run the plugin's suite
bun build ./index.ts --target=node > /dev/null   # transpile check
omp --extension .                          # load once for a live smoke test
```

For iterative work, link it so edits go live without reinstalling:

```sh
omp plugin link ./<plugin>
```

## Publishing a plugin

Each plugin publishes independently to npm:

```sh
cd <plugin>
npm version patch          # or minor/major — npm versions are immutable
npm publish --access public
```

Then commit and push the repo. Users update with
`omp plugin install <package>@latest`.

## License

MIT — see each plugin's `LICENSE`.
