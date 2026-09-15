/**
 * The overlay: one BrowserWindow, created at startup, reused forever.
 *
 * Creating a window per hotkey press would cost 100-300ms and flash white on
 * first paint, which is exactly the latency this whole app exists to avoid.
 * So it is built once, kept hidden, and only ever moved, shown and hidden.
 */
import { BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import type { OverlaySession } from '@shared/types'

let overlay: BrowserWindow | null = null
let ready: Promise<void> | null = null

export function createOverlay(): BrowserWindow {
  if (overlay && !overlay.isDestroyed()) return overlay

  overlay = new BrowserWindow({
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    // No invisible resize border of our own, and no Win11 corner rounding —
    // it would clip the corners of the flipping panel.
    thickFrame: false,
    roundedCorners: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // Deliberately focusable. `focusable: false` makes the window untypeable
    // and toggling it back at runtime is unreliable on Windows; activation is
    // controlled with show() vs showInactive() instead.
    focusable: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  })

  overlay.setAlwaysOnTop(true, 'screen-saver')
  applyContentProtection()

  // Content protection has been lost across hide()/show() on Windows, so it is
  // re-applied every time rather than trusted to persist.
  overlay.on('show', applyContentProtection)

  overlay.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  ready = new Promise<void>((resolve) => {
    overlay!.once('ready-to-show', () => resolve())
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void overlay.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/overlay/index.html`)
  } else {
    void overlay.loadFile(join(__dirname, '../renderer/overlay/index.html'))
  }

  return overlay
}

/**
 * SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE) under the hood: DWM still
 * paints the window on the physical display but omits it from every capture
 * pipeline. That keeps the overlay out of its own screenshot, and as a
 * deliberate side effect out of the user's screen shares too.
 */
function applyContentProtection(): void {
  if (!overlay || overlay.isDestroyed()) return
  // Content protection also hides the overlay from screen recorders and from
  // our own screenshots, which makes the animation impossible to inspect.
  // RHO_NO_PROTECT lifts it for that, and for nothing else.
  if (process.env['RHO_NO_PROTECT']) return
  overlay.setContentProtection(true)
}

export function getOverlay(): BrowserWindow | null {
  return overlay && !overlay.isDestroyed() ? overlay : null
}

export async function whenOverlayReady(): Promise<void> {
  if (ready) await ready
}

/**
 * Place, show and focus the overlay — then let the renderer worry about
 * animation. Focus is never gated on the flip finishing.
 */
export function presentOverlay(bounds: Electron.Rectangle, session: OverlaySession): void {
  const win = getOverlay()
  if (!win) return
  win.setBounds(bounds)
  win.webContents.send('overlay:open', session)
  win.show()
  win.focus()
  win.moveTop()

  // Windows can hand the foreground to us and then take it back if another
  // always-on-top window contests it; one corrective nudge is cheap.
  setTimeout(() => {
    const w = getOverlay()
    if (w && w.isVisible() && !w.isFocused()) w.focus()
  }, 30)
}

export function hideOverlay(): void {
  const win = getOverlay()
  if (win && win.isVisible()) win.hide()
}

export function isOverlayVisible(): boolean {
  const win = getOverlay()
  return !!win && win.isVisible()
}
