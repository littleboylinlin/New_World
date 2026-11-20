import { invalid, ProviderFailure } from './errors.mjs'
import { isRecord, mergeJson, nonempty, validateGeneration } from './config.mjs'

function omitUndefined(values) {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined))
}

function openAiInput(model, messages, stream) {
  return { model, messages: messages.map(({ role, text }) => ({ role, content: text })), stream }
}

function responsesInput(model, messages, stream) {
  return { model, input: openAiInput(model, messages, stream).messages, stream }
}

function anthropicInput(model, messages, stream) {
  return omitUndefined({
    model, stream,
    system: systemText(messages),
    messages: messages.filter(({ role }) => role !== 'system').map(({ role, text }) => ({ role, content: text })),
  })
}

function geminiInput(_model, messages) {
  const system = systemText(messages)
  return omitUndefined({
    systemInstruction: system === undefined ? undefined : { parts: [{ text: system }] },
    contents: messages.filter(({ role }) => role !== 'system')
      .map(({ role, text }) => ({ role: role === 'assistant' ? 'model' : 'user', parts: [{ text }] })),
  })
}

function systemText(messages) {
  const system = messages.filter(({ role }) => role === 'system').map(({ text }) => text)
  return system.length ? system.join('\n\n') : undefined
}

function openAiSettings(settings, output, reasoning) {
  if (settings.thinkingBudgetTokens !== undefined) {
    invalid('This protocol uses reasoning effort instead of a thinking token budget.')
  }
  return omitUndefined({
    temperature: settings.temperature,
    top_p: settings.topP,
    [output]: settings.maxOutputTokens,
    ...reasoning,
  })
}

function thinkingSettings({ reasoningEffort, thinkingBudgetTokens }) {
  if (reasoningEffort !== undefined && thinkingBudgetTokens !== undefined) {
    invalid('Choose reasoning effort or a thinking token budget for this protocol.')
  }
  return { reasoningEffort, thinkingBudgetTokens }
}

function anthropicSettings(settings) {
  const { reasoningEffort, thinkingBudgetTokens } = thinkingSettings(settings)
  return omitUndefined({
    temperature: settings.temperature,
    top_p: settings.topP,
    max_tokens: settings.maxOutputTokens,
    thinking: reasoningEffort !== undefined ? { type: 'adaptive' }
      : thinkingBudgetTokens !== undefined ? { type: 'enabled', budget_tokens: thinkingBudgetTokens } : undefined,
    output_config: reasoningEffort === undefined ? undefined : { effort: reasoningEffort },
  })
}

function geminiSettings(settings) {
  const { reasoningEffort, thinkingBudgetTokens } = thinkingSettings(settings)
  const thinkingConfig = omitUndefined({ thinkingLevel: reasoningEffort?.toUpperCase(), thinkingBudget: thinkingBudgetTokens })
  const generationConfig = omitUndefined({
    temperature: settings.temperature,
    topP: settings.topP,
    maxOutputTokens: settings.maxOutputTokens,
    thinkingConfig: Object.keys(thinkingConfig).length ? thinkingConfig : undefined,
  })
  return Object.keys(generationConfig).length ? { generationConfig } : {}
}

function completion(text, finishReason) {
  return omitUndefined({ text, finishReason: typeof finishReason === 'string' ? finishReason : undefined })
}

function invalidResponse() {
  throw new ProviderFailure('invalid_response')
}

function textBlocks(parts, select) {
  return parts.map(select).filter((value) => typeof value === 'string').join('')
}

function openAiResult(value) {
  const choice = value?.choices?.[0]
  if (!choice?.message) invalidResponse()
  return completion(choice.message.content ?? choice.message.refusal ?? '', choice.finish_reason)
}

function responsesResult(value) {
  if (!Array.isArray(value?.output)) invalidResponse()
  const parts = value.output.filter((item) => item.type === 'message' && Array.isArray(item.content)).flatMap((item) => item.content)
  return completion(textBlocks(parts, (part) => part.type === 'output_text' ? part.text : part.refusal),
    value.incomplete_details?.reason ?? value.status)
}

function anthropicResult(value) {
  if (!Array.isArray(value?.content)) invalidResponse()
  return completion(textBlocks(value.content, (part) => part.type === 'text' ? part.text : undefined), value.stop_reason)
}

function geminiResult(value) {
  const candidate = value?.candidates?.[0]
  const promptBlock = value?.promptFeedback?.blockReason
  if (!candidate && !promptBlock) invalidResponse()
  const parts = candidate?.content?.parts ?? []
  if (!Array.isArray(parts)) invalidResponse()
  return completion(textBlocks(parts, (part) => part.thought ? undefined : part.text), candidate?.finishReason ?? promptBlock)
}

function openAiStream(value, type) {
  if (type === 'done') return { end: true }
  const choice = value?.choices?.[0]
  return {
    text: choice?.delta?.content ?? choice?.delta?.refusal,
    finishReason: choice?.finish_reason,
    canEnd: Boolean(choice?.finish_reason),
  }
}

function responsesStream(value, type) {
  switch (type) {
    case 'response.output_text.delta':
    case 'response.refusal.delta':
      return { text: value.delta }
    case 'response.completed':
    case 'response.incomplete':
      return { end: true, finishReason: value.response?.incomplete_details?.reason ?? value.response?.status }
    case 'response.failed':
      return { error: value.response?.error ?? value }
    default:
      return {}
  }
}

function anthropicStream(value, type) {
  switch (type) {
    case 'content_block_delta':
      return { text: value.delta?.type === 'text_delta' ? value.delta.text : undefined }
    case 'message_delta':
      return { finishReason: value.delta?.stop_reason }
    case 'message_stop':
      return { end: true }
    default:
      return {}
  }
}

function geminiStream(value) {
  if (!value?.candidates?.length && !value?.promptFeedback?.blockReason) return {}
  const { text, finishReason } = geminiResult(value)
  return { text, finishReason, canEnd: Boolean(finishReason) }
}

function dataModels(value) {
  if (!Array.isArray(value?.data)) invalidResponse()
  const models = value.data.filter((model) => nonempty(model?.id)).map((model) =>
    omitUndefined({ id: model.id, displayName: typeof model.display_name === 'string' ? model.display_name : undefined }))
  return omitUndefined({ models, nextCursor: value.has_more === true && nonempty(value.last_id) ? value.last_id : undefined })
}

function geminiModels(value) {
  if (!isRecord(value) || (value.models !== undefined && !Array.isArray(value.models))) invalidResponse()
  const models = (value.models ?? []).filter((model) =>
    nonempty(model?.name) && (!Array.isArray(model.supportedGenerationMethods) || model.supportedGenerationMethods.includes('generateContent')),
  ).map((model) => omitUndefined({
    id: model.name.replace(/^models\//, ''),
    displayName: typeof model.displayName === 'string' ? model.displayName : undefined,
  }))
  return omitUndefined({ models, nextCursor: nonempty(value.nextPageToken) ? value.nextPageToken : undefined })
}

export const adapters = {
  'openai-chat': {
    path: 'chat/completions', input: openAiInput, inputFields: ['model', 'messages', 'stream'],
    settings: (options) => openAiSettings(options, 'max_completion_tokens', { reasoning_effort: options.reasoningEffort }),
    result: openAiResult, stream: openAiStream, models: dataModels, probeLimit: 'max_completion_tokens',
  },
  'openai-responses': {
    path: 'responses', input: responsesInput, inputFields: ['model', 'input', 'instructions', 'stream'],
    defaults: { store: false },
    settings: (options) => openAiSettings(options, 'max_output_tokens', {
      reasoning: options.reasoningEffort === undefined ? undefined : { effort: options.reasoningEffort },
    }),
    result: responsesResult, stream: responsesStream, models: dataModels, probeLimit: 'max_output_tokens',
  },
  'anthropic-messages': {
    path: 'messages', input: anthropicInput, inputFields: ['model', 'messages', 'system', 'stream'],
    settings: anthropicSettings, result: anthropicResult, stream: anthropicStream, models: dataModels,
    cursorParam: 'after_id', probeLimit: 'max_tokens',
  },
  'gemini-generate-content': {
    path: 'models/{model}:generateContent', streamPath: 'models/{model}:streamGenerateContent?alt=sse',
    input: geminiInput, inputFields: ['model', 'contents', 'systemInstruction', 'system_instruction', 'stream'],
    settings: geminiSettings, result: geminiResult, stream: geminiStream, models: geminiModels, cursorParam: 'pageToken',
  },
}

export function generationPath(config, streaming) {
  const adapter = adapters[config.protocol]
  if (!streaming) return config.paths?.generate ?? adapter.path
  return config.paths?.stream ?? adapter.streamPath ?? config.paths?.generate ?? adapter.path
}

export function requestBody(config, request, streaming, probe) {
  const adapter = adapters[config.protocol]
  const model = config.model?.trim()
  if (!nonempty(model)) invalid('Enter a model name for this AI profile.')
  const { messages, generation } = request
  if (!Array.isArray(messages) || !messages.some((message) => message?.role === 'user')
    || messages.some((message) => !isRecord(message) || !['system', 'user', 'assistant'].includes(message.role) || typeof message.text !== 'string')) {
    invalid('Provide text messages, including a user message.')
  }
  validateGeneration(generation)
  const options = { ...config.generation, ...omitUndefined(generation ?? {}) }
  const body = mergeJson({ ...adapter.defaults, ...adapter.settings(probe ? {} : options) }, config.extraBody)
  for (const field of adapter.inputFields) delete body[field]
  if (probe) {
    if (config.protocol === 'gemini-generate-content') {
      body.generationConfig = mergeJson(isRecord(body.generationConfig) ? body.generationConfig : {}, { maxOutputTokens: 16 })
      delete body.generationConfig.thinkingConfig
    } else {
      // Respect legacy Chat-compatible relays configured with max_tokens.
      const limit = config.protocol === 'openai-chat' && Object.hasOwn(body, 'max_tokens')
        && !Object.hasOwn(body, adapter.probeLimit) ? 'max_tokens' : adapter.probeLimit
      body[limit] = 16
      if (limit !== 'max_tokens') delete body.max_tokens
      delete body.thinking
      delete body.reasoning
      delete body.reasoning_effort
      delete body.output_config
    }
  }
  if (config.protocol === 'anthropic-messages' && (!Number.isSafeInteger(body.max_tokens) || body.max_tokens <= 0)) {
    invalid('Anthropic Messages requires a maximum output token count.')
  }
  return { ...body, ...adapter.input(model, messages, streaming) }
}
