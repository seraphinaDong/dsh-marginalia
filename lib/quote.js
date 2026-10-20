/**
 * Find one unused copy of `quote` inside `text`.
 * An exact slice wins. If the selection picked up line breaks that the
 * rendered reply does not store, a match that ignores whitespace still counts.
 */
export function quoteMatch(text, quote, used) {
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

/** The same span, even when a second selection picked up different line breaks. */
export function sameQuote(left, right) {
  const a = String(left)
  const b = String(right)
  if (a === b) return true
  const folded = foldSpace(a).out
  return folded.length > 0 && folded === foldSpace(b).out
}
