/**
 * dsh-marginalia — client half.
 *
 * DSH loads this through window.__ModuleLoader__. React comes from the host.
 * The 学习 tab only lists notes. Marking happens on 对话: select text in an
 * assistant reply or in a message the user sent, and the actions appear above
 * the caret. Right-click opens the same card. The reasoning trace is left
 * alone. The chat renderer owns that text, so the mark is painted back with
 * the CSS Highlight API.
 */
window.__ModuleLoader__.load({
  id: 'dsh-marginalia',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const h = React.createElement

    const MARKABLE_KINDS = new Set(['assistant', 'assistant-step', 'user', 'steering'])
    const DEFAULT_COLORS = ['#E04848', '#3B82F6', '#E3C96B']
    const MAX_COLORS = 5
    const COLOR_KEY = 'dsh-marginalia-colors'
    const CATEGORY_KEY = 'dsh-marginalia-categories'
    const MAX_CATEGORIES = 100
    const MAX_MARKDOWN = 12_000
    const liveHighlights = new Set()
    let colorEl = null
    let paletteOpen = false
    const store = {
      sessionId: '',
      cwd: '',
      marks: [],
      status: '',
      listeners: new Set(),
    }
    let snapshot = {
      sessionId: '',
      cwd: '',
      marks: [],
      status: '',
    }
    let pluginCtx = null
    let menuEl = null
    let menuTimer = 0
    let menuGeneration = 0
    let lastX = 8
    let lastY = 8
    let lastRange = null
    let lastMarkdown = ''
    let openMarkId = ''
    let pollTimer = 0
    let pinsOn = false
    let lastLocated = []
    let noteSaveTimer = 0
    const pinLayer = new Map()
    const threads = new Map()

    function quoteMatch(text, quote, used) {
      const source = String(text)
      const needle = String(quote)
      const taken = Array.isArray(used) ? used : []
      if (!needle.trim()) return null
      const blocked = (start, end) => taken.some((range) => start < range.end && end > range.start)
      let from = 0
      while (from <= source.length) {
        const at = source.indexOf(needle, from)
        if (at < 0) break
        const end = at + needle.length
        if (!blocked(at, end)) return { start: at, end }
        from = at + 1
      }
      const folded = foldSpace(source)
      const wanted = foldSpace(needle).out
      if (!wanted) return null
      from = 0
      while (from <= folded.out.length) {
        const at = folded.out.indexOf(wanted, from)
        if (at < 0) break
        const start = folded.map[at]
        const end = folded.map[at + wanted.length - 1] + 1
        if (!blocked(start, end)) return { start, end }
        from = at + 1
      }
      return null
    }

    function foldSpace(text) {
      let out = ''
      const map = []
      for (let i = 0; i < text.length; i += 1) {
        if (/\s/.test(text[i])) continue
        out += text[i]
        map.push(i)
      }
      return { out, map }
    }

    function sameQuote(left, right) {
      const a = String(left)
      const b = String(right)
      if (a === b) return true
      const folded = foldSpace(a).out
      return folded.length > 0 && folded === foldSpace(b).out
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
    function renderMarkdown(source) {
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
    function plainFromMarkdown(source) {
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
    function markdownFromNode(node) {
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

    function storedMarkdown(source, quote) {
      const clipped = cleanMarkdown(source)
      if (!clipped || clipped === quote) return ''
      if (!sameQuote(plainFromMarkdown(clipped), quote)) return ''
      return clipped
    }

    function wrapLive(text, el, host, hostWeight, hostItalic) {
      if (!String(text || '').trim()) return text
      let bold = false
      let italic = false
      let code = false
      let current = el
      while (current && current.nodeType === 1 && current !== host) {
        const tag = current.tagName
        if (tag === 'CODE' || tag === 'PRE') code = true
        if (tag === 'STRONG' || tag === 'B') bold = true
        if (tag === 'EM' || tag === 'I') italic = true
        if (typeof window.getComputedStyle === 'function') {
          const style = window.getComputedStyle(current)
          const weight = Number(style.fontWeight)
          if (style.fontWeight === 'bold' || (Number.isFinite(weight) && weight >= 600 && weight > hostWeight)) bold = true
          const slant = style.fontStyle === 'italic' || style.fontStyle === 'oblique'
          if (slant && !hostItalic) italic = true
        }
        current = current.parentElement
      }
      if (code) return `\`${text}\``
      if (bold && italic) return `***${text}***`
      if (bold) return `**${text}**`
      if (italic) return `*${text}*`
      return text
    }

    function markdownFromComputed(range) {
      const root = range.commonAncestorContainer
      const scope = root && root.nodeType === 1 ? root : root && root.parentElement
      if (!scope || typeof document.createTreeWalker !== 'function') return ''
      const host = scope.closest ? scope.closest('[data-chat-flow-kind]') : null
      const hostStyle = host && typeof window.getComputedStyle === 'function' ? window.getComputedStyle(host) : null
      const hostWeight = hostStyle ? Number(hostStyle.fontWeight) || 400 : 400
      const hostItalic = hostStyle ? hostStyle.fontStyle === 'italic' || hostStyle.fontStyle === 'oblique' : false
      const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT)
      let out = ''
      let previousBlock = null
      let node = walker.nextNode()
      while (node) {
        if (typeof range.intersectsNode === 'function' && !range.intersectsNode(node)) {
          node = walker.nextNode()
          continue
        }
        let text = node.textContent || ''
        if (node === range.startContainer) text = text.slice(range.startOffset)
        if (node === range.endContainer) {
          const end = node === range.startContainer ? range.endOffset - range.startOffset : range.endOffset
          text = text.slice(0, end)
        }
        if (text) {
          const block = node.parentElement && node.parentElement.closest
            ? node.parentElement.closest('p, li, pre, h1, h2, h3, h4, h5, h6, blockquote, tr')
            : null
          if (previousBlock && block && previousBlock !== block) out += '\n'
          if (block) previousBlock = block
          out += wrapLive(text, node.parentElement, host, hostWeight, hostItalic)
        }
        node = walker.nextNode()
      }
      return cleanMarkdown(out)
    }

    function markdownFor(range, quote) {
      if (!range || typeof range.cloneContents !== 'function') return ''
      let source = ''
      try {
        const box = document.createElement('div')
        box.appendChild(range.cloneContents())
        source = markdownFromNode(box)
      } catch {
        source = ''
      }
      const kept = storedMarkdown(source, quote)
      if (kept) return kept
      try {
        return storedMarkdown(markdownFromComputed(range), quote)
      } catch {
        return ''
      }
    }

    function promptQuote(quote, markdown) {
      const source = typeof markdown === 'string' ? markdown.trim() : ''
      if (!source || source.length > 4000) return quote
      if (!sameQuote(plainFromMarkdown(source), quote)) return quote
      return source
    }

    function excerptOf(mark) {
      return mark && typeof mark.markdown === 'string' && mark.markdown.trim() ? mark.markdown : (mark && mark.quote) || ''
    }

    function rangesOverlap(a, b) {
      if (!a || !b || typeof a.compareBoundaryPoints !== 'function') return false
      try {
        const endToStart = typeof Range !== 'undefined' && Range.END_TO_START != null ? Range.END_TO_START : 3
        return a.compareBoundaryPoints(endToStart, b) < 0 && b.compareBoundaryPoints(endToStart, a) < 0
      } catch {
        return false
      }
    }

    function normalizeHex(value) {
      const text = String(value || '').trim()
      if (!/^#[0-9a-fA-F]{6}$/.test(text)) return ''
      return text.toUpperCase()
    }

    function isColorMark(mark) {
      return !!mark && (mark.kind === 'mark' || mark.kind === 'red')
    }

    function markColor(mark) {
      return normalizeHex(mark && mark.color) || '#E04848'
    }

    function loadColors() {
      const picked = []
      const seen = new Set(DEFAULT_COLORS)
      try {
        const raw = JSON.parse(window.localStorage.getItem(COLOR_KEY) || '[]')
        for (const item of Array.isArray(raw) ? raw : []) {
          const hex = normalizeHex(item)
          if (!hex || seen.has(hex)) continue
          seen.add(hex)
          picked.push(hex)
        }
      } catch {
        /* The three defaults still show. */
      }
      return [...DEFAULT_COLORS, ...picked].slice(0, MAX_COLORS)
    }

    function saveColors(colors) {
      const next = []
      const seen = new Set()
      for (const item of colors) {
        const hex = normalizeHex(item)
        if (!hex || seen.has(hex)) continue
        seen.add(hex)
        next.push(hex)
        if (next.length >= MAX_COLORS) break
      }
      const stored = next.length ? next : DEFAULT_COLORS.slice()
      try {
        window.localStorage.setItem(COLOR_KEY, JSON.stringify(stored.filter((hex) => !DEFAULT_COLORS.includes(hex))))
      } catch {
        /* This session still keeps the list in memory via the caller. */
      }
      return stored
    }

    function cleanCategory(value) {
      if (typeof value !== 'string') return ''
      const text = value.replace(/[\u0000-\u001F]/g, '').replace(/\s+/g, ' ').trim()
      if (!text || text.length > 40) return ''
      return text
    }

    function loadCategories() {
      const picked = []
      const seen = new Set()
      try {
        const raw = JSON.parse(window.localStorage.getItem(CATEGORY_KEY) || '[]')
        for (const item of Array.isArray(raw) ? raw : []) {
          const name = cleanCategory(item)
          if (!name || seen.has(name)) continue
          seen.add(name)
          picked.push(name)
          if (picked.length >= MAX_CATEGORIES) break
        }
      } catch {
        /* Custom names can still come from the notes themselves. */
      }
      return picked
    }

    function saveCategories(names) {
      const next = []
      const seen = new Set()
      for (const item of names) {
        const name = cleanCategory(item)
        if (!name || seen.has(name)) continue
        seen.add(name)
        next.push(name)
        if (next.length >= MAX_CATEGORIES) break
      }
      try {
        window.localStorage.setItem(CATEGORY_KEY, JSON.stringify(next))
      } catch {
        /* This session still keeps the list in memory via the caller. */
      }
      return next
    }

    function listedCategories(stored, marks) {
      const seen = new Set()
      const list = []
      const add = (value, limited) => {
        const name = cleanCategory(value)
        if (!name || seen.has(name)) return
        if (limited && list.length >= MAX_CATEGORIES) return
        seen.add(name)
        list.push(name)
      }
      for (const name of stored) add(name, true)
      for (const mark of marks || []) add(mark && mark.category, false)
      return list
    }

    function fade(hex) {
      const value = parseInt(hex.slice(1), 16)
      const red = (value >> 16) & 255
      const green = (value >> 8) & 255
      const blue = value & 255
      return `rgba(${red}, ${green}, ${blue}, .45)`
    }

    function coveredMarks(marks, kind, quote, selectionRange) {
      const used = []
      const hits = []
      for (const mark of marks) {
        const range = findQuoteRange(mark.quote, used, mark.kind !== 'note')
        if (mark.kind !== kind) continue
        const exact = sameQuote(mark.quote, quote)
        const hit = Boolean(range && selectionRange && rangesOverlap(selectionRange, range))
        if (exact || hit) hits.push(mark)
      }
      return hits
    }

    function linkedThread(marks, quote, selectionRange) {
      for (let i = marks.length - 1; i >= 0; i -= 1) {
        const mark = marks[i]
        if (mark && mark.childId && sameQuote(mark.quote, quote)) return mark
      }
      const used = []
      for (let i = marks.length - 1; i >= 0; i -= 1) {
        const mark = marks[i]
        if (!mark || !mark.childId || !mark.quote) continue
        const range = findQuoteRange(mark.quote, used, false)
        if (range && selectionRange && rangesOverlap(selectionRange, range)) return mark
      }
      return null
    }

    function colorHits(marks, quote, selectionRange) {
      const used = []
      const hits = []
      for (const mark of marks) {
        const range = findQuoteRange(mark.quote, used, mark.kind !== 'note')
        if (!isColorMark(mark)) continue
        const exact = sameQuote(mark.quote, quote)
        const hit = Boolean(range && selectionRange && rangesOverlap(selectionRange, range))
        if (exact || hit) hits.push(mark)
      }
      return hits
    }

    function emit() {
      for (const listener of store.listeners) listener()
    }

    function patch(partial) {
      Object.assign(store, partial)
      snapshot = {
        sessionId: store.sessionId,
        cwd: store.cwd,
        marks: store.marks,
        status: store.status,
      }
      emit()
    }

    function useStore() {
      return React.useSyncExternalStore(
        (listener) => {
          store.listeners.add(listener)
          return () => store.listeners.delete(listener)
        },
        () => snapshot,
      )
    }

    function route(path, query) {
      const qs = query ? `?${new URLSearchParams(query).toString()}` : ''
      return `${path}${qs}`
    }

    function cwdOf(ctx, sessionId) {
      try {
        const sessions = (ctx && ctx.sessions) || (ctx && typeof ctx.get === 'function' ? ctx.get('sessions') : null)
        const row = sessions && sessions.list && sessions.list.getSnapshot ? sessions.list.getSnapshot().byId?.[sessionId] : null
        if (row && typeof row.cwd === 'string' && row.cwd) return row.cwd
        const header = sessions && sessions.binding ? sessions.binding(sessionId)?.session?.header : null
        if (header && typeof header.cwd === 'string') return header.cwd
      } catch {
        /* Notes still save under the default workspace. */
      }
      return ''
    }

    function sourceOf(sessionId) {
      return `session:${sessionId}`
    }

    function pack(marks) {
      let text = ''
      const packed = []
      for (const mark of marks) {
        if (text) text += '\n'
        const start = text.length
        text += mark.quote
        packed.push({ ...mark, start, end: text.length })
      }
      return { text, marks: packed }
    }

    function localMarkdown(marks) {
      const lines = ['# 对话标注', '']
      if (marks.length === 0) return `${lines.join('\n')}还没有标注。\n`
      marks.forEach((mark, index) => {
        const label = mark.kind === 'line' ? '划线' : mark.kind === 'note' ? '提问' : '标记'
        const category = cleanCategory(mark.category)
        const heading = category ? `${label} · ${category}` : label
        const body = excerptOf(mark)
        lines.push(`## ${index + 1}. ${heading}`, '', `> ${body.replace(/\n/g, '\n> ')}`, '')
        if (mark.question && mark.question.trim()) lines.push(`提问：${mark.question.trim()}`, '')
        if (mark.comment && mark.comment.trim()) lines.push(mark.comment.trim(), '')
      })
      return `${lines.join('\n')}\n`
    }

    async function readNotes(sessionId, cwd) {
      const res = await fetch(route('/marginalia/api/notes', { source: sourceOf(sessionId), root: cwd || '' }), {
        headers: { accept: 'application/json' },
      })
      const data = await res.json()
      if (!res.ok || !data || data.ok !== true) throw new Error((data && data.error && data.error.message) || `HTTP ${res.status}`)
      return Array.isArray(data.marks) ? data.marks : []
    }

    function cancelPendingNoteSave() {
      window.clearTimeout(noteSaveTimer)
      noteSaveTimer = 0
    }

    async function writeNotes(sessionId, cwd, marks) {
      cancelPendingNoteSave()
      const packed = pack(marks)
      const res = await fetch(route('/marginalia/api/notes'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          root: cwd || '',
          source: sourceOf(sessionId),
          title: '对话标注',
          text: packed.text,
          marks: packed.marks,
        }),
      })
      const data = await res.json()
      if (!res.ok || !data || data.ok !== true) throw new Error((data && data.error && data.error.message) || `HTTP ${res.status}`)
      return data.marks || []
    }

    function elementOf(node) {
      if (!node) return null
      if (node.nodeType === 1) return node
      return node.parentElement || null
    }

    function markHost(node) {
      const el = elementOf(node)
      if (!el || !el.closest) return null
      const flow = el.closest('[data-chat-flow-kind]')
      if (!flow) return null
      const kind = flow.getAttribute('data-chat-flow-kind')
      if (!MARKABLE_KINDS.has(kind)) return null
      if (flow.getAttribute('data-chat-group-part') === 'reasoning') return null
      return flow
    }

    function sessionIdFrom(node) {
      const el = elementOf(node)
      const host = el && el.closest ? el.closest('[data-conversation-session]') : null
      if (!host) return ''
      return host.getAttribute('data-conversation-session') || ''
    }

    function findQuoteRange(quote, used, reserve = true) {
      const hosts = document.querySelectorAll('[data-chat-flow-kind="assistant-step"], [data-chat-flow-kind="assistant"], [data-chat-flow-kind="user"], [data-chat-flow-kind="steering"]')
      for (const host of hosts) {
        if (host.getAttribute('data-chat-group-part') === 'reasoning') continue
        const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT)
        const parts = []
        let text = ''
        let current = walker.nextNode()
        while (current) {
          parts.push({ node: current, start: text.length })
          text += current.textContent || ''
          current = walker.nextNode()
        }
        const taken = []
        if (reserve) {
          for (const range of used) {
            if (range.host === host) taken.push(range)
          }
        }
        const hit = quoteMatch(text, quote, taken)
        if (!hit) continue
        const range = rangeFrom(parts, hit.start, hit.end)
        if (!range) continue
        if (reserve) used.push({ host, start: hit.start, end: hit.end })
        return range
      }
      return null
    }

    function rangeFrom(parts, start, end) {
      let startNode = null
      let startOffset = 0
      let endNode = null
      let endOffset = 0
      for (let i = 0; i < parts.length; i += 1) {
        const part = parts[i]
        const next = i + 1 < parts.length ? parts[i + 1].start : part.start + (part.node.textContent || '').length
        if (startNode == null && start >= part.start && start <= next) {
          startNode = part.node
          startOffset = start - part.start
        }
        if (end >= part.start && end <= next) {
          endNode = part.node
          endOffset = end - part.start
        }
      }
      if (!startNode || !endNode) return null
      const range = document.createRange()
      try {
        range.setStart(startNode, startOffset)
        range.setEnd(endNode, endOffset)
      } catch {
        return null
      }
      return range
    }

    function paint(marks) {
      const located = []
      const used = []
      const line = []
      const byColor = new Map()
      for (const mark of marks) {
        const range = findQuoteRange(mark.quote, used, mark.kind !== 'note')
        located.push({ mark, range })
        if (!range) continue
        if (mark.kind === 'line') {
          line.push(range)
          continue
        }
        if (!isColorMark(mark)) continue
        const color = markColor(mark)
        if (!byColor.has(color)) byColor.set(color, [])
        byColor.get(color).push(range)
      }
      const rules = ['::highlight(dsh-marginalia-line) { text-decoration: underline; text-decoration-color: #c9a227; text-decoration-thickness: 2px; }']
      const names = new Set(['dsh-marginalia-line'])
      if (typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight === 'function') {
        CSS.highlights.set('dsh-marginalia-line', new Highlight(...line))
        for (const [color, ranges] of byColor) {
          const name = `dsh-marginalia-${color.slice(1).toLowerCase()}`
          names.add(name)
          rules.push(`::highlight(${name}) { background-color: ${fade(color)}; color: inherit; }`)
          CSS.highlights.set(name, new Highlight(...ranges))
        }
        for (const name of liveHighlights) {
          if (!names.has(name)) CSS.highlights.delete(name)
        }
        CSS.highlights.delete('dsh-marginalia-red')
        liveHighlights.clear()
        for (const name of names) liveHighlights.add(name)
      }
      writeStyle(rules.join('\n'))
      layoutPins(located)
    }

    function ensureStyle() {
      let style = document.getElementById('dsh-marginalia-style')
      if (!style) {
        style = document.createElement('style')
        style.id = 'dsh-marginalia-style'
        document.head.appendChild(style)
      }
      writeStyle([
        '::highlight(dsh-marginalia-line) { text-decoration: underline; text-decoration-color: #c9a227; text-decoration-thickness: 2px; }',
      ].join('\n'))
    }

    function cardCss() {
      return [
        '.dsh-marginalia-card { position: fixed; z-index: 2147483000; box-sizing: border-box; color: #1c1917; background-color: #ffffff; background-image: linear-gradient(180deg, rgba(255,255,255,.72), rgba(255,255,255,0) 42%), radial-gradient(rgba(90,70,50,.045) .65px, transparent .65px); background-size: auto, 4px 4px; border: 1px solid rgba(28,25,23,.08); border-radius: 14px; box-shadow: inset 0 1px 0 #fff, 0 1px 2px rgba(40,32,24,.05), 0 14px 32px rgba(40,32,24,.12); font: 13px/1.45 "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; user-select: none; }',
        '.dsh-marginalia-toast { max-width: 240px; padding: 8px 12px; }',
        '.dsh-marginalia-toolbar { display: flex; flex-wrap: wrap; gap: 6px; padding: 6px; }',
        '.dsh-marginalia-ask { display: flex; flex-direction: column; gap: 8px; width: 280px; padding: 10px 12px; }',
        '.dsh-marginalia-card button { font: inherit; color: #1c1917; cursor: pointer; background: #fff; border: 1px solid rgba(28,25,23,.1); border-radius: 999px; padding: 4px 12px; box-shadow: inset 0 1px 0 #fff, 0 1px 2px rgba(40,32,24,.06); }',
        '.dsh-marginalia-card button:hover { background: #fafafa; }',
        '.dsh-marginalia-card button:active { background: #f4f2ef; }',
        '.dsh-marginalia-card input, .dsh-marginalia-card select { width: 100%; box-sizing: border-box; font: 13px/1.45 "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; color: #1c1917; background: #fff; border: 1px solid rgba(28,25,23,.1); border-radius: 10px; padding: 6px 8px; user-select: text; }',
        '.dsh-marginalia-preview { color: #57534e; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }',
        '.dsh-marginalia-keep, .dsh-marginalia-field { color: #78716c; font-size: 12px; }',
        '.dsh-marginalia-field { display: flex; flex-direction: column; gap: 4px; }',
        '.dsh-marginalia-actions { display: flex; justify-content: flex-end; gap: 6px; }',
        '.dsh-marginalia-colors { display: flex; align-items: center; gap: 6px; padding: 6px; }',
        '.dsh-marginalia-card .dsh-marginalia-swatch, .dsh-marginalia-card .dsh-marginalia-plus { width: 22px; height: 22px; padding: 0; border-radius: 999px; line-height: 18px; }',
        '.dsh-marginalia-card .dsh-marginalia-swatch { border: 2px solid #fff; box-shadow: 0 0 0 1px rgba(28,25,23,.2); }',
        '.dsh-marginalia-card .dsh-marginalia-swatch[data-on="true"] { box-shadow: 0 0 0 2px #1c1917; }',
        '.dsh-marginalia-card .dsh-marginalia-plus { font-size: 16px; }',
        '.dsh-marginalia-card .dsh-marginalia-plus:disabled { opacity: .4; cursor: default; }',
        '.dsh-marginalia-card input.dsh-marginalia-palette { position: absolute; width: 1px; height: 1px; padding: 0; border: 0; opacity: 0; }',
        '.dsh-marginalia-md { color: #1c1917; font: 13px/1.55 "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; overflow-wrap: anywhere; }',
        '.dsh-marginalia-md p { margin: 0 0 8px; }',
        '.dsh-marginalia-md p:last-child { margin-bottom: 0; }',
        '.dsh-marginalia-md strong { font-weight: 650; }',
        '.dsh-marginalia-md em { font-style: italic; }',
        '.dsh-marginalia-md del { text-decoration: line-through; }',
        '.dsh-marginalia-md code { font-family: Consolas, ui-monospace, monospace; background: rgba(28,25,23,.06); border-radius: 4px; padding: 0 4px; }',
        '.dsh-marginalia-md pre { margin: 0 0 8px; padding: 8px 10px; background: #f6f4f1; border-radius: 10px; overflow: auto; }',
        '.dsh-marginalia-md pre code { background: transparent; padding: 0; }',
        '.dsh-marginalia-md a { color: #1d4ed8; }',
        '.dsh-marginalia-md ul, .dsh-marginalia-md ol { margin: 0 0 8px; padding-left: 1.2em; }',
        '.dsh-marginalia-md h1, .dsh-marginalia-md h2, .dsh-marginalia-md h3, .dsh-marginalia-md h4 { font-size: 14px; line-height: 1.4; margin: 0 0 6px; }',
        '.dsh-marginalia-md blockquote { margin: 0 0 8px; padding-left: 8px; border-left: 2px solid rgba(28,25,23,.2); }',
      ].join('\n')
    }

    function writeStyle(highlights) {
      let style = document.getElementById('dsh-marginalia-style')
      if (!style) {
        style = document.createElement('style')
        style.id = 'dsh-marginalia-style'
        document.head.appendChild(style)
      }
      style.textContent = `${cardCss()}\n${highlights || ''}`
    }

    function endRect(range) {
      if (!range || typeof range.getClientRects !== 'function') return null
      try {
        const rects = range.getClientRects()
        for (let i = rects.length - 1; i >= 0; i -= 1) {
          const rect = rects[i]
          if (rect.width > 0 && rect.height > 0) return rect
        }
      } catch {
        return null
      }
      return null
    }

    function clearPins() {
      for (const pin of pinLayer.values()) {
        pin.button.remove()
        pin.note.remove()
      }
      pinLayer.clear()
    }

    function stopThreadWatch() {
      window.clearInterval(pollTimer)
      pollTimer = 0
    }

    function renderNote(note, mark) {
      const thread = threads.get(mark.childId) || { text: '', running: true, error: '' }
      const bodyText = thread.error || thread.text || (thread.running ? '正在回答…' : '这条进程没有写出文字。')
      const sig = `${mark.question}\n${thread.running ? 1 : 0}\n${bodyText}`
      if (note.getAttribute('data-sig') === sig) return
      const scroll = note.scrollTop
      note.setAttribute('data-sig', sig)
      note.replaceChildren()
      const head = document.createElement('div')
      head.style.display = 'flex'
      head.style.gap = '8px'
      head.style.alignItems = 'flex-start'
      head.style.marginBottom = '6px'
      const title = document.createElement('div')
      title.textContent = mark.question || ''
      title.style.flex = '1'
      title.style.fontWeight = '600'
      title.style.whiteSpace = 'pre-wrap'
      const close = document.createElement('button')
      close.type = 'button'
      close.textContent = '合上'
      close.style.font = 'inherit'
      close.style.color = 'inherit'
      close.style.cursor = 'pointer'
      close.style.background = 'transparent'
      close.style.border = '1px solid var(--dsw-alias-border-subtle, rgba(201,162,39,.6))'
      close.style.borderRadius = '4px'
      close.style.padding = '2px 6px'
      close.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        openMarkId = ''
        stopThreadWatch()
        layoutPins(lastLocated)
      })
      head.append(title, close)
      const body = document.createElement('div')
      body.textContent = bodyText
      body.style.whiteSpace = 'pre-wrap'
      body.style.opacity = thread.text || thread.error ? '1' : '0.75'
      note.append(head, body)
      note.scrollTop = scroll
    }

    function ensurePin(mark) {
      const existing = pinLayer.get(mark.id)
      if (existing) return existing
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = '“'
      button.title = mark.question || '提问'
      button.setAttribute('data-marginalia-pin', 'true')
      button.setAttribute('data-marginalia-menu', 'true')
      button.style.position = 'fixed'
      button.style.zIndex = '2147482800'
      button.style.width = '18px'
      button.style.height = '18px'
      button.style.padding = '0'
      button.style.borderRadius = '999px'
      button.style.font = '13px/16px Georgia, serif'
      button.style.cursor = 'pointer'
      button.style.border = '1px solid #c9a227'
      button.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        openMarkId = openMarkId === mark.id ? '' : mark.id
        if (openMarkId) watchThread()
        else stopThreadWatch()
        layoutPins(lastLocated)
      })
      const note = document.createElement('div')
      note.setAttribute('data-marginalia-pin', 'true')
      note.setAttribute('data-marginalia-menu', 'true')
      note.style.position = 'fixed'
      note.style.zIndex = '2147482800'
      note.style.display = 'none'
      note.style.width = '260px'
      note.style.maxHeight = '280px'
      note.style.overflow = 'auto'
      note.style.padding = '8px 10px'
      note.style.background = 'var(--dsw-alias-bg-elevated, Canvas)'
      note.style.color = 'var(--dsw-alias-label-primary, CanvasText)'
      note.style.border = '1px solid var(--dsw-alias-border-subtle, rgba(201,162,39,.7))'
      note.style.borderLeft = '3px solid #c9a227'
      note.style.borderRadius = '8px'
      note.style.boxShadow = '0 8px 24px rgba(0,0,0,.18)'
      note.style.font = '13px/1.45 sans-serif'
      document.body.append(button, note)
      const pin = { button, note }
      pinLayer.set(mark.id, pin)
      return pin
    }

    function layoutPins(located) {
      lastLocated = located || []
      if (!pinsOn) {
        clearPins()
        return
      }
      const alive = new Set()
      if (openMarkId && !lastLocated.some((item) => item.mark && item.mark.id === openMarkId)) {
        openMarkId = ''
        stopThreadWatch()
      }
      for (const item of lastLocated) {
        const mark = item.mark
        if (!mark || !mark.childId || !mark.question) continue
        alive.add(mark.id)
        const pin = ensurePin(mark)
        const rect = endRect(item.range)
        const open = openMarkId === mark.id
        pin.button.setAttribute('aria-expanded', open ? 'true' : 'false')
        pin.button.setAttribute('aria-label', open ? '合上这条提问' : '展开这条提问')
        pin.button.title = mark.question
        pin.button.style.background = open ? '#c9a227' : 'var(--dsw-alias-bg-elevated, Canvas)'
        pin.button.style.color = open ? '#1a1a1a' : '#c9a227'
        if (!rect) {
          pin.button.style.display = 'none'
          pin.note.style.display = 'none'
          continue
        }
        pin.button.style.display = 'block'
        const left = Math.min(Math.max(8, rect.right + 2), Math.max(8, window.innerWidth - 22))
        const top = Math.min(Math.max(8, rect.top - 10), Math.max(8, window.innerHeight - 22))
        pin.button.style.left = `${left}px`
        pin.button.style.top = `${top}px`
        if (!open) {
          pin.note.style.display = 'none'
          continue
        }
        renderNote(pin.note, mark)
        pin.note.style.display = 'block'
        place(pin.note, left, rect.bottom + 8)
      }
      for (const [id, pin] of pinLayer) {
        if (alive.has(id)) continue
        pin.button.remove()
        pin.note.remove()
        pinLayer.delete(id)
      }
    }

    async function pullThread(childId) {
      const res = await fetch(route('/marginalia/api/child', { childId }), { headers: { accept: 'application/json' } })
      const data = await res.json().catch(() => null)
      if (res.status === 404) return true
      const prev = threads.get(childId) || { text: '', running: true, error: '' }
      if (!res.ok || !data || data.ok !== true) {
        threads.set(childId, {
          text: prev.text,
          running: true,
          error: (data && data.error && data.error.message) || `HTTP ${res.status}`,
        })
        return true
      }
      threads.set(childId, { text: data.text || '', running: data.running === true, error: '' })
      return data.running === true
    }

    function watchThread() {
      stopThreadWatch()
      if (!openMarkId) return
      const mark = store.marks.find((item) => item.id === openMarkId)
      if (!mark || !mark.childId) return
      const childId = mark.childId
      const tick = async () => {
        const current = store.marks.find((item) => item.id === openMarkId)
        if (!current || current.childId !== childId) return
        let again = true
        try {
          again = await pullThread(childId)
        } catch {
          again = true
        }
        layoutPins(lastLocated)
        if (!again) stopThreadWatch()
      }
      tick()
      pollTimer = window.setInterval(tick, 1000)
    }

    function closeMenu() {
      menuGeneration += 1
      paletteOpen = false
      window.clearTimeout(menuTimer)
      if (colorEl) {
        colorEl.remove()
        colorEl = null
      }
      if (menuEl) {
        menuEl.remove()
        menuEl = null
      }
    }

    function place(el, x, y) {
      document.body.appendChild(el)
      const rect = el.getBoundingClientRect()
      const left = Math.min(Math.max(8, x), Math.max(8, window.innerWidth - rect.width - 8))
      let top = Math.max(8, y)
      if (top + rect.height > window.innerHeight - 8) top = Math.max(8, y - rect.height - 6)
      el.style.left = `${left}px`
      el.style.top = `${top}px`
    }

    function placeNearCaret(el, range, fallbackX, fallbackY) {
      document.body.appendChild(el)
      const box = el.getBoundingClientRect()
      const caret = endRect(range)
      const anchorX = caret ? caret.right : fallbackX
      const anchorTop = caret ? caret.top : fallbackY
      const maxLeft = Math.max(8, window.innerWidth - box.width - 8)
      let left = anchorX + 8
      if (left > maxLeft) left = Math.max(8, anchorX - box.width - 8)
      left = Math.min(Math.max(8, left), maxLeft)
      let top = anchorTop - box.height - 8
      if (top < 8) top = caret ? caret.bottom + 8 : fallbackY + 8
      const maxTop = Math.max(8, window.innerHeight - box.height - 8)
      top = Math.min(Math.max(8, top), maxTop)
      el.style.left = `${left}px`
      el.style.top = `${top}px`
    }

    function keepSelection(el) {
      el.addEventListener('mousedown', (event) => {
        const target = event.target
        if (target && target.closest && target.closest('button')) event.preventDefault()
      }, true)
    }

    function showNote(x, y, text) {
      closeMenu()
      const el = document.createElement('div')
      el.setAttribute('data-marginalia-menu', 'true')
      el.className = 'dsh-marginalia-card dsh-marginalia-toast'
      el.textContent = text
      menuEl = el
      placeNearCaret(el, lastRange, x, y)
      menuTimer = window.setTimeout(() => {
        if (menuEl === el) closeMenu()
      }, 1600)
    }

    function menuButton(label, onClick) {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = label
      button.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        onClick()
      })
      return button
    }

    async function saveMark(kind, quote, sessionId, color) {
      const cwd = cwdOf(pluginCtx, sessionId)
      const marks = store.sessionId === sessionId ? store.marks : await readNotes(sessionId, cwd)
      const duplicate = kind === 'mark'
        ? marks.some((mark) => isColorMark(mark) && mark.quote === quote)
        : marks.some((mark) => mark.quote === quote && mark.kind === kind)
      if (duplicate) {
        patch({ sessionId, cwd, marks })
        return { duplicate: true, marks }
      }
      const markdown = storedMarkdown(lastMarkdown, quote)
      const next = [...marks, {
        id: `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        kind,
        ...(kind === 'mark' ? { color: normalizeHex(color) || '#E04848' } : {}),
        quote,
        ...(markdown ? { markdown } : {}),
        comment: '',
        start: 0,
        end: quote.length,
      }]
      patch({ sessionId, cwd, marks: next, status: '正在写入笔记…' })
      const saved = await writeNotes(sessionId, cwd, next)
      patch({ sessionId, cwd, marks: saved, status: '已收入「学习」笔记。' })
      paint(saved)
      return { duplicate: false, marks: saved }
    }

    async function recolorMark(sessionId, quote, selectionRange, color) {
      const hex = normalizeHex(color)
      if (!hex) return null
      const cwd = cwdOf(pluginCtx, sessionId)
      const marks = store.sessionId === sessionId ? store.marks : await readNotes(sessionId, cwd)
      const hits = colorHits(marks, quote, selectionRange)
      if (hits.length === 0) return saveMark('mark', quote, sessionId, hex)
      const ids = new Set(hits.map((mark) => mark.id))
      const next = marks.map((mark) => (ids.has(mark.id) ? { ...mark, kind: 'mark', color: hex } : mark))
      patch({ sessionId, cwd, marks: next, status: '正在写入笔记…' })
      const saved = await writeNotes(sessionId, cwd, next)
      patch({ sessionId, cwd, marks: saved, status: '已换成这个颜色。' })
      paint(saved)
      return { duplicate: false, marks: saved }
    }

    function placeColorBox(box, anchor) {
      document.body.appendChild(box)
      const host = anchor.getBoundingClientRect()
      const rect = box.getBoundingClientRect()
      const maxLeft = Math.max(8, window.innerWidth - rect.width - 8)
      let left = Math.min(Math.max(8, host.left), maxLeft)
      let top = host.top - rect.height - 8
      if (top < 8) top = Math.min(host.bottom + 8, Math.max(8, window.innerHeight - rect.height - 8))
      box.style.left = `${left}px`
      box.style.top = `${top}px`
    }

    function showColorBox(anchor, sessionId, quote, selectionRange, activeColor) {
      if (colorEl) colorEl.remove()
      const colors = loadColors()
      const box = document.createElement('div')
      box.setAttribute('data-marginalia-menu', 'true')
      box.className = 'dsh-marginalia-card dsh-marginalia-colors'
      box.title = '选择标记颜色'
      const current = normalizeHex(activeColor) || colors[0]
      for (const hex of colors) {
        const swatch = document.createElement('button')
        swatch.type = 'button'
        swatch.className = 'dsh-marginalia-swatch'
        swatch.title = hex
        swatch.style.background = hex
        swatch.setAttribute('data-on', hex === current ? 'true' : 'false')
        swatch.addEventListener('click', (event) => {
          event.preventDefault()
          event.stopPropagation()
          recolorMark(sessionId, quote, selectionRange, hex).then(() => {
            if (colorEl === box) showColorBox(anchor, sessionId, quote, selectionRange, hex)
          }).catch((error) => {
            showNote(lastX, lastY, String((error && error.message) || error))
          })
        })
        box.append(swatch)
      }
      const plus = document.createElement('button')
      plus.type = 'button'
      plus.className = 'dsh-marginalia-plus'
      plus.textContent = '+'
      plus.title = colors.length >= MAX_COLORS ? '最多 5 种颜色' : '自定义颜色'
      plus.disabled = colors.length >= MAX_COLORS
      const picker = document.createElement('input')
      picker.type = 'color'
      picker.className = 'dsh-marginalia-palette'
      picker.value = current
      picker.addEventListener('focus', () => { paletteOpen = true })
      picker.addEventListener('blur', () => { paletteOpen = false })
      picker.addEventListener('change', () => {
        paletteOpen = false
        const hex = normalizeHex(picker.value)
        if (!hex) return
        const known = loadColors()
        if (!known.includes(hex)) {
          if (known.length >= MAX_COLORS) {
            showNote(lastX, lastY, '最多 5 种颜色。')
            return
          }
          saveColors([...known, hex])
        }
        recolorMark(sessionId, quote, selectionRange, hex).then(() => {
          if (menuEl && anchor.isConnected) showColorBox(anchor, sessionId, quote, selectionRange, hex)
        }).catch((error) => {
          showNote(lastX, lastY, String((error && error.message) || error))
        })
      })
      plus.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        if (plus.disabled) return
        picker.click()
      })
      box.append(plus, picker)
      keepSelection(box)
      box.addEventListener('contextmenu', (event) => event.preventDefault())
      colorEl = box
      placeColorBox(box, anchor)
    }

    async function toggle(kind, quote, sessionId, selectionRange) {
      closeMenu()
      if (!sessionId) {
        patch({ status: '还没对上当前对话。' })
        showNote(lastX, lastY, '还没对上当前对话。')
        return
      }
      const label = kind === 'line' ? '划线' : '标记'
      try {
        const cwd = cwdOf(pluginCtx, sessionId)
        const marks = store.sessionId === sessionId ? store.marks : await readNotes(sessionId, cwd)
        const hits = coveredMarks(marks, kind, quote, selectionRange)
        if (hits.length > 0) {
          const drop = new Set(hits.map((mark) => mark.id))
          const next = marks.filter((mark) => !drop.has(mark.id))
          patch({ sessionId, cwd, marks: next, status: '正在写入笔记…' })
          const saved = await writeNotes(sessionId, cwd, next)
          patch({ sessionId, cwd, marks: saved, status: `已取消${label}。` })
          paint(saved)
          showNote(lastX, lastY, `已取消${label}。`)
          return
        }
        const result = await saveMark(kind, quote, sessionId)
        showNote(lastX, lastY, result.duplicate ? '这段已经标过了。' : '已收入「学习」。')
      } catch (error) {
        const message = String((error && error.message) || error)
        patch({ status: message })
        showNote(lastX, lastY, message)
      }
    }

    async function cancelColors(quote, sessionId, selectionRange) {
      closeMenu()
      if (!sessionId) {
        patch({ status: '还没对上当前对话。' })
        showNote(lastX, lastY, '还没对上当前对话。')
        return
      }
      try {
        const cwd = cwdOf(pluginCtx, sessionId)
        const marks = store.sessionId === sessionId ? store.marks : await readNotes(sessionId, cwd)
        const hits = colorHits(marks, quote, selectionRange)
        if (hits.length === 0) return
        const drop = new Set(hits.map((mark) => mark.id))
        const next = marks.filter((mark) => !drop.has(mark.id))
        patch({ sessionId, cwd, marks: next, status: '正在写入笔记…' })
        const saved = await writeNotes(sessionId, cwd, next)
        patch({ sessionId, cwd, marks: saved, status: '已取消标记。' })
        paint(saved)
        showNote(lastX, lastY, '已取消标记。')
      } catch (error) {
        const message = String((error && error.message) || error)
        patch({ status: message })
        showNote(lastX, lastY, message)
      }
    }

    async function startMark(anchor, quote, sessionId, selectionRange, button) {
      if (!sessionId) {
        patch({ status: '还没对上当前对话。' })
        showNote(lastX, lastY, '还没对上当前对话。')
        return
      }
      const color = loadColors()[0] || '#E04848'
      try {
        const result = await saveMark('mark', quote, sessionId, color)
        if (!anchor.isConnected) return
        if (button) {
          button.textContent = '取消标记'
          button.dataset.on = 'true'
        }
        const hits = colorHits(result.marks || [], quote, selectionRange)
        const active = hits.length ? markColor(hits[hits.length - 1]) : color
        showColorBox(anchor, sessionId, quote, selectionRange, active)
      } catch (error) {
        const message = String((error && error.message) || error)
        patch({ status: message })
        showNote(lastX, lastY, message)
      }
    }

    function openChildAside(parentId, childId) {
      if (!parentId || !childId || !pluginCtx || typeof pluginCtx.get !== 'function') return
      let sidebar = null
      try {
        sidebar = pluginCtx.get('sidebarRight')
      } catch {
        return
      }
      if (!sidebar || typeof sidebar.openResource !== 'function') return
      const query = new URLSearchParams({ parent: parentId, mode: 'continuable' })
      const address = `dsh-resource://subagentchat/session/${encodeURIComponent(childId)}?${query}`
      try {
        sidebar.openResource(address, { kind: 'subagentchat', preferNewPane: true })
      } catch {
        /* The side list still has the thread, and the note still shows the latest reply. */
      }
    }

    function joinQuestion(previous, next) {
      const added = String(next || '').trim()
      const prior = String(previous || '').trim()
      if (!added) return prior.slice(0, 2000)
      if (!prior) return added.slice(0, 2000)
      const last = prior.split('\n').pop().trim()
      if (last === added) return prior.slice(0, 2000)
      return `${prior}\n${added}`.slice(0, 2000)
    }

    function widerQuote(current, incoming) {
      const a = String(current || '')
      const b = String(incoming || '')
      if (!a.trim()) return b.slice(0, 4000)
      if (!b.trim()) return a.slice(0, 4000)
      if (sameQuote(a, b)) return (a.length >= b.length ? a : b).slice(0, 4000)
      const foldedCurrent = foldSpace(a).out
      const foldedIncoming = foldSpace(b).out
      if (foldedCurrent && foldedIncoming && foldedIncoming.includes(foldedCurrent) && foldedIncoming !== foldedCurrent) {
        return b.slice(0, 4000)
      }
      return a.slice(0, 4000)
    }

    async function attachThread(quote, sessionId, question, childId, markdown) {
      const cwd = cwdOf(pluginCtx, sessionId)
      const marks = store.sessionId === sessionId ? store.marks : await readNotes(sessionId, cwd)
      let target = null
      for (let i = marks.length - 1; i >= 0; i -= 1) {
        const mark = marks[i]
        if (mark && mark.childId === childId) {
          target = mark
          break
        }
      }
      if (!target) {
        for (let i = marks.length - 1; i >= 0; i -= 1) {
          const mark = marks[i]
          if (mark && mark.kind === 'note' && sameQuote(mark.quote, quote)) {
            target = mark
            break
          }
        }
      }
      if (!target) {
        for (let i = marks.length - 1; i >= 0; i -= 1) {
          const mark = marks[i]
          if (mark && mark.childId && sameQuote(mark.quote, quote)) {
            target = mark
            break
          }
        }
      }
      const nextQuote = target ? widerQuote(target.quote, quote) : quote
      const formatted = storedMarkdown(markdown, nextQuote) || storedMarkdown(target && target.markdown, nextQuote)
      const next = target
        ? marks.map((mark) => (mark.id === target.id
          ? {
            ...mark,
            quote: nextQuote,
            ...(formatted ? { markdown: formatted } : { markdown: '' }),
            question: joinQuestion(mark.question, question),
            childId,
          }
          : mark))
        : [...marks, {
          id: `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
          kind: 'note',
          quote,
          ...(formatted ? { markdown: formatted } : {}),
          question: joinQuestion('', question),
          childId,
          comment: '',
          start: 0,
          end: quote.length,
        }]
      patch({ sessionId, cwd, marks: next, status: '正在写入笔记…' })
      const saved = await writeNotes(sessionId, cwd, next)
      const stuck = saved.find((mark) => mark.childId === childId) || (target && saved.find((mark) => mark.id === target.id))
      patch({ sessionId, cwd, marks: saved, status: '已记入「学习」。' })
      openMarkId = stuck ? stuck.id : ''
      threads.set(childId, { text: '', running: true, error: '' })
      paint(saved)
      watchThread()
    }

    async function ask(quote, sessionId, question, continueId, model, markdown) {
      const formatted = markdown == null ? lastMarkdown : markdown
      closeMenu()
      if (!sessionId) {
        patch({ status: '还没对上当前对话。' })
        showNote(lastX, lastY, '还没对上当前对话。')
        return
      }
      const text = String(question || '').trim()
      if (!text) return
      if (text.length > 2000) {
        showNote(lastX, lastY, '问题要写在 2000 字以内。')
        return
      }
      try {
        const body = { sessionId, quote: promptQuote(quote, formatted), question: text }
        if (continueId) body.continueId = continueId
        if (model && model.provider && model.id) {
          body.provider = model.provider
          body.model = model.id
        }
        const res = await fetch(route('/marginalia/api/ask'), {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body),
        })
        const data = await res.json()
        if (!res.ok || !data || data.ok !== true || !data.childId) {
          throw new Error((data && data.error && data.error.message) || `HTTP ${res.status}`)
        }
        await attachThread(quote, sessionId, text, data.childId, formatted)
        openChildAside(data.parentId || sessionId, data.childId)
        if (data.continued === true) patch({ status: '已记入「学习」，接到这条进程下面。' })
      } catch (error) {
        const message = String((error && error.message) || error)
        patch({ status: message })
        showNote(lastX, lastY, message)
      }
    }

    async function copyQuote(quote) {
      const text = promptQuote(quote, lastMarkdown)
      const html = renderMarkdown(text)
      closeMenu()
      let copied = false
      try {
        if (navigator.clipboard && typeof navigator.clipboard.write === 'function' && typeof ClipboardItem !== 'undefined') {
          await navigator.clipboard.write([
            new ClipboardItem({
              'text/plain': new Blob([text], { type: 'text/plain' }),
              'text/html': new Blob([html], { type: 'text/html' }),
            }),
          ])
          copied = true
        }
      } catch {
        copied = false
      }
      if (!copied) {
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text)
            copied = true
          }
        } catch {
          copied = false
        }
      }
      if (!copied) {
        const area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', '')
        area.style.position = 'fixed'
        area.style.left = '-9999px'
        document.body.appendChild(area)
        area.select()
        try {
          copied = document.execCommand('copy')
        } catch {
          copied = false
        }
        area.remove()
      }
      showNote(lastX, lastY, copied ? '已复制。' : '复制失败。')
    }

    async function openMenu(x, y, quote, sessionId, selectionRange) {
      closeMenu()
      const generation = menuGeneration
      lastX = x
      lastY = y
      lastRange = selectionRange || null
      let marks = store.sessionId === sessionId ? store.marks : []
      if (store.sessionId !== sessionId && sessionId) {
        try {
          const cwd = cwdOf(pluginCtx, sessionId)
          marks = await readNotes(sessionId, cwd)
          if (generation !== menuGeneration) return
          patch({ sessionId, cwd, marks })
        } catch {
          marks = []
        }
      }
      if (generation !== menuGeneration) return
      let childHere = false
      if (sessionId) {
        try {
          const res = await fetch(route('/marginalia/api/thread', { sessionId }), { headers: { accept: 'application/json' } })
          const data = await res.json()
          childHere = !!(res.ok && data && data.role === 'child')
        } catch {
          childHere = false
        }
      }
      if (generation !== menuGeneration) return
      const colorOn = colorHits(marks, quote, selectionRange).length > 0
      const lineMarks = coveredMarks(marks, 'line', quote, selectionRange)
      const lineOn = lineMarks.length > 0
      const linked = linkedThread(marks, quote, selectionRange)
      const follow = childHere || !!linked
      const continueId = childHere ? '' : (linked && linked.childId) || ''
      const el = document.createElement('div')
      el.setAttribute('data-marginalia-menu', 'true')
      el.className = 'dsh-marginalia-card dsh-marginalia-toolbar'
      const markButton = menuButton(colorOn ? '取消标记' : '标记', () => {
        if (markButton.dataset.on === 'true') {
          void cancelColors(quote, sessionId, selectionRange)
          return
        }
        void startMark(el, quote, sessionId, selectionRange, markButton)
      })
      if (colorOn) markButton.dataset.on = 'true'
      el.append(
        menuButton('复制', () => copyQuote(quote)),
        markButton,
        menuButton(lineOn ? '取消划线' : '划线', () => toggle('line', quote, sessionId, selectionRange)),
        menuButton(follow ? '追问' : '提问', () => openAsk(x, y, quote, sessionId, continueId, follow)),
      )
      keepSelection(el)
      el.addEventListener('contextmenu', (event) => event.preventDefault())
      menuEl = el
      placeNearCaret(el, selectionRange, x, y)
      if (colorOn) {
        const hits = colorHits(marks, quote, selectionRange)
        showColorBox(el, sessionId, quote, selectionRange, hits.length ? markColor(hits[hits.length - 1]) : '#E04848')
      }
    }

    function chosenModel(select) {
      if (!select || !select.value) return null
      return chosenModelValue(select.value)
    }

    function chosenModelValue(value) {
      if (!value) return null
      const splitAt = String(value).indexOf('\n')
      if (splitAt <= 0) return null
      const provider = String(value).slice(0, splitAt)
      const id = String(value).slice(splitAt + 1)
      if (!provider || !id) return null
      return { provider, id }
    }

    function modelOptions(models, inheritLabel, selectedValue) {
      const options = [h('option', { value: '', key: 'inherit' }, inheritLabel)]
      const seen = new Set([''])
      const groups = new Map()
      const rows = Array.isArray(models) ? models.slice() : []
      const selected = chosenModelValue(selectedValue)
      if (selected && !rows.some((model) => model && model.provider === selected.provider && model.id === selected.id)) {
        rows.unshift({ provider: selected.provider, providerName: selected.provider, id: selected.id, name: selected.id })
      }
      for (const model of rows) {
        if (!model || !model.provider || !model.id) continue
        const key = `${model.provider}\n${model.id}`
        if (seen.has(key)) continue
        seen.add(key)
        const name = model.providerName || model.provider
        if (!groups.has(name)) groups.set(name, [])
        groups.get(name).push(model)
      }
      for (const [name, groupRows] of groups) {
        options.push(h('optgroup', { key: name, label: name }, groupRows.map((model) => {
          const key = `${model.provider}\n${model.id}`
          return h('option', { key, value: key }, model.name || model.id)
        })))
      }
      return options
    }

    function fillModels(select, generation) {
      fetch(route('/marginalia/api/models'), { headers: { accept: 'application/json' } })
        .then((res) => res.json())
        .then((data) => {
          if (generation !== menuGeneration || !select.isConnected) return
          if (!data || data.ok !== true || !Array.isArray(data.models)) return
          const groups = new Map()
          for (const model of data.models) {
            if (!model || !model.provider || !model.id) continue
            const name = model.providerName || model.provider
            if (!groups.has(name)) groups.set(name, [])
            groups.get(name).push(model)
          }
          for (const [name, models] of groups) {
            const group = document.createElement('optgroup')
            group.label = name
            for (const model of models) {
              const option = document.createElement('option')
              option.value = `${model.provider}\n${model.id}`
              option.textContent = model.name || model.id
              group.append(option)
            }
            select.append(group)
          }
        })
        .catch(() => {})
    }

    function openAsk(x, y, quote, sessionId, continueId, follow) {
      closeMenu()
      const generation = menuGeneration
      lastX = x
      lastY = y
      const el = document.createElement('form')
      el.setAttribute('data-marginalia-menu', 'true')
      el.className = 'dsh-marginalia-card dsh-marginalia-ask'
      const preview = document.createElement('div')
      preview.className = 'dsh-marginalia-preview'
      preview.textContent = quote.length > 42 ? `${quote.slice(0, 42)}…` : quote
      const input = document.createElement('input')
      input.type = 'text'
      input.maxLength = 2000
      input.placeholder = '这段是什么？'
      const row = document.createElement('div')
      row.className = 'dsh-marginalia-actions'
      const cancel = document.createElement('button')
      cancel.type = 'button'
      cancel.textContent = '取消'
      cancel.addEventListener('click', (event) => {
        event.preventDefault()
        closeMenu()
      })
      const go = document.createElement('button')
      go.type = 'submit'
      go.textContent = follow ? '追问' : '发起'
      row.append(cancel, go)
      const field = document.createElement('label')
      field.className = 'dsh-marginalia-field'
      field.textContent = '模型'
      const select = document.createElement('select')
      const inherit = document.createElement('option')
      inherit.value = ''
      inherit.textContent = follow ? '沿用当前模型' : '跟随当前对话'
      select.append(inherit)
      select.addEventListener('change', () => select.blur())
      field.append(select)
      el.append(preview, input, field, row)
      fillModels(select, generation)
      keepSelection(el)
      el.addEventListener('submit', (event) => {
        event.preventDefault()
        const question = input.value.trim()
        if (!question) {
          input.focus()
          return
        }
        ask(quote, sessionId, question, follow ? continueId : '', chosenModel(select))
      })
      el.addEventListener('contextmenu', (event) => event.preventDefault())
      menuEl = el
      placeNearCaret(el, lastRange, x, y)
      input.focus()
    }

    const S = {
      wrap: {
        height: '100%', minHeight: 0, overflow: 'auto', padding: 16,
        font: '13px/1.55 "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
      },
      hint: { opacity: 0.75, margin: '0 0 12px', fontSize: 12, lineHeight: 1.5 },
      card: {
        color: '#1c1917',
        backgroundColor: '#ffffff',
        backgroundImage: 'linear-gradient(180deg, rgba(255,255,255,.72), rgba(255,255,255,0) 42%), radial-gradient(rgba(90,70,50,.045) .65px, transparent .65px)',
        backgroundSize: 'auto, 4px 4px',
        border: '1px solid rgba(28,25,23,.08)',
        borderRadius: 14,
        boxShadow: 'inset 0 1px 0 #fff, 0 1px 2px rgba(40,32,24,.05), 0 8px 20px rgba(40,32,24,.06)',
        padding: '12px 14px',
        marginBottom: 10,
      },
      field: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 },
      preview: { maxHeight: 220, overflow: 'auto' },
      label: { color: '#78716c', fontSize: 12 },
      comment: {
        width: '100%', boxSizing: 'border-box', resize: 'vertical',
        font: 'inherit', color: '#1c1917', background: '#fff',
        border: '1px solid rgba(28,25,23,.1)', borderRadius: 10, padding: '6px 8px',
      },
      row: { display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' },
      head: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 10 },
      btn: {
        font: 'inherit', color: '#1c1917', cursor: 'pointer', background: '#fff',
        border: '1px solid rgba(28,25,23,.1)', borderRadius: 999, padding: '4px 12px',
        boxShadow: 'inset 0 1px 0 #fff, 0 1px 2px rgba(40,32,24,.06)',
      },
      select: {
        font: 'inherit', color: '#1c1917', cursor: 'pointer', background: '#fff',
        border: '1px solid rgba(28,25,23,.1)', borderRadius: 999, padding: '4px 10px',
        boxShadow: 'inset 0 1px 0 #fff, 0 1px 2px rgba(40,32,24,.06)',
      },
      check: { width: 15, height: 15, margin: 0, flex: 'none', accentColor: '#1c1917' },
      chip: { fontSize: 11, borderRadius: 999, padding: '2px 8px', color: '#1c1917', flex: 'none' },
    }

    function SessionProbe(props) {
      const sessionId = props.sessionId || ''
      React.useEffect(() => {
        if (!sessionId) return undefined
        let cancelled = false
        const cwd = cwdOf(pluginCtx, sessionId)
        patch({ sessionId, cwd, marks: store.sessionId === sessionId ? store.marks : [], status: '' })
        readNotes(sessionId, cwd).then((marks) => {
          if (cancelled || store.sessionId !== sessionId) return
          patch({ marks })
          paint(marks)
        }).catch((error) => {
          if (!cancelled) patch({ status: String((error && error.message) || error) })
        })
        return () => { cancelled = true }
      }, [sessionId])
      React.useEffect(() => {
        ensureStyle()
        let timer = 0
        const ownNode = (node) => {
          const el = !node ? null : node.nodeType === 1 ? node : node.parentElement
          return Boolean(el && el.closest && el.closest('[data-marginalia-pin], [data-marginalia-menu], [data-marginalia-model], #dsh-marginalia-style'))
        }
        const observer = new MutationObserver((records) => {
          const own = records.every((record) => ownNode(record.target)
            && [...record.addedNodes].every(ownNode)
            && [...record.removedNodes].every(ownNode))
          if (own) return
          window.clearTimeout(timer)
          timer = window.setTimeout(() => paint(store.marks), 120)
        })
        observer.observe(document.body, { childList: true, subtree: true, characterData: true })
        const onMove = () => layoutPins(lastLocated)
        document.addEventListener('scroll', onMove, true)
        window.addEventListener('resize', onMove)
        pinsOn = true
        paint(store.marks)
        if (openMarkId) watchThread()
        return () => {
          pinsOn = false
          observer.disconnect()
          window.clearTimeout(timer)
          document.removeEventListener('scroll', onMove, true)
          window.removeEventListener('resize', onMove)
          stopThreadWatch()
          clearPins()
        }
      }, [sessionId])
      return null
    }

    function StudyNotes(props) {
      const ctx = props.studyCtx || pluginCtx
      const snap = useStore()
      const sessionId = props.sessionId || snap.sessionId
      const asking = React.useState('')
      const draft = React.useState('')
      const modelDraft = React.useState('')
      const catalog = React.useState([])
      const askingId = asking[0]
      const setAskingId = asking[1]
      const questionDraft = draft[0]
      const setQuestionDraft = draft[1]
      const chosenDraft = modelDraft[0]
      const setChosenDraft = modelDraft[1]
      const modelList = catalog[0]
      const setModelList = catalog[1]
      const filterModeState = React.useState('all')
      const filterMode = filterModeState[0]
      const setFilterMode = filterModeState[1]
      const filterNameState = React.useState('')
      const filterName = filterNameState[0]
      const setFilterName = filterNameState[1]
      const pickedState = React.useState([])
      const pickedIds = pickedState[0]
      const setPickedIds = pickedState[1]
      const categoryState = React.useState(loadCategories)
      const storedCategories = categoryState[0]
      const setStoredCategories = categoryState[1]
      const categoryDraftState = React.useState('')
      const categoryDraft = categoryDraftState[0]
      const setCategoryDraft = categoryDraftState[1]
      const batchState = React.useState('')
      const batchCategory = batchState[0]
      const setBatchCategory = batchState[1]
      React.useEffect(() => {
        let cancelled = false
        fetch(route('/marginalia/api/models'), { headers: { accept: 'application/json' } })
          .then((res) => res.json())
          .then((data) => {
            if (cancelled || !data || data.ok !== true || !Array.isArray(data.models)) return
            setModelList(data.models)
          })
          .catch(() => {})
        return () => { cancelled = true }
      }, [])
      async function save(next) {
        if (!sessionId) {
          patch({ status: '还没对上当前对话。' })
          return
        }
        if (next.some((mark) => !String(mark && mark.quote || '').trim())) {
          patch({ marks: next, status: '摘录不能是空白。' })
          return
        }
        const cwd = cwdOf(ctx, sessionId)
        patch({ marks: next, cwd, status: '正在写入笔记…' })
        try {
          const saved = await writeNotes(sessionId, cwd, next)
          patch({ marks: saved, status: '已保存。' })
          paint(saved)
        } catch (error) {
          patch({ status: String((error && error.message) || error) })
        }
      }
      function editExcerpt(id, source) {
        const clipped = String(source || '').slice(0, MAX_MARKDOWN)
        const plain = plainFromMarkdown(clipped).slice(0, 4000)
        const current = store.marks.find((item) => item.id === id)
        const fields = { markdown: clipped }
        if (!current || !sameQuote(plain, current.quote)) fields.quote = plain || clipped.slice(0, 4000)
        editMark(id, fields)
      }
      function editMark(id, fields) {
        const next = store.marks.map((item) => (item.id === id ? { ...item, ...fields } : item))
        patch({ marks: next })
        window.clearTimeout(noteSaveTimer)
        noteSaveTimer = window.setTimeout(() => {
          noteSaveTimer = 0
          const current = store.marks
          const mark = current.find((item) => item.id === id)
          if (!mark || !String(mark.quote || '').trim()) {
            patch({ status: '摘录不能是空白。' })
            return
          }
          save(current)
        }, 300)
      }
      function kindLabel(mark) {
        if (mark.kind === 'line') return '划线'
        if (mark.kind === 'note') return '提问'
        return '标记'
      }
      function chipBackground(mark) {
        if (mark.kind === 'line') return 'rgba(227,201,107,.45)'
        if (mark.kind === 'note') return 'rgba(28,25,23,.06)'
        return fade(markColor(mark))
      }
      function field(label, value, placeholder, maxLength, rows, onValue) {
        return h('label', { style: S.field },
          h('span', { style: S.label }, label),
          h('textarea', {
            style: S.comment,
            rows,
            placeholder,
            maxLength,
            value: value || '',
            onChange: (event) => onValue(event.target.value),
          }))
      }
      const categoryNames = listedCategories(storedCategories, snap.marks)
      const activeName = filterMode === 'name' && categoryNames.includes(filterName) ? filterName : ''
      const activeMode = activeName ? 'name' : filterMode === 'none' ? 'none' : 'all'
      const visible = snap.marks.filter((mark) => {
        const name = cleanCategory(mark && mark.category)
        if (activeMode === 'none') return !name
        if (activeMode === 'name') return name === activeName
        return true
      })
      const visibleIds = new Set(visible.map((mark) => mark.id))
      const pickedVisible = pickedIds.filter((id) => visibleIds.has(id))
      const allChecked = visible.length > 0 && pickedVisible.length === visible.length
      function categoryOptions() {
        return categoryNames.map((name) => h('option', { key: name, value: name }, name))
      }
      function addCategory() {
        const name = cleanCategory(categoryDraft)
        if (!name) {
          patch({ status: '类别名称不能是空白。' })
          return
        }
        if (storedCategories.includes(name)) {
          setFilterMode('name')
          setFilterName(name)
          setCategoryDraft('')
          patch({ status: `类别「${name}」已经有了。` })
          return
        }
        if (storedCategories.length >= MAX_CATEGORIES) {
          patch({ status: `类别最多 ${MAX_CATEGORIES} 个。` })
          return
        }
        setStoredCategories(saveCategories(storedCategories.concat(name)))
        setFilterMode('name')
        setFilterName(name)
        setCategoryDraft('')
        patch({ status: `已添加类别「${name}」。` })
      }
      function toggleAll() {
        if (allChecked) {
          setPickedIds(pickedIds.filter((id) => !visibleIds.has(id)))
          return
        }
        const next = new Set(pickedIds)
        for (const id of visibleIds) next.add(id)
        setPickedIds([...next])
      }
      function toggleOne(id) {
        setPickedIds(pickedIds.includes(id) ? pickedIds.filter((item) => item !== id) : pickedIds.concat(id))
      }
      function applyBatch() {
        const chosen = new Set(pickedVisible)
        save(store.marks.map((item) => (chosen.has(item.id) ? { ...item, category: batchCategory } : item)))
      }
      function deleteBatch() {
        const chosen = new Set(pickedVisible)
        setPickedIds(pickedIds.filter((id) => !chosen.has(id)))
        save(store.marks.filter((item) => !chosen.has(item.id)))
      }
      return h(
        'div',
        { style: S.wrap },
        h('div', { style: S.hint }, '选中一段可以复制、标记、划线或提问。提问记在这里，不会自动划线。摘录会留下原文的加粗和代码：上面按页面的样子显示，下面是 Markdown，改完会保存。复制出去的也是这份 Markdown。笔记旁边可以按类别筛选，类别可以自己加。勾选之后可以一起改类别或删除。'),
        snap.status ? h('div', { style: S.hint }, snap.status) : null,
        h(
          'div',
          { style: S.head },
          h('strong', { style: { flex: 'none' } }, `笔记 · ${snap.marks.length}`),
          h('select', {
            value: activeMode === 'name' ? `name:${activeName}` : activeMode,
            'aria-label': '按类别筛选',
            onChange: (event) => {
              const value = event.target.value
              if (value === 'none') {
                setFilterMode('none')
                return
              }
              if (value.startsWith('name:')) {
                setFilterMode('name')
                setFilterName(value.slice(5))
                return
              }
              setFilterMode('all')
            },
            style: S.select,
          },
          h('option', { value: 'all' }, '全部'),
          h('option', { value: 'none' }, '未分类'),
          categoryNames.map((name) => h('option', { key: name, value: `name:${name}` }, name))),
          activeMode === 'all' ? null : h('span', { style: { fontSize: 12, opacity: 0.75 } }, `显示 ${visible.length} 条`),
          h('input', {
            value: categoryDraft,
            placeholder: '新类别',
            maxLength: 40,
            'aria-label': '新类别名称',
            onChange: (event) => setCategoryDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              addCategory()
            },
            style: { ...S.comment, width: 128, flex: '0 1 140px', borderRadius: 999, padding: '4px 10px' },
          }),
          h('button', { type: 'button', style: S.btn, onClick: addCategory }, '添加类别'),
          h('span', { style: { flex: '1 1 8px' } }),
          h('button', {
            type: 'button',
            style: S.btn,
            disabled: visible.length === 0,
            onClick: async () => {
              try {
                await navigator.clipboard.writeText(localMarkdown(visible))
                patch({ status: visible.length === snap.marks.length ? '笔记已复制。' : `已复制这 ${visible.length} 条。` })
              } catch {
                patch({ status: '复制失败。' })
              }
            },
          }, '复制笔记'),
        ),
        visible.length === 0 ? null : h(
          'div',
          { style: { ...S.head, marginBottom: 8 } },
          h('label', { style: { display: 'flex', alignItems: 'center', gap: 6, flex: 'none' } },
            h('input', {
              type: 'checkbox',
              checked: allChecked,
              ref: (node) => {
                if (node) node.indeterminate = pickedVisible.length > 0 && !allChecked
              },
              onChange: toggleAll,
              style: S.check,
              'aria-label': '全选当前筛出的笔记',
            }),
            '全选',
          ),
          pickedVisible.length === 0 ? null : h('span', { style: { fontSize: 12, opacity: 0.75 } }, `已选 ${pickedVisible.length}`),
          pickedVisible.length === 0 ? null : h('select', {
            value: categoryNames.includes(batchCategory) ? batchCategory : '',
            'aria-label': '批量设置的类别',
            onChange: (event) => setBatchCategory(event.target.value),
            style: S.select,
          },
          h('option', { value: '' }, '未分类'),
          categoryOptions()),
          pickedVisible.length === 0 ? null : h('button', { type: 'button', style: S.btn, onClick: applyBatch }, '设为该类别'),
          pickedVisible.length === 0 ? null : h('button', { type: 'button', style: S.btn, onClick: deleteBatch }, '删除'),
        ),
        visible.length === 0
          ? h('div', { style: S.hint }, snap.marks.length === 0 ? '还没有笔记。' : '这个类别下还没有笔记。')
          : visible.map((mark) => {
            const index = snap.marks.indexOf(mark)
            return h(
            'div',
            { key: mark.id, style: S.card },
            h(
              'div',
              { style: { ...S.row, flexWrap: 'wrap' } },
              h('span', { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 } },
                h('input', {
                  type: 'checkbox',
                  checked: pickedIds.includes(mark.id),
                  onChange: () => toggleOne(mark.id),
                  style: S.check,
                  'aria-label': `勾选第 ${index + 1} 条笔记`,
                }),
                h('span', { style: { color: '#78716c', fontSize: 12, flex: 'none' } }, String(index + 1)),
                h('select', {
                  value: cleanCategory(mark.category),
                  'aria-label': `第 ${index + 1} 条笔记的类别`,
                  onChange: (event) => editMark(mark.id, { category: event.target.value }),
                  style: { ...S.select, maxWidth: 180 },
                },
                h('option', { value: '' }, '未分类'),
                categoryOptions()),
                h('span', {
                  style: { ...S.chip, background: chipBackground(mark) },
                }, kindLabel(mark)),
              ),
              h('span', { style: { display: 'flex', gap: 4 } },
                h('button', {
                  type: 'button',
                  style: S.btn,
                  onClick: () => {
                    setAskingId(askingId === mark.id ? '' : mark.id)
                    setQuestionDraft('')
                    setChosenDraft('')
                  },
                }, mark.childId ? '追问' : '提问'),
                h('button', {
                  type: 'button',
                  style: S.btn,
                  onClick: () => {
                    setPickedIds(pickedIds.filter((item) => item !== mark.id))
                    save(store.marks.filter((item) => item.id !== mark.id))
                  },
                }, '删除'),
              ),
            ),
            askingId === mark.id ? h('form', {
              style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 },
              onSubmit: (event) => {
                event.preventDefault()
                const question = questionDraft.trim()
                if (!question) return
                ask(mark.quote, sessionId, question, mark.childId || '', chosenModelValue(chosenDraft), mark.markdown || '')
                setAskingId('')
                setQuestionDraft('')
                setChosenDraft('')
              },
            },
            h('select', {
              value: chosenDraft,
              onChange: (event) => setChosenDraft(event.target.value),
              style: { ...S.comment, background: '#fff', color: '#1c1917' },
            }, modelOptions(modelList, mark.childId ? '沿用当前模型' : '跟随当前对话', chosenDraft)),
            h('div', { style: { display: 'flex', gap: 4 } },
              h('input', {
                style: { ...S.comment, flex: 1 },
                value: questionDraft,
                placeholder: '这段是什么？',
                maxLength: 2000,
                onChange: (event) => setQuestionDraft(event.target.value),
              }),
              h('button', { type: 'submit', style: S.btn }, '发起'),
            ),
            ) : null,
            (() => {
              const excerpt = excerptOf(mark)
              const rendered = renderMarkdown(excerpt)
              const formatted = /<(strong|em|code|pre|a|li|h[1-6]|del|blockquote)\b/.test(rendered)
              return formatted ? h('div', { style: S.field },
                h('span', { style: S.label }, '预览'),
                h('div', {
                  className: 'dsh-marginalia-md',
                  style: S.preview,
                  dangerouslySetInnerHTML: { __html: rendered },
                }),
              ) : null
            })(),
            field('摘录', excerptOf(mark), 'Markdown，例如 **加粗**', MAX_MARKDOWN, 4, (source) => editExcerpt(mark.id, source)),
            (mark.kind === 'note' || (mark.question && String(mark.question).trim()))
              ? field('问题', mark.question, '记下要问的话', 2000, 2, (question) => editMark(mark.id, { question }))
              : null,
            field('批注', mark.comment, '批注，可选', 2000, 2, (comment) => editMark(mark.id, { comment })),
            )
          }),
      )
    }

    function ModelSeat(props) {
      const sessionId = props.sessionId || ''
      const role = React.useState('')
      const models = React.useState([])
      const picked = React.useState('')
      const note = React.useState('')
      const roleName = role[0]
      const setRoleName = role[1]
      const modelList = models[0]
      const setModelList = models[1]
      const pickedValue = picked[0]
      const setPickedValue = picked[1]
      const noteText = note[0]
      const setNoteText = note[1]
      React.useEffect(() => {
        if (!sessionId) {
          setRoleName('')
          setModelList([])
          setPickedValue('')
          return undefined
        }
        let cancelled = false
        Promise.all([
          fetch(route('/marginalia/api/thread', { sessionId }), { headers: { accept: 'application/json' } }).then((res) => res.json()).catch(() => null),
          fetch(route('/marginalia/api/models'), { headers: { accept: 'application/json' } }).then((res) => res.json()).catch(() => null),
        ]).then(([thread, catalog]) => {
          if (cancelled) return
          if (!thread || thread.role !== 'child') {
            setRoleName('')
            setModelList([])
            setPickedValue('')
            setNoteText('')
            return
          }
          const list = catalog && catalog.ok === true && Array.isArray(catalog.models) ? catalog.models : []
          const current = thread.provider && thread.model ? `${thread.provider}\n${thread.model}` : ''
          setRoleName('child')
          setModelList(list)
          setPickedValue(current)
          setNoteText('')
        })
        return () => { cancelled = true }
      }, [sessionId])
      if (roleName !== 'child') return null
      return h('label', {
        'data-marginalia-model': 'true',
        style: {
          display: 'flex', alignItems: 'center', gap: 8, margin: '0 8px 8px',
          color: '#1c1917', font: '13px/1.4 "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
        },
      },
      h('span', { style: { flex: 'none', color: '#78716c', fontSize: 12 } }, '模型'),
      h('select', {
        value: pickedValue,
        'aria-label': '更换这条进程的模型',
        onChange: (event) => {
          const value = event.target.value
          const choice = chosenModelValue(value)
          if (!choice) return
          setPickedValue(value)
          setNoteText('正在更换模型…')
          fetch(route('/marginalia/api/model'), {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ sessionId, provider: choice.provider, model: choice.id }),
          }).then((res) => res.json().then((data) => ({ res, data }))).then(({ res, data }) => {
            if (!res.ok || !data || data.ok !== true) {
              throw new Error((data && data.error && data.error.message) || `HTTP ${res.status}`)
            }
            setNoteText('下一条回复会用这个模型。')
          }).catch((error) => {
            setNoteText(String((error && error.message) || error))
          })
        },
        style: {
          flex: 1, minWidth: 0, color: '#1c1917', background: '#fff',
          border: '1px solid rgba(28,25,23,.12)', borderRadius: 10, padding: '4px 8px',
        },
      }, modelOptions(modelList, '选择模型', pickedValue)),
      noteText ? h('span', { style: { flex: 'none', color: '#78716c', fontSize: 12 } }, noteText) : null,
      )
    }

    function apply(ctx) {
      pluginCtx = ctx
      const slots = ctx.slots
      if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return
      ensureStyle()
      ctx.effect(() => {
        const presentSelection = (quote, sessionId, range, fallbackX, fallbackY) => {
          const rect = endRect(range)
          const x = rect ? rect.right : fallbackX
          const y = rect ? rect.top : fallbackY
          lastRange = range
          lastMarkdown = markdownFor(range, quote)
          if (quote.length > 4000) {
            lastX = x
            lastY = y
            showNote(x, y, '一次最多标 4000 字。')
            return
          }
          openMenu(x, y, quote, sessionId, range)
        }
        const onContext = (event) => {
          if (event.target && event.target.closest && event.target.closest('[data-marginalia-menu]')) return
          const selection = window.getSelection()
          if (!selection || selection.isCollapsed || selection.rangeCount === 0) return
          const anchorHost = markHost(selection.anchorNode)
          const focusHost = markHost(selection.focusNode)
          if (!anchorHost || anchorHost !== focusHost) return
          const quote = selection.toString().trim()
          if (!quote) return
          event.preventDefault()
          const selectionRange = selection.getRangeAt(0).cloneRange()
          presentSelection(quote, sessionIdFrom(selection.anchorNode), selectionRange, event.clientX, event.clientY)
        }
        const onUp = (event) => {
          if (event.button !== 0) return
          const target = event.target
          if (target && target.closest && target.closest('[data-marginalia-menu], [data-marginalia-pin]')) return
          const fallbackX = event.clientX
          const fallbackY = event.clientY
          window.setTimeout(() => {
            const selection = window.getSelection()
            if (!selection || selection.isCollapsed || selection.rangeCount === 0) return
            const anchorHost = markHost(selection.anchorNode)
            const focusHost = markHost(selection.focusNode)
            if (!anchorHost || anchorHost !== focusHost) return
            const quote = selection.toString().trim()
            if (!quote) return
            const selectionRange = selection.getRangeAt(0).cloneRange()
            presentSelection(quote, sessionIdFrom(selection.anchorNode), selectionRange, fallbackX, fallbackY)
          }, 0)
        }
        const onDown = (event) => {
          if (!menuEl) return
          const target = event.target
          if (paletteOpen) return
          if (target && ((menuEl && menuEl.contains(target)) || (colorEl && colorEl.contains(target)))) return
          const active = document.activeElement
          if (active && active.tagName === 'SELECT' && menuEl.contains(active)) return
          closeMenu()
        }
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          if (menuEl) {
            event.preventDefault()
            event.stopPropagation()
            closeMenu()
            return
          }
          if (!openMarkId) return
          event.preventDefault()
          event.stopPropagation()
          openMarkId = ''
          stopThreadWatch()
          layoutPins(lastLocated)
        }
        document.addEventListener('contextmenu', onContext, true)
        document.addEventListener('mouseup', onUp, true)
        document.addEventListener('mousedown', onDown, true)
        document.addEventListener('keydown', onKey, true)
        return () => {
          document.removeEventListener('contextmenu', onContext, true)
          document.removeEventListener('mouseup', onUp, true)
          document.removeEventListener('mousedown', onDown, true)
          document.removeEventListener('keydown', onKey, true)
          closeMenu()
          stopThreadWatch()
          openMarkId = ''
          clearPins()
          const style = document.getElementById('dsh-marginalia-style')
          if (style) style.remove()
          if (typeof CSS !== 'undefined' && CSS.highlights) {
            for (const name of liveHighlights) CSS.highlights.delete(name)
            liveHighlights.clear()
            CSS.highlights.delete('dsh-marginalia-red')
            CSS.highlights.delete('dsh-marginalia-line')
          }
        }
      }, 'dsh-marginalia: reply selection menu')
      ctx.effect(
        () => slots.inject('conversation.view', () => slots.register({
          name: 'conversation.view',
          id: 'marginalia',
          order: 20,
          label: '学习',
          inject: () => ({ studyCtx: ctx }),
        }, StudyNotes)),
        'dsh-marginalia: notes view',
      )
      ctx.effect(
        () => slots.inject('conversation.composer.dock', () => slots.register({
          name: 'conversation.composer.dock',
          id: 'dsh-marginalia-model',
          order: 70,
        }, ModelSeat)),
        'dsh-marginalia: child model',
      )
      ctx.effect(
        () => slots.inject('conversation.composer.dock', () => slots.register({
          name: 'conversation.composer.dock',
          id: 'dsh-marginalia-session',
          order: 80,
        }, SessionProbe)),
        'dsh-marginalia: session probe',
      )
    }

    exports.apply = apply
    exports.inject = ['slots', 'uiWorkspace']
    return module.exports
  },
})
