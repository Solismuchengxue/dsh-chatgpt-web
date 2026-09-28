import assert from 'node:assert/strict'
import { isAbsolute } from 'node:path'
import test from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { ChatGptWebAdapter } from '../src/adapter.js'
import { EXTENSION_ORIGIN, EXTENSION_PUBLIC_KEY, extensionOriginFromManifestKey } from '../src/extension-identity.js'
import {
  BRIDGE_HOST,
  BRIDGE_PORT,
  installRuntime,
  resolveExtensionDirectory,
  type RuntimeAssembly,
} from '../src/index.js'
import type { ChatTransport } from '../src/protocol.js'
import { RequestQueue } from '../src/request-queue.js'
import { SessionManager } from '../src/session-manager.js'

const noopTransport: ChatTransport = {
  async *generate() {},
  async abort() {},
  async dispose() {},
}

test('production bridge constants and extension path are deterministic', () => {
  assert.equal(BRIDGE_HOST, '127.0.0.1')
  assert.equal(BRIDGE_PORT, 8765)
  const directory = resolveExtensionDirectory()
  assert.equal(isAbsolute(directory), true)
  assert.match(directory, /[\\/]extension$/)
  assert.equal(EXTENSION_ORIGIN, extensionOriginFromManifestKey(EXTENSION_PUBLIC_KEY))
})

test('plugin lifecycle registers exactly chatgpt-web, logs setup, and disposes transport', async () => {
  const routes: string[][] = []
  const logs: string[] = []
  const disposers: Array<() => void | Promise<void>> = []
  let disposed = 0

  const transport: ChatTransport = {
    async *generate() {},
    async abort() {},
    async dispose() { disposed += 1 },
  }
  const adapter = new ChatGptWebAdapter({
    transport: noopTransport,
    sessions: new SessionManager('/tmp/dsh-chatgpt-web-index-test-state.json'),
    queue: new RequestQueue(),
  })
  const runtime: RuntimeAssembly = {
    bridge: { async start() { return { host: '127.0.0.1', port: 8765 } } },
    transport,
    adapter,
    extensionDirectory: '/absolute/package/extension',
    expectedOrigin: EXTENSION_ORIGIN,
  }

  const ctx = {
    llm: {
      registerAdapter(routeList: string[]) {
        routes.push(routeList)
        return () => {}
      },
    },
    logger: {
      info(message: string) { logs.push(message) },
    },
    effect(factory: () => () => void | Promise<void>) {
      disposers.push(factory())
    },
    on() {},
  } as unknown as Context

  await installRuntime(ctx, runtime)
  assert.deepEqual(routes, [['chatgpt-web']])
  assert.match(logs.join('\n'), /ws:\/\/127\.0\.0\.1:8765/)
  assert.match(logs.join('\n'), /\/absolute\/package\/extension/)
  assert.equal(disposers.length, 1)
  await disposers[0]?.()
  assert.equal(disposed, 1)
})
