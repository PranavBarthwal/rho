/**
 * Global hotkey registration.
 *
 * Electron's globalShortcut uses RegisterHotKey rather than a low-level
 * keyboard hook, which is the outcome we want: no antivirus false positives
 * and no system-wide input latency. The cost is that a combination another
 * app has already claimed simply fails to register, so the return value is
 * checked and the user can rebind.
 */
import { globalShortcut } from 'electron'

export const DEFAULT_ACCELERATOR = 'Control+Alt+Space'

/**
 * Fallbacks in preference order. Win+ combinations are omitted deliberately:
 * the shell reserves most of them and registration either fails or is
 * silently hijacked.
 */
export const SUGGESTED = [
  'Control+Alt+Space',
  'Alt+`',
  'Control+Alt+N',
  'Control+Shift+Space',
  'Alt+Q'
]

let current = ''

export function registerHotkey(accelerator: string, handler: () => void): boolean {
  unregisterHotkey()
  try {
    if (!globalShortcut.register(accelerator, handler)) return false
  } catch {
    return false
  }
  if (!globalShortcut.isRegistered(accelerator)) return false
  current = accelerator
  return true
}

/** Try the preferred binding, then fall back, so the app is never unusable. */
export function registerWithFallback(
  preferred: string,
  handler: () => void
): { accelerator: string; fellBack: boolean } | null {
  if (registerHotkey(preferred, handler)) return { accelerator: preferred, fellBack: false }
  for (const alt of SUGGESTED) {
    if (alt === preferred) continue
    if (registerHotkey(alt, handler)) return { accelerator: alt, fellBack: true }
  }
  return null
}

export function currentHotkey(): string {
  return current
}

export function unregisterHotkey(): void {
  if (current) {
    globalShortcut.unregister(current)
    current = ''
  }
}
