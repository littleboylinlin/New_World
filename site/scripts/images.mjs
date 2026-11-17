// Renders src/icon-64.png and src/og.png from the App icon. Run after changing the icon or the design.
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const root = fileURLToPath(new URL('..', import.meta.url))
const icon = `data:image/png;base64,${(await readFile(`${root}../public/app-icon.png`)).toString('base64')}`
const style = await readFile(`${root}src/styles.css`, 'utf-8')

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH })
const page = await browser.newPage({ colorScheme: 'light' })

const small = await page.evaluate(async (source) => {
  const image = new Image()
  image.src = source
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 64
  const context = canvas.getContext('2d')
  context.imageSmoothingQuality = 'high'
  context.drawImage(image, 0, 0, 64, 64)
  return canvas.toDataURL('image/png').split(',')[1]
}, icon)
await writeFile(`${root}src/icon-64.png`, Buffer.from(small, 'base64'))

await page.setViewportSize({ width: 1200, height: 630 })
await page.setContent(`<!doctype html><html lang="zh-CN"><head><style>${style}
  body { justify-content: center; padding: 0 96px; }
  .card { display: flex; align-items: center; justify-content: space-between; gap: 48px; }
  .title { font-size: 128px; }
  .lede { font-size: 34px; margin-top: 36px; }
  .og-en { margin-top: 8px; color: var(--muted); font-size: 24px; font-weight: 700; }
  .og-icon { width: 260px; height: 260px; border: 4px solid var(--ink); border-radius: 56px; box-shadow: 10px 10px 0 var(--edge); transform: rotate(3deg); }
  .og-stripe { position: fixed; inset: auto 0 0; height: 18px; }
</style></head><body>
  <div class="card">
    <div>
      <h1 class="title"><span class="title-word">New</span><span class="title-word title-mark">World</span></h1>
      <p class="lede">本地小说管理器与写作工作台</p>
      <p class="og-en">A local novel manager and writing workbench</p>
    </div>
    <img class="og-icon" src="${icon}" alt="">
  </div>
  <div class="stripe og-stripe"></div>
</body></html>`)
await page.screenshot({ path: `${root}src/og.png` })
await browser.close()
