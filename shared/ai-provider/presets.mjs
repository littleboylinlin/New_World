const presets = [
  { id: 'openai-chat', config: {
    name: 'OpenAI Chat Completions', protocol: 'openai-chat', baseUrl: 'https://api.openai.com/v1', auth: { kind: 'bearer' },
  } },
  { id: 'openai-responses', config: {
    name: 'OpenAI Responses', protocol: 'openai-responses', baseUrl: 'https://api.openai.com/v1', auth: { kind: 'bearer' },
  } },
  { id: 'anthropic', config: {
    name: 'Anthropic', protocol: 'anthropic-messages', baseUrl: 'https://api.anthropic.com/v1', auth: { kind: 'x-api-key' },
    generation: { maxOutputTokens: 1024 },
  } },
  { id: 'gemini', config: {
    name: 'Gemini', protocol: 'gemini-generate-content', baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    auth: { kind: 'header', name: 'x-goog-api-key' },
  } },
  { id: 'deepseek', config: {
    name: 'DeepSeek', protocol: 'openai-chat', baseUrl: 'https://api.deepseek.com/v1', auth: { kind: 'bearer' },
  } },
  { id: 'openrouter', config: {
    name: 'OpenRouter', protocol: 'openai-chat', baseUrl: 'https://openrouter.ai/api/v1', auth: { kind: 'bearer' },
  } },
  { id: 'ollama', config: {
    name: 'Ollama', protocol: 'openai-chat', baseUrl: 'http://localhost:11434/v1', auth: { kind: 'none' },
  } },
]

export function listPresets() {
  return structuredClone(presets)
}
