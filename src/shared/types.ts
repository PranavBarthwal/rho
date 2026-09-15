/** Physical (Win32) pixel rectangle. */
export interface PhysRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Everything we learn about the foreground window in the synchronous instant
 * the hotkey fires. Captured before any await, because the foreground window
 * is gone the moment we yield.
 */
export interface WindowSnapshot {
  /** HWND as a string, because it arrives from koffi as a BigInt. */
  hwnd: string
  title: string
  className: string
  exePath: string
  /** Lowercased basename, e.g. "chrome.exe". */
  exeName: string
  pid: number
  rect: PhysRect
  /** True when bounds came from DWM extended frame bounds rather than GetWindowRect. */
  boundsFromDwm: boolean
  minimized: boolean
  capturedAt: number
}

export interface NoteContext {
  app: string
  titleKey: string
  urlKey?: string
  /** Where urlKey came from, for UI honesty about accuracy. */
  urlSource?: 'extension' | 'uia'
  contextKey: string
}

export interface NoteMeta {
  id: string
  contextKey: string
  app: string
  title: string
  url?: string
  aliases: string[]
  shot?: string
  created: string
  updated: string
  tags: string[]
}

export interface Note extends NoteMeta {
  body: string
}

/** What the overlay renderer receives when it opens. */
export interface OverlaySession {
  note: Note
  snapshot: WindowSnapshot
  /**
   * Where the card sits inside the overlay window, in CSS pixels.
   *
   * The window is deliberately larger than the window being flipped: under
   * perspective the card's near edge projects outside its own rectangle as it
   * turns, and the drop shadow needs somewhere to fall. Both would be clipped
   * against a window sized exactly to the card.
   */
  card: { x: number; y: number; width: number; height: number }
}

/** A captured window bitmap on its way to the flip's front face. */
export interface ShotPayload {
  dataUrl: string
  width: number
  height: number
}

export interface UrlUpdate {
  url: string
  source: string
}
