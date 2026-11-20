import type { ProfileConfig, SplitRequest, TextChunk } from './types.mjs'
export function splitChapterText(config: ProfileConfig, request: Pick<SplitRequest, 'text' | 'reservedPromptTokens' | 'reservedOutputTokens'>): TextChunk[]
export function chapterCacheKey(config: ProfileConfig, text: string, promptVersion: string): Promise<string>
