/**
 * Foreground-window introspection and focus handoff.
 *
 * Everything in `snapshotForeground()` is synchronous on purpose: it runs
 * inside the global hotkey callback, and the foreground window is only
 * knowable in that instant. One `await` before this returns and we would be
 * describing our own overlay instead.
 */
import { screen } from 'electron'
import type { PhysRect, WindowSnapshot } from '@shared/types'
import {
  AttachThreadInput,
  CloseHandle,
  DWMWA_CLOAKED,
  DWMWA_EXTENDED_FRAME_BOUNDS,
  DwmGetWindowAttributeDword,
  DwmGetWindowAttributeRect,
  GA_ROOT,
  GetAncestor,
  GetClassNameW,
  GetCurrentThreadId,
  GetForegroundWindow,
  GetWindowRect,
  GetWindowTextW,
  GetWindowThreadProcessId,
  IsIconic,
  IsWindow,
  IsWindowVisible,
  OpenProcess,
  PROCESS_QUERY_LIMITED_INFORMATION,
  QueryFullProcessImageNameW,
  S_OK,
  SW_RESTORE,
  SetForegroundWindow,
  ShowWindow,
  type Win32Rect,
  wideString
} from './ffi'

/** koffi hands HWNDs back as BigInt; they can be passed straight back in. */
type Hwnd = bigint

function toPhys(r: Win32Rect): PhysRect {
  return { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top }
}

/**
 * Visible bounds of a window in physical pixels.
 *
 * GetWindowRect is wrong for us twice over. It includes the invisible DWM
 * resize border, and — because it is subject to the process's DPI awareness —
 * it reports DPI-virtualized coordinates to a non-aware process. DWM's
 * extended frame bounds are always the true visible frame in real pixels,
 * regardless of awareness. We only fall back to GetWindowRect when DWM
 * refuses, which it does for minimized and pre-DWM windows.
 */
function windowBounds(hwnd: Hwnd): { rect: PhysRect; fromDwm: boolean } {
  const dwm: Partial<Win32Rect> = {}
  const hr = DwmGetWindowAttributeRect(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, dwm, 16)
  if (hr === S_OK) {
    const r = dwm as Win32Rect
    if (r.right > r.left && r.bottom > r.top) return { rect: toPhys(r), fromDwm: true }
  }
  const gwr: Partial<Win32Rect> = {}
  GetWindowRect(hwnd, gwr)
  return { rect: toPhys(gwr as Win32Rect), fromDwm: false }
}

/** UWP and suspended windows report plausible bounds while being invisible. */
function isCloaked(hwnd: Hwnd): boolean {
  const out: [number] = [0]
  const hr = DwmGetWindowAttributeDword(hwnd, DWMWA_CLOAKED, out, 4)
  return hr === S_OK && out[0] !== 0
}

function windowText(hwnd: Hwnd): string {
  const buf = Buffer.alloc(2 * 512)
  return wideString(buf, GetWindowTextW(hwnd, buf, 512))
}

function windowClass(hwnd: Hwnd): string {
  const buf = Buffer.alloc(2 * 256)
  return wideString(buf, GetClassNameW(hwnd, buf, 256))
}

function processPath(pid: number): string {
  if (!pid) return ''
  const handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
  if (!handle) return ''
  try {
    // lpdwSize is in/out and counts CHARACTERS, not bytes.
    const size: [number] = [1024]
    const buf = Buffer.alloc(2 * 1024)
    return QueryFullProcessImageNameW(handle, 0, buf, size) ? wideString(buf, size[0]) : ''
  } finally {
    CloseHandle(handle)
  }
}

/**
 * Anything smaller than this is not a window a person is looking at — it is a
 * helper or a message-only window that happens to hold focus. Flipping one
 * would put the editor in a postage stamp.
 */
const MIN_FLIPPABLE = { width: 160, height: 100 }

export function snapshotForeground(): WindowSnapshot | null {
  const raw = GetForegroundWindow() as Hwnd
  if (!raw) return null

  // Chrome popups and tool windows hand us a child; normalize to the top level.
  const hwnd = ((GetAncestor(raw, GA_ROOT) as Hwnd) || raw) as Hwnd
  if (!IsWindow(hwnd)) return null

  // The shell parks focus on cloaked 1x1 helpers (ThumbnailDeviceHelperWnd and
  // friends) when the desktop is active. They are invisible and unflippable.
  if (isCloaked(hwnd)) return null

  // Hiding a window does not always move the foreground with it: after the
  // overlay closes, Windows can leave it as the foreground window while it is
  // hidden. Without this we would go on to describe a window nobody can see.
  if (!IsWindowVisible(hwnd)) return null

  const pidOut: [number] = [0]
  GetWindowThreadProcessId(hwnd, pidOut)

  // Never flip ourselves. Our own windows reaching this point means the
  // overlay just closed and focus has not landed anywhere real yet; treating
  // that as a target binds a note to rho instead of to the user's work.
  if (pidOut[0] === process.pid) return null

  const exePath = processPath(pidOut[0])
  const { rect, fromDwm } = windowBounds(hwnd)

  if (rect.width < MIN_FLIPPABLE.width || rect.height < MIN_FLIPPABLE.height) return null

  return {
    hwnd: String(hwnd),
    title: windowText(hwnd),
    className: windowClass(hwnd),
    exePath,
    exeName: exePath ? exePath.split('\\').pop()!.toLowerCase() : '',
    pid: pidOut[0],
    rect,
    boundsFromDwm: fromDwm,
    minimized: !!IsIconic(hwnd),
    capturedAt: Date.now()
  }
}

/**
 * A stand-in for when there is no window worth flipping — the desktop is
 * focused, or the shell has parked focus on an invisible helper.
 *
 * The hotkey has to do something every single time. A tool whose promise is
 * "the fastest way to take a note" cannot answer a keypress with silence, so
 * this puts a panel in the middle of the display the cursor is on and keys it
 * to the desktop.
 */
export function desktopSnapshot(): WindowSnapshot {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const w = Math.min(760, Math.round(display.workArea.width * 0.5))
  const h = Math.min(520, Math.round(display.workArea.height * 0.6))
  const dip: Electron.Rectangle = {
    x: display.workArea.x + Math.round((display.workArea.width - w) / 2),
    y: display.workArea.y + Math.round((display.workArea.height - h) / 2),
    width: w,
    height: h
  }
  const phys = screen.dipToScreenRect(null, dip)

  return {
    hwnd: '',
    title: 'Desktop',
    className: 'rho:desktop',
    exePath: '',
    exeName: 'desktop',
    pid: 0,
    rect: { x: phys.x, y: phys.y, width: phys.width, height: phys.height },
    boundsFromDwm: false,
    minimized: false,
    capturedAt: Date.now()
  }
}

/**
 * Physical pixels to Electron DIPs.
 *
 * screenToDipRect rounds to integers, so at fractional scaling (this machine
 * runs 125%) the round trip is off by up to a pixel. We inflate by one DIP on
 * each side and let the captured bitmap overscan rather than chasing
 * exactness: a one-pixel gap reads as a bright seam of desktop through the
 * middle of the flip, whereas a one-pixel overlap is invisible.
 */
export function physToDip(rect: PhysRect): Electron.Rectangle {
  const dip = screen.screenToDipRect(null, rect)
  return {
    x: Math.round(dip.x) - 1,
    y: Math.round(dip.y) - 1,
    width: Math.round(dip.width) + 2,
    height: Math.round(dip.height) + 2
  }
}

/**
 * How much empty space to leave around the card, in DIPs.
 *
 * It exists for the turn, not for looks: with perspective applied, the edge
 * swinging toward the viewer is magnified and lands outside the card's own
 * rectangle. Without room, it is sliced off against the window edge mid-flip.
 * The shadow needs the same room.
 */
const FLIP_MARGIN = 120

/**
 * Grow a rect to give the flip room, without leaving the display.
 *
 * Clamping means a maximized window gets little or no margin — correct, since
 * there is no visible surround to show a shadow in anyway — and the card's
 * offset inside the window is reported back so the renderer can place it
 * however the clamp worked out.
 */
export function overlayBoundsFor(card: Electron.Rectangle): {
  window: Electron.Rectangle
  card: Electron.Rectangle
} {
  const display = screen.getDisplayMatching(card)
  const area = display.bounds

  const left = Math.max(area.x, card.x - FLIP_MARGIN)
  const top = Math.max(area.y, card.y - FLIP_MARGIN)
  const right = Math.min(area.x + area.width, card.x + card.width + FLIP_MARGIN)
  const bottom = Math.min(area.y + area.height, card.y + card.height + FLIP_MARGIN)

  const win = { x: left, y: top, width: right - left, height: bottom - top }
  return {
    window: win,
    card: { x: card.x - win.x, y: card.y - win.y, width: card.width, height: card.height }
  }
}

export function isForeground(hwnd: string): boolean {
  const fg = GetForegroundWindow() as Hwnd
  return !!fg && String(fg) === hwnd
}

/**
 * Put focus back where it was when the hotkey fired.
 *
 * The cheap path is to just hide the overlay and let Windows activate the next
 * window in z-order, which is normally the original. This is the corrective
 * step for when it isn't. We are the foreground process at this moment, so
 * SetForegroundWindow is usually permitted; the AttachThreadInput dance is an
 * ugly last resort for when the foreground lock still refuses us.
 */
export function restoreForeground(hwndStr: string): boolean {
  let hwnd: Hwnd
  try {
    hwnd = BigInt(hwndStr)
  } catch {
    return false
  }
  if (!hwnd || !IsWindow(hwnd)) return false

  if (IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE)
  if (SetForegroundWindow(hwnd)) return true

  const fg = GetForegroundWindow() as Hwnd
  if (!fg) return false
  const fgThread = GetWindowThreadProcessId(fg, [0] as [number]) as number
  const ourThread = GetCurrentThreadId() as number
  if (!fgThread || fgThread === ourThread) return false

  AttachThreadInput(fgThread, ourThread, true)
  const ok = !!SetForegroundWindow(hwnd)
  AttachThreadInput(fgThread, ourThread, false)
  return ok
}
