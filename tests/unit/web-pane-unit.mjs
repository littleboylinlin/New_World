import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { describe, it } from 'node:test'
import { addressFor } from '../../src/web-search.ts'

const require = createRequire(import.meta.url)
const { isWebUrl, isCertificateError, isPaneId, readBounds } = require('../../desktop/web-pane.cjs')

describe('网页块地址栏', () => {
  it('网址原样打开，补上 https；本机地址用 http', () => {
    assert.deepEqual(addressFor('https://example.com/a?b=1', 'bing'), { url: 'https://example.com/a?b=1' })
    assert.deepEqual(addressFor('example.com/path', 'bing'), { url: 'https://example.com/path' })
    assert.deepEqual(addressFor('localhost:8080/x', 'bing'), { url: 'http://localhost:8080/x' })
    assert.deepEqual(addressFor('127.0.0.1:3000', 'bing'), { url: 'http://127.0.0.1:3000/' })
  })

  it('不是网址就用所选搜索引擎搜索', () => {
    assert.deepEqual(addressFor('灯塔 守夜人', 'bing'), { url: 'https://www.bing.com/search?q=%E7%81%AF%E5%A1%94%20%E5%AE%88%E5%A4%9C%E4%BA%BA' })
    assert.deepEqual(addressFor('雾港', 'baidu'), { url: 'https://www.baidu.com/s?wd=%E9%9B%BE%E6%B8%AF' })
    assert.deepEqual(addressFor('lighthouse', 'google'), { url: 'https://www.google.com/search?q=lighthouse' })
    assert.deepEqual(addressFor('fog harbor', 'duckduckgo'), { url: 'https://duckduckgo.com/?q=fog%20harbor' })
    assert.equal(addressFor('   ', 'bing'), undefined)
  })

  it('file:、javascript: 和其他协议被拒绝，不会被当成搜索', () => {
    for (const input of ['file:///etc/passwd', 'javascript:alert(1)', 'JavaScript:void(0)', 'data:text/html,hi', 'new-world://app/', 'chrome://settings', 'about:blank', 'mailto:a@b.c']) {
      assert.deepEqual(addressFor(input, 'bing'), { blocked: input }, input)
    }
  })
})

describe('网页块主进程校验', () => {
  it('只认 http 和 https', () => {
    assert.equal(isWebUrl('https://example.com'), true)
    assert.equal(isWebUrl('http://127.0.0.1:8080/x'), true)
    for (const value of ['file:///etc/passwd', 'javascript:alert(1)', 'new-world://app/', 'about:blank', 'ftp://example.com', '', 42, null]) assert.equal(isWebUrl(value), false, String(value))
  })

  it('证书错误码、块编号和位置都要校验', () => {
    assert.equal(isCertificateError(-202), true)
    assert.equal(isCertificateError(-105), false)
    assert.equal(isPaneId('ref-abc-1'), true)
    assert.equal(isPaneId('../x'), false)
    assert.deepEqual(readBounds({ x: 10.4, y: 20.6, width: 300, height: 200 }), { x: 10, y: 21, width: 300, height: 200 })
    assert.equal(readBounds({ x: 0, y: 0, width: 0, height: 10 }), undefined)
    assert.equal(readBounds({ x: 'a', y: 0, width: 10, height: 10 }), undefined)
  })
})
