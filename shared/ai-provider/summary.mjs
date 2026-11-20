import { endpointUrl, nonempty } from './config.mjs'
import { invalid } from './errors.mjs'
import { generationPath } from './protocols.mjs'

const encoder = new TextEncoder()
const sentences = new Intl.Segmenter(undefined, { granularity: 'sentence' })
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

function conservativeTokens(text) {
  return encoder.encode(text).length
}

function outputLimit(config) {
  const body = config.extraBody
  switch (config.protocol) {
    case 'openai-chat':
      return body?.max_completion_tokens ?? body?.max_tokens ?? config.generation?.maxOutputTokens
    case 'openai-responses':
      return body?.max_output_tokens ?? config.generation?.maxOutputTokens
    case 'anthropic-messages':
      return body?.max_tokens ?? config.generation?.maxOutputTokens
    case 'gemini-generate-content':
      return body?.generationConfig?.maxOutputTokens ?? config.generation?.maxOutputTokens
  }
}

function budgetOf(config, request) {
  const context = config.generation?.contextTokens
  if (!Number.isSafeInteger(context) || context < 1) invalid('Set the profile context length before splitting text.')
  const outputLimitFromConfig = outputLimit(config)
  const defaultOutput = Number.isSafeInteger(outputLimitFromConfig) && outputLimitFromConfig > 0
    ? outputLimitFromConfig : Math.max(1, Math.min(1024, Math.floor(context / 4)))
  const output = request.reservedOutputTokens === undefined ? defaultOutput : request.reservedOutputTokens
  const prompt = request.reservedPromptTokens === undefined ? Math.min(256, Math.floor(context / 8)) : request.reservedPromptTokens
  if (!Number.isSafeInteger(output) || output < 0 || !Number.isSafeInteger(prompt) || prompt < 0 || context <= output + prompt) {
    invalid('Leave room for chapter text in the context length after reserving prompt and output tokens.')
  }
  return context - output - prompt
}

function* paragraphs(text) {
  let offset = 0
  for (const newline of text.matchAll(/\r\n|\n|\r/g)) {
    const end = newline.index + newline[0].length
    yield text.slice(offset, end)
    offset = end
  }
  if (offset < text.length) yield text.slice(offset)
}

function* pieces(text, budget) {
  for (const paragraph of paragraphs(text)) {
    const estimated = conservativeTokens(paragraph)
    if (estimated <= budget) {
      yield [paragraph, estimated]
      continue
    }
    for (const { segment: sentence } of sentences.segment(paragraph)) {
      const estimatedSentence = conservativeTokens(sentence)
      if (estimatedSentence <= budget) {
        yield [sentence, estimatedSentence]
        continue
      }
      for (const { segment: grapheme } of graphemes.segment(sentence)) {
        const estimatedGrapheme = conservativeTokens(grapheme)
        if (estimatedGrapheme <= budget) {
          yield [grapheme, estimatedGrapheme]
        } else {
          for (const point of grapheme) {
            const estimatedPoint = conservativeTokens(point)
            if (estimatedPoint > budget) invalid('Increase the context budget to fit a Unicode character.')
            yield [point, estimatedPoint]
          }
        }
      }
    }
  }
}

export function splitChapterText(config, request) {
  const { text } = request
  if (typeof text !== 'string') invalid('Provide chapter text to split.')
  const budget = budgetOf(config, request)
  const chunks = []
  let start = 0
  let end = 0
  let estimatedTokens = 0
  for (const [piece, size] of pieces(text, budget)) {
    if (estimatedTokens + size > budget) {
      chunks.push({ start, end, text: text.slice(start, end), estimatedTokens })
      start = end
      estimatedTokens = 0
    }
    end += piece.length
    estimatedTokens += size
  }
  if (end > start) chunks.push({ start, end, text: text.slice(start, end), estimatedTokens })
  return chunks
}

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function chapterCacheKey(config, text, promptVersion) {
  if (typeof text !== 'string' || !nonempty(promptVersion)) invalid('Provide chapter text and a prompt version.')
  const model = config.model?.trim()
  if (!nonempty(model)) invalid('Select a model for the chapter summary.')
  const modelId = config.protocol === 'gemini-generate-content' ? model.replace(/^models\//, '') : model
  const endpoints = [false, true].map((stream) => endpointUrl(config, generationPath(config, stream), model).href)
  return sha256(JSON.stringify([await sha256(text), [config.protocol, modelId, ...endpoints], promptVersion]))
}
