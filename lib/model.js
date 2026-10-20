/**
 * Pure helpers for the study page. No I/O: the host plugin and the tests
 * both call these, and the numbers here are the product limits.
 */
import { createHash } from 'node:crypto'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'

export const PAGE_EXTS = new Set(['.md', '.markdown', '.txt', '.text', '.html', '.htm'])
export const MAX_TEXT = 120_000
export const MAX_MARKS = 400
export const MAX_QUOTE = 4_000
export const MAX_COMMENT = 2_000
export const MAX_SOURCE = 2_000

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

/** Page files this step knows how to open. Anything else is refused. */
export function isPageFile(file) {
  return PAGE_EXTS.has(extname(file).toLowerCase())
}

export function isHttpSource(source) {
  return /^https?:\/\//i.test(source)
}

/** Stable id for one source string. Used as the note filename. */
export function pageKey(source) {
  return createHash('sha256').update(String(source)).digest('hex').slice(0, 16)
}

/**
 * Resolve `target` and require it to stay inside `root`.
 * Returns the absolute path, or null when it escapes the root.
 */
export function insideRoot(root, target) {
  const base = resolve(root)
  const abs = resolve(base, target)
  const rel = relative(base, abs)
  if (rel === '') return abs
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
  return abs
}

export function decodeEntities(value) {
  return String(value).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body) => {
    const token = String(body)
    if (token[0] === '#') {
      const hex = token[1] === 'x' || token[1] === 'X'
      const code = Number.parseInt(token.slice(hex ? 2 : 1), hex ? 16 : 10)
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole
      try {
        return String.fromCodePoint(code)
      } catch {
        return whole
      }
    }
    return Object.hasOwn(NAMED_ENTITIES, token.toLowerCase()) ? NAMED_ENTITIES[token.toLowerCase()] : whole
  })
}

/**
 * Turn an HTML document into readable plain text.
 * Scripts and styles are dropped so a page can be selected and marked.
 * The sidebar browser iframe is sandboxed, so the highlight has to live
 * on this extracted text instead of on the live page.
 */
export function htmlToText(html) {
  let source = String(html)
  const titleMatch = source.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  source = source
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '')
  source = source.replace(/<\s*br\s*\/?\s*>/gi, '\n')
  source = source.replace(/<\/\s*(p|div|h[1-6]|li|tr|blockquote|section|article|pre)\s*>/gi, '\n')
  source = source.replace(/<[^>]+>/g, '')
  const text = decodeEntities(source)
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim() : ''
  return { title, text }
}

export function titleFromText(text, fallback) {
  const heading = String(text).match(/^#\s+(.+)$/m)
  const picked = (heading ? heading[1] : fallback || '').replace(/\s+/g, ' ').trim()
  return picked.slice(0, 120) || '未命名页面'
}

export function clipText(text) {
  const raw = String(text).replace(/^\uFEFF/, '')
  if (raw.length <= MAX_TEXT) return { text: raw, truncated: false }
  return { text: raw.slice(0, MAX_TEXT), truncated: true }
}

/** Question and child id ride along with a mark. A bad id is dropped, not fatal. */
function noteMeta(mark) {
  const extra = {}
  const question = typeof mark?.question === 'string' ? mark.question.trim().slice(0, MAX_COMMENT) : ''
  if (question) extra.question = question
  let childId = typeof mark?.childId === 'string' ? mark.childId.trim() : ''
  if (!childId || childId.length > 200 || /[\u0000-\u001f]/.test(childId)) childId = ''
  if (childId) extra.childId = childId
  return extra
}

function rangesOverlap(start, end, ranges) {
  return ranges.some((range) => start < range.end && end > range.start)
}

/**
 * Keep marks whose quote still exists in `text`.
 * A mark is kept in place when the slice still matches, otherwise rebound
 * to the first unused copy of the same quote. Marks that no longer appear
 * are counted as dropped so the note does not cite text that is gone.
 */
export function reconcileMarks(text, marks) {
  const source = String(text)
  const kept = []
  const used = []
  let dropped = 0
  const list = Array.isArray(marks) ? marks : []
  for (const mark of list) {
    if (kept.length >= MAX_MARKS) {
      dropped += 1
      continue
    }
    const quote = typeof mark?.quote === 'string' ? mark.quote : ''
    if (!quote || quote.length > MAX_QUOTE) {
      dropped += 1
      continue
    }
    const start = Number(mark.start)
    const end = Number(mark.end)
    let nextStart = null
    if (Number.isInteger(start) && Number.isInteger(end) && end - start === quote.length && source.slice(start, end) === quote && !rangesOverlap(start, end, used)) {
      nextStart = start
    } else {
      let from = 0
      while (from <= source.length) {
        const at = source.indexOf(quote, from)
        if (at < 0) break
        if (!rangesOverlap(at, at + quote.length, used)) {
          nextStart = at
          break
        }
        from = at + 1
      }
    }
    if (nextStart == null) {
      dropped += 1
      continue
    }
    const nextEnd = nextStart + quote.length
    used.push({ start: nextStart, end: nextEnd })
    kept.push({
      id: typeof mark.id === 'string' && mark.id ? mark.id.slice(0, 40) : `m${kept.length}`,
      start: nextStart,
      end: nextEnd,
      kind: mark.kind === 'line' ? 'line' : 'red',
      comment: typeof mark.comment === 'string' ? mark.comment.slice(0, MAX_COMMENT) : '',
      quote,
      ...noteMeta(mark),
    })
  }
  kept.sort((a, b) => a.start - b.start || a.end - b.end)
  return { marks: kept, dropped }
}

/** Reject a client payload before it is reconciled against the page text. */
export function sanitizeIncomingMarks(marks) {
  if (!Array.isArray(marks)) return { ok: false, message: 'marks 必须是数组' }
  if (marks.length > MAX_MARKS) return { ok: false, message: `一次最多 ${MAX_MARKS} 条标注` }
  const clean = []
  for (const mark of marks) {
    if (!mark || typeof mark !== 'object') return { ok: false, message: '标注格式不对' }
    const quote = typeof mark.quote === 'string' ? mark.quote : ''
    if (!quote.trim()) return { ok: false, message: '标注不能是空白' }
    if (quote.length > MAX_QUOTE) return { ok: false, message: `一段标注最多 ${MAX_QUOTE} 字` }
    const start = Number(mark.start)
    const end = Number(mark.end)
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end !== start + quote.length) {
      return { ok: false, message: '标注位置和原文对不上' }
    }
    const kind = mark.kind === 'line' ? 'line' : mark.kind === 'red' ? 'red' : ''
    if (!kind) return { ok: false, message: '标注类型只能是标红或划线' }
    const comment = typeof mark.comment === 'string' ? mark.comment : ''
    if (comment.length > MAX_COMMENT) return { ok: false, message: `批注最多 ${MAX_COMMENT} 字` }
    clean.push({
      id: typeof mark.id === 'string' && /^[\w.-]+$/.test(mark.id) ? mark.id.slice(0, 40) : `m${clean.length}`,
      start,
      end,
      kind,
      comment,
      quote,
      ...noteMeta(mark),
    })
  }
  return { ok: true, marks: clean }
}

export function notesMarkdown({ title, source, marks }) {
  const lines = [`# ${title || '笔记'}`, '', `来源：${source || ''}`, '']
  if (!marks || marks.length === 0) {
    lines.push('还没有标注。', '')
    return lines.join('\n')
  }
  marks.forEach((mark, index) => {
    const label = mark.kind === 'line' ? '划线' : '标红'
    lines.push(`## ${index + 1}. ${label}`, '', `> ${String(mark.quote).replace(/\n/g, '\n> ')}`, '')
    if (mark.question && String(mark.question).trim()) {
      lines.push(`提问：${String(mark.question).trim()}`, '')
    }
    if (mark.comment && mark.comment.trim()) {
      lines.push(mark.comment.trim(), '')
    }
  })
  return lines.join('\n')
}

export function fallbackTitle(source) {
  if (isHttpSource(source)) {
    try {
      return new URL(source).hostname || '网页'
    } catch {
      return '网页'
    }
  }
  return basename(source) || '页面'
}
