import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import { fakeAiService, fakeText } from '../helpers/fake-ai.mjs'

test('Electron 主进程请求无需 CORS，取消关闭连接，v1 仍独立', async () => {
  const fake = await fakeAiService()
  const home = await mkdtemp(join(tmpdir(), 'new-world-provider-ipc-'))
  let app
  try {
    await mkdir(join(home, 'NewWorld-languages'), { recursive: true })
    await writeFile(join(home, 'NewWorld-languages', 'language.json'), JSON.stringify({ locale: 'zh-CN' }))
    const args = ['.', '--disable-gpu']
    if (process.platform === 'linux') args.push('--no-sandbox')
    app = await electron.launch({
      args, env: { ...process.env, XDG_CONFIG_HOME: home, APPDATA: home, NEW_WORLD_DISABLE_INTRO: '1' },
    })
    const page = await app.firstWindow()
    const result = await page.evaluate(async (url) => {
      const desktop = window.newWorldDesktop
      const bridge = desktop.aiProvider
      const config = { name: 'Loopback', baseUrl: url + '/cors/v1', protocol: 'openai-chat', auth: { kind: 'none' }, model: 'example' }
      const saved = await bridge.call('saveProfile', { config })
      const test = await bridge.call('testConnection', { profileId: saved.data.id })
      const hang = await bridge.call('saveProfile', { config: { ...config, baseUrl: url + '/hang/v1' } })
      const id = crypto.randomUUID()
      await bridge.start(id, {
        feature: 'ask', profileId: hang.data.id, messages: [{ role: 'user', text: 'stream text' }],
      })
      const delta = await bridge.next(id)
      bridge.cancel(id)
      const stopped = await bridge.next(id)
      return { saved, test, delta, stopped, v1: await desktop.getAiState() }
    }, fake.url)
    expect(result.saved.data.rememberCredentials).toBe(true)
    expect(result.test).toEqual({ ok: true, httpStatus: 200 })
    expect(result.delta).toEqual({ type: 'delta', text: fakeText })
    expect(result.stopped).toEqual({ type: 'cancelled' })
    expect(result.v1.enabled).toBe(false)
    expect(await page.evaluate(() => window.newWorldDesktop.aiProvider.call('getAiState'))).toMatchObject({ ok: false })
    await expect.poll(() => fake.requests.at(-1)?.closed).toBe(true)
  } finally {
    await app?.close()
    await fake.close()
    await rm(home, { recursive: true, force: true })
  }
})
