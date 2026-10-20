import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { quoteMatch, sameQuote } from './quote.js'

const here = dirname(fileURLToPath(import.meta.url))

test('an exact quote is located once', () => {
  const hit = quoteMatch('前言。叶绿体把光变成糖。后记。', '叶绿体把光变成糖。', [])
  assert.deepEqual(hit, { start: 3, end: 12 })
})

test('a line break in the selection still matches the reply text', () => {
  const hit = quoteMatch('hello world', 'hello\nworld', [])
  assert.deepEqual(hit, { start: 0, end: 11 })
})

test('a used copy is skipped', () => {
  const hit = quoteMatch('甲甲', '甲', [{ start: 0, end: 1 }])
  assert.deepEqual(hit, { start: 1, end: 2 })
})

test('a blank quote is not a match', () => {
  assert.equal(quoteMatch('正文', '   ', []), null)
})

test('the same span still matches when the second selection adds a line break', () => {
  assert.equal(sameQuote('叶绿体把光变成糖。', '叶绿体把光变成糖。'), true)
  assert.equal(sameQuote('hello world', 'hello\nworld'), true)
  assert.equal(sameQuote('叶绿体', '线粒体'), false)
  assert.equal(sameQuote('   ', ' '), false)
})

test('the conversation client uses this same matcher', () => {
  const quoteSrc = readFileSync(join(here, 'quote.js'), 'utf8')
  const clientSrc = readFileSync(join(here, 'client.js'), 'utf8')
  assert.equal(compactFn(clientSrc, 'quoteMatch'), compactFn(quoteSrc, 'quoteMatch'))
  assert.equal(compactFn(clientSrc, 'foldSpace'), compactFn(quoteSrc, 'foldSpace'))
  assert.equal(compactFn(clientSrc, 'sameQuote'), compactFn(quoteSrc, 'sameQuote'))
})

function compactFn(source, name) {
  const start = source.indexOf(`function ${name}`)
  assert.ok(start >= 0, name)
  let depth = 0
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1).replace(/\s+/g, ' ').trim()
    }
  }
  throw new Error(`unclosed ${name}`)
}
