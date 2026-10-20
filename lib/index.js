/**
 * dsh-marginalia — host half.
 *
 * The sidebar browser draws pages in a sandboxed iframe, so this plugin
 * cannot paint on that frame. It reads the page (local html/markdown/txt,
 * or an http(s) URL) into plain text, then stores the marks the client makes.
 *
 * Notes stay under ~/.dsh/study-notes, not inside the project, so a study
 * session does not dirty the git repo the page came from.
 *
 * process.cwd() is the DSH app directory. The project root is the session
 * cwd the client sends, then the default workspace in workspace.json.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  MAX_SOURCE,
  clipText,
  fallbackTitle,
  htmlToText,
  insideRoot,
  isHttpSource,
  isPageFile,
  notesMarkdown,
  pageKey,
  reconcileMarks,
  sanitizeIncomingMarks,
  titleFromText,
} from './model.js'

export const name = 'dsh-marginalia'
export const inject = ['webServer', 'agents', 'subagents']

/** The first turn only sees this prompt. Spawn does not inherit the parent transcript. */
export function questionPrompt(quote, question) {
  return `下面这段是从回复里划出来的：\n\n${quote}\n\n请只根据这段内容回答：${question}\n\n只在这次回复里作答，不要给别的对话发消息。`
}

/** A later turn keeps the child session's own memory and adds the new span. */
export function followUpPrompt(quote, question) {
  return `顺着这次已经开始的讨论往下说，前面的回答仍然算数。\n\n新划出的内容：\n\n${quote}\n\n请回答：${question}\n\n只在这次回复里作答，不要给别的对话发消息。`
}

function threadFile() {
  return join(harnessHome(), 'study-threads.json')
}

function readThreads() {
  try {
    const data = JSON.parse(readFileSync(threadFile(), 'utf8'))
    if (!data || typeof data.children !== 'object' || data.children === null || Array.isArray(data.children)) return {}
    return data.children
  } catch {
    return {}
  }
}

function rememberThread(parentId, childId) {
  const children = readThreads()
  children[childId] = parentId
  mkdirSync(harnessHome(), { recursive: true })
  writeFileSync(threadFile(), JSON.stringify({ children }))
}

function studyError(error) {
  const message = String(error && error.message ? error.message : error)
  if (message.includes('cannot be resumed') || message.includes('not-resumable') || message.includes('NOT_RESUMABLE')) {
    return Object.assign(new Error('这条进程是一次性的，不能往下续。请在主对话里重新提问。'), { status: 409, code: 'not-resumable' })
  }
  if (message.includes('parent-unavailable') || message.includes('not live')) {
    return Object.assign(new Error('当前对话没有在运行，接不上下一条。'), { status: 409, code: 'no-agent' })
  }
  if (error && error.status) return error
  return Object.assign(new Error(message || '子进程没有接上'), { status: 502, code: 'continue-failed' })
}

/** Drop this plugin's child echoes. A continuable child otherwise writes its closing text back under the main conversation. */
function silenceParent(parent) {
  if (!parent || parent.__dshMarginaliaSilence) return
  try {
    parent.__dshMarginaliaSilence = true
    for (const method of ['followup', 'steer', 'inject']) {
      const original = parent[method]
      if (typeof original !== 'function') continue
      parent[method] = function silenced(message, ...rest) {
        const source = message && message.source
        const sender = source && typeof source.senderSessionId === 'string' ? source.senderSessionId : ''
        const children = readThreads()
        if (sender && Object.prototype.hasOwnProperty.call(children, sender) && (source.kind === 'subagent-settled' || source.kind === 'agent-message')) {
          return undefined
        }
        return original.call(this, message, ...rest)
      }
    }
  } catch {
    /* the child still runs; a failed wrap must not block the question */
  }
}

function canContinue(ctx) {
  return !!(ctx.subagents && typeof ctx.subagents.startActivation === 'function' && typeof ctx.subagents[Symbol.for('dsh.subagent.deliverPrompt')] === 'function')
}

function headerOf(ctx, sessionId) {
  const agent = ctx.agents.get(sessionId)
  if (agent && agent.session && agent.session.header) return agent.session.header
  try {
    const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : null
    const session = sessions && typeof sessions.get === 'function' ? sessions.get(sessionId) : null
    if (session && session.header) return session.header
  } catch {
    return null
  }
  return null
}

function parentOf(ctx, sessionId) {
  const threads = readThreads()
  if (Object.prototype.hasOwnProperty.call(threads, sessionId)) return threads[sessionId]
  const header = headerOf(ctx, sessionId)
  if (header && header.origin === 'subagent' && typeof header.parentSession === 'string' && header.parentSession.trim()) {
    return header.parentSession.trim()
  }
  return ''
}

const childModelHooks = new WeakMap()

function describedModel(ctx, sessionId) {
  try {
    const agent = ctx.agents.get(sessionId)
    if (!agent) return null
    const events = agent.session && typeof agent.session.snapshotEvents === 'function' ? agent.session.snapshotEvents() : []
    if (Array.isArray(events)) {
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const event = events[i]
        const data = event && event.data
        if (event && event.type === 'model/selection' && data && typeof data.provider === 'string' && typeof data.model === 'string') {
          return { provider: data.provider, model: data.model }
        }
      }
    }
    const options = agent.options
    if (options && typeof options.provider === 'string' && typeof options.model === 'string' && options.provider && options.model) {
      return { provider: options.provider, model: options.model }
    }
  } catch {
    return null
  }
  return null
}

function installLocalModelHook(agent, hook) {
  const agentCtx = agent.ctx
  if (!agentCtx || typeof agentCtx.on !== 'function') return
  agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const selected = hook.current
    const assembled = typeof next === 'function' ? await next() : _assembly
    hook.assembled = selected
    if (!selected || !assembled || typeof assembled !== 'object') return assembled
    return {
      ...assembled,
      variables: { ...(assembled.variables || {}), provider: selected.provider, model: selected.model },
    }
  })
  agentCtx.on('agent/request', async (_payload, next) => {
    const resolved = typeof next === 'function' ? await next() : _payload
    const selected = hook.assembled
    if (!selected || !resolved || typeof resolved !== 'object') return resolved
    const rest = { ...resolved }
    delete rest.reasoningEffort
    return { ...rest, provider: selected.provider, model: selected.model }
  })
}

async function installChildModel(agent, selection) {
  let hook = childModelHooks.get(agent)
  if (!hook) {
    hook = { current: selection, assembled: undefined }
    childModelHooks.set(agent, hook)
    try {
      const official = await import('@deepseek-ai/dsh-agent')
      if (official && typeof official.installModelSelection === 'function' && agent.ctx) {
        official.installModelSelection(agent.ctx, hook)
        return
      }
    } catch {
      /* The local hook below routes the next turn when the package is not on this path. */
    }
    try {
      installLocalModelHook(agent, hook)
    } catch {
      /* The selection event is still on the session. */
    }
    return
  }
  hook.current = selection
}

async function applyChildModel(ctx, childId, agentOptions) {
  const agent = ctx.agents.get(childId)
  if (!agent) {
    throw Object.assign(new Error('这条进程没有在运行，换不了模型。'), { status: 409, code: 'no-agent' })
  }
  const selection = { provider: agentOptions.provider, model: agentOptions.model }
  try {
    if (agent.session && typeof agent.session.append === 'function') {
      agent.session.append('model/selection', selection)
    }
  } catch {
    /* Routing still follows the hook when the log refuses the event. */
  }
  await installChildModel(agent, selection)
}

async function continueThread(ctx, parentId, childId, quote, question, agentOptions) {
  const parent = ctx.agents.get(parentId)
  if (!parent) {
    throw Object.assign(new Error('当前对话没有在运行，接不上下一条。'), { status: 409, code: 'no-agent' })
  }
  silenceParent(parent)
  rememberThread(parentId, childId)
  if (agentOptions) await applyChildModel(ctx, childId, agentOptions)
  const controller = new AbortController()
  try {
    await ctx.subagents[Symbol.for('dsh.subagent.deliverPrompt')](
      parent,
      childId,
      [{ type: 'text', text: followUpPrompt(quote, question) }],
      { kind: 'user' },
      controller.signal,
      'queue',
    )
  } catch (error) {
    throw studyError(error)
  }
  return { childId, parentId, continued: true }
}

async function startContinuableChild(ctx, parent, label, text, signal, agentOptions) {
  const request = {
    parent,
    prompt: [{ type: 'text', text }],
  }
  if (agentOptions) request.agentOptions = { provider: agentOptions.provider, model: agentOptions.model }
  const spec = { provider: 'spawn', label, signal }
  try {
    return await ctx.subagents.startActivation({ ...spec, request: { ...request, toolFilter: { deny: ['send_message'] } } })
  } catch (error) {
    const message = String(error && error.message ? error.message : error)
    if (!message.includes('unknown global tool') || !message.includes('"send_message"')) throw error
    return await ctx.subagents.startActivation({ ...spec, request })
  }
}

async function askChild(ctx, sessionId, quote, question, continueId, requested) {
  if (!ctx.agents || typeof ctx.agents.get !== 'function' || !canContinue(ctx)) {
    throw Object.assign(new Error('这个版本开不了子进程'), { status: 501, code: 'no-subagent' })
  }
  const agentOptions = resolveStudyModel(
    listStudyModels(readDesktopProfile()),
    requested && requested.provider,
    requested && requested.model,
  )
  const runningParent = parentOf(ctx, sessionId)
  if (runningParent) return continueThread(ctx, runningParent, sessionId, quote, question, agentOptions)
  const linked = typeof continueId === 'string' ? continueId.trim() : ''
  const threads = readThreads()
  if (linked && Object.prototype.hasOwnProperty.call(threads, linked)) {
    return continueThread(ctx, threads[linked], linked, quote, question, agentOptions)
  }
  const parent = ctx.agents.get(sessionId)
  if (!parent) {
    throw Object.assign(new Error('当前对话没有在运行，开不了子进程'), { status: 409, code: 'no-agent' })
  }
  silenceParent(parent)
  const controller = new AbortController()
  const started = await startContinuableChild(
    ctx,
    parent,
    question.replace(/\s+/g, ' ').slice(0, 40),
    questionPrompt(quote, question),
    controller.signal,
    agentOptions,
  )
  const childId = started && typeof started.childId === 'string' ? started.childId : ''
  if (!childId) {
    throw Object.assign(new Error('子进程没有返回编号'), { status: 502, code: 'no-child' })
  }
  rememberThread(sessionId, childId)
  return { childId, parentId: sessionId, continued: false }
}

function textBlocks(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) parts.push(block.text)
  }
  return parts.join('\n')
}

function streamText(stream) {
  if (!Array.isArray(stream)) return ''
  const parts = []
  for (const record of stream) {
    if (!record || record.type !== 'text-chunks' || !Array.isArray(record.texts)) continue
    const joined = record.texts.filter((part) => typeof part === 'string').join('')
    if (joined.trim()) parts.push(joined)
  }
  return parts.join('')
}

/** Latest assistant reply. `running` stays true from turn/start until turn/end. */
export function childTranscript(events) {
  let running = false
  let text = ''
  const list = Array.isArray(events) ? events : []
  for (const event of list) {
    if (!event || typeof event !== 'object') continue
    if (event.type === 'turn/start') running = true
    else if (event.type === 'turn/end') running = false
    else if (event.type === 'assistant/message') {
      const next = textBlocks(event.data && event.data.message && event.data.message.content)
      if (next) text = next
    } else if (event.type === 'assistant/attempt') {
      const next = streamText(event.data && event.data.stream)
      if (next) text = next
    }
  }
  if (text.length > 20_000) text = `${text.slice(0, 20_000)}…`
  return { running, text }
}

function sessionEvents(ctx, childId) {
  const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : null
  const session = sessions && typeof sessions.get === 'function' ? sessions.get(childId) : null
  if (!session || typeof session.snapshotEvents !== 'function') return null
  const events = session.snapshotEvents()
  return Array.isArray(events) ? events : []
}

const API_PREFIX = '/marginalia/api'
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_DOWNLOAD_BYTES = 1_500_000
const FETCH_TIMEOUT_MS = 8_000

function writeJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

function fail(res, status, code, message) {
  writeJson(res, status, { ok: false, error: { code, message } })
}

async function readJson(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk)
    total += buffer.length
    if (total > 1_000_000) {
      const error = new Error('请求太大')
      error.status = 413
      throw error
    }
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return {}
  try {
    return JSON.parse(text)
  } catch {
    const error = new Error('请求不是 JSON')
    error.status = 400
    throw error
  }
}

export function harnessHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

const OFFICIAL_MODELS = [
  { provider: 'deepseek-official', providerName: 'DeepSeek', id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
  { provider: 'deepseek-official', providerName: 'DeepSeek', id: 'deepseek-flash', name: 'DeepSeek Flash' },
]

function yamlScalar(value) {
  const raw = String(value || '').trim()
  if (raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))) {
    return raw.slice(1, -1).trim()
  }
  return raw
}

/** Model names from the desktop profile. Keys and endpoints stay on the host. */
export function catalogFromProfile(text) {
  const models = []
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/)
  let inProviders = false
  let providersIndent = -1
  let provider = ''
  let providerName = ''
  let inModels = false
  let modelsIndent = -1
  let current = null
  for (const raw of lines) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue
    const indent = raw.match(/^ */)?.[0].length || 0
    const line = raw.trim()
    if (!inProviders) {
      if (line === 'providers:') {
        inProviders = true
        providersIndent = indent
      }
      continue
    }
    if (indent <= providersIndent) break
    const providerKey = line.match(/^([A-Za-z0-9][A-Za-z0-9_.-]*):$/)
    if (indent === providersIndent + 2 && providerKey) {
      provider = providerKey[1]
      providerName = provider
      inModels = false
      current = null
      continue
    }
    if (!provider) continue
    if (indent === providersIndent + 4 && line.startsWith('displayName:')) {
      const name = yamlScalar(line.slice('displayName:'.length))
      if (name) providerName = name
      continue
    }
    if (indent === providersIndent + 4 && line === 'models:') {
      inModels = true
      modelsIndent = indent
      current = null
      continue
    }
    if (inModels && indent <= modelsIndent) {
      inModels = false
      current = null
    }
    if (!inModels) continue
    if (line.startsWith('- id:')) {
      const id = yamlScalar(line.slice('- id:'.length))
      current = id ? { provider, providerName, id, name: id } : null
      if (current) models.push(current)
      continue
    }
    if (current && line.startsWith('name:')) {
      const name = yamlScalar(line.slice('name:'.length))
      if (name) current.name = name
    }
  }
  return models
}

export function listStudyModels(profileText) {
  const seen = new Set()
  const out = []
  for (const model of [...OFFICIAL_MODELS, ...catalogFromProfile(profileText)]) {
    if (!model || !model.provider || !model.id) continue
    const key = `${model.provider}\n${model.id}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      provider: model.provider,
      providerName: model.providerName || model.provider,
      id: model.id,
      name: model.name || model.id,
    })
  }
  return out
}

/** Empty means inherit the parent. A follow-up does not call this. */
export function resolveStudyModel(models, provider, model) {
  const chosenProvider = typeof provider === 'string' ? provider.trim() : ''
  const chosenModel = typeof model === 'string' ? model.trim() : ''
  if (!chosenProvider && !chosenModel) return null
  const known = Array.isArray(models) && models.some((item) => item.provider === chosenProvider && item.id === chosenModel)
  if (!known) {
    throw Object.assign(new Error('没有这个模型'), { status: 400, code: 'bad-model' })
  }
  return { provider: chosenProvider, model: chosenModel }
}

function readDesktopProfile() {
  try {
    return readFileSync(join(harnessHome(), 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8')
  } catch {
    return ''
  }
}

export function resolveWorkspaceRoot(fallback) {
  try {
    const raw = JSON.parse(readFileSync(join(harnessHome(), 'storages', 'workspace.json'), 'utf8'))
    const id = raw?.global?.defaultWorkspaceId
    const ws = id ? raw?.tables?.workspaces?.[id] : null
    if (ws && typeof ws.path === 'string' && ws.path.trim()) return ws.path
    const all = Object.values(raw?.tables?.workspaces || {})
    const latest = all.sort((a, b) => String(b?.updatedAt || '').localeCompare(String(a?.updatedAt || '')))[0]
    if (latest && typeof latest.path === 'string' && latest.path.trim()) return latest.path
  } catch {
    /* fall through */
  }
  return fallback
}

function workspaceRoot(requested) {
  const candidate = typeof requested === 'string' ? requested.trim() : ''
  if (!candidate) return resolveWorkspaceRoot(process.cwd())
  try {
    const info = statSync(candidate)
    if (!info.isDirectory()) return null
    return candidate
  } catch {
    return null
  }
}

function notesPaths(root, source) {
  const dir = join(harnessHome(), 'study-notes', pageKey(root))
  const key = pageKey(source)
  return {
    dir,
    key,
    indexPath: join(dir, 'index.json'),
    markdownPath: join(dir, `${key}.md`),
  }
}

function readIndex(indexPath) {
  try {
    const parsed = JSON.parse(readFileSync(indexPath, 'utf8'))
    if (parsed && parsed.pages && typeof parsed.pages === 'object') return parsed
  } catch {
    /* a missing index is a new notebook */
  }
  return { version: 1, pages: {} }
}

function pageRecord(index, key) {
  const page = index.pages[key]
  if (!page || typeof page !== 'object') return null
  return {
    source: typeof page.source === 'string' ? page.source : '',
    title: typeof page.title === 'string' ? page.title : '',
    updatedAt: typeof page.updatedAt === 'string' ? page.updatedAt : '',
    marks: Array.isArray(page.marks) ? page.marks : [],
  }
}

async function loadPage(source, root) {
  if (isHttpSource(source)) {
    let url
    try {
      url = new URL(source)
    } catch {
      throw Object.assign(new Error('链接格式不对'), { status: 400, code: 'bad-source' })
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw Object.assign(new Error('只打开 http 或 https 页面'), { status: 400, code: 'bad-source' })
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      const response = await fetch(url, {
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          accept: 'text/html, text/plain;q=0.9',
          'user-agent': 'dsh-marginalia/0.1',
        },
      })
      if (!response.ok) {
        throw Object.assign(new Error(`页面返回 ${response.status}`), { status: 502, code: 'fetch-failed' })
      }
      const finalUrl = response.url || url.href
      if (!isHttpSource(finalUrl)) {
        throw Object.assign(new Error('跳转之后不是 http(s) 页面'), { status: 400, code: 'bad-source' })
      }
      const type = String(response.headers.get('content-type') || '')
      const length = Number(response.headers.get('content-length') || 0)
      if (length > MAX_DOWNLOAD_BYTES) {
        throw Object.assign(new Error('页面超过 1.5MB'), { status: 413, code: 'too-large' })
      }
      const bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.length > MAX_DOWNLOAD_BYTES) {
        throw Object.assign(new Error('页面超过 1.5MB'), { status: 413, code: 'too-large' })
      }
      const raw = bytes.toString('utf8')
      const looksHtml = /html|xml/i.test(type) || /^\s*</.test(raw)
      if (!looksHtml && type && !/text\//i.test(type)) {
        throw Object.assign(new Error(`这个地址不是文本页面（${type.split(';')[0]}）`), { status: 415, code: 'not-text' })
      }
      if (looksHtml) {
        const extracted = htmlToText(raw)
        const clipped = clipText(extracted.text)
        return {
          source: finalUrl,
          kind: 'url',
          title: extracted.title || fallbackTitle(finalUrl),
          ...clipped,
        }
      }
      const clipped = clipText(raw)
      return {
        source: finalUrl,
        kind: 'url',
        title: titleFromText(clipped.text, fallbackTitle(finalUrl)),
        ...clipped,
      }
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw Object.assign(new Error('打开页面超时'), { status: 504, code: 'timeout' })
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  const abs = insideRoot(root, source)
  if (!abs) {
    throw Object.assign(new Error('文件必须在当前工作区里面'), { status: 400, code: 'outside-root' })
  }
  if (!isPageFile(abs)) {
    throw Object.assign(new Error('这一步只打开 html、markdown 和 txt'), { status: 415, code: 'not-page' })
  }
  let info
  try {
    info = statSync(abs)
  } catch {
    throw Object.assign(new Error('找不到这个文件'), { status: 404, code: 'not-found' })
  }
  if (!info.isFile()) {
    throw Object.assign(new Error('这不是文件'), { status: 400, code: 'not-file' })
  }
  if (info.size > MAX_FILE_BYTES) {
    throw Object.assign(new Error('文件超过 2MB'), { status: 413, code: 'too-large' })
  }
  const raw = readFileSync(abs, 'utf8')
  const html = isPageFile(abs) && /\.html?$/i.test(abs)
  if (html) {
    const extracted = htmlToText(raw)
    const clipped = clipText(extracted.text)
    return {
      source: abs,
      kind: 'file',
      title: extracted.title || fallbackTitle(abs),
      ...clipped,
    }
  }
  const clipped = clipText(raw)
  return {
    source: abs,
    kind: 'file',
    title: titleFromText(clipped.text, fallbackTitle(abs)),
    ...clipped,
  }
}

function openNotebook(root, source, text, title) {
  const paths = notesPaths(root, source)
  const index = readIndex(paths.indexPath)
  const existing = pageRecord(index, paths.key)
  const reconciled = reconcileMarks(text, existing?.marks || [])
  return {
    paths,
    index,
    title: existing?.title || title,
    marks: reconciled.marks,
    dropped: reconciled.dropped,
    markdownPath: paths.markdownPath,
  }
}

function writeNotebook(root, source, title, marks) {
  const paths = notesPaths(root, source)
  mkdirSync(paths.dir, { recursive: true })
  const index = readIndex(paths.indexPath)
  const updatedAt = new Date().toISOString()
  index.version = 1
  index.pages[paths.key] = { source, title, updatedAt, marks }
  const markdown = notesMarkdown({ title, source, marks })
  writeFileSync(paths.indexPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
  writeFileSync(paths.markdownPath, markdown, 'utf8')
  return { updatedAt, markdownPath: paths.markdownPath, markdown }
}

export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: async (req, res) => {
          try {
            const url = new URL(req.url || '/', 'http://localhost')
            const sub = url.pathname.slice(API_PREFIX.length).replace(/^\/+/, '')
            if (sub === 'page' && req.method === 'GET') {
              const source = (url.searchParams.get('source') || '').trim()
              if (!source || source.length > MAX_SOURCE) {
                fail(res, 400, 'bad-source', '缺一个页面地址或文件路径')
                return
              }
              const root = workspaceRoot(url.searchParams.get('root') || '')
              if (!root) {
                fail(res, 400, 'bad-root', '工作区路径不存在')
                return
              }
              const page = await loadPage(source, root)
              const notebook = openNotebook(root, page.source, page.text, page.title)
              writeJson(res, 200, {
                ok: true,
                source: page.source,
                kind: page.kind,
                title: notebook.title,
                text: page.text,
                truncated: page.truncated,
                marks: notebook.marks,
                dropped: notebook.dropped,
                markdownPath: notebook.markdownPath,
              })
              return
            }
            if (sub === 'notes' && req.method === 'GET') {
              const source = (url.searchParams.get('source') || '').trim()
              if (!source || source.length > MAX_SOURCE) {
                fail(res, 400, 'bad-source', '缺笔记来源')
                return
              }
              const root = workspaceRoot(url.searchParams.get('root') || '')
              if (!root) {
                fail(res, 400, 'bad-root', '工作区路径不存在')
                return
              }
              const paths = notesPaths(root, source)
              const page = pageRecord(readIndex(paths.indexPath), paths.key)
              writeJson(res, 200, {
                ok: true,
                source,
                title: page?.title || '',
                marks: page?.marks || [],
                markdownPath: paths.markdownPath,
              })
              return
            }
            if (sub === 'notes' && req.method === 'POST') {
              const body = await readJson(req)
              const source = typeof body.source === 'string' ? body.source.trim() : ''
              const title = typeof body.title === 'string' ? body.title.trim().slice(0, 120) : ''
              const text = typeof body.text === 'string' ? body.text : ''
              if (!source || source.length > MAX_SOURCE) {
                fail(res, 400, 'bad-source', '缺页面来源')
                return
              }
              if (text.length > 120_000) {
                fail(res, 413, 'too-large', '页面文本太长')
                return
              }
              const root = workspaceRoot(typeof body.root === 'string' ? body.root : '')
              if (!root) {
                fail(res, 400, 'bad-root', '工作区路径不存在')
                return
              }
              const incoming = sanitizeIncomingMarks(body.marks)
              if (!incoming.ok) {
                fail(res, 400, 'bad-marks', incoming.message)
                return
              }
              const reconciled = reconcileMarks(text, incoming.marks)
              const saved = writeNotebook(root, source, title || fallbackTitle(source), reconciled.marks)
              writeJson(res, 200, {
                ok: true,
                marks: reconciled.marks,
                dropped: reconciled.dropped,
                updatedAt: saved.updatedAt,
                markdownPath: saved.markdownPath,
                markdown: saved.markdown,
              })
              return
            }
            if (sub === 'child' && req.method === 'GET') {
              const childId = (url.searchParams.get('childId') || '').trim()
              if (!childId || childId.length > 200) {
                fail(res, 400, 'bad-child', '没有这条进程')
                return
              }
              let events = null
              try {
                events = sessionEvents(ctx, childId)
              } catch (error) {
                fail(res, 500, 'child-failed', String(error && error.message ? error.message : error))
                return
              }
              if (!events) {
                fail(res, 404, 'no-child', '这条进程还没挂上')
                return
              }
              const transcript = childTranscript(events)
              writeJson(res, 200, { ok: true, childId, running: transcript.running, text: transcript.text })
              return
            }
            if (sub === 'thread' && req.method === 'GET') {
              const sessionId = (url.searchParams.get('sessionId') || '').trim()
              if (!sessionId || sessionId.length > 200) {
                fail(res, 400, 'bad-session', '没有当前对话')
                return
              }
              const threads = readThreads()
              const parentId = Object.prototype.hasOwnProperty.call(threads, sessionId) ? threads[sessionId] : ''
              const current = parentId ? describedModel(ctx, sessionId) : null
              writeJson(res, 200, parentId
                ? {
                  ok: true,
                  role: 'child',
                  sessionId,
                  parentId,
                  childId: sessionId,
                  ...current ? { provider: current.provider, model: current.model } : {},
                }
                : { ok: true, role: 'main', sessionId })
              return
            }
            if (sub === 'model' && req.method === 'POST') {
              const body = await readJson(req)
              const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
              const provider = typeof body.provider === 'string' ? body.provider : ''
              const model = typeof body.model === 'string' ? body.model : ''
              if (!sessionId || sessionId.length > 200) {
                fail(res, 400, 'bad-session', '没有当前对话')
                return
              }
              const choice = resolveStudyModel(listStudyModels(readDesktopProfile()), provider, model)
              if (!choice) {
                fail(res, 400, 'bad-model', '没有这个模型')
                return
              }
              if (!parentOf(ctx, sessionId)) {
                fail(res, 404, 'no-child', '没有这条进程')
                return
              }
              await applyChildModel(ctx, sessionId, choice)
              writeJson(res, 200, { ok: true, provider: choice.provider, model: choice.model })
              return
            }
            if (sub === 'models' && req.method === 'GET') {
              writeJson(res, 200, { ok: true, models: listStudyModels(readDesktopProfile()) })
              return
            }
            if (sub === 'ask' && req.method === 'POST') {
              const body = await readJson(req)
              const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
              const quote = typeof body.quote === 'string' ? body.quote.trim() : ''
              const question = typeof body.question === 'string' ? body.question.trim() : ''
              const continueId = typeof body.continueId === 'string' ? body.continueId.trim() : ''
              const provider = typeof body.provider === 'string' ? body.provider : ''
              const model = typeof body.model === 'string' ? body.model : ''
              if (!sessionId || sessionId.length > 200) {
                fail(res, 400, 'bad-session', '没有当前对话')
                return
              }
              if (continueId.length > 200) {
                fail(res, 400, 'bad-child', '没有这条进程')
                return
              }
              if (!quote || quote.length > 4_000) {
                fail(res, 400, 'bad-quote', '没有要提问的那段文字')
                return
              }
              if (!question || question.length > 2_000) {
                fail(res, 400, 'bad-question', '问题要写在 2000 字以内')
                return
              }
              const started = await askChild(ctx, sessionId, quote, question, continueId, { provider, model })
              writeJson(res, 200, {
                ok: true,
                childId: started.childId,
                parentId: started.parentId,
                continued: started.continued === true,
              })
              return
            }
            fail(res, 404, 'not-found', `没有这个接口: ${sub || '/'}`)
          } catch (error) {
            const status = Number(error?.status) || 500
            const code = typeof error?.code === 'string' ? error.code : 'study-failed'
            fail(res, status, code, String(error?.message || error))
          }
        },
      }),
    'dsh-marginalia: /marginalia/api route',
  )
}
