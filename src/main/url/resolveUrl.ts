/**
 * Working out which page a browser window is showing.
 *
 * Two sources, in order of trust:
 *  1. The companion extension, which pushes the real URL as tabs change, so
 *     at hotkey time it is already in memory and costs nothing.
 *  2. UI Automation, which reads the omnibox. Always available, but gives a
 *     display string rather than a URL and cannot see PWA or elevated windows.
 *
 * Non-browser windows short-circuit: there is nothing to look up.
 */
import type { WindowSnapshot } from '@shared/types'
import { cachedTabFor } from './extensionBridge'
import { readOmnibox } from './uiaSidecar'

export interface UrlResult {
  value: string
  source: 'extension' | 'uia'
}

const BROWSERS = new Set([
  'chrome.exe',
  'msedge.exe',
  'brave.exe',
  'vivaldi.exe',
  'opera.exe',
  'firefox.exe'
])

export function isBrowser(snapshot: WindowSnapshot): boolean {
  return BROWSERS.has(snapshot.exeName)
}

/**
 * The pre-show lookup. Memory only — it runs before the overlay is visible,
 * so it is never allowed to block.
 */
export function cachedUrl(snapshot: WindowSnapshot): UrlResult | undefined {
  if (!isBrowser(snapshot)) return undefined
  const fromExtension = cachedTabFor(snapshot)
  return fromExtension ? { value: fromExtension, source: 'extension' } : undefined
}

/** The post-show lookup, which may talk to the UIA sidecar and wait. */
export async function resolveUrl(snapshot: WindowSnapshot): Promise<UrlResult | undefined> {
  const cached = cachedUrl(snapshot)
  if (cached) return cached
  if (!isBrowser(snapshot)) return undefined

  const fromUia = await readOmnibox(snapshot.hwnd)
  return fromUia ? { value: fromUia, source: 'uia' } : undefined
}
