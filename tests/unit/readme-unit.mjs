import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// The READMEs point to the latest release instead of naming a "current" version, so they cannot fall
// behind when a release forgets them. Versions stay only where they say when a feature arrived.
for (const name of ['README.md', 'README.en.md']) {
  test(`${name} 不写死当前版本号`, async () => {
    const text = await readFile(new URL(`../../${name}`, import.meta.url), 'utf8')
    assert.doesNotMatch(text, /New World v\d+\.\d+/, 'the opening names no version')
    assert.doesNotMatch(text, /当前正式版[^。]*v\d+\.\d+|current stable release[^.]*v\d+\.\d+/i, 'the download section names no version')
    assert.match(text, /releases\/latest/, 'it links to the latest release')
  })
}
