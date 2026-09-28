# dsh-chatgpt-web

Experimental standalone DeepSeek Harness provider that uses an already authenticated ordinary ChatGPT Web session through a local Chrome extension.

```text
DSH native chat
  -> chatgpt-web/auto
  -> localhost WebSocket bridge (127.0.0.1:8765)
  -> bundled Chrome MV3 extension
  -> one extension-owned ChatGPT worker tab
  -> chatgpt.com
```

No OpenAI API key, OpenAI Platform inference credits, or Secure MCP Tunnel are required by this plugin. It automates the normal `chatgpt.com` web UI that the user is already signed in to.

## Status

**Solis compatibility fork: `0.1.1-solis.1`, targeting DSH `0.1.7-rc.2`.**

This branch ports the DSH adapter to the current message model. It preserves the original browser extension, loopback bridge, FIFO queue, managed-conversation ownership, and authoritative-completion-only output. Market/npm publication is still a work in progress.

The upstream `0.1.0` author recorded completed browser and packed-install acceptance on DSH `0.1.1-rc.2`. That historical result does **not** certify this fork on Windows or the current ChatGPT UI. Authenticated Chrome/ChatGPT acceptance for this fork is pending; use an isolated DSH profile first.

See [the compatibility and acceptance notes](docs/dsh-0.1.7-compatibility.md) for supported inputs, cloud verification, and remaining local gates. The upstream premature-completion issue was resolved using semantic response action controls before `generation-complete`; that browser implementation is unchanged.

See:

- [`docs/2026-08-26-progress-and-debugging-log.md`](docs/2026-08-26-progress-and-debugging-log.md) for the implementation/debugging history;
- [`docs/manual-smoke.md`](docs/manual-smoke.md) for the manual browser acceptance matrix and packed-install procedure;
- [`docs/superpowers/specs/2026-08-26-chatgpt-web-v0.1-design.md`](docs/superpowers/specs/2026-08-26-chatgpt-web-v0.1-design.md) for the as-built v0.1 architecture and resolved premature-completion findings;
- [`docs/superpowers/plans/2026-08-26-chatgpt-web-v0.1-implementation.md`](docs/superpowers/plans/2026-08-26-chatgpt-web-v0.1-implementation.md) for the implementation plan and historical release checklist.

## v0.1 scope

Implemented or substantially implemented:

- text-only `chatgpt-web/auto` provider;
- one plugin-created managed ChatGPT conversation per DSH session;
- one dedicated Chrome worker tab;
- FIFO serialization of browser generations;
- DSH cancellation -> ChatGPT Stop generation;
- persisted DSH-session-to-ChatGPT-URL mappings and synchronization digests;
- safe pre-Send recovery when a managed ChatGPT conversation has disappeared;
- conservative uncertain state after ambiguous post-dispatch failures;
- runtime-context-aware response targeting so DSH plugin snapshots do not become the apparent human request;
- stable Chrome extension identity and exact extension-Origin validation on the loopback bridge.

Intentional v0.1 limitations:

- text-only input/output;
- DSH tool schemas are rejected when nonempty; native tools are not callable from ChatGPT in this fork (empty tool declarations/history are accepted);
- an external Chrome/Chromium browser with the bundled unpacked extension is required;
- ChatGPT Web DOM changes can require updates to `extension/chatgpt-page-adapter.js`;
- `reasoningEffort`, `temperature`, `maxTokens`, `stop`, and DSH auxiliary `purpose` calls are rejected as unsupported;
- no GitHub Actions or CI workflows;
- no automatic Chrome extension installation.

### Important output semantics

Browser `delta` events are **internal transport observations only** in the current v0.1 implementation. They are not emitted to DSH as user-visible incremental text.

The browser DOM is mutable: React can remount or rewrite old conversation content, while DSH `text-delta` output is append-only. A real second-turn regression demonstrated an old assistant answer crossing the browser boundary as a delta before the correct final answer appeared.

Therefore the adapter currently publishes text to DSH only after authoritative `generation-complete`:

```text
browser delta(s)
  -> internal only

generation-complete(fullText)
  -> block-start(text)
  -> text-delta(fullText)
  -> block-end(fullText)
  -> finish(stop)
```

This intentionally sacrifices token-by-token DSH streaming for v0.1 correctness. The premature-completion bug has been resolved by requiring semantic completed-response action markers (`data-testid="copy-turn-action-button"`, etc.) before `generation-complete` is emitted.

## Requirements

- DeepSeek Harness `0.1.7-rc.2` and `@deepseek-ai/cordis ~4.0.4`;
- Node.js `^22.19.0 || >=24.0.0`;
- Chrome/Chromium with access to `https://chatgpt.com`;
- a logged-in ChatGPT Web session;
- the package-manager prerequisites required by `dsh plugin` on the DSH installation.

## Development install

```bash
npm ci
npm run check
npm test
npm run build

dsh plugin --profile chatgpt-web-compat add .
```

Use a separately initialized test profile and an unused Web port for browser acceptance. Confirm the profile/port flags with your installed `dsh web --help`; see the acceptance notes before starting it. The bridge remains fixed at `127.0.0.1:8765`, so only one instance of this plugin can run on the same host at a time.

At startup the plugin logs the loopback bridge and bundled extension directory:

```text
[dsh-chatgpt-web] bridge listening on ws://127.0.0.1:8765
[dsh-chatgpt-web] Chrome extension directory: /absolute/path/to/dsh-chatgpt-web/extension
[dsh-chatgpt-web] expected Chrome extension origin: chrome-extension://...
```

Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select that `extension` directory. Reload the unpacked extension manually after editing extension source files.

In DSH select:

```text
chatgpt-web/auto
```

and use the normal DSH chat UI.

## Published install

The intended install command after an npm release is:

```bash
dsh plugin --profile web add dsh-chatgpt-web
```

The compatibility fork is not published to npm. Install its locally built tarball for acceptance; the package-name command above describes the upstream intended publication path only.

## Conversation model

DSH remains the canonical durable transcript. A managed ChatGPT conversation is provider-side conversational cache only.

For normal continuation, the adapter sends only the DSH history suffix that is not already synchronized. It never sends ChatGPT's previous assistant output back into the same ChatGPT conversation as a new user message.

DSH can append runtime context as `role=user` messages whose structural source is a plugin snapshot. Producer-owned source kinds replace the old generic plugin source in DSH 0.1.7. Bridge prompts preserve those messages as context but explicitly target the newest message whose `source.kind === "user"` as the human request. Later user-role plugin/tool messages are context, not a new human turn.

If the managed ChatGPT conversation is missing before Send, the adapter can safely clear the mapping and perform one fresh rehydration attempt from canonical DSH history. If generation is aborted after submission or a post-dispatch failure makes provider state ambiguous, the session is marked `uncertain`; a later turn rehydrates into a fresh managed conversation instead of blindly replaying the ambiguous request.

Persistent state contains only operational mapping/digests. It does not store ChatGPT cookies, login tokens, full DSH transcripts, or copies of personal ChatGPT chats.

Transient ChatGPT routes of the form `/c/WEB:...` are rejected and never persisted as managed conversation URLs.

## Actual bridge protocol

Protocol:

```text
dsh-chatgpt-web-v1
```

Plugin -> extension messages currently implemented:

- `generate`
- `abort`
- `ping`

Extension -> plugin messages currently implemented:

- `hello`
- `request-state`
- `session-ready`
- `delta`
- `generation-complete`
- `generation-aborted`
- `error`
- `pong`

Request-scoped events carry `requestId` and a monotonically increasing `seq`. `sessionId` and optional managed `conversationUrl` travel on `generate`.

The critical retry boundary is Send. Explicit failures proven to happen before Send may be retry-safe; after a prompt may have been sent, automatic resend is forbidden and ambiguity becomes `CHATGPT_WEB_UNCERTAIN`.

## Worker-tab privacy model

The extension never enumerates the ChatGPT sidebar and never searches for or adopts arbitrary existing ChatGPT tabs.

It stores only the id of its dedicated worker tab in `chrome.storage.session`. If that tab disappears, it creates another worker tab rather than searching the user's existing tabs. It navigates only to the ChatGPT homepage for new/rehydrated sessions or to managed conversation URLs supplied by the plugin.

Pre-existing personal ChatGPT conversations are outside the plugin's scope.

## Local security boundary

The bridge is fixed to:

```text
ws://127.0.0.1:8765/
```

It binds loopback only and validates the deterministic `chrome-extension://...` Origin produced by the bundled manifest public key. The public key is an identity pin, not a secret or cryptographic authentication token.

This blocks ordinary remote/web-page access to the bridge. A malicious process already running as the same local user can forge a WebSocket Origin, so same-user local processes remain inside the v0.1 trust boundary.

The bridge exposes no shell, filesystem API, cookie reader, generic HTTP proxy, or arbitrary-command endpoint.

## Local verification

There is deliberately no GitHub Actions or CI workflow in this project. Verification is local:

```bash
npm run check
npm test
npm run build
npm pack --dry-run
```

The Solis compatibility candidate passes production/test type checks and 68 automated tests, including the actual DSH LLM Runtime with a simulated browser transport. Build and package checks also pass. The upstream 56-test and isolated DSH profile results remain historical evidence for its earlier release.

Real-browser acceptance is pending and requires an authenticated ChatGPT Web session. See [the current acceptance checklist](docs/dsh-0.1.7-compatibility.md); [`docs/manual-smoke.md`](docs/manual-smoke.md) preserves the upstream scenarios.

## Browser DOM maintenance

All ChatGPT-specific selectors, composer mutation, assistant extraction, Stop detection, and completion detection live in:

```text
extension/chatgpt-page-adapter.js
```

Do not spread ChatGPT selectors into the DSH adapter, transport, session manager, bridge server, or service worker.

When a live DOM defect is found, gather evidence first, write a focused regression fixture/test, verify RED, then make the smallest production change. Historically, the premature-completion bug was resolved by introducing semantic response action checks rather than merely increasing the stability timeout.

## Upstream roadmap (outside this compatibility port)

```text
v0.1  text + managed conversations + authoritative final output + abort
v0.2  validated native DSH tool-call bridge
v0.3  continuable subagent/autonomous supervision loop
v0.4  optional managed/headless Chromium transport
```

Reliable incremental browser-to-DSH streaming may be revisited only after the mutable-DOM identity/completion problem has a proven safe design.

This integration is unofficial browser automation and is not an OpenAI API integration.
