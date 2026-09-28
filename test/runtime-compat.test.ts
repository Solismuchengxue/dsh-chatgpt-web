import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import {
  LlmRuntime, createAssistantMessage, createDeveloperMessage, createSystemMessage, createUserMessage,
  markAgentLoopRequest, type GenerateOptions, type RequestMessage, type StreamChunk, type ContentBlock,
} from '@deepseek-ai/dsh-llm'
import { ChatGptWebAdapter } from '../src/adapter.js'
import type { ChatTransport, GenerateRequest } from '../src/protocol.js'
import { RequestQueue } from '../src/request-queue.js'
import { SessionManager } from '../src/session-manager.js'
import { installRuntime } from '../src/index.js'

const user = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
const assistant = (text: string) => createAssistantMessage({ source: { provider: 'chatgpt-web', model: 'auto' }, content: [{ type: 'text', text }] })

test('real DSH runtime preserves separate sessions, continuation and restart with loop-shaped requests', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-runtime-'))
  const ctx = new Context()
  const runtime = ctx.plugin(LlmRuntime)
  const requests: GenerateRequest[] = []
  let newChats = 0
  const transport: ChatTransport = {
    async *generate(request) {
      requests.push(request)
      const url = request.conversationUrl ?? `https://chatgpt.com/c/chat-${++newChats}`
      yield { type: 'session-ready', requestId: request.requestId, conversationUrl: url, seq: 0 }
      yield { type: 'complete', requestId: request.requestId, text: 'reply', seq: 1 }
    },
    async abort() {}, async dispose() {},
  }
  const adapter = () => new ChatGptWebAdapter({
    transport, sessions: new SessionManager(join(directory, 'state.json')), queue: new RequestQueue(),
  })
  try {
    await runtime.await()
    let unregister = ctx.llm.registerAdapter(['chatgpt-web'], adapter())
    const run = async (sessionId: string, messages: RequestMessage[], overrides: Partial<GenerateOptions> = {}) => {
      const request = markAgentLoopRequest({
        provider: 'chatgpt-web', model: 'auto', sessionId: sessionId as never,
        messages, tools: [], toolHistory: { tools: [], updates: [] }, ...overrides,
      })
      const prepared = await ctx.llm.prepareCall({ provider: 'chatgpt-web', model: 'auto' })
      const chunks: StreamChunk[] = []
      for await (const chunk of prepared.stream(request)) chunks.push(chunk)
      return chunks
    }
    const messages = [createSystemMessage('policy'), user('first')]
    for (const sessionId of ['a', 'b']) {
      const chunks = await run(sessionId, messages)
      assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
    }
    assert.equal(newChats, 2)
    assert.match(requests[0]!.prompt, /System instructions:\npolicy/)
    unregister()
    unregister = ctx.llm.registerAdapter(['chatgpt-web'], adapter())
    const history = [...messages, assistant('reply'), user('second')]
    const chunks = await run('a', history)
    assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
    assert.equal(requests[2]!.conversationUrl, 'https://chatgpt.com/c/chat-1')
    assert.match(requests[2]!.prompt, /second/)
    assert.doesNotMatch(requests[2]!.prompt, /first|reply|policy/)
    assert.equal(newChats, 2)
    const rejected = await run('a', history, { tools: [{ name: 'bash', description: 'shell', parameters: { type: 'object' } }] })
    const finish = rejected.at(-1)
    assert.equal(finish?.type, 'finish')
    if (finish?.type === 'finish') {
      assert.equal(finish.reason.kind, 'error')
      if (finish.reason.kind === 'error') assert.equal(finish.reason.failure.code, 'CHATGPT_WEB_UNSUPPORTED')
    }
    assert.equal(requests.length, 3)
    unregister()
  } finally {
    await ctx.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('installed plugin preserves developer text and rejects unsupported inputs before runtime projection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-projection-'))
  const ctx = new Context()
  const runtime = ctx.plugin(LlmRuntime)
  const requests: GenerateRequest[] = []
  const transport: ChatTransport = {
    async *generate(request) {
      requests.push(request)
      yield { type: 'session-ready', requestId: request.requestId, conversationUrl: `https://chatgpt.com/c/${request.sessionId}`, seq: 0 }
      yield { type: 'complete', requestId: request.requestId, text: 'reply', seq: 1 }
    },
    async abort() {}, async dispose() {},
  }
  try {
    await runtime.await()
    const adapter = new ChatGptWebAdapter({ transport, sessions: new SessionManager(join(directory, 'state.json')), queue: new RequestQueue() })
    await installRuntime(ctx, { adapter, transport,
      bridge: { async start() { return { host: '127.0.0.1', port: 8765 } } },
      extensionDirectory: '/test/extension', expectedOrigin: 'test',
    })
    const run = async (messages: RequestMessage[], sessionId = 'projection') => {
      const request = markAgentLoopRequest(Object.freeze({
        provider: 'chatgpt-web', model: 'auto', sessionId: sessionId as never,
        messages, tools: [], toolHistory: { tools: [], updates: [] },
      }))
      const prepared = await ctx.llm.prepareCall({ provider: 'chatgpt-web', model: 'auto' })
      const chunks: StreamChunk[] = []
      for await (const chunk of prepared.stream(request)) chunks.push(chunk)
      return chunks
    }
    const developer = createDeveloperMessage({ source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'Developer context survives.' }] })
    await run([createSystemMessage('policy'), user('question'), developer])
    assert.match(requests[0]!.prompt, /role=developer/)
    assert.match(requests[0]!.prompt, /Developer context survives\./)
    assert.match(requests[0]!.prompt, /Respond to DSH message 1,/)
    for (const block of [
      { type: 'image', attachment: { id: 'image', mimeType: 'image/png', width: 1, height: 1, byteLength: 1 } },
      { type: 'file', attachment: { id: 'file', name: 'a.txt', mimeType: 'text/plain', byteLength: 1 } },
      { type: 'tool-addition', toolName: 'bash' },
      { type: 'tool-removal', toolName: 'bash' },
    ]) {
      const message = block.type.startsWith('tool-')
        ? { ...developer, content: [block as ContentBlock] }
        : { ...user(''), content: [block as ContentBlock] }
      const chunks = await run([message])
      const finish = chunks.at(-1)
      assert.equal(finish?.type, 'finish')
      if (finish?.type === 'finish') {
        assert.equal(finish.reason.kind, 'error')
        if (finish.reason.kind === 'error') assert.equal(finish.reason.failure.code,
          block.type === 'image' ? 'CHATGPT_WEB_UNSUPPORTED_IMAGE' : 'CHATGPT_WEB_UNSUPPORTED')
      }
    }
    assert.equal(requests.length, 1)
    await Promise.all(['alpha', 'beta'].map(name => run([
      createSystemMessage(`system-${name}`), user(`human-${name}`),
      createDeveloperMessage({ source: { kind: 'system-prompt' }, content: [{ type: 'text', text: `context-${name}` }] }),
    ], name)))
    assert.equal(requests.length, 3)
    for (const name of ['alpha', 'beta']) {
      const prompt = requests.find(request => request.sessionId === name)!.prompt
      assert.match(prompt, new RegExp(`system-${name}`))
      assert.match(prompt, new RegExp(`context-${name}`))
      assert.doesNotMatch(prompt, new RegExp(name === 'alpha' ? 'beta' : 'alpha'))
    }
    // A direct call after middleware completion must not inherit any captured request.
    for await (const _ of adapter.stream({ provider: 'chatgpt-web', model: 'auto', sessionId: 'direct' as never,
      messages: [user('only-direct')],
    })) { /* exhaust */ }
    assert.match(requests[3]!.prompt, /only-direct/)
    assert.doesNotMatch(requests[3]!.prompt, /alpha|beta|Developer context/)
  } finally {
    await ctx.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
