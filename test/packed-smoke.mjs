import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

if (!process.argv[2]) throw new Error('Usage: node test/packed-smoke.mjs <isolated npm install directory>')
const consumer = createRequire(join(resolve(process.argv[2]), 'package.json'))
const load = name => import(pathToFileURL(consumer.resolve(name)).href)
const { Context } = await load('@deepseek-ai/cordis')
const { LlmRuntime, createSystemMessage, createUserMessage, createDeveloperMessage, createAssistantMessage } = await load('@deepseek-ai/dsh-llm')
const WebSocket = consumer('ws')

const temporary = await mkdtemp(join(tmpdir(), 'dsh-packed-state-'))
process.env.XDG_DATA_HOME = temporary
const plugin = await load('dsh-chatgpt-web')
const ctx = new Context()
let socket
const requests = []
const protocol = 'dsh-chatgpt-web-v1'
try {
  await ctx.plugin(LlmRuntime).await()
  const runtime = plugin.createRuntimeAssembly()
  await plugin.installRuntime(ctx, runtime)
  socket = new WebSocket('ws://127.0.0.1:8765', { origin: plugin.EXTENSION_ORIGIN })
  await once(socket, 'open')
  socket.on('message', raw => {
    const request = JSON.parse(raw.toString())
    if (request.type === 'ping') socket.send(JSON.stringify({ protocol, type: 'pong', nonce: request.nonce }))
    if (request.type !== 'generate') return
    requests.push(request)
    socket.send(JSON.stringify({ protocol, type: 'session-ready', requestId: request.requestId,
      conversationUrl: request.conversationUrl ?? 'https://chatgpt.com/c/packed-test', seq: 0 }))
    socket.send(JSON.stringify({ protocol, type: 'generation-complete', requestId: request.requestId,
      text: 'packed reply', seq: 1 }))
  })
  socket.send(JSON.stringify({ protocol, type: 'hello', extensionVersion: '0.1.0' }))
  for (let tries = 0; !runtime.bridge.isConnected() && tries < 100; tries++) await new Promise(r => setTimeout(r, 5))
  assert.equal(runtime.bridge.isConnected(), true)
  assert.equal((await ctx.llm.listModels('chatgpt-web'))[0].id, 'auto')
  const messages = [createSystemMessage('packed policy'),
    createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'packed question' }] }),
    createDeveloperMessage({ source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'packed developer' }] }),
  ]
  const run = async messages => {
    const chunks = []
    for await (const chunk of ctx.llm.stream({ provider: 'chatgpt-web', model: 'auto', sessionId: 'packed-session',
      messages, tools: [], toolHistory: { tools: [], updates: [] } })) chunks.push(chunk)
    assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
    assert.equal(chunks.find(chunk => chunk.type === 'text-delta').text, 'packed reply')
  }
  await run(messages)
  await run([...messages, createAssistantMessage({ source: { provider: 'chatgpt-web', model: 'auto' }, content: [{ type: 'text', text: 'packed reply' }] }),
    createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'second question' }] }),
  ])
  assert.match(requests[0].prompt, /packed policy/)
  assert.match(requests[0].prompt, /packed developer/)
  assert.equal(requests[1].conversationUrl, 'https://chatgpt.com/c/packed-test')
  assert.match(requests[1].prompt, /second question/)
  assert.doesNotMatch(requests[1].prompt, /packed question|packed reply|packed developer/)
  const manifest = JSON.parse(await readFile(join(runtime.extensionDirectory, 'manifest.json'), 'utf8'))
  assert.equal(manifest.manifest_version, 3)
  console.log(JSON.stringify({ result: 'PASS', sourceCheckoutRequired: false, realRuntime: true, realLoopbackBridge: true,
    browser: 'simulated WebSocket extension', turns: requests.length, reusedUrl: requests[1].conversationUrl,
    extensionPackaged: true }))
} finally {
  socket?.close()
  await ctx.fiber.dispose()
  await rm(temporary, { recursive: true, force: true })
}
