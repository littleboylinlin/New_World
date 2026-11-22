import { databaseSnapshot } from './project-fixture.mjs'
import { test, expect } from './app-test.mjs'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { ZipReader, ZipWriter, Uint8ArrayReader, Uint8ArrayWriter } from '@zip.js/zip.js'
test.setTimeout(90000)
async function create(page, title) {
  await page.goto('/#/tasks')
  await page.getByLabel('快速添加任务', { exact: true }).fill(title)
  await page.locator('.task-quick button').click()
  await expect(page.getByRole('button', { name: title, exact: true })).toBeVisible()
}
async function settings(page) {
  await page.getByRole('link', { name: '设置', exact: true }).click()
  await page.getByRole('link', { name: '备份与恢复', exact: true }).click()
  return page.getByRole('region', { name: '备份与恢复', exact: true })
}
test('全库备份包含独立任务，旧备份恢复保留任务，新备份整体恢复任务', async ({ page }, info) => {
  await create(page, '进入备份的任务')
  let panel = await settings(page)
  const promise = page.waitForEvent('download')
  await panel.getByRole('button', { name: '立即备份', exact: true }).click()
  const path = info.outputPath('tasks.zip')
  await (await promise).saveAs(path)
  const zip = new ZipReader(new Uint8ArrayReader(await readFile(path))),
    entries = await zip.getEntries(),
    data = []
  for (const entry of entries)
    data.push([entry.filename, await entry.getData(new Uint8ArrayWriter())])
  await zip.close()
  const manifest = JSON.parse(
    Buffer.from(data.find(([name]) => name === 'new-world-backup.json')[1]).toString(),
  )
  expect(manifest.version).toBe(4)
  expect(manifest.taskData.tasks.map((t) => t.title)).toEqual(['进入备份的任务'])
  const legacy = { ...manifest, version: 1 }
  delete legacy.taskData
  delete legacy.aiBaselines
  delete legacy.storyCards
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false })
  for (const [name, bytes] of data)
    await writer.add(
      name,
      new Uint8ArrayReader(
        name === 'new-world-backup.json' ? Buffer.from(JSON.stringify(legacy)) : bytes,
      ),
    )
  const old = info.outputPath('old.zip')
  await writeFile(old, await writer.close())
  await create(page, '备份以后的任务')
  async function restore(file, expected) {
    panel = await settings(page)
    const chooser = page.waitForEvent('filechooser')
    await panel.getByRole('button', { name: '从备份恢复…', exact: true }).click()
    await (await chooser).setFiles(file)
    const dialog = page.getByRole('dialog', { name: '从备份恢复', exact: true })
    await expect(dialog).toContainText(expected)
    await dialog.getByRole('button', { name: '替换当前书库', exact: true }).click()
    await expect(dialog).toBeHidden()
    await page.goto('/#/tasks')
  }
  await restore(old, '现有任务数据将保留')
  await expect(page.getByRole('button', { name: '备份以后的任务', exact: true })).toBeVisible()
  await restore(path, '备份含 1 条任务')
  await expect(page.getByRole('button', { name: '进入备份的任务', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '备份以后的任务', exact: true })).toHaveCount(0)
})

test('全库任务附件按原字节恢复，损坏附件拒绝且原书库不变', async ({ page }, info) => {
  await create(page, '带附件的任务')
  const taskId = (await page.evaluate(databaseSnapshot)).tasks[0].id
  const bytes = Buffer.from('备份附件\r\n精确字节')
  const sha = createHash('sha256').update(bytes).digest('hex')
  await page.evaluate(
    async ({ taskId, rawBytes, hash }) => {
      const db = await new Promise((r) => {
        const q = indexedDB.open('new-world-library')
        q.onsuccess = () => r(q.result)
      })
      const blob = new Blob([new Uint8Array(rawBytes)], { type: 'text/plain' })
      const tx = db.transaction('taskAttachments', 'readwrite')
      tx.objectStore('taskAttachments').put({
        id: crypto.randomUUID(),
        taskId,
        name: '备份.txt',
        type: 'text/plain',
        bytes: blob.size,
        sha256: hash,
        content: blob,
      })
      await new Promise((r) => (tx.oncomplete = r))
      db.close()
    },
    { taskId, rawBytes: [...bytes], hash: sha },
  )
  let panel = await settings(page),
    download = page.waitForEvent('download')
  await panel.getByRole('button', { name: '立即备份', exact: true }).click()
  const path = info.outputPath('attachments.zip')
  await (await download).saveAs(path)
  const zip = new ZipReader(new Uint8ArrayReader(await readFile(path)), { useWebWorkers: false }),
    entries = []
  for (const entry of await zip.getEntries())
    entries.push([entry.filename, await entry.getData(new Uint8ArrayWriter())])
  await zip.close()
  const asset = entries.find(([name]) => name.startsWith('tasks/assets/'))
  expect(Buffer.from(asset[1])).toEqual(bytes)
  await page.evaluate(async () => {
    const db = await new Promise((r) => {
      const q = indexedDB.open('new-world-library')
      q.onsuccess = () => r(q.result)
    })
    const tx = db.transaction('taskAttachments', 'readwrite')
    tx.objectStore('taskAttachments').clear()
    await new Promise((r) => (tx.oncomplete = r))
    db.close()
  })
  panel = await settings(page)
  let chooser = page.waitForEvent('filechooser')
  await panel.getByRole('button', { name: '从备份恢复…', exact: true }).click()
  await (await chooser).setFiles(path)
  let form = page.getByRole('dialog', { name: '从备份恢复', exact: true })
  await form.getByRole('button', { name: '替换当前书库', exact: true }).click()
  await expect(form).toBeHidden()
  await page.goto('/#/tasks')
  await page.getByRole('button', { name: '带附件的任务', exact: true }).click()
  download = page.waitForEvent('download')
  await page.locator('.task-card').getByRole('button', { name: '下载附件', exact: true }).click()
  const restored = info.outputPath('restored.txt')
  await (await download).saveAs(restored)
  expect(await readFile(restored)).toEqual(bytes)
  await page.locator('.task-card').getByRole('button', { name: '收起', exact: true }).first().click()
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false })
  for (const [name, data] of entries)
    await writer.add(
      name,
      new Uint8ArrayReader(name === asset[0] ? new Uint8Array(data.length).fill(88) : data),
    )
  const bad = info.outputPath('damaged.zip')
  await writeFile(bad, await writer.close())
  panel = await settings(page)
  const before = await page.evaluate(databaseSnapshot)
  chooser = page.waitForEvent('filechooser')
  await panel.getByRole('button', { name: '从备份恢复…', exact: true }).click()
  await (await chooser).setFiles(bad)
  await expect(panel.getByRole('alert')).toContainText(/任务|无法|损坏|读取|Invalid/)
  expect(await page.evaluate(databaseSnapshot)).toEqual(before)
  await expect(page.getByRole('dialog', { name: '从备份恢复', exact: true })).toHaveCount(0)
})
