import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PROTOCOL,
  canonicalManagedConversationUrl,
  parseExtensionMessage,
  wireGenerateMessage,
} from '../src/protocol.js'

function message(value: Record<string, unknown>): string {
  return JSON.stringify({ protocol: PROTOCOL, ...value })
}

test('parses hello and request-scoped extension messages', () => {
  assert.equal(parseExtensionMessage(message({ type: 'hello', extensionVersion: '0.1.0' })).type, 'hello')
  assert.equal(parseExtensionMessage(message({ type: 'request-state', requestId: 'r1', stage: 'sent', seq: 0 })).type, 'request-state')
  assert.equal(parseExtensionMessage(message({ type: 'session-ready', requestId: 'r1', conversationUrl: 'https://chatgpt.com/c/abc?x=1#y', seq: 1 })).type, 'session-ready')
  assert.equal(parseExtensionMessage(message({ type: 'delta', requestId: 'r1', text: 'hi', seq: 2 })).type, 'delta')
  assert.equal(parseExtensionMessage(message({ type: 'generation-complete', requestId: 'r1', text: 'hi', seq: 3 })).type, 'generation-complete')
  assert.equal(parseExtensionMessage(message({ type: 'generation-aborted', requestId: 'r1', seq: 4 })).type, 'generation-aborted')
  assert.equal(parseExtensionMessage(message({ type: 'error', requestId: 'r1', code: 'DOM', message: 'bad', afterSend: false, seq: 5 })).type, 'error')
  assert.equal(parseExtensionMessage(message({ type: 'pong', nonce: 'n1' })).type, 'pong')
})

test('rejects wrong protocol, missing request id, and invalid sequence', () => {
  assert.throws(() => parseExtensionMessage(JSON.stringify({ protocol: 'v0', type: 'hello', extensionVersion: '0.1.0' })), /unsupported bridge protocol/)
  assert.throws(() => parseExtensionMessage(message({ type: 'delta', text: 'x', seq: 1 })), /requestId/)
  assert.throws(() => parseExtensionMessage(message({ type: 'delta', requestId: 'r1', text: 'x', seq: -1 })), /seq/)
  assert.throws(() => parseExtensionMessage(message({ type: 'delta', requestId: 'r1', text: 'x', seq: 1.5 })), /seq/)
})

test('canonicalizes only plugin-manageable ChatGPT conversation urls', () => {
  assert.equal(canonicalManagedConversationUrl('https://chatgpt.com/c/abc-123?foo=bar#hash'), 'https://chatgpt.com/c/abc-123')
  const generated = wireGenerateMessage({ requestId: 'r', sessionId: 's', conversationUrl: 'https://chatgpt.com/c/a?x=1', prompt: 'p' })
  assert.equal(generated.type, 'generate')
  if (generated.type === 'generate') assert.equal(generated.conversationUrl, 'https://chatgpt.com/c/a')
  assert.throws(() => canonicalManagedConversationUrl('https://example.com/c/abc'), /chatgpt\.com/)
  assert.throws(() => canonicalManagedConversationUrl('https://chatgpt.com/'), /\/c\/<id>/)
  assert.throws(() => canonicalManagedConversationUrl('http://chatgpt.com/c/abc'), /https/)
  assert.throws(() => canonicalManagedConversationUrl('https://chatgpt.com/c/a/extra'), /\/c\/<id>/)
})
