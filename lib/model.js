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
export const MAX_MARKDOWN = 12_000
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

/** A category name is a short label. Blank, control-only, or over-long names are omitted. */
function cleanCategory(value) {
  if (typeof value !== 'string') return ''
  const text = value.replace(/[\u0000-\u001F]/g, '').replace(/\s+/g, ' ').trim()
  if (!text || text.length > 40) return ''
  return text
}

/** Question, child id, category, and the Markdown excerpt ride along with a mark. */
function noteMeta(mark) {
  const extra = {}
  const question = typeof mark?.question === 'string' ? mark.question.trim().slice(0, MAX_COMMENT) : ''
  if (question) extra.question = question
  let childId = typeof mark?.childId === 'string' ? mark.childId.trim() : ''
  if (!childId || childId.length > 200 || /[\u0000-\u001f]/.test(childId)) childId = ''
  if (childId) extra.childId = childId
  const markdown = markdownSource(mark?.markdown)
  if (markdown) extra.markdown = markdown
  const category = cleanCategory(mark?.category)
  if (category) extra.category = category
  return extra
}

function markdownSource(value) {
  if (typeof value !== 'string') return ''
  const text = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').slice(0, MAX_MARKDOWN)
  return text.trim() ? text : ''
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function inlineMarkdown(text) {
  let html = escapeHtml(text)
  html = html.replace(/`([^`\n]+)`/g, (_, code) => `<code>${code}</code>`)
  html = html.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, href) => {
    return `<a href="${href.replace(/"/g, '%22')}" target="_blank" rel="noopener noreferrer">${label}</a>`
  })
  html = html.replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>')
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
  html = html.replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
  html = html.replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,;:!?])/g, '$1<em>$2</em>')
  return html
}

/** Render a small Markdown subset to HTML. Raw HTML in the source stays escaped. */
export function renderMarkdown(source) {
  const raw = String(source || '').replace(/\r\n/g, '\n')
  const fences = []
  const text = raw.replace(/```[^\n]*\n([\s\S]*?)```/g, (_, code) => {
    fences.push(`<pre><code>${escapeHtml(String(code).replace(/\n$/, ''))}</code></pre>`)
    return `\u0000F${fences.length - 1}\u0000`
  })
  const lines = text.split('\n')
  const blocks = []
  let paragraph = []
  let list = null
  const flushParagraph = () => {
    if (paragraph.length === 0) return
    blocks.push(`<p>${inlineMarkdown(paragraph.join('\n')).replace(/\n/g, '<br>')}</p>`)
    paragraph = []
  }
  const flushList = () => {
    if (!list) return
    blocks.push(`<${list.type}>${list.items.join('')}</${list.type}>`)
    list = null
  }
  for (const line of lines) {
    const fence = /^\u0000F(\d+)\u0000$/.exec(line.trim())
    if (fence) {
      flushParagraph()
      flushList()
      blocks.push(fences[Number(fence[1])] || '')
      continue
    }
    if (!line.trim()) {
      flushParagraph()
      flushList()
      continue
    }
    const heading = /^(#{1,6})[ \t]+(.+)$/.exec(line)
    if (heading) {
      flushParagraph()
      flushList()
      blocks.push(`<h${heading[1].length}>${inlineMarkdown(heading[2])}</h${heading[1].length}>`)
      continue
    }
    const quote = /^>[ \t]?(.*)$/.exec(line)
    if (quote) {
      flushParagraph()
      flushList()
      blocks.push(`<blockquote>${inlineMarkdown(quote[1])}</blockquote>`)
      continue
    }
    const bullet = /^[-*+][ \t]+(.+)$/.exec(line)
    if (bullet) {
      flushParagraph()
      if (!list || list.type !== 'ul') {
        flushList()
        list = { type: 'ul', items: [] }
      }
      list.items.push(`<li>${inlineMarkdown(bullet[1])}</li>`)
      continue
    }
    const numbered = /^\d+\.[ \t]+(.+)$/.exec(line)
    if (numbered) {
      flushParagraph()
      if (!list || list.type !== 'ol') {
        flushList()
        list = { type: 'ol', items: [] }
      }
      list.items.push(`<li>${inlineMarkdown(numbered[1])}</li>`)
      continue
    }
    flushList()
    paragraph.push(line)
  }
  flushParagraph()
  flushList()
  return blocks.join('')
}

/** Words a reader sees, so a formatted excerpt can still be found in the chat. */
export function plainFromMarkdown(source) {
  let text = String(source || '').replace(/\r\n/g, '\n')
  text = text.replace(/```[^\n]*\n([\s\S]*?)```/g, (_, code) => code)
  text = text.replace(/`([^`]+)`/g, '$1')
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1')
  text = text.replace(/(\*\*\*|___)([\s\S]*?)\1/g, '$2')
  text = text.replace(/(\*\*|__)([\s\S]*?)\1/g, '$2')
  text = text.replace(/~~([\s\S]*?)~~/g, '$1')
  text = text.replace(/(^|[\s(])[*_]([^*\n_]+?)[*_](?=$|[\s).,;:!?])/g, '$1$2')
  text = text.replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
  text = text.replace(/^[ \t]*>[ \t]?/gm, '')
  text = text.replace(/^[ \t]*[-*+][ \t]+/gm, '')
  text = text.replace(/^[ \t]*\d+\.[ \t]+/gm, '')
  return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

function nodeTag(node) {
  return String(node && node.tagName || '').toUpperCase()
}

function nodeChildren(node) {
  if (!node || !node.childNodes) return []
  return Array.from(node.childNodes)
}

function inlineWeight(node) {
  const weight = String(node && node.style && node.style.fontWeight || '')
  const numeric = Number(weight)
  return weight === 'bold' || (Number.isFinite(numeric) && numeric >= 600)
}

function inlineItalic(node) {
  const style = String(node && node.style && node.style.fontStyle || '')
  return style === 'italic' || style === 'oblique'
}

function wrapMarker(marker, inner) {
  if (!String(inner || '').trim()) return inner
  if (inner.startsWith(marker) && inner.endsWith(marker)) return inner
  return `${marker}${inner}${marker}`
}

function linkMarkdown(node, inner) {
  const href = typeof node.getAttribute === 'function' ? String(node.getAttribute('href') || '') : ''
  if (!/^https?:\/\//i.test(href)) return inner
  return `[${inner}](${href})`
}

function applyInline(node, inner) {
  const tag = nodeTag(node)
  if (tag === 'CODE') return `\`${String(inner).replace(/`/g, '\\`')}\``
  if (tag === 'A') return linkMarkdown(node, inner)
  const bold = tag === 'STRONG' || tag === 'B' || inlineWeight(node)
  const italic = tag === 'EM' || tag === 'I' || inlineItalic(node)
  const strike = tag === 'DEL' || tag === 'S' || tag === 'STRIKE'
  let text = inner
  if (strike) text = wrapMarker('~~', text)
  if (bold && italic) text = wrapMarker('***', text)
  else if (bold) text = wrapMarker('**', text)
  else if (italic) text = wrapMarker('*', text)
  return text
}

function textWithoutChrome(node) {
  if (!node) return ''
  if (node.nodeType === 3) return node.textContent || ''
  const tag = nodeTag(node)
  if (tag === 'BUTTON' || tag === 'SVG' || tag === 'SCRIPT' || tag === 'STYLE') return ''
  const children = nodeChildren(node)
  if (children.length === 0) return node.textContent || ''
  return children.map((child) => textWithoutChrome(child)).join('')
}

function listMarker(node) {
  const parent = node.parentNode || node.parentElement
  if (nodeTag(parent) !== 'OL') return '- '
  const items = nodeChildren(parent).filter((child) => nodeTag(child) === 'LI')
  const index = Math.max(1, items.indexOf(node) + 1)
  return `${index}. `
}

/**
 * Turn a rendered selection back into Markdown.
 * `node` is a DOM node or a small stand-in with nodeType, tagName, and childNodes.
 */
export function markdownFromNode(node) {
  return cleanMarkdown(markdownNode(node))
}

function markdownNode(node) {
  if (!node) return ''
  if (node.nodeType === 3) return node.textContent || ''
  if (node.nodeType !== 1 && node.nodeType !== 11) return ''
  const tag = nodeTag(node)
  if (tag === 'BUTTON' || tag === 'SVG' || tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEXTAREA' || tag === 'INPUT') return ''
  if (typeof node.getAttribute === 'function' && node.getAttribute('aria-hidden') === 'true') return ''
  if (tag === 'BR') return '\n'
  if (tag === 'PRE') return `\n\`\`\`\n${textWithoutChrome(node).replace(/\n$/, '')}\n\`\`\`\n`
  const inner = nodeChildren(node).map((child) => markdownNode(child)).join('')
  if (tag === 'LI') return `${listMarker(node)}${applyInline(node, inner.trim())}\n`
  if (/^H[1-6]$/.test(tag)) return `\n${'#'.repeat(Number(tag[1]))} ${applyInline(node, inner.trim())}\n`
  if (tag === 'BLOCKQUOTE') {
    const body = applyInline(node, inner.trim())
    return `\n${body.split('\n').map((line) => `> ${line}`).join('\n')}\n`
  }
  if (tag === 'TD' || tag === 'TH') return `${inner.trim()} | `
  if (tag === 'TR') return `${inner.trim()}\n`
  if (tag === 'P' || tag === 'DIV' || tag === 'UL' || tag === 'OL' || tag === 'SECTION' || tag === 'ARTICLE' || tag === 'TABLE') {
    const body = applyInline(node, inner.trim())
    return body ? `\n${body}\n` : ''
  }
  return applyInline(node, inner)
}

function cleanMarkdown(source) {
  return String(source || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_MARKDOWN)
}

function rangesOverlap(start, end, ranges) {
  return ranges.some((range) => start < range.end && end > range.start)
}

/** A color mark stores #RRGGBB. Older notes used kind "red" and stay red. */
function describeMark(mark, strict) {
  if (mark.kind === 'line') return { kind: 'line' }
  if (mark.kind === 'note') return { kind: 'note' }
  const raw = typeof mark.color === 'string' ? mark.color.trim() : ''
  const color = /^#[0-9a-fA-F]{6}$/.test(raw) ? raw.toUpperCase() : ''
  if (mark.kind === 'mark') {
    if (!color) {
      if (strict) return { error: '颜色格式不对' }
      return { kind: 'mark', color: '#E04848' }
    }
    return { kind: 'mark', color }
  }
  if (mark.kind === 'red') return color ? { kind: 'red', color } : { kind: 'red' }
  return { error: '标注类型只能是标记、划线或笔记' }
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
    const described = describeMark(mark, false)
    if (described.error) {
      dropped += 1
      continue
    }
    used.push({ start: nextStart, end: nextEnd })
    kept.push({
      id: typeof mark.id === 'string' && mark.id ? mark.id.slice(0, 40) : `m${kept.length}`,
      start: nextStart,
      end: nextEnd,
      kind: described.kind,
      ...(described.color ? { color: described.color } : {}),
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
    const described = describeMark(mark, true)
    if (described.error) return { ok: false, message: described.error }
    const comment = typeof mark.comment === 'string' ? mark.comment : ''
    if (comment.length > MAX_COMMENT) return { ok: false, message: `批注最多 ${MAX_COMMENT} 字` }
    clean.push({
      id: typeof mark.id === 'string' && /^[\w.-]+$/.test(mark.id) ? mark.id.slice(0, 40) : `m${clean.length}`,
      start,
      end,
      ...described,
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
    const label = mark.kind === 'line' ? '划线' : mark.kind === 'note' ? '提问' : '标记'
    const category = cleanCategory(mark.category)
    const heading = category ? `${label} · ${category}` : label
    const body = typeof mark.markdown === 'string' && mark.markdown.trim() ? mark.markdown : mark.quote
    lines.push(`## ${index + 1}. ${heading}`, '', `> ${String(body).replace(/\n/g, '\n> ')}`, '')
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
