import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { ChatGptWebAdapter, CHATGPT_WEB_PROVIDER } from './adapter.js'
import { BridgeServer } from './bridge-server.js'
import { EXTENSION_ORIGIN } from './extension-identity.js'
import type { ChatTransport } from './protocol.js'
import { RequestQueue } from './request-queue.js'
import { SessionManager } from './session-manager.js'
import { ExternalChromeTransport } from './transport.js'

export const name = 'dsh-chatgpt-web'
export const inject = ['llm']

export const BRIDGE_HOST = '127.0.0.1' as const
export const BRIDGE_PORT = 8765

export interface RuntimeAssembly {
  bridge: {
    start(): Promise<{ host: string; port: number }>
  }
  transport: ChatTransport
  adapter: ChatGptWebAdapter
  extensionDirectory: string
  expectedOrigin: string
}

export function resolveExtensionDirectory(moduleUrl = import.meta.url): string {
  return resolve(fileURLToPath(new URL('../extension/', moduleUrl)))
}

export function createRuntimeAssembly(): RuntimeAssembly {
  const bridge = new BridgeServer({
    host: BRIDGE_HOST,
    port: BRIDGE_PORT,
    expectedOrigin: EXTENSION_ORIGIN,
  })
  const transport = new ExternalChromeTransport(bridge)
  const sessions = new SessionManager()
  const queue = new RequestQueue()
  const adapter = new ChatGptWebAdapter({ transport, sessions, queue })
  return {
    bridge,
    transport,
    adapter,
    extensionDirectory: resolveExtensionDirectory(),
    expectedOrigin: EXTENSION_ORIGIN,
  }
}

export async function installRuntime(ctx: Context, runtime: RuntimeAssembly): Promise<void> {
  const address = await runtime.bridge.start()
  ctx.effect(() => () => runtime.transport.dispose())
  ctx.llm.registerAdapter([CHATGPT_WEB_PROVIDER], runtime.adapter)
  ctx.on('llm/stream', (options, next) => options.provider === CHATGPT_WEB_PROVIDER
    ? runtime.adapter.withRequestContext(options, next)
    : next())

  ctx.logger.info(`[dsh-chatgpt-web] bridge listening on ws://${address.host}:${address.port}`)
  ctx.logger.info(`[dsh-chatgpt-web] Chrome extension directory: ${runtime.extensionDirectory}`)
  ctx.logger.info(`[dsh-chatgpt-web] expected Chrome extension origin: ${runtime.expectedOrigin}`)
}

export async function apply(ctx: Context): Promise<void> {
  await installRuntime(ctx, createRuntimeAssembly())
}

export { ChatGptWebAdapter } from './adapter.js'
export { BridgeServer } from './bridge-server.js'
export { EXTENSION_ID, EXTENSION_ORIGIN, EXTENSION_PUBLIC_KEY } from './extension-identity.js'
export { SessionManager } from './session-manager.js'
export { ExternalChromeTransport } from './transport.js'
