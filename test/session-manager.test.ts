import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createAssistantMessage, createUserMessage, type Message } from '@deepseek-ai/dsh-llm'
import { SessionManager } from '../src/session-manager.js'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'test-runtime': {
      kind: 'test-runtime'
      form: 'snapshot'
      sections: readonly { name: string; text: string }[]
    }
  }
}

function user(text: string): Message {
  return createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
}

function runtimeContext(text: string): Message {
  return createUserMessage({
    source: {
      kind: 'test-runtime',
      form: 'snapshot',
      sections: [{ name: 'runtime', text }],
    },
    content: [{ type: 'text', text }],
  })
}

function assistant(text: string): Message {
  return createAssistantMessage({ source: { provider: 'chatgpt-web', model: 'auto' }, content: [{ type: 'text', text }] })
}

async function tempState(): Promise<{ directory: string; statePath: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-chatgpt-web-'))
  return { directory, statePath: join(directory, 'state.json') }
}

test('new session uses full context and successful state survives restart', async () => {
  const { statePath } = await tempState()
  const manager = new SessionManager(statePath)
  const firstMessages = [user('hello')]
  const first = await manager.plan('s1', 'system', firstMessages)
  assert.equal(first.kind, 'new')
  assert.match(first.prompt, /System instructions:\nsystem/)
  assert.match(first.prompt, /hello/)

  await manager.commitSuccess('s1', 'system', firstMessages, 'https://chatgpt.com/c/chat-a?x=1', 'world')
  const stored = await manager.get('s1')
  assert.equal(stored?.conversationUrl, 'https://chatgpt.com/c/chat-a')
  assert.equal(stored?.syncedMessageCount, 2)
  assert.equal(stored?.status, 'ready')

  const restarted = new SessionManager(statePath)
  const continued = await restarted.plan('s1', 'system', [user('hello'), assistant('world'), user('again')])
  assert.equal(continued.kind, 'continue')
  if (continued.kind === 'continue') {
    assert.equal(continued.conversationUrl, 'https://chatgpt.com/c/chat-a')
    assert.match(continued.prompt, /again/)
    assert.doesNotMatch(continued.prompt, /world/)
  }
})

test('runtime context after the human turn stays context and does not become the response target', async () => {
  const { statePath } = await tempState()
  const manager = new SessionManager(statePath)
  const snapshot = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.'
  const planned = await manager.plan('s1', 'system', [
    user('Ответь одним словом: первый'),
    runtimeContext(snapshot),
  ])

  assert.equal(planned.kind, 'new')
  assert.match(planned.prompt, /Ответь одним словом: первый/)
  assert.match(planned.prompt, /Current runtime context/)
  assert.match(planned.prompt, /Respond to DSH message 1, the newest human-authored user message/)
  assert.match(planned.prompt, /later user-role plugin or tool messages are context/i)
  assert.doesNotMatch(planned.prompt, /Respond only to the newest DSH user turn\./)
})

test('untrusted history or uncertain state forces rehydration', async () => {
  const { statePath } = await tempState()
  const manager = new SessionManager(statePath)
  await manager.commitSuccess('s1', 'system', [user('a')], 'https://chatgpt.com/c/a', 'b')

  assert.equal((await manager.plan('s1', 'changed', [user('a'), assistant('b'), user('c')])).kind, 'rehydrate')
  assert.equal((await manager.plan('s1', 'system', [user('different'), assistant('b'), user('c')])).kind, 'rehydrate')
  assert.equal((await manager.plan('s1', 'system', [user('a')])).kind, 'rehydrate')

  await manager.markUncertain('s1')
  const uncertain = await manager.get('s1')
  assert.equal(uncertain?.conversationUrl, 'https://chatgpt.com/c/a')
  assert.equal(uncertain?.status, 'uncertain')
  assert.equal((await manager.plan('s1', 'system', [user('a'), assistant('b'), user('c')])).kind, 'rehydrate')
})

test('corrupt state fails closed and is not overwritten', async () => {
  const { statePath } = await tempState()
  await writeFile(statePath, '{broken', 'utf8')
  const manager = new SessionManager(statePath)
  await assert.rejects(manager.plan('s1', undefined, [user('a')]), /state file is corrupt/)
  assert.equal(await readFile(statePath, 'utf8'), '{broken')
})

test('state writes leave no temporary sibling behind', async () => {
  const { directory, statePath } = await tempState()
  const manager = new SessionManager(statePath)
  await manager.commitSuccess('s1', undefined, [user('a')], 'https://chatgpt.com/c/a', 'b')
  const names = await readdir(directory)
  assert.deepEqual(names, ['state.json'])
  const parsed = JSON.parse(await readFile(statePath, 'utf8')) as { version: number }
  assert.equal(parsed.version, 1)
})
