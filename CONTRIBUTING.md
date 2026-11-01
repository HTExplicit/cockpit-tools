# Contributing to Cockpit Tools

Read [AGENTS.md](AGENTS.md) before making changes. It is the source of truth for
code organization, documentation, and verification policy; [.editorconfig](.editorconfig)
defines editor formatting. This guide provides development commands.

## Development setup

Install frontend dependencies with `npm ci`. For desktop prerequisites, see the
[Tauri build guide](docs/TAURI_BUILD_GUIDE.md).

## Project layout

| Directory | Responsibility |
| --- | --- |
| `src/` | React UI, state, services, and translations |
| `src-tauri/` | Tauri host, native integrations, and Codex enhancement adapters |
| `crates/cockpit-core/` | Shared Rust business logic |
| `crates/cockpit-cli/` | Command-line application |
| `scripts/` | Development, validation, and release tooling |
| `tests/` | Integration fixtures and regression tests |
| `docs/` | Usage, architecture, and development documentation |

## Minimal verification

Choose checks for the affected behavior. Documentation-only edits and source
migrations need relevant link and file-integrity checks plus `git diff --check`,
without business tests. Full suites, builds, and release preflight are not
routine requirements for each change.

For TypeScript logic or type changes, run the directly affected tests and the
typecheck. For example:

```sh
node node_modules/tsx/dist/cli.mjs --test src/components/codex/CodexAppEnhancementSettings.test.ts
npm run typecheck
```

For prediction adapter or module-graph behavior:

```sh
node --experimental-vm-modules --test src-tauri/src/modules/codex_app_enhancements/predictions.test.cjs src-tauri/src/modules/codex_app_enhancements/prediction_graph.test.cjs
```

Add the startup test only when the startup path changes:

```sh
node --experimental-vm-modules --test src-tauri/src/modules/codex_app_enhancements/startup_preload.test.cjs
```

For the Windows prediction backend, build the pinned CLI with
`pwsh -File sidecars/codex-sample/build.ps1`. Use `-RunTests` only for changes to
its sample patch. Generated sources, caches, and binaries remain untracked;
see [prediction compatibility](docs/codex-native-predictions.md) for deployment.

For translation-key changes:

```sh
node scripts/check_locales.cjs
```

For Rust changes, select the affected package and filter by test name. For example:

```sh
cargo test --package cockpit-tools prediction_only_profile -- --test-threads=1
```

Replace the example test paths or name filter with those covering your change;
use `cockpit-core` or `cockpit-cli` when that package is affected.

## Development commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the frontend development server |
| `npm run tauri:dev` | Start the Tauri desktop application |
| `cargo run --package cockpit-cli -- <commands>` | Run the CLI |
| `npm run build` | Build the frontend when build verification is needed |

## Releases and security

Follow the existing [release process](docs/release-process.md) when preparing a
release. Report security issues through [SECURITY.md](SECURITY.md).
