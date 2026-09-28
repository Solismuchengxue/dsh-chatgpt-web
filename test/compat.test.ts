import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  createAssistantMessage, createDeveloperMessage, createSystemMessage,
  createToolResultMessage, createUserMessage, ToolCallId,
  type ContentBlock, type GenerateOptions, type Message,
} from '@deepseek-ai/dsh-llm'
import { ChatGptWebAdapter } from '../src/adapter.js'
import { historyDigest, serializeHistory } from '../src/history.js'
import { RequestQueue } from '../src/request-queue.js'
import { SessionManager } from '../src/session-manager.js'
import type { ChatTransport } from '../src/protocol.js'

const user = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
const assistant = (text: string) => createAssistantMessage({ source: { provider: 'chatgpt-web', model: 'auto' }, content: [{ type: 'text', text }] })
const unsupported = (error: unknown) => (error as { code?: string }).code === 'CHATGPT_WEB_UNSUPPORTED'
async function sessions() {
  return new SessionManager(join(await mkdtemp(join(tmpdir(), 'dsh-compat-')), 'state.json'))
}

test('leading system prompt occupies the instruction slot and survives restart without replaying history', async () => {
  const manager = await sessions()
  const messages = [createSystemMessage('Be concise.'), user('hello')]
  const first = await manager.plan('s1', undefined, messages)
  assert.match(first.prompt, /System instructions:\nBe concise\./)
  assert.doesNotMatch(first.prompt, /role=system/)
  assert.match(first.prompt, /Respond to DSH message 1,/)
  await manager.commitSuccess('s1', undefined, messages, 'https://chatgpt.com/c/first', 'world')
  const state = await manager.get('s1')
  assert.equal(state?.syncedMessageCount, 2)
  const restarted = new SessionManager(manager.statePath)
  const continued = await restarted.plan('s1', undefined, [...messages, assistant('world'), user('again')])
  assert.equal(continued.kind, 'continue')
  if (continued.kind === 'continue') assert.equal(continued.conversationUrl, 'https://chatgpt.com/c/first')
  assert.match(continued.prompt, /again/)
  assert.doesNotMatch(continued.prompt, /Be concise|hello|world/)
  const changed = await restarted.plan('s1', undefined, [createSystemMessage('Use Japanese.'), user('hello'), assistant('world'), user('again')])
  assert.equal(changed.kind, 'rehydrate')
  assert.match(changed.prompt, /System instructions:\nUse Japanese\./)
})

test('equivalent explicit and leading system prompts share a cache, and combined prompts preserve order', async () => {
  const manager = await sessions()
  await manager.commitSuccess('s1', 'policy', [user('a')], 'https://chatgpt.com/c/a', 'b')
  assert.equal((await manager.plan('s1', undefined, [createSystemMessage('policy'), user('a'), assistant('b'), user('c')])).kind, 'continue')
  const combined = await manager.plan('s2', 'outer', [createSystemMessage('inner'), createSystemMessage('last'), user('a')])
  assert.match(combined.prompt, /System instructions:\nouter\n\ninner\n\nlast/)
  const blank = await manager.plan('s3', undefined, [createSystemMessage(''), user('a')])
  assert.match(blank.prompt, /System instructions:\n\(none\)/)
})

test('unsupported one-shot input fails before browser dispatch or persistent state changes', async () => {
  const manager = await sessions()
  let sends = 0
  const transport: ChatTransport = {
    async *generate() { sends += 1; throw new Error('must not dispatch') },
    async abort() {}, async dispose() {},
  }
  const adapter = new ChatGptWebAdapter({ transport, sessions: manager, queue: new RequestQueue() })
  await assert.rejects(async () => {
    for await (const _ of adapter.stream({ provider: 'chatgpt-web', model: 'auto', sessionId: 's1' as never,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'one-shot' }] }],
    })) { /* exhaust */ }
  }, unsupported)
  assert.equal(sends, 0)
  assert.equal(await manager.get('s1'), undefined)
  await assert.rejects(readFile(manager.statePath), { code: 'ENOENT' })
})

test('non-leading system messages and non-text system blocks fail closed', async () => {
  const manager = await sessions()
  await assert.rejects(manager.plan('s1', undefined, [user('a'), createSystemMessage('late')]), unsupported)
  const reasoningSystem = { ...createSystemMessage(''), content: [{ type: 'reasoning', text: 'policy' }] } as Message
  await assert.rejects(manager.plan('s1', undefined, [reasoningSystem, user('a')]), unsupported)
})

test('first-class tool results preserve call correlation and failure status in prompts and digests', () => {
  const result = (id: string, isError: boolean) => createToolResultMessage({
    callId: ToolCallId(id), isError, content: [{ type: 'text', text: 'historical result' }],
  })
  assert.notEqual(historyDigest([result('a', false)]), historyDigest([result('b', false)]))
  assert.notEqual(historyDigest([result('a', false)]), historyDigest([result('a', true)]))
  const prompt = serializeHistory([result('a', true)])
  assert.match(prompt, /role=tool/)
  assert.match(prompt, /historical-tool-result callId="a" isError=true/)
  assert.match(prompt, /historical result/)
})

test('developer text stays context after the newest human request', async () => {
  const manager = await sessions()
  const planned = await manager.plan('s1', undefined, [user('question'), createDeveloperMessage({
    source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'runtime context' }],
  })])
  assert.match(planned.prompt, /role=developer/)
  assert.match(planned.prompt, /runtime context/)
  assert.match(planned.prompt, /Respond to DSH message 1,/)
})

test('changing human attribution invalidates a previously synchronized prefix', async () => {
  const manager = await sessions()
  const context = createUserMessage({ source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'a' }] })
  assert.notEqual(historyDigest([user('a')]), historyDigest([context]))
  await manager.commitSuccess('s1', undefined, [user('a')], 'https://chatgpt.com/c/a', 'b')
  assert.equal((await manager.plan('s1', undefined, [context, assistant('b'), user('c')])).kind, 'rehydrate')
})

test('file and dynamic tool blocks fail in both hashing and prompt serialization', () => {
  for (const block of [
    { type: 'file', attachment: {} },
    { type: 'tool-addition', toolName: 'bash' },
    { type: 'tool-removal', toolName: 'bash' },
    { type: 'future-block' },
  ]) {
    const message = { ...user(''), content: [block] } as unknown as Message
    assert.throws(() => historyDigest([message]), unsupported)
    assert.throws(() => serializeHistory([message]), unsupported)
  }
})

test('active tool declarations and tool history fail before browser dispatch', async () => {
  const manager = await sessions()
  let sends = 0
  const transport: ChatTransport = {
    async *generate() { sends += 1; throw new Error('must not dispatch') },
    async abort() {}, async dispose() {},
  }
  const adapter = new ChatGptWebAdapter({ transport, sessions: manager, queue: new RequestQueue() })
  for (const overrides of [
    { tools: [{ name: 'bash', description: 'shell', parameters: { type: 'object' } }] },
    { toolHistory: { tools: [{ name: 'bash', description: 'shell', parameters: { type: 'object' } }], updates: [] } },
    { toolHistory: { tools: [], updates: [{ messageId: user('update').id, additions: [] }] } },
  ] satisfies Partial<GenerateOptions>[]) {
    await assert.rejects(async () => {
      for await (const _ of adapter.stream({ provider: 'chatgpt-web', model: 'auto', sessionId: 's1' as never,
        messages: [user('a')], ...overrides,
      })) { /* exhaust */ }
    }, unsupported)
  }
  assert.equal(sends, 0)
  assert.equal(await manager.get('s1'), undefined)
})

test('unsupported continuation content is rejected without altering a ready mapping', async () => {
  const manager = await sessions()
  await manager.commitSuccess('s1', undefined, [user('a')], 'https://chatgpt.com/c/a', 'b')
  const before = await readFile(manager.statePath, 'utf8')
  const invalid = { ...user(''), content: [{ type: 'file', attachment: {} } as ContentBlock] }
  await assert.rejects(manager.plan('s1', undefined, [user('a'), assistant('b'), invalid]), unsupported)
  assert.equal(await readFile(manager.statePath, 'utf8'), before)
})
