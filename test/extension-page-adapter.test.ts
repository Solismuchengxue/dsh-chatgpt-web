import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { Window, type Element } from 'happy-dom'

interface PageAdapter {
  isReady(): boolean
  waitForManagedConversation(expectedUrl: string, timeoutMs?: number): Promise<void>
  sendMessage(text: string, options?: { isAborted?: () => boolean; beforeSend?: () => void | Promise<void>; sendTimeoutMs?: number }): Promise<{ assistantCount: number; assistantText: string }>
  observeGeneration(options?: { baseline?: { assistantCount: number; assistantText: string }; onUpdate?: (update: { text: string; append: boolean; delta: string }) => void; startTimeoutMs?: number; completionStabilityMs?: number; overallTimeoutMs?: number }): Promise<string>
  stopGeneration(): boolean
  getConversationUrl(raw?: string): string | null
}

const source = await readFile(new URL('../extension/chatgpt-page-adapter.js', import.meta.url), 'utf8')

async function fixture(name: string, url = 'https://chatgpt.com/'): Promise<{ window: Window; adapter: PageAdapter }> {
  const html = await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
  const window = new Window({ url })
  window.document.write(html)
  window.eval(source)
  const adapter = (window as unknown as { __DSH_CHATGPT_PAGE_ADAPTER__: PageAdapter }).__DSH_CHATGPT_PAGE_ADAPTER__
  return { window, adapter }
}

function appendResponseActions(window: Window, turn: Element): void {
  const copy = window.document.createElement('button')
  copy.setAttribute('data-testid', 'copy-turn-action-button')
  turn.append(copy)
}

test('page adapter detects composer and accepts only managed conversation URLs', async () => {
  const { adapter } = await fixture('chatgpt-ready.html', 'https://chatgpt.com/c/abc?x=1#hash')
  assert.equal(adapter.isReady(), true)
  assert.equal(adapter.getConversationUrl(), 'https://chatgpt.com/c/abc')
  assert.equal(adapter.getConversationUrl('https://chatgpt.com/c/WEB:844a3154-d7da-4e73-a05c-8c565c9393a4'), null)
  assert.equal(adapter.getConversationUrl('https://chatgpt.com/'), null)
  assert.equal(adapter.getConversationUrl('https://example.com/c/abc'), null)
})

test('managed conversation readiness requires the expected URL and loaded history', async () => {
  const { window, adapter } = await fixture('chatgpt-ready.html', 'https://chatgpt.com/c/abc')
  const waiting = adapter.waitForManagedConversation('https://chatgpt.com/c/abc', 250)
  setTimeout(() => {
    const turn = window.document.createElement('article')
    turn.setAttribute('data-turn', 'user')
    turn.textContent = 'existing managed history'
    window.document.body.append(turn)
  }, 20)
  await waiting

  await assert.rejects(
    adapter.waitForManagedConversation('https://chatgpt.com/c/different', 30),
    error => (error as { code?: unknown }).code === 'CHATGPT_CONVERSATION_MISSING',
  )
})

test('sendMessage publishes the sent boundary before clicking Send', async () => {
  const { window, adapter } = await fixture('chatgpt-ready.html')
  const order: string[] = []
  window.document.querySelector('button')?.addEventListener('click', () => { order.push('click') })
  await adapter.sendMessage('hello from DSH', { beforeSend: () => { order.push('boundary') } })
  assert.match(window.document.querySelector('#prompt-textarea')?.textContent ?? '', /hello from DSH/)
  assert.deepEqual(order, ['boundary', 'click'])
})

test('sendMessage never clicks Send after cancellation while waiting', async () => {
  const { window, adapter } = await fixture('chatgpt-ready.html')
  const button = window.document.querySelector('button')
  assert.ok(button)
  button.disabled = true
  let aborted = false
  let clicked = 0
  button.addEventListener('click', () => { clicked += 1 })
  const sending = adapter.sendMessage('do not send', { isAborted: () => aborted, sendTimeoutMs: 500 })
  setTimeout(() => { aborted = true }, 20)
  await assert.rejects(sending, /aborted before Send/)
  assert.equal(clicked, 0)
})

test('thinking status is filtered and append-compatible updates emit only suffix', async () => {
  const { window, adapter } = await fixture('chatgpt-thinking.html')
  const updates: Array<{ text: string; append: boolean; delta: string }> = []
  const observation = adapter.observeGeneration({ baseline: { assistantCount: 0, assistantText: '' }, onUpdate: update => updates.push(update), startTimeoutMs: 1000, completionStabilityMs: 30, overallTimeoutMs: 2000 })
  const body = window.document.querySelector('.markdown')
  const turn = window.document.querySelector('article[data-turn="assistant"], section[data-turn="assistant"]')
  assert.ok(body)
  assert.ok(turn)
  setTimeout(() => { body.textContent = '1' }, 20)
  setTimeout(() => { body.textContent = '12' }, 40)
  setTimeout(() => appendResponseActions(window, turn), 70)
  const final = await observation
  assert.equal(final, '12')
  assert.deepEqual(updates.filter(update => update.delta !== '').map(update => update.delta), ['1', '2'])
  assert.equal(updates.some(update => /Думаю/i.test(update.text)), false)
})

test('a Stop button appearing before the new assistant turn never replays the previous answer', async () => {
  const { window, adapter } = await fixture('chatgpt-ready.html')
  const old = window.document.createElement('article')
  old.setAttribute('data-turn', 'assistant')
  const oldBody = window.document.createElement('div')
  oldBody.className = 'markdown'
  oldBody.textContent = 'OLD ANSWER'
  old.append(oldBody)
  window.document.body.append(old)
  const stop = window.document.createElement('button')
  stop.setAttribute('data-testid', 'stop-button')
  window.document.body.append(stop)

  const fresh = window.document.createElement('article')
  fresh.setAttribute('data-turn', 'assistant')
  const freshBody = window.document.createElement('div')
  freshBody.className = 'markdown'
  freshBody.textContent = 'NEW ANSWER'
  fresh.append(freshBody)

  const updates: Array<{ text: string; append: boolean; delta: string }> = []
  const observation = adapter.observeGeneration({ baseline: { assistantCount: 1, assistantText: 'OLD ANSWER' }, onUpdate: update => updates.push(update), startTimeoutMs: 1000, completionStabilityMs: 30, overallTimeoutMs: 2000 })
  setTimeout(() => window.document.body.append(fresh), 20)
  setTimeout(() => stop.remove(), 50)
  setTimeout(() => appendResponseActions(window, fresh), 60)
  const final = await observation
  assert.equal(final, 'NEW ANSWER')
  assert.equal(updates.some(update => update.text.includes('OLD ANSWER')), false)
  assert.deepEqual(updates.filter(update => update.delta !== '').map(update => update.delta), ['NEW ANSWER'])
})

test('an active Stop button extends the first-content deadline without replaying baseline text', async () => {
  const { window, adapter } = await fixture('chatgpt-ready.html')
  const old = window.document.createElement('article')
  old.setAttribute('data-turn', 'assistant')
  const oldBody = window.document.createElement('div')
  oldBody.className = 'markdown'
  oldBody.textContent = 'OLD ANSWER'
  old.append(oldBody)
  window.document.body.append(old)
  const stop = window.document.createElement('button')
  stop.setAttribute('data-testid', 'stop-button')
  window.document.body.append(stop)

  const fresh = window.document.createElement('article')
  fresh.setAttribute('data-turn', 'assistant')
  const freshBody = window.document.createElement('div')
  freshBody.className = 'markdown'
  freshBody.textContent = 'LATE ANSWER'
  fresh.append(freshBody)

  const updates: Array<{ text: string; append: boolean; delta: string }> = []
  const observation = adapter.observeGeneration({ baseline: { assistantCount: 1, assistantText: 'OLD ANSWER' }, onUpdate: update => updates.push(update), startTimeoutMs: 20, completionStabilityMs: 20, overallTimeoutMs: 1000 })
  setTimeout(() => window.document.body.append(fresh), 60)
  setTimeout(() => stop.remove(), 100)
  setTimeout(() => appendResponseActions(window, fresh), 110)

  const final = await observation
  assert.equal(final, 'LATE ANSWER')
  assert.equal(updates.some(update => update.text.includes('OLD ANSWER')), false)
})

test('a false stable pause after Stop disappears does not complete before response actions appear', async () => {
  const { window, adapter } = await fixture('chatgpt-ready.html')
  const stop = window.document.createElement('button')
  stop.setAttribute('data-testid', 'stop-button')
  window.document.body.append(stop)

  const observation = adapter.observeGeneration({
    baseline: { assistantCount: 0, assistantText: '' },
    startTimeoutMs: 1000,
    completionStabilityMs: 30,
    overallTimeoutMs: 2000,
  })

  const turn = window.document.createElement('section')
  turn.setAttribute('data-turn', 'assistant')
  const message = window.document.createElement('div')
  message.setAttribute('data-message-author-role', 'assistant')
  const body = window.document.createElement('div')
  body.className = 'markdown'
  body.textContent = 'Хорошо 🙂'
  message.append(body)
  turn.append(message)

  setTimeout(() => window.document.body.append(turn), 10)
  setTimeout(() => stop.remove(), 20)
  setTimeout(() => { body.textContent = 'Хорошо 🙂 А у тебя как?' }, 100)
  setTimeout(() => {
    const actions = window.document.createElement('div')
    actions.setAttribute('role', 'group')
    actions.setAttribute('aria-label', 'Действия с ответом')
    const copy = window.document.createElement('button')
    copy.setAttribute('data-testid', 'copy-turn-action-button')
    actions.append(copy)
    turn.append(actions)
  }, 130)

  const final = await observation
  assert.equal(final, 'Хорошо 🙂 А у тебя как?')
})

test('rewritten snapshot is marked non-append and later compatible snapshot resumes', async () => {
  const { window, adapter } = await fixture('chatgpt-thinking.html')
  const updates: Array<{ text: string; append: boolean; delta: string }> = []
  const observation = adapter.observeGeneration({ baseline: { assistantCount: 0, assistantText: '' }, onUpdate: update => updates.push(update), startTimeoutMs: 1000, completionStabilityMs: 40, overallTimeoutMs: 2000 })
  const body = window.document.querySelector('.markdown')
  const turn = window.document.querySelector('article[data-turn="assistant"], section[data-turn="assistant"]')
  assert.ok(body)
  assert.ok(turn)
  setTimeout(() => { body.textContent = 'ab' }, 10)
  setTimeout(() => { body.textContent = 'ax' }, 25)
  setTimeout(() => { body.textContent = 'abc' }, 45)
  setTimeout(() => appendResponseActions(window, turn), 90)
  const final = await observation
  assert.equal(final, 'abc')
  assert.equal(updates.some(update => update.text === 'ax' && update.append === false), true)
  assert.deepEqual(updates.filter(update => update.delta !== '').map(update => update.delta), ['ab', 'c'])
})
