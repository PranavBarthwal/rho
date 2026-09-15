/**
 * The hotkey path. Order of operations here *is* the product.
 *
 * The rule is that the user can type before anything slow has finished. So we
 * take the window snapshot synchronously, show the overlay and hand it the
 * note immediately, and let the screenshot and the URL lookup land afterwards
 * — the flip animation absorbs them.
 */
import type { WindowSnapshot } from '@shared/types'
import { log } from './log'
import { captureRect, saveShot } from './capture/screenCapture'
import { candidateKeys, normalizeUrl, resolveContext } from './context/resolve'
import { hideOverlay, isOverlayVisible, presentOverlay } from './overlay/overlayWindow'
import { getOverlay } from './overlay/overlayWindow'
import {
  desktopSnapshot,
  isForeground,
  overlayBoundsFor,
  physToDip,
  restoreForeground,
  snapshotForeground
} from './win32/foreground'
import { openForContext, recordUrl, setShot, updateBody } from './store/notes'
import { cachedUrl, resolveUrl } from './url/resolveUrl'
import { getSettings } from './settings'

interface ActiveSession {
  noteId: string
  snapshot: WindowSnapshot
  openedAt: number
}

let active: ActiveSession | null = null

export function currentSession(): ActiveSession | null {
  return active
}

export async function toggleOverlay(): Promise<void> {
  if (isOverlayVisible()) {
    // Ask the renderer to close rather than hiding the window out from under
    // it: only the renderer has the buffer, and hiding first would rely on a
    // blur handler racing the hide to save it.
    const win = getOverlay()
    if (win) {
      win.webContents.send('overlay:request-dismiss')
      // Must outlast the renderer's closing animation, or this cuts the flip
      // short. If the renderer really is wedged the note is still safe —
      // every keystroke is debounce-saved.
      setTimeout(() => {
        if (isOverlayVisible()) void dismissOverlay()
      }, 600)
      return
    }
    await dismissOverlay()
    return
  }
  await openOverlay()
}

async function openOverlay(): Promise<void> {
  // Synchronous, before any await: the foreground window is only knowable in
  // this instant, and the first thing we do next is take the foreground away.
  // No flippable window (the desktop is focused, or the shell parked focus on
  // a cloaked helper) still gets a note — just a centered one.
  const snapshot = snapshotForeground() ?? desktopSnapshot()

  const t0 = Date.now()
  const dipRect = physToDip(snapshot.rect)
  // The overlay window is larger than the card so the turn is not clipped.
  const bounds = overlayBoundsFor(dipRect)

  // Only the extension's push is fast enough to consult before showing; the
  // UIA read happens after the overlay is already up.
  const known = cachedUrl(snapshot)
  const ctx = resolveContext(snapshot, known)
  const note = await openForContext(ctx, candidateKeys(ctx), snapshot.title || ctx.app)

  active = { noteId: note.id, snapshot, openedAt: t0 }

  presentOverlay(bounds.window, { note, snapshot, card: bounds.card })

  log('overlay shown', {
    ms: Date.now() - t0,
    app: snapshot.exeName,
    title: snapshot.title,
    phys: snapshot.rect,
    dip: dipRect,
    dwmBounds: snapshot.boundsFromDwm,
    note: note.id,
    key: ctx.contextKey
  })

  // Everything below is cosmetic or corrective and must not block typing.
  void hydrate(snapshot, note.id, dipRect)
}

/**
 * Post-show work: the screenshot for the flip's front face, and the URL that
 * may re-key the note. Both are allowed to fail silently.
 */
async function hydrate(
  snapshot: WindowSnapshot,
  noteId: string,
  dipRect: Electron.Rectangle
): Promise<void> {
  const win = getOverlay()

  // With shots turned off there is no picture of the window to turn, so the
  // renderer is told at once rather than waiting out its timeout, and nothing
  // about the window is ever written to disk.
  const shotStart = Date.now()
  const capturing = getSettings().captureShots
    ? captureRect(snapshot.rect, dipRect).then(async (cap) => {
        // The turn is gated on this arriving, so its cost is worth watching.
        log('capture', { ms: Date.now() - shotStart, ok: !!cap, ...(cap?.timing ?? {}) })
        if (!cap) {
          win?.webContents.send('overlay:shot-failed')
          return
        }
        // Only deliver if this is still the session it was captured for.
        if (active?.noteId !== noteId) return
        win?.webContents.send('overlay:shot', {
          dataUrl: cap.dataUrl,
          width: cap.width,
          height: cap.height
        })
        const rel = await saveShot(noteId, cap)
        if (rel) await setShot(noteId, rel)
      })
    : Promise.resolve(win?.webContents.send('overlay:shot-failed'))

  const urlStart = Date.now()
  const resolving = resolveUrl(snapshot).then(async (url) => {
    log('url lookup', { ms: Date.now() - urlStart, app: snapshot.exeName, found: url?.value ?? null, source: url?.source ?? null })
    if (!url || active?.noteId !== noteId) return
    win?.webContents.send('overlay:context', { url: url.value, source: url.source })
    // Remember it on the note: the library shows it, and once the extension
    // is connected the URL becomes the key this note is found by.
    const key = normalizeUrl(url.value)
    await recordUrl(noteId, url.value, key ? `${snapshot.exeName}|${key}` : undefined)
  })

  await Promise.allSettled([capturing, resolving])
}

export async function dismissOverlay(body?: string): Promise<void> {
  const session = active
  log('dismiss', { note: session?.noteId, bodyLen: body?.length ?? null })
  if (session && body !== undefined) {
    await updateBody(session.noteId, body)
  }
  hideOverlay()
  active = null
  // No hwnd means we opened over the desktop; there is nothing to give focus
  // back to, and hiding already does the right thing.
  if (!session || !session.snapshot.hwnd) return

  // Hiding usually hands focus back to the window underneath on its own; this
  // is the corrective path for when z-order does not cooperate.
  setTimeout(() => {
    const already = isForeground(session.snapshot.hwnd)
    const restored = already ? true : restoreForeground(session.snapshot.hwnd)
    log('focus restore', { already, restored, hwnd: session.snapshot.hwnd })
  }, 50)
}
