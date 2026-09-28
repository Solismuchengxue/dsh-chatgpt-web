# DSH 0.1.7-rc.2 compatibility fork

Version: `0.1.1-solis.1`.
Upstream baseline: `14aa2d5e334161a301ba1a0bd8e5a40f2976aedc`.
Target: `@deepseek-ai/dsh-llm 0.1.7-rc.2`, Cordis `~4.0.4`.

## Purpose and scope

Ordinary text chat with a persistent DSH-session-to-ChatGPT-conversation mapping. The browser extension, bridge protocol, origin check, queue, abort/recovery semantics, and final-answer-only output are inherited without modification. This is a compatibility candidate, not a claim of current authenticated browser acceptance.

| Input | Behavior |
| --- | --- |
| Durable user/assistant text, historical reasoning | Preserved as conversation context |
| Leading system messages and optional `options.system` | Combined in order into the instruction section; changes invalidate cache reuse |
| Developer text, producer-owned user context | Preserved; only `role=user, source.kind=user` becomes the human response target |
| Historical tool calls and tool-role results | Serialized as history; result call identity and failure status participate in the digest |
| Empty `tools` and empty `toolHistory` | Accepted (normal Agent Loop shape) |
| Active tools, nonempty tool history, tool additions/removals | Rejected with `CHATGPT_WEB_UNSUPPORTED` |
| Raw image blocks | Rejected with `CHATGPT_WEB_UNSUPPORTED_IMAGE` |
| Files, unknown blocks, non-leading/non-text system messages | Rejected with `CHATGPT_WEB_UNSUPPORTED` |
| Identity-free one-shot user input | Rejected; this provider requires durable session messages |
| Reasoning effort, temperature, token/stop controls, auxiliary purpose | Rejected as in upstream |

Use a text-only session with tools disabled and a fresh history without tool-registration events. This fork does not implement native tool execution, file processing, vision, or auxiliary title/compaction calls. Configure another provider for auxiliary calls where required by the host application.

## Runtime integration

DSH 0.1.7's LLM Runtime transforms files/images into text and filters developer messages before adapter dispatch. `installRuntime` therefore registers a provider-scoped `llm/stream` interceptor that validates the raw inputs and preserves the original immutable message sequence through per-adapter async context. It does not mutate the request, bypass model resolution, or change controls/signals. Rejections are terminal error chunks through normal runtime use. Direct adapter callers still receive `LlmError`.

The adapter serializes only explicitly supported fields; it does not emit provider-private replay metadata. The middleware never intercepts other providers. Request iteration and cleanup run in the captured context so concurrent sessions do not share their histories.

System messages are removed from the synchronized conversation-message count and kept in `systemDigest`. Human/context attribution now contributes to user-message digests. Existing version-1 state is readable, but an old digest mismatch safely rehydrates once into a new plugin-owned conversation. Existing ChatGPT conversations are not deleted; a changed system prompt, changed history, or uncertain generation may also rehydrate, as in upstream.

## Cloud verification

Environment: Linux, Node.js 24.19.0, npm 11.9.0, Cordis 4.0.4, DSH LLM 0.1.7-rc.2.

- All 37 source blobs matched the upstream GitHub baseline before edits.
- Upstream baseline: type check and 56 tests passed. The `tsx` CLI could not open its local IPC pipe in this environment; `node --import tsx --test` executes the same tests without that extra pipe.
- Switching the dependency alone reproduced 12 production TypeScript diagnostics. New regressions reproduced incorrect system handling, missing tool-result correlation, one-shot handling, and runtime developer-message loss before the fixes.
- `npm run check` now checks production and test types. Two existing test typing problems (Happy DOM element type and protocol-union narrowing) were corrected without changing production browser behavior.
- Final automated checks: 68/68 tests passed, zero failures/skips; production and test type checks, build, `npm pack --dry-run`, and `npm pack` passed. Real-runtime tests use actual Cordis/DSH LLM packages and replace only the browser transport.
- The tarball installed into a separate npm consumer with no dev dependencies or source-checkout dependency. `test/packed-smoke.mjs` exercised the installed plugin, actual DSH LLM Runtime, actual loopback WebSocket bridge and simulated extension: two turns, URL reused, developer context preserved, extension manifest present.
- Full DSH CLI profile installation and authenticated Chrome/ChatGPT acceptance remain unverified. The installed-package smoke is not a live browser E2E result.

## Reproduce automated checks

```bash
npm ci
npm run check
npm test
npm run build
npm pack --dry-run
npm pack
```

To reproduce the isolated installed-package smoke (requires bridge port 8765 to be free):

```bash
npm install --prefix /tmp/dsh-packed-consumer ./dsh-chatgpt-web-0.1.1-solis.1.tgz --ignore-scripts --omit=dev --no-audit --no-fund
node test/packed-smoke.mjs /tmp/dsh-packed-consumer
```

The smoke uses a temporary state directory and closes the bridge on exit. It does not sign into or open ChatGPT.

The lockfile pins the verified dependency tree. A successful `npm pack` runs the prepack gates. The tarball contains `lib`, `extension`, the Cordis patch, README, license, and package metadata; it does not contain login state or source-checkout dependencies.

## Local acceptance still required

Use a separate DSH `0.1.7-rc.2` test profile, a separate browser profile, an unused Web port, and no other process owning bridge port 8765. Keep the existing production profile and its port 3080 unchanged.

After initializing the test profile using the installed DSH CLI, install the built tarball:

```bash
dsh plugin --profile chatgpt-web-compat add ./dsh-chatgpt-web-0.1.1-solis.1.tgz
```

Check `dsh web --help` for the supported profile/port flags in that installation before starting it. Load the extension directory from the installed package, not a stale source copy, and sign into ChatGPT in the test browser profile.

Acceptance checklist:

1. Plugin is compatible without an allow-version exemption and offers `chatgpt-web/auto`.
2. Text-only, tools-disabled session A completes multiple turns at one managed URL.
3. Session B gets a different managed URL; switching back resumes A correctly.
4. Restarting DSH restores the mapping and sends only the new suffix.
5. Changing system instructions or history safely rehydrates; it does not silently reuse incompatible context.
6. Stop/abort produces no partial authoritative answer; the next turn handles uncertainty safely.
7. Deleting a managed ChatGPT conversation recovers once before Send.
8. Unsupported attachments/tools fail before browser Send, and displayed errors are understandable.
9. Browser privacy/ownership behavior and answer extraction pass the upstream acceptance scenarios against the current UI.

No current Windows/Chrome/ChatGPT result is implied by the cloud tests. Production installation follows local acceptance.
