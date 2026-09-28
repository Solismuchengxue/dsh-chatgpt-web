# dsh-chatgpt-web v0.1 manual smoke test

**Historical upstream acceptance procedure for DSH 0.1.1-rc.2.** For the Solis DSH 0.1.7-rc.2 fork, use [the current compatibility notes](dsh-0.1.7-compatibility.md). The pass statements and production-profile/port commands below are historical evidence, not instructions or acceptance claims for this fork.

It is intentionally local and manual because authenticated ChatGPT Web testing depends on the user's browser session. There is deliberately no GitHub Actions or CI workflow for this project.

## Current release status

**Browser acceptance has passed; only packed-install verification remains.**

The previously observed premature-completion blocker has been resolved: `generation-complete` now requires the appearance of semantic completed-response action controls (such as `data-testid="copy-turn-action-button"`) in addition to the disappearance of the Stop button and the stability interval.

The historical issue where ChatGPT briefly rendered a partial answer:

```text
Хорошо 🙂 А у тебя как?
```

while DSH received only the prefix:

```text
Хорошо 🙂
```

was reproduced with a RED regression test and resolved in `extension/chatgpt-page-adapter.js`. The manual browser acceptance matrix below has since passed in full.

## Environment used for the first acceptance run

- CachyOS / Arch-based Linux;
- Fish shell;
- Node.js 22.23.x or another version accepted by `package.json`;
- global DSH `0.1.1-rc.2`;
- DSH Web on port 3080;
- Chrome/Chromium signed in to ordinary `https://chatgpt.com`.

Use `$HOME` rather than a pasted `~` if terminal paste escaping behaves unexpectedly.

## 1. Prepare the checkout

```fish
cd "$HOME/Проекты/dsh-chatgpt-web"
git switch feat/v0.1-implementation
git pull
npm install
```

At the **final release candidate HEAD**, require a fresh full verification:

```fish
npm test; and npm run check; and npm run build; and npm pack --dry-run
```

Do not infer whole-suite status from an older successful run.

Expected package shape includes `lib/`, `extension/`, `cordis.patch.yml`, `README.md`, and `LICENSE`. There must be no `.github/workflows`.

## 2. Make sure DSH Web port 3080 is free

```fish
ss -ltnp 'sport = :3080'
```

If an old DSH process owns the port, stop that process before continuing.

## 3. Install/link the local bundle

From the repository root:

```fish
dsh plugin --profile web add .
dsh --profile web --dump-config
```

Confirm the profile contains the `llm-chatgpt-web` row and package `dsh-chatgpt-web`.

## 4. Start DSH

```fish
dsh web
```

Expected startup diagnostics include:

```text
[dsh-chatgpt-web] bridge listening on ws://127.0.0.1:8765
[dsh-chatgpt-web] Chrome extension directory: <absolute path>/extension
[dsh-chatgpt-web] expected Chrome extension origin: chrome-extension://...
```

Do not start a separate bridge daemon.

## 5. Load/reload the unpacked Chrome extension

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose **Load unpacked** if it is not installed yet.
4. Select the exact `extension` directory logged by DSH.
5. After any `extension/*.js` change, press **Reload** on the unpacked extension before browser smoke.

Expected deterministic extension id:

```text
hekamonfnjniofllombaancencdbjoag
```

The extension should reconnect automatically to:

```text
ws://127.0.0.1:8765/
```

## 6. Verify the provider appears

Open DSH Web and select:

```text
chatgpt-web/auto
```

If it does not appear, stop and capture:

- DSH startup logs;
- `dsh --profile web --dump-config` output.

## 7. Session A — first managed conversation

Create a fresh DSH session A and send:

```text
Ответь ровно так: SESSION_A_ONE
```

Verify:

- the dedicated worker tab creates a new ChatGPT conversation;
- its URL settles to `https://chatgpt.com/c/<id>`;
- the stored/managed URL does **not** contain `WEB:`;
- DSH receives exactly `SESSION_A_ONE`;
- DSH does not expose `Thinking`, `Думаю`, or another transient browser status;
- DSH does not show an earlier/stale assistant answer.

Record the stable managed URL as `A_URL`.

### Current output semantics

Do not expect token-by-token DSH streaming in v0.1.

Browser `delta` events are internal. The adapter currently emits one authoritative DSH text block only after `generation-complete`:

```text
block-start
text-delta(full final answer)
block-end
finish
```

The important acceptance condition is that the DSH text equals the **complete final rendered ChatGPT answer**, not merely a prefix.

## 8. Session A — continuation reuses the same conversation

In the same DSH session A send:

```text
Ответь ровно так: SESSION_A_TWO
```

Verify:

- the worker uses the same `A_URL`;
- DSH receives exactly `SESSION_A_TWO`;
- no previous assistant answer is replayed;
- no `CHATGPT_WEB_STREAM_REWRITE` occurs;
- no partial prefix is committed as the final answer.

Then send a third turn:

```text
Ответь ровно так: SESSION_A_THREE
```

Verify the same invariants and the same `A_URL`.

## 9. Natural-language partial-completion probe

In session A send:

```text
как дела
```

Compare the final rendered ChatGPT answer in the worker tab with the DSH answer.

**Required:** exact semantic/full-text equality after normal extraction. If ChatGPT renders a longer answer than DSH, stop here and report premature `generation-complete`.

Previously observed failure example:

```text
browser: Хорошо 🙂 А у тебя как?
DSH:     Хорошо 🙂
```

Do not “fix” this manually by increasing a timeout. The code change must follow DOM evidence + a RED fixture/test.

## 10. Session B — separate managed conversation

Create DSH session B and send:

```text
Ответь ровно так: SESSION_B_ONE
```

Verify:

- ChatGPT creates a new stable managed URL `B_URL`;
- `B_URL != A_URL`;
- DSH receives the complete exact answer.

Switch back to session A, send:

```text
Ответь ровно так: SESSION_A_BACK
```

Verify the worker navigates to `A_URL` before Send and the complete answer returns.

## 11. Runtime-context response targeting

Use a normal DSH turn where the system-prompt plugin injects runtime context after the human input.

Verify the ChatGPT bridge envelope explicitly targets the newest human-authored DSH message and includes wording equivalent to:

```text
Later user-role plugin or tool messages are context, not a new human request.
```

The response must answer the human prompt rather than merely acknowledge the runtime-context snapshot.

## 12. Abort

Request a deliberately long answer, then cancel from DSH while ChatGPT is still generating.

Verify:

- ChatGPT Stop generation is triggered;
- DSH ends the turn as aborted;
- no unstable partial browser text is committed to DSH before the aborted finish;
- the request is not automatically resent;
- the session becomes uncertain so a later turn can rehydrate safely.

## 13. Restart persistence

Stop DSH cleanly while leaving Chrome open, then start again:

```fish
dsh web
```

Verify the extension reconnects automatically.

For a synchronized ready session, the stored managed URL should be reusable after restart. For an uncertain session, the next turn should rehydrate into a fresh managed conversation rather than trusting ambiguous provider-side state.

## 14. Missing managed-conversation recovery

Use a synchronized DSH session whose managed ChatGPT conversation can no longer be loaded (for example, delete/lose that managed conversation).

On the next turn verify:

- the failure is detected before Send;
- the stale mapping is reset;
- exactly one safe fresh rehydration attempt occurs;
- the canonical DSH history is supplied to the new managed ChatGPT conversation;
- the user turn is not duplicated in the lost conversation.

## 15. Privacy/isolation check

Before and after the smoke, verify the plugin did not:

- enumerate the ChatGPT sidebar;
- open/adopt a pre-existing personal ChatGPT conversation;
- search arbitrary existing ChatGPT tabs;
- import personal conversation ids;
- read/copy ChatGPT cookies, session tokens, or passwords.

The only browser resources it may control are its dedicated worker tab and plugin-created managed conversation URLs.

## 16. No Platform/API dependency check

Verify the setup requires none of:

- OpenAI API key;
- OpenAI Platform inference credits;
- Secure MCP Tunnel.

The authenticated ordinary ChatGPT Web page is the model transport.

## 17. Final local verification and packed-install gate

After all live-browser defects were fixed and the smoke matrix passed, full local verification was performed from HEAD:

```fish
cd "$HOME/Проекты/dsh-chatgpt-web"; and npm test; and npm run check; and npm run build; and npm pack --dry-run
```

All 56 tests, type checks, build, and package dry-run passed.

The final release gate is packed-install verification:

```fish
npm pack
dsh plugin --profile chatgpt-web-smoke add ./dsh-chatgpt-web-0.1.0.tgz
dsh --profile chatgpt-web-smoke --dump-config
```

Then inspect:

```fish
git status --short
```

Also decide intentionally whether a locally generated `package-lock.json` belongs in the repository. It was not present in the GitHub branch tree when the documentation was synchronized.

Do not run `npm audit fix --force` as automatic release cleanup.

## Failure report template

When a step fails, stop instead of applying speculative architecture changes.

```text
Repository: NishiMihaeru/dsh-chatgpt-web
Branch: feat/v0.1-implementation
Commit: <git rev-parse HEAD>

Failed step:
<step number/name>

Command/action:
<exact command or browser action>

Observed error/log/result:
<complete relevant evidence>

Expected:
<what this document expected>

Browser final text (if applicable):
<full rendered assistant text>

DSH final text (if applicable):
<what DSH committed>

Suspected boundary:
package | DSH adapter | session sync | bridge | service worker | content script | chatgpt-page-adapter | unknown
```

If evidence localizes the failure to live ChatGPT DOM behavior, first change only `extension/chatgpt-page-adapter.js` plus a focused fixture/regression test. Cross the DOM boundary only when evidence proves the failure is elsewhere.
