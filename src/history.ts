import { createHash } from 'node:crypto'
import {
  createAssistantMessage,
  LlmError,
  type ContentBlock,
  type Message,
  type RequestMessage,
} from '@deepseek-ai/dsh-llm'

export const UNSUPPORTED_IMAGE_CODE = 'CHATGPT_WEB_UNSUPPORTED_IMAGE'
export const UNSUPPORTED_BLOCK_CODE = 'CHATGPT_WEB_UNSUPPORTED'

function normalizedBlock(block: ContentBlock): unknown {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'reasoning':
      return { type: 'reasoning', text: block.text }
    case 'image':
      throw new LlmError('ChatGPT Web v0.1 does not support image input', UNSUPPORTED_IMAGE_CODE)
    case 'tool-call':
      return {
        type: 'tool-call',
        id: String(block.id),
        name: block.name,
        arguments: block.arguments,
      }
    default:
      throw new LlmError(
        `ChatGPT Web v0.1 cannot serialize content block type ${String((block as { type?: unknown }).type)}`,
        UNSUPPORTED_BLOCK_CODE,
      )
  }
}

export function normalizedMessage(message: Message): unknown {
  return {
    role: message.role,
    // Human attribution affects the response target, unlike ids/provider metadata.
    ...(message.role === 'user' ? { human: message.source.kind === 'user' } : {}),
    ...(message.role === 'tool' ? {
      toolCallId: String(message.toolCallId),
      isError: message.isError ?? false,
    } : {}),
    content: message.content.map(normalizedBlock),
  }
}

export function historyDigest(messages: readonly Message[]): string {
  const normalized = messages.map(normalizedMessage)
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
}

export function textDigest(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function serializeBlock(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
      return `[text]\n${block.text}`
    case 'reasoning':
      return `[reasoning-context]\n${block.text}`
    case 'image':
      throw new LlmError('ChatGPT Web v0.1 does not support image input', UNSUPPORTED_IMAGE_CODE)
    case 'tool-call':
      return `[historical-tool-call name=${JSON.stringify(block.name)} id=${JSON.stringify(String(block.id))}]\n${block.arguments}`
    default:
      throw new LlmError(
        `ChatGPT Web v0.1 cannot serialize content block type ${String((block as { type?: unknown }).type)}`,
        UNSUPPORTED_BLOCK_CODE,
      )
  }
}

export function serializeHistory(messages: readonly Message[]): string {
  return messages.map((message, index) => {
    const blocks = message.content.map(serializeBlock).join('\n\n')
    const toolResult = message.role === 'tool'
      ? `[historical-tool-result callId=${JSON.stringify(String(message.toolCallId))} isError=${String(message.isError ?? false)}]\n`
      : ''
    return `--- message ${index + 1} role=${message.role} ---\n${toolResult}${blocks}`
  }).join('\n\n')
}

/** Normalize the two DSH system-prompt representations before planning or committing. */
export function normalizeRequest(
  system: string | undefined,
  requestMessages: readonly RequestMessage[],
): { system: string | undefined; messages: Message[] } {
  const instructions: string[] = system ? [system] : []
  const messages: Message[] = []
  for (const message of requestMessages) {
    if (message.id === undefined || message.source === undefined) {
      throw new LlmError(
        'ChatGPT Web requires durable DSH messages; identity-free one-shot input is unsupported',
        UNSUPPORTED_BLOCK_CODE,
      )
    }
    // Validate every block, including cached prefixes, before any browser side effect.
    normalizedMessage(message)
    if (message.role === 'system') {
      if (messages.length > 0) {
        throw new LlmError('ChatGPT Web supports system messages only at the start of history', UNSUPPORTED_BLOCK_CODE)
      }
      const text = message.content.map(block => {
        if (block.type !== 'text') {
          throw new LlmError('ChatGPT Web system instructions must contain only text', UNSUPPORTED_BLOCK_CODE)
        }
        return block.text
      }).join('\n\n')
      if (text) instructions.push(text)
    } else {
      messages.push(message)
    }
  }
  return { system: instructions.length ? instructions.join('\n\n') : undefined, messages }
}

export function syntheticAssistantMessage(text: string): Message {
  return createAssistantMessage({
    content: [{ type: 'text', text }],
    source: {
      provider: 'chatgpt-web',
      model: 'auto',
    },
  })
}
