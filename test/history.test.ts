import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ToolCallId,
  createToolResultMessage,
  createAssistantMessage,
  createUserMessage,
  type Message,
} from '@deepseek-ai/dsh-llm'
import {
  historyDigest,
  normalizedMessage,
  serializeHistory,
} from '../src/history.js'

function user(text: string): Message {
  return createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
}

function assistant(text: string): Message {
  return createAssistantMessage({ source: { provider: 'x', model: 'y' }, content: [{ type: 'text', text }] })
}

test('history digest ignores message identity and source metadata', () => {
  const one = user('same')
  const two = user('same')
  assert.notEqual(one.id, two.id)
  assert.equal(historyDigest([one]), historyDigest([two]))
  assert.deepEqual(normalizedMessage(one), normalizedMessage(two))
})

test('history digest changes with semantic content', () => {
  assert.notEqual(historyDigest([user('a')]), historyDigest([user('b')]))
  assert.notEqual(historyDigest([user('a')]), historyDigest([assistant('a')]))

  const callA = createAssistantMessage({
    source: { provider: 'x', model: 'y' },
    content: [{ type: 'tool-call', id: ToolCallId('c1'), name: 'tool', arguments: '{"x":1}' }],
  })
  const callB = createAssistantMessage({
    source: { provider: 'x', model: 'y' },
    content: [{ type: 'tool-call', id: ToolCallId('c1'), name: 'tool', arguments: '{"x":2}' }],
  })
  assert.notEqual(historyDigest([callA]), historyDigest([callB]))
})

test('image blocks fail instead of being flattened', () => {
  const imageMessage = {
    ...user('placeholder'),
    content: [{ type: 'image', attachment: {} }],
  } as unknown as Message
  assert.throws(() => historyDigest([imageMessage]), (error: unknown) => {
    return (error as { code?: unknown }).code === 'CHATGPT_WEB_UNSUPPORTED_IMAGE'
  })
})

test('rehydration serialization preserves text, reasoning, and historical tool context', () => {
  const message = createAssistantMessage({
    source: { provider: 'x', model: 'y' },
    content: [
      { type: 'text', text: 'answer' },
      { type: 'reasoning', text: 'reasoning context' },
      { type: 'tool-call', id: ToolCallId('c1'), name: 'lookup', arguments: '{"q":"x"}' },
    ],
  })
  const result = createToolResultMessage({ callId: ToolCallId('c1'), content: [{ type: 'text', text: 'result' }], isError: false })
  const serialized = serializeHistory([message, result])
  assert.match(serialized, /answer/)
  assert.match(serialized, /reasoning context/)
  assert.match(serialized, /historical-tool-call/)
  assert.match(serialized, /\{"q":"x"\}/)
  assert.match(serialized, /historical-tool-result/)
  assert.match(serialized, /result/)
})
