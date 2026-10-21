import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { markdownFromNode, notesMarkdown, pageKey, plainFromMarkdown, reconcileMarks, renderMarkdown, sanitizeIncomingMarks } from './model.js'
import { apply, childTranscript, followUpPrompt, harnessHome, listStudyModels, questionPrompt, resolveStudyModel } from './index.js'

test('html text drops scripts and keeps the words around them', async () => {
  const { htmlToText } = await import('./model.js')
  const page = htmlToText(`
    <html><head><title>光合 &amp; 呼吸</title><style>body{color:red}</style></head>
    <body><script>alert('no')</script><p>叶绿体把光变成糖。</p><p>线粒体把糖变成能量。</p></body></html>
  `)
  assert.equal(page.title, '光合 & 呼吸')
  assert.equal(page.text.includes('alert'), false)
  assert.equal(page.text.includes('color:red'), false)
  assert.equal(page.text.includes('叶绿体把光变成糖。'), true)
  assert.equal(page.text.includes('线粒体把糖变成能量。'), true)
})

test('a file outside the workspace is refused', async () => {
  const { insideRoot } = await import('./model.js')
  const root = 'C:\\Users\\YOGA\\notes'
  assert.equal(insideRoot(root, 'C:\\Users\\YOGA\\notes\\a.md').endsWith('a.md'), true)
  assert.equal(insideRoot(root, 'C:\\Users\\YOGA\\other\\a.md'), null)
  assert.equal(insideRoot(root, '..\\secret.txt'), null)
})

test('a mark survives a small edit when the quote is still there', () => {
  const text = '前言。叶绿体把光变成糖。后记。'
  const moved = reconcileMarks(`开头改了。${text}`, [
    { id: 'm1', start: 3, end: 13, kind: 'red', comment: '定义', quote: '叶绿体把光变成糖。' },
  ])
  assert.equal(moved.dropped, 0)
  assert.equal(moved.marks[0].quote, '叶绿体把光变成糖。')
  assert.equal(moved.marks[0].start > 3, true)
})

test('a mark whose quote disappeared is dropped', () => {
  const result = reconcileMarks('只剩下一句话。', [
    { id: 'm1', start: 0, end: 4, kind: 'line', comment: '', quote: '已经删掉的句子' },
  ])
  assert.equal(result.dropped, 1)
  assert.equal(result.marks.length, 0)
})

test('markdown note keeps the quote and the comment', () => {
  const markdown = notesMarkdown({
    title: '细胞',
    source: 'C:\\page.html',
    marks: [{ kind: 'red', quote: '叶绿体把光变成糖。', comment: '先记定义' }],
  })
  assert.match(markdown, /^# 细胞/)
  assert.match(markdown, /> 叶绿体把光变成糖。/)
  assert.match(markdown, /先记定义/)
})

test('host route saves a note under the harness home', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-marginalia-'))
  const home = mkdtempSync(join(tmpdir(), 'dsh-marginalia-home-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const page = join(root, 'cell.html')
  writeFileSync(page, '<html><head><title>细胞</title></head><body><p>叶绿体把光变成糖。</p></body></html>', 'utf8')
  const calls = []
  const ctx = {
    effect(fn) {
      calls.push(fn())
    },
    webServer: {
      register(route) {
        calls.route = route
        return () => {}
      },
    },
  }
  apply(ctx)
  try {
  const opened = await request(calls.route.handler, 'GET', `/marginalia/api/page?source=${encodeURIComponent(page)}&root=${encodeURIComponent(root)}`)
  assert.equal(opened.status, 200)
  assert.equal(opened.body.ok, true)
  assert.equal(opened.body.text.includes('叶绿体把光变成糖。'), true)
  const quote = '叶绿体把光变成糖。'
  const start = opened.body.text.indexOf(quote)
  const saved = await request(calls.route.handler, 'POST', '/marginalia/api/notes', {
    root,
    source: opened.body.source,
    title: opened.body.title,
    text: opened.body.text,
    marks: [{ id: 'm1', start, end: start + quote.length, kind: 'red', comment: '定义', quote }],
  })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.ok, true)
  assert.equal(saved.body.markdownPath.startsWith(harnessHome()), true)
  const loaded = await request(calls.route.handler, 'GET', `/marginalia/api/notes?source=${encodeURIComponent(opened.body.source)}&root=${encodeURIComponent(root)}`)
  assert.equal(loaded.status, 200)
  assert.equal(loaded.body.marks.length, 1)
  assert.equal(loaded.body.marks[0].quote, quote)
  const markdown = readFileSync(saved.body.markdownPath, 'utf8')
  assert.match(markdown, /叶绿体把光变成糖。/)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(root, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('a colored mark keeps its color and an old red mark still loads', () => {
  const quote = '叶绿体把光变成糖。'
  const incoming = sanitizeIncomingMarks([{
    id: 'm-color',
    start: 0,
    end: quote.length,
    kind: 'mark',
    color: '#3b82f6',
    comment: '',
    quote,
  }])
  assert.equal(incoming.ok, true)
  assert.equal(incoming.marks[0].kind, 'mark')
  assert.equal(incoming.marks[0].color, '#3B82F6')
  const kept = reconcileMarks(`前言。${quote}`, incoming.marks)
  assert.equal(kept.dropped, 0)
  assert.equal(kept.marks[0].color, '#3B82F6')
  const legacy = sanitizeIncomingMarks([{
    id: 'm-red',
    start: 0,
    end: quote.length,
    kind: 'red',
    comment: '',
    quote,
  }])
  assert.equal(legacy.ok, true)
  assert.equal(legacy.marks[0].kind, 'red')
  assert.equal(legacy.marks[0].color, undefined)
  const bad = sanitizeIncomingMarks([{
    id: 'm-bad',
    start: 0,
    end: quote.length,
    kind: 'mark',
    color: 'blue',
    comment: '',
    quote,
  }])
  assert.equal(bad.ok, false)
})

test('rendered bold becomes markdown that the note can show and edit', () => {
  const node = {
    nodeType: 11,
    childNodes: [
      { nodeType: 1, tagName: 'STRONG', childNodes: [{ nodeType: 3, textContent: '叶绿体' }] },
      { nodeType: 3, textContent: '把光变成糖。' },
    ],
  }
  const markdown = markdownFromNode(node)
  assert.equal(markdown, '**叶绿体**把光变成糖。')
  assert.equal(plainFromMarkdown(markdown), '叶绿体把光变成糖。')
  const html = renderMarkdown(markdown)
  assert.match(html, /<strong>叶绿体<\/strong>/)
  const styled = markdownFromNode({
    nodeType: 1,
    tagName: 'SPAN',
    style: { fontWeight: '700' },
    childNodes: [{ nodeType: 3, textContent: '粗体' }],
  })
  assert.equal(styled, '**粗体**')
  const hostile = renderMarkdown('<script>alert(1)</script>\n\n**粗**')
  assert.equal(hostile.includes('<script'), false)
  assert.match(hostile, /&lt;script&gt;/)
  assert.match(hostile, /<strong>粗<\/strong>/)
  assert.equal(renderMarkdown('[x](javascript:alert(1))').includes('href='), false)
  const quote = '叶绿体把光变成糖。'
  const incoming = sanitizeIncomingMarks([{
    id: 'm-md',
    start: 0,
    end: quote.length,
    kind: 'mark',
    color: '#E04848',
    comment: '',
    quote,
    markdown,
  }])
  assert.equal(incoming.ok, true)
  assert.equal(incoming.marks[0].markdown, markdown)
  const kept = reconcileMarks(quote, incoming.marks)
  assert.equal(kept.dropped, 0)
  assert.equal(kept.marks[0].markdown, markdown)
  assert.match(notesMarkdown({ title: '细胞', source: 'session:1', marks: kept.marks }), /\*\*叶绿体\*\*/)
})

test('the conversation client uses the same markdown helpers', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const modelSrc = readFileSync(join(here, 'model.js'), 'utf8')
  const clientSrc = readFileSync(join(here, 'client.js'), 'utf8')
  for (const name of ['escapeHtml', 'inlineMarkdown', 'renderMarkdown', 'plainFromMarkdown', 'markdownFromNode', 'markdownNode', 'cleanMarkdown', 'cleanCategory']) {
    assert.equal(compactFn(clientSrc, name), compactFn(modelSrc, name), name)
  }
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

test('a note keeps its category and drops a blank or oversized one', () => {
  const quote = '叶绿体把光变成糖。'
  const incoming = sanitizeIncomingMarks([{
    id: 'm-cat',
    start: 0,
    end: quote.length,
    kind: 'mark',
    color: '#E04848',
    comment: '',
    quote,
    category: '  概念 \n',
  }])
  assert.equal(incoming.ok, true)
  assert.equal(incoming.marks[0].category, '概念')
  const kept = reconcileMarks(quote, incoming.marks)
  assert.equal(kept.dropped, 0)
  assert.equal(kept.marks[0].category, '概念')
  assert.match(notesMarkdown({ title: '细胞', source: 'session:1', marks: kept.marks }), /## 1\. 标记 · 概念/)
  const blank = sanitizeIncomingMarks([{
    id: 'm-blank',
    start: 0,
    end: quote.length,
    kind: 'note',
    comment: '',
    quote,
    category: ' \n\t ',
  }])
  assert.equal(blank.ok, true)
  assert.equal(blank.marks[0].category, undefined)
  const long = sanitizeIncomingMarks([{
    id: 'm-long',
    start: 0,
    end: quote.length,
    kind: 'note',
    comment: '',
    quote,
    category: '类'.repeat(41),
  }])
  assert.equal(long.ok, true)
  assert.equal(long.marks[0].category, undefined)
  const controls = sanitizeIncomingMarks([{
    id: 'm-ctrl',
    start: 0,
    end: quote.length,
    kind: 'note',
    comment: '',
    quote,
    category: '\u0000\u0001',
  }])
  assert.equal(controls.ok, true)
  assert.equal(controls.marks[0].category, undefined)
  const plain = notesMarkdown({ title: '细胞', source: 'session:1', marks: blank.marks })
  assert.match(plain, /## 1\. 提问/)
  assert.equal(plain.includes(' · '), false)
})

test('a question note keeps its question without an underline', () => {
  const quote = '叶绿体把光变成糖。'
  const incoming = sanitizeIncomingMarks([{
    id: 'm-note',
    start: 0,
    end: quote.length,
    kind: 'note',
    comment: '先放着',
    quote,
    question: '这是什么',
    childId: 'child-session',
  }])
  assert.equal(incoming.ok, true)
  assert.equal(incoming.marks[0].kind, 'note')
  assert.equal(incoming.marks[0].question, '这是什么')
  assert.equal(incoming.marks[0].childId, 'child-session')
  const kept = reconcileMarks(`前言。${quote}`, incoming.marks)
  assert.equal(kept.dropped, 0)
  assert.equal(kept.marks[0].kind, 'note')
  assert.equal(kept.marks[0].question, '这是什么')
  assert.equal(kept.marks[0].childId, 'child-session')
  const paired = `${quote}\n${quote}`
  const both = reconcileMarks(paired, [
    { id: 'a', start: 0, end: quote.length, kind: 'note', comment: '', quote, question: '小的' },
    { id: 'b', start: quote.length + 1, end: quote.length + 1 + quote.length, kind: 'note', comment: '', quote, question: '另一条' },
  ])
  assert.equal(both.dropped, 0)
  assert.equal(both.marks.length, 2)
  assert.equal(both.marks[0].question, '小的')
  assert.equal(both.marks[1].question, '另一条')
  const markdown = notesMarkdown({ title: '细胞', source: 'session:1', marks: kept.marks })
  assert.match(markdown, /## 1\. 提问/)
  assert.match(markdown, /提问：这是什么/)
})

test('a question stays on the underline and follows the quote', () => {
  const quote = '叶绿体把光变成糖。'
  const incoming = sanitizeIncomingMarks([{
    id: 'm1',
    start: 0,
    end: quote.length,
    kind: 'line',
    comment: '',
    quote,
    question: '这是什么',
    childId: 'child-session',
  }])
  assert.equal(incoming.ok, true)
  assert.equal(incoming.marks[0].question, '这是什么')
  assert.equal(incoming.marks[0].childId, 'child-session')
  const kept = reconcileMarks(`前言。${quote}`, incoming.marks)
  assert.equal(kept.dropped, 0)
  assert.equal(kept.marks[0].question, '这是什么')
  assert.equal(kept.marks[0].childId, 'child-session')
  assert.equal(kept.marks[0].start, '前言。'.length)
})

test('a child transcript is the assistant reply until the turn ends', () => {
  const running = childTranscript([
    { type: 'turn/start', data: {} },
    { type: 'user/message', data: { message: { content: [{ type: 'text', text: '整段提示' }] } } },
    {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'reasoning', text: '想想' }, { type: 'text', text: '叶绿体。' }] } },
    },
  ])
  assert.equal(running.running, true)
  assert.equal(running.text, '叶绿体。')
  const done = childTranscript([
    { type: 'turn/start' },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '叶绿体。' }] } } },
    { type: 'turn/end' },
  ])
  assert.equal(done.running, false)
  assert.equal(done.text, '叶绿体。')
})

test('a question starts a child session that can see the underlined quote', async () => {
  const calls = []
  const parent = {
    id: 'parent-session',
    followup(message) {
      calls.delivered = message
      return 'sent'
    },
  }
  const ctx = {
    effect(fn) {
      calls.push(fn())
    },
    webServer: {
      register(route) {
        calls.route = route
        return () => {}
      },
    },
    agents: {
      get(id) {
        return id === 'parent-session' ? parent : undefined
      },
    },
    subagents: {
      async startActivation(spec) {
        calls.spec = spec
        calls.starts += 1
        return { childId: 'child-session', messageId: 'm1' }
      },
      async [Symbol.for('dsh.subagent.deliverPrompt')](parent, childId, content, source, signal, delivery) {
        calls.prompts.push({ parent, childId, content, source, signal, delivery })
        return { messageId: 'm2' }
      },
    },
  }
  calls.starts = 0
  calls.prompts = []
  const home = mkdtempSync(join(tmpdir(), 'dsh-marginalia-threads-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  apply(ctx)
  try {
  const quote = '叶绿体把光变成糖。'
  const asked = await request(calls.route.handler, 'POST', '/marginalia/api/ask', {
    sessionId: 'parent-session',
    quote,
    question: '这是什么',
  })
  assert.equal(asked.status, 200)
  assert.equal(asked.body.childId, 'child-session')
  assert.equal(asked.body.continued, false)
  assert.equal(asked.body.parentId, 'parent-session')
  assert.equal(calls.spec.provider, 'spawn')
  assert.equal(calls.spec.request.parent, parent)
  assert.deepEqual(calls.spec.request.toolFilter, { deny: ['send_message'] })
  assert.equal(calls.spec.request.prompt[0].text, questionPrompt(quote, '这是什么'))
  assert.equal(calls.spec.request.agentOptions, undefined)
  parent.followup({ source: { kind: 'subagent-settled', senderSessionId: 'child-session' } })
  assert.equal(calls.delivered, undefined)
  parent.followup({ source: { kind: 'user' } })
  assert.equal(calls.delivered.source.kind, 'user')
  const role = await request(calls.route.handler, 'GET', '/marginalia/api/thread?sessionId=child-session')
  assert.equal(role.status, 200)
  assert.equal(role.body.role, 'child')
  assert.equal(role.body.parentId, 'parent-session')
  const followed = await request(calls.route.handler, 'POST', '/marginalia/api/ask', {
    sessionId: 'child-session',
    quote: '是叶绿体。',
    question: '再具体一点',
  })
  assert.equal(followed.status, 200)
  assert.equal(followed.body.childId, 'child-session')
  assert.equal(followed.body.continued, true)
  assert.equal(calls.starts, 1)
  assert.equal(calls.prompts[0].parent, parent)
  assert.equal(calls.prompts[0].childId, 'child-session')
  assert.equal(calls.prompts[0].content[0].text, followUpPrompt('是叶绿体。', '再具体一点'))
  const fromMain = await request(calls.route.handler, 'POST', '/marginalia/api/ask', {
    sessionId: 'parent-session',
    quote,
    question: '换个说法',
    continueId: 'child-session',
  })
  assert.equal(fromMain.status, 200)
  assert.equal(fromMain.body.continued, true)
  assert.equal(calls.starts, 1)
  assert.equal(calls.prompts.length, 2)
  const missing = await request(calls.route.handler, 'POST', '/marginalia/api/ask', {
    sessionId: 'other-session',
    quote,
    question: '这是什么',
  })
  assert.equal(missing.status, 409)
  const early = await request(calls.route.handler, 'GET', '/marginalia/api/child?childId=child-session')
  assert.equal(early.status, 404)
  ctx.get = () => ({
    get(id) {
      if (id !== 'child-session') return undefined
      return {
        snapshotEvents() {
          return [
            { type: 'turn/start' },
            { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '是叶绿体。' }] } } },
            { type: 'turn/end' },
          ]
        },
      }
    },
  })
  const child = await request(calls.route.handler, 'GET', '/marginalia/api/child?childId=child-session')
  assert.equal(child.status, 200)
  assert.equal(child.body.running, false)
  assert.equal(child.body.text, '是叶绿体。')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('a question still starts when this build has no send_message tool', async () => {
  const calls = []
  const parent = { id: 'parent-session' }
  const ctx = {
    effect(fn) {
      calls.push(fn())
    },
    webServer: {
      register(route) {
        calls.route = route
        return () => {}
      },
    },
    agents: {
      get(id) {
        return id === 'parent-session' ? parent : undefined
      },
    },
    subagents: {
      async startActivation(spec) {
        calls.attempts.push(spec)
        if (spec.request.toolFilter) {
          throw new Error('tools.restrict() names unknown global tool "send_message"; known global tools: read')
        }
        return { childId: 'child-plain', messageId: 'm1' }
      },
      async [Symbol.for('dsh.subagent.deliverPrompt')]() {
        return { messageId: 'm2' }
      },
    },
  }
  calls.attempts = []
  const home = mkdtempSync(join(tmpdir(), 'dsh-marginalia-threads-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  apply(ctx)
  try {
  const asked = await request(calls.route.handler, 'POST', '/marginalia/api/ask', {
    sessionId: 'parent-session',
    quote: '叶绿体把光变成糖。',
    question: '这是什么',
  })
  assert.equal(asked.status, 200)
  assert.equal(asked.body.childId, 'child-plain')
  assert.equal(calls.attempts.length, 2)
  assert.deepEqual(calls.attempts[0].request.toolFilter, { deny: ['send_message'] })
  assert.equal(calls.attempts[1].request.toolFilter, undefined)
  assert.equal(calls.attempts[1].request.parent, parent)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('asking inside an older subagent continues that same thread', async () => {
  const calls = []
  const parent = { id: 'parent-session' }
  const child = { session: { header: { origin: 'subagent', parentSession: 'parent-session' } } }
  const ctx = {
    effect(fn) {
      calls.push(fn())
    },
    webServer: {
      register(route) {
        calls.route = route
        return () => {}
      },
    },
    agents: {
      get(id) {
        if (id === 'parent-session') return parent
        if (id === 'older-child') return child
        return undefined
      },
    },
    subagents: {
      async startActivation() {
        calls.started = true
        return { childId: 'nested', messageId: 'm1' }
      },
      async [Symbol.for('dsh.subagent.deliverPrompt')](parent, childId, content, source, signal, delivery) {
        calls.prompt = { parent, childId, content, source, signal, delivery }
        return { messageId: 'm2' }
      },
    },
  }
  const home = mkdtempSync(join(tmpdir(), 'dsh-marginalia-threads-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  apply(ctx)
  try {
    const asked = await request(calls.route.handler, 'POST', '/marginalia/api/ask', {
      sessionId: 'older-child',
      quote: '是叶绿体。',
      question: '再具体一点',
    })
    assert.equal(asked.status, 200)
    assert.equal(asked.body.continued, true)
    assert.equal(asked.body.childId, 'older-child')
    assert.equal(asked.body.parentId, 'parent-session')
    assert.equal(calls.started, undefined)
    assert.equal(calls.prompt.childId, 'older-child')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('a new question can pick a catalog model and a follow-up can switch it', async () => {
  const profile = `
- id: llm-pi-ai
  config:
    providers:
      deepseek-official:
        displayName: DeepSeek
        apiKeyEnv: SHOULD_NOT_LEAK
        models:
          - id: deepseek-v4-pro
            name: 别的名字
      shusheng:
        displayName: 书生
        apiKeyEnv: SHUSHENG_API_KEY
        api: openai-completions
        baseURL: https://example.invalid/v1
        models:
          - id: glm-5.3
            name: GLM-5.3
          - id: intern-s2
            name: "书生-S2"
`
  const listed = listStudyModels(profile)
  assert.deepEqual(listed.map((item) => `${item.provider}|${item.id}|${item.name}|${item.providerName}`), [
    'deepseek-official|deepseek-v4-pro|DeepSeek V4 Pro|DeepSeek',
    'deepseek-official|deepseek-flash|DeepSeek Flash|DeepSeek',
    'shusheng|glm-5.3|GLM-5.3|书生',
    'shusheng|intern-s2|书生-S2|书生',
  ])
  assert.equal(JSON.stringify(listed).includes('SHOULD_NOT_LEAK'), false)
  assert.equal(JSON.stringify(listed).includes('example.invalid'), false)
  assert.equal(resolveStudyModel(listed, '', ''), null)
  assert.deepEqual(resolveStudyModel(listed, 'shusheng', 'glm-5.3'), { provider: 'shusheng', model: 'glm-5.3' })
  assert.throws(() => resolveStudyModel(listed, 'shusheng', 'missing'), /没有这个模型/)

  const calls = []
  const parent = { id: 'parent-session' }
  const childLog = []
  const childAgent = {
    options: { provider: 'deepseek-official', model: 'deepseek-flash' },
    session: {
      append(type, data) {
        childLog.push({ type, data })
        calls.selection = { type, data }
      },
      snapshotEvents() {
        return childLog.map((item) => ({ type: item.type, data: item.data }))
      },
    },
    ctx: {
      on(name) {
        calls.hooks.push(name)
        return () => {}
      },
    },
  }
  const ctx = {
    effect(fn) {
      calls.push(fn())
    },
    webServer: {
      register(route) {
        calls.route = route
        return () => {}
      },
    },
    agents: {
      get(id) {
        if (id === 'parent-session') return parent
        if (id === 'child-model') return childAgent
        return undefined
      },
    },
    subagents: {
      async startActivation(spec) {
        calls.attempts.push(spec)
        if (spec.request.toolFilter) {
          throw new Error('tools.restrict() names unknown global tool "send_message"; known global tools: read')
        }
        return { childId: 'child-model', messageId: 'm1' }
      },
      async [Symbol.for('dsh.subagent.deliverPrompt')](parent, childId, content, source, signal, delivery) {
        calls.prompts.push({ parent, childId, content, source, signal, delivery })
        return { messageId: 'm2' }
      },
    },
  }
  calls.attempts = []
  calls.prompts = []
  calls.hooks = []
  const home = mkdtempSync(join(tmpdir(), 'dsh-marginalia-models-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  apply(ctx)
  try {
    const bare = await request(calls.route.handler, 'GET', '/marginalia/api/models')
    assert.equal(bare.status, 200)
    assert.deepEqual(bare.body.models.map((item) => item.id), ['deepseek-v4-pro', 'deepseek-flash'])
    mkdirSync(join(home, 'profiles', 'desktop'), { recursive: true })
    writeFileSync(join(home, 'profiles', 'desktop', 'cordis.patch.yml'), profile, 'utf8')
    const loaded = await request(calls.route.handler, 'GET', '/marginalia/api/models')
    assert.equal(loaded.status, 200)
    assert.equal(JSON.stringify(loaded.body).includes('SHOULD_NOT_LEAK'), false)
    assert.equal(JSON.stringify(loaded.body).includes('SHUSHENG_API_KEY'), false)
    assert.equal(loaded.body.models.find((item) => item.id === 'glm-5.3').providerName, '书生')
    assert.equal(loaded.body.models.find((item) => item.id === 'deepseek-v4-pro').name, 'DeepSeek V4 Pro')
    const quote = '叶绿体把光变成糖。'
    const asked = await request(calls.route.handler, 'POST', '/marginalia/api/ask', {
      sessionId: 'parent-session',
      quote,
      question: '这是什么',
      provider: 'deepseek-official',
      model: 'deepseek-flash',
    })
    assert.equal(asked.status, 200)
    assert.equal(asked.body.continued, false)
    assert.equal(calls.attempts.length, 2)
    assert.deepEqual(calls.attempts[0].request.agentOptions, { provider: 'deepseek-official', model: 'deepseek-flash' })
    assert.deepEqual(calls.attempts[0].request.toolFilter, { deny: ['send_message'] })
    assert.deepEqual(calls.attempts[1].request.agentOptions, { provider: 'deepseek-official', model: 'deepseek-flash' })
    assert.equal(calls.attempts[1].request.toolFilter, undefined)
    const followed = await request(calls.route.handler, 'POST', '/marginalia/api/ask', {
      sessionId: 'child-model',
      quote: '是叶绿体。',
      question: '再具体一点',
      provider: 'shusheng',
      model: 'glm-5.3',
    })
    assert.equal(followed.status, 200)
    assert.equal(followed.body.continued, true)
    assert.equal(calls.attempts.length, 2)
    assert.equal(calls.prompts[0].childId, 'child-model')
    assert.equal(calls.prompts[0].parent, parent)
    assert.deepEqual(calls.selection, { type: 'model/selection', data: { provider: 'shusheng', model: 'glm-5.3' } })
    assert.deepEqual(calls.hooks, ['system-prompt/assemble', 'agent/request'])
    const switched = await request(calls.route.handler, 'POST', '/marginalia/api/model', {
      sessionId: 'child-model',
      provider: 'shusheng',
      model: 'intern-s2',
    })
    assert.equal(switched.status, 200)
    assert.equal(switched.body.model, 'intern-s2')
    assert.equal(calls.hooks.length, 2)
    const info = await request(calls.route.handler, 'GET', '/marginalia/api/thread?sessionId=child-model')
    assert.equal(info.status, 200)
    assert.equal(info.body.provider, 'shusheng')
    assert.equal(info.body.model, 'intern-s2')
    const unknown = await request(calls.route.handler, 'POST', '/marginalia/api/ask', {
      sessionId: 'parent-session',
      quote,
      question: '换一个',
      provider: 'deepseek-official',
      model: 'not-a-model',
    })
    assert.equal(unknown.status, 400)
    assert.equal(unknown.body.error.message, '没有这个模型')
    assert.equal(calls.attempts.length, 2)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})

function request(handler, method, path, json) {
  const chunks = []
  const body = json ? Buffer.from(JSON.stringify(json)) : null
  const req = {
    url: path,
    method,
    headers: {},
    async *[Symbol.asyncIterator]() {
      if (body) yield body
    },
  }
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value
    },
    end(payload) {
      chunks.push(payload)
    },
  }
  return handler(req, res).then(() => ({
    status: res.statusCode,
    body: JSON.parse(chunks.join('')),
  }))
}
