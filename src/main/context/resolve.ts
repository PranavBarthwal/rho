/**
 * Turning a window into a stable note identity.
 *
 * This is deliberately tolerant. The URL is the good key, but it is often
 * missing (no extension connected, a PWA with no omnibox, an elevated
 * browser) and often fuzzy when present (the omnibox shows a display string,
 * not a URL). So every note also records the keys it has been seen under, and
 * a note found by title merges cleanly once a real URL turns up.
 */
import type { NoteContext, WindowSnapshot } from '@shared/types'

/** Window-title suffixes that name the browser rather than the page. */
const APP_SUFFIXES = [
  ' - Google Chrome',
  ' — Google Chrome',
  ' - Microsoft​ Edge',
  ' - Microsoft Edge',
  ' — Mozilla Firefox',
  ' - Mozilla Firefox',
  ' - Brave',
  ' - Visual Studio Code',
  ' — Visual Studio Code'
]

/**
 * Prefixes browsers and chat apps use for transient state: unread counts,
 * playing indicators, unsaved-changes markers. They churn constantly and must
 * not be part of the key, or every notification would orphan the note.
 */
const VOLATILE_PREFIX = /^(\(\d+\+?\)\s*|●\s*|•\s*|\*\s*|▶\s*|🔴\s*)+/u

export function normalizeTitle(title: string): string {
  let t = title.trim()
  t = t.replace(VOLATILE_PREFIX, '')
  for (const suffix of APP_SUFFIXES) {
    if (t.endsWith(suffix)) {
      t = t.slice(0, -suffix.length)
      break
    }
  }
  return t.trim().toLowerCase()
}

/**
 * Reduce a URL (or a fuzzy omnibox display string) to a stable key.
 *
 * Query strings and fragments are dropped: they carry tracking parameters and
 * scroll positions that would split one page into many notes. The cost is
 * that pages which genuinely live in their query string share a note, which
 * is the right trade for a note-taking tool.
 */
export function normalizeUrl(raw: string): string | undefined {
  let s = raw.trim()
  if (!s) return undefined

  // The omnibox reports a search query rather than a URL when the user is
  // mid-typing. A value with whitespace and no dot is not an address.
  if (/\s/.test(s) && !/^[a-z]+:\/\//i.test(s)) return undefined

  s = s.replace(/^[a-z]+:\/\//i, '')
  s = s.replace(/^www\./i, '')
  s = s.split('#')[0].split('?')[0]
  s = s.replace(/\/+$/, '')
  s = s.toLowerCase()

  if (!s || !s.includes('.')) return undefined
  return s
}

const GENERIC_TITLES = new Set(['', 'new tab', 'untitled', 'program manager'])

export function resolveContext(
  snapshot: WindowSnapshot,
  url?: { value: string; source: 'extension' | 'uia' }
): NoteContext {
  const app = snapshot.exeName || snapshot.className.toLowerCase() || 'unknown'
  const titleKey = normalizeTitle(snapshot.title)
  const urlKey = url ? normalizeUrl(url.value) : undefined

  // Falls through URL -> title -> app, so there is always a key to bind to
  // even for a titleless window we know nothing about.
  const discriminator = urlKey ?? (GENERIC_TITLES.has(titleKey) ? '' : titleKey)
  const contextKey = discriminator ? `${app}|${discriminator}` : app

  return {
    app,
    titleKey,
    urlKey,
    urlSource: urlKey ? url!.source : undefined,
    contextKey
  }
}

/**
 * Keys a note could also be filed under, most specific first.
 *
 * Used to find a note that was created before the URL was known: we open with
 * a title key, the URL arrives a moment later, and this lets the note be
 * re-keyed to the URL instead of silently forking into a second note.
 */
export function candidateKeys(ctx: NoteContext): string[] {
  const keys: string[] = [ctx.contextKey]
  if (ctx.urlKey && !GENERIC_TITLES.has(ctx.titleKey)) {
    keys.push(`${ctx.app}|${ctx.titleKey}`)
  }
  return keys
}
