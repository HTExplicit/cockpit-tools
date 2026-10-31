# Native composer predictions for local API connections

Cockpit connects verified local API-backed Codex conversations to the native
gray-text suggestion and Tab editor. The feature is disabled by default.

## Enable and use

Enable **Native next-step predictions (Tab completion)** in Cockpit's Codex
enhancement settings, then restart the target Codex instance through Cockpit
when it is idle. The native **Show predictions** preference must also be enabled.
Pressing Tab accepts a suggestion as an editable draft without sending it.

Predictions make additional API requests using the source conversation's model,
provider, and context, and consume that provider's usage allowance.

## Compatibility

- Applies to verified local API connections. ChatGPT-authenticated, remote, SSH,
  and cloud connections retain their existing behavior.
- Requires an idle source thread owned by the current client. Plan mode,
  temporary or side conversations, and closed subagents are excluded.
- Uses Cockpit's document-start module loader and Codex's native `thread/sample`
  RPC, editor, and Tab handler. It does not modify the installed Codex files or
  create a separate editor or HTTP inference client.
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

Requests are deduplicated by source turn, with one active prediction per thread,
a 45-second deadline, and no automatic retry. New turns, thread deletion,
account/authentication updates, disabling predictions, and runtime disposal
cancel pending work. Source eligibility and provider are checked again before
delivery; stale or late results are discarded. Cancellation settles locally and
releases listeners before abandoning queued IPC work and sending
`thread/sample/cancel` for the same request ID. It never interrupts the source
turn or waits for network cleanup before returning the local result.

Successful suggestions and valid empty suggestions are cached by source turn.
Other request errors propagate without caching an empty success. The existing
native flow may request that source again; the adapter does not schedule retries.
Unsupported sampling does not fall back to an ordinary prediction conversation.

The response text must be JSON containing a `suggestion` string or explicit
`null`. Extra fields are ignored; strings are trimmed, and an empty string is a
valid empty suggestion. Long and multiline strings reach the native editor
without an adapter length limit. Malformed JSON, missing fields, and incorrect
types fail the request. A missing or null response **text** is also a failure,
distinct from the valid JSON result `{"suggestion": null}`.

## Backend limits

The request includes `effort: "low"`; its effective reasoning effort depends on
model/provider support and may inherit the source setting. The prediction prompt
forbids actions and tool calls, but the native `disableMcp` option is not a
universal server-side tool prohibition. A tool attempt or absent text can yield
null response text, which the adapter treats as a failure.

## Maintenance and verification

Follow the [project conventions](../AGENTS.md) and
[contribution guide](../CONTRIBUTING.md). For changes to prediction behavior or
its module graph, run the existing relevant tests:

```sh
node --experimental-vm-modules --test src-tauri/src/modules/codex_app_enhancements/predictions.test.cjs src-tauri/src/modules/codex_app_enhancements/prediction_graph.test.cjs
```

Add startup, settings, locale, or Rust checks only when those areas change.
When a compatibility change needs live acceptance, use a synthetic conversation
and actual Tab input. Verify the editable draft, unchanged submitted-message
count, existing-draft and IME protection, cancellation, and disabled settings.
Report only relevant versions, adapter status/reason, and sanitized results;
exclude credentials, private endpoints, real conversations, and copied Codex
modules. Keep execution history out of this document.

## Fork and updates

This fork integrates the feature with upstream v1.3.76. Its updater still points
to upstream releases, so installing an upstream update can replace the fork's
enhancements. A fork-specific update channel is not configured.
