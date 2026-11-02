# Native composer predictions for local API connections

Cockpit connects verified local API-backed Codex conversations to the native
gray-text suggestion and Tab editor. The feature is disabled by default.

## Enable and use

Enable **Native next-step predictions (Tab completion)** in Cockpit's Codex
enhancement settings, then restart the target Codex instance through Cockpit
when it is idle. The native **Show predictions** preference must also be enabled.
Pressing Tab accepts a suggestion as an editable draft without sending it.

Native speed controls are enabled automatically for verified API profiles.
The prediction preference remains independent and disabled by default.

Windows launches require the matching Cockpit sample backend. Build it with
`pwsh -File sidecars/codex-sample/build.ps1`; its source revision and patch are
kept alongside the script. The executable and matching Windows helpers are
installed in `codex-sample/` beside Cockpit. Missing or incompatible files stop
an enhanced launch with an error; disabling predictions uses the official CLI.

Predictions make additional API requests using the source conversation's model,
provider, and context, and consume that provider's usage allowance.

## Compatibility

- Applies to verified local API connections. ChatGPT-authenticated, remote, SSH,
  and cloud connections retain their existing behavior.
- Follows the native live and catch-up triggers. Live predictions require the
  source owner; catch-up predictions require a resumed, idle source. Plan mode,
  temporary or side conversations, and closed subagents are excluded.
- Uses Cockpit's document-start module loader and Codex's native `thread/sample`
  RPC, editor, and Tab handler. Windows uses a versioned companion CLI through
  process-local `CODEX_CLI_PATH`; official installed files remain unchanged.
- Shares the initial-module discovery used by other enhancements, including
  supported re-export wrappers. Unknown or ambiguous native module layouts
  disable prediction compatibility without disabling normal chat.
- Fresh local pages queue preload registration before their application scripts
  run. Existing pages are never paused or reloaded; attachment after document
  startup can only prepare a future document.
- Sampling creates no ordinary prediction conversation or turn. Normal task
  notifications and their preferences are preserved; no notification filter or
  global mute is installed.

## Requests and cancellation

The adapter resumes the source thread, verifies its latest idle turn, and sends
`thread/sample` with `threadId` and `expectedTurnId`. A result must include the
matching `sourceTurnId` and a real `responseId`. The adapter does not replay
history or override the source model or provider.

Requests are deduplicated by source turn, with one active prediction per thread
and no automatic retry. The backend keeps its native 30-second deadline; the
45-second transport deadline also allows for IPC and cleanup. New turns, thread
deletion, authentication changes, disabling predictions, and runtime disposal
cancel pending work. Ordinary account status updates do not cancel predictions.
The source turn is checked before delivery; stale results are discarded.
Cancellation rejects the request and
releases listeners before abandoning queued IPC work and sending
`thread/sample/cancel` for the same request ID. It never interrupts the source
turn or waits for network cleanup before returning the local result.

Successful suggestions and valid empty suggestions are cached by source turn.
An empty suggestion retains its native result metadata with `text: null`.
New turns and prediction-setting changes invalidate the cache. Errors and
cancellation propagate without caching an empty success. The existing
native flow may request that source again; the adapter does not schedule retries.
Unsupported sampling does not fall back to an ordinary prediction conversation.

The response text must be JSON containing a `suggestion` string or explicit
`null`. Extra fields are ignored; strings are trimmed, and an empty string is a
valid empty suggestion. Long and multiline strings reach the native editor
without an adapter length limit. Malformed JSON, missing fields, and incorrect
types fail the request. A missing or null response **text** is also a failure,
distinct from the valid JSON result `{"suggestion": null}`.

## Backend limits

The companion CLI applies `effort: "low"` to the private sample's first turn,
including custom API providers, without changing the source settings or the
global reasoning-update policy. The provider still controls actual inference
latency; a response exceeding 30 seconds fails rather than retrying.

The native sample interceptor captures model output before tool execution and
ordinary turn-completion hooks. Tool attempts or absent text can yield null
response text, which the adapter treats as a failure. Predictions create no
ordinary task notifications.

## Maintenance and verification

Follow the [project conventions](../AGENTS.md) and
[contribution guide](../CONTRIBUTING.md). For changes to prediction behavior or
its module graph, run the existing relevant tests:

```sh
node --experimental-vm-modules --test src-tauri/src/modules/codex_app_enhancements/predictions.test.cjs src-tauri/src/modules/codex_app_enhancements/prediction_graph.test.cjs
```

Add startup, settings, locale, or Rust checks only when those areas change.
For the companion backend, use the build script's `-RunTests` option to run the
direct sample cases against its pinned source and patch.
When a compatibility change needs live acceptance, use a synthetic conversation
and actual Tab input. Verify the editable draft, unchanged submitted-message
count, existing-draft and IME protection, cancellation, and disabled settings.
Report only relevant versions, adapter status/reason, and sanitized results;
exclude credentials, private endpoints, real conversations, and copied Codex
modules. Keep execution history out of this document.

## Fork and updates

This fork integrates the feature with upstream v1.3.78. Its updater still points
to upstream releases, so installing an upstream update can replace the fork's
enhancements. A fork-specific update channel is not configured.
