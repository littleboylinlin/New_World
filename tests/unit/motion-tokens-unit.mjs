import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import test from 'node:test'

const root = new URL('../../src/', import.meta.url).pathname

// Looping animations keep their own rhythm; everything else reads the shared tokens.
const loops = ['.progress-spinner', '.typing-caret::after', '.web-summary-streaming::after', '.ai-assist-streaming::after']

function cssFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return cssFiles(path)
    return entry.name.endsWith('.css') ? [path] : []
  })
}

/** Every animation and transition declaration in src, with the selector it sits under. */
function declarations() {
  const found = []
  for (const file of cssFiles(root)) {
    const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    for (const block of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
      const selector = block[1].trim()
      for (const declaration of block[2].matchAll(/(?:^|;)\s*((?:animation|transition)(?:-[a-z-]+)?)\s*:\s*([^;]*)/g)) {
        found.push({ file: relative(root, file), selector, property: declaration[1], value: declaration[2].trim() })
      }
    }
  }
  return found
}

const looping = (entry) => loops.some((name) => entry.selector.split(',').some((part) => part.trim().endsWith(name)))
const describe = (entry) => `${entry.file}: ${entry.selector} { ${entry.property}: ${entry.value} }`

test('src 下 CSS 的 animation / transition 不写死时长，只用 --motion-* 变量（循环动画除外）', () => {
  const all = declarations()
  assert.ok(all.length > 50, 'expected to find the stylesheet motion rules')
  const literal = all.filter((entry) => !looping(entry) && /(?<![\w-])\d*\.?\d+m?s\b/.test(entry.value.replace(/var\([^)]*\)/g, '')))
  assert.deepEqual(literal.map(describe), [])
})

test('缓动只用三条共享曲线（进场、退场、回弹）', () => {
  const stray = declarations().filter((entry) => !looping(entry)
    && /\b(ease|ease-in|ease-out|ease-in-out|linear)\b|cubic-bezier\(|steps\(/.test(entry.value.replace(/var\([^)]*\)/g, '')))
  assert.deepEqual(stray.map(describe), [])
  const curves = new Set(declarations().flatMap((entry) => [...entry.value.matchAll(/var\((--ease-[a-z-]+)\)/g)].map((match) => match[1])))
  assert.deepEqual([...curves].filter((name) => !['--ease-enter', '--ease-exit', '--ease-spring'].includes(name)), [])
})

test('过渡不改动宽高和位置，只走 transform、opacity 与颜色', () => {
  const layout = /\b(width|height|top|left|right|bottom|inset|padding[a-z-]*|margin[a-z-]*|max-width|max-height|block-size|inline-size|filter|letter-spacing|clip-path)\b/
  const moved = declarations().filter((entry) => entry.property.startsWith('transition') && layout.test(entry.value))
  assert.deepEqual(moved.map(describe), [])
})

test('时长只有四档，减少动态效果时全部为 0', () => {
  const css = readFileSync(join(root, 'motion.css'), 'utf8')
  const tokens = Object.fromEntries([...css.matchAll(/--motion-(instant|fast|base|slow):\s*(\d+)ms/g)].slice(0, 4).map((match) => [match[1], Number(match[2])]))
  assert.deepEqual(tokens, { instant: 100, fast: 150, base: 200, slow: 260 })
  const reduced = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*:root\s*\{([^}]*)\}/)?.[1] ?? ''
  for (const name of ['instant', 'fast', 'base', 'slow']) assert.match(reduced, new RegExp(`--motion-${name}: 0ms`))
  const used = new Set(declarations().flatMap((entry) => [...entry.value.matchAll(/var\(--motion-([a-z]+)\)/g)].map((match) => match[1])))
  assert.deepEqual([...used].filter((name) => !['instant', 'fast', 'base', 'slow', 'stagger'].includes(name)), [])
})
