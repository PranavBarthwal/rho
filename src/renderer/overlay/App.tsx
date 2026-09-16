import { useCallback, useEffect, useRef, useState } from 'react'
import type { OverlaySession, ShotPayload } from '../../shared/types'
import Editor, { type EditorHandle } from '../shared/Editor'

const SAVE_DEBOUNCE_MS = 300

/** Kept in step with --flip-out in overlay.css. */
const FLIP_OUT_MS = 240

/**
 * How long to hold still waiting for the picture before turning anyway.
 *
 * Nothing is drawn while we wait — the overlay is transparent, so the window
 * sits there looking untouched, which is the honest thing to show when we have
 * no picture of it to turn yet. Turning early means turning a blank panel,
 * which is the fake-looking flip this gate exists to prevent.
 *
 * The GDI blit lands in ~50ms, so this is mostly slack rather than a real
 * wait. Typing is unaffected either way: the editor took focus on frame one.
 */
const SHOT_WAIT_MS = 200

type Phase = 'idle' | 'waiting' | 'opening' | 'closing'

export default function App(): React.JSX.Element {
  const [session, setSession] = useState<OverlaySession | null>(null)
  const [shot, setShot] = useState<ShotPayload | null>(null)
  const [flipped, setFlipped] = useState(false)
  const [phase, setPhase] = useState<Phase>('idle')
  const [url, setUrl] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const editorRef = useRef<EditorHandle>(null)
  const saveTimer = useRef<number | null>(null)
  const closeTimer = useRef<number | null>(null)
  const shotTimer = useRef<number | null>(null)
  /** Guards the turn so the shot and the timeout cannot both start it. */
  const turning = useRef(false)
  const noteId = useRef<string | null>(null)
  /** When the overlay opened, so the wait for the shot can be measured. */
  const openedAt = useRef(0)

  const clearSaveTimer = (): void => {
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
  }

  /** Flush before anything that could lose the buffer. */
  const flush = useCallback(() => {
    clearSaveTimer()
    const id = noteId.current
    const el = editorRef.current
    if (!id || !el) return
    window.rho.overlay.save(id, el.getMarkdown())
    // Writes are debounced and quiet; this is the only sign they happened.
    setSaved(true)
    window.setTimeout(() => setSaved(false), 1100)
  }, [])

  /**
   * Turn the card back over, then dismiss.
   *
   * The delay is the one place the animation is allowed to cost anything. It
   * is short, and vanishing mid-gesture after a considered way in reads as a
   * glitch rather than as speed.
   */
  const close = useCallback(() => {
    if (closeTimer.current) return
    clearSaveTimer()
    if (shotTimer.current) {
      window.clearTimeout(shotTimer.current)
      shotTimer.current = null
    }
    const body = editorRef.current?.getMarkdown()
    const wasTurning = turning.current
    turning.current = false
    setFlipped(false)
    setPhase('closing')
    // Dismissed before the turn ever began: there is nothing to play back, so
    // go straight out rather than sitting on an invisible overlay.
    if (!wasTurning) {
      setPhase('idle')
      window.rho.overlay.dismiss(body)
      return
    }
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null
      setPhase('idle')
      window.rho.overlay.dismiss(body)
    }, FLIP_OUT_MS)
  }, [])

  /**
   * Start the turn. Runs once per session, from whichever of the screenshot
   * or the timeout gets here first.
   */
  const beginTurn = useCallback((withShot: boolean) => {
    if (turning.current) return
    turning.current = true
    if (shotTimer.current) {
      window.clearTimeout(shotTimer.current)
      shotTimer.current = null
    }
    window.rho.overlay.turnStarted(Date.now() - openedAt.current, withShot)
    // Two frames so the browser has painted the resting state to animate away
    // from, and so the recess turns opaque under a card that still covers it.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!turning.current) return
        setPhase('opening')
        setFlipped(true)
      })
    })
  }, [])

  useEffect(() => {
    return window.rho.overlay.onOpen((s) => {
      if (closeTimer.current) {
        window.clearTimeout(closeTimer.current)
        closeTimer.current = null
      }
      openedAt.current = Date.now()
      noteId.current = s.note.id
      setSession(s)
      setShot(null)
      setSaved(false)
      setUrl(s.note.url ?? null)

      const el = editorRef.current
      if (el) {
        el.setMarkdown(s.note.body)
        // Focus in this same frame. The turn has not started yet and must
        // never be what gates the ability to type — an existing note also
        // lands the caret at the end so you continue rather than overwrite.
        el.focusEnd()
      }

      // Hold still, drawing nothing, until we have a picture of the window to
      // turn. Rotating before then would turn an empty panel in front of the
      // untouched window, which is what makes a flip look fake.
      turning.current = false
      setPhase('waiting')
      if (shotTimer.current) window.clearTimeout(shotTimer.current)
      shotTimer.current = window.setTimeout(() => beginTurn(false), SHOT_WAIT_MS)
    })
  }, [beginTurn])

  useEffect(() => window.rho.overlay.onRequestDismiss(close), [close])
  useEffect(
    () =>
      window.rho.overlay.onShot((s) => {
        setShot(s)
        beginTurn(true)
      }),
    [beginTurn]
  )
  // No screenshot is coming: turn straight away rather than waiting out the
  // timeout for something that will never arrive.
  useEffect(
    () =>
      window.rho.overlay.onShotFailed(() => {
        setShot(null)
        beginTurn(false)
      }),
    [beginTurn]
  )
  useEffect(() => window.rho.overlay.onContext((c) => setUrl(c.url)), [])

  // The window is hidden by the main process, not unmounted, so a blur means
  // focus was stolen — save rather than risk losing the buffer.
  useEffect(() => {
    const onBlur = (): void => flush()
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [flush])

  const scheduleSave = (): void => {
    clearSaveTimer()
    saveTimer.current = window.setTimeout(flush, SAVE_DEBOUNCE_MS)
  }

  const meta = session?.snapshot
  const title = session?.note.title || meta?.title || ''

  // Perspective has to scale with the card, or the same focal length that
  // looks right on a small window tears a maximized one apart. Tied to the
  // longest edge so tall and wide windows turn alike.
  const card = session?.card
  const frameStyle: React.CSSProperties = card
    ? {
        left: card.x,
        top: card.y,
        width: card.width,
        height: card.height,
        perspective: `${Math.round(Math.max(card.width, card.height) * 1.9)}px`
      }
    : { inset: 0 }

  // The recess is live for the whole turn, in both directions: it has to be
  // opaque before the card first exposes it and stay so until the card covers
  // it again on the way out.
  const turningNow = phase === 'opening' || phase === 'closing'
  const frameClass = [
    'frame',
    turningNow ? 'is-flipping' : '',
    phase === 'opening' ? 'is-opening' : '',
    phase === 'closing' ? 'is-closing' : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className="stage" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className={frameClass} style={frameStyle}>
        <div className="recess">
          {shot ? <img src={shot.dataUrl} alt="" draggable={false} /> : null}
        </div>
        <div className="depth">
          <div className={`card${flipped ? ' flipped' : ''}`}>
            <div className="face face--front">
              {shot ? <img src={shot.dataUrl} alt="" draggable={false} /> : null}
              <div className="sheen" />
              <div className="shade shade--front" />
            </div>

            {/* The card has thickness; these close the slab at its sides. */}
            <div className="edge edge--l" />
            <div className="edge edge--r" />

            <div className="face face--back">
              <div className="meta">
                <span className="meta__mark">ρ</span>
                <span className="meta__app">{meta?.exeName?.replace(/\.exe$/, '') ?? 'rho'}</span>
                <span className="meta__title" title={url ?? title}>
                  {url ?? title}
                </span>
                <span className={`meta__saved${saved ? ' is-on' : ''}`}>saved</span>
                <span className="meta__hint">
                  <kbd>esc</kbd>
                </span>
              </div>
              <div className="shade shade--back" />
              <Editor
                ref={editorRef}
                onChange={scheduleSave}
                onExit={close}
                onOpenLibrary={() => {
                  flush()
                  window.rho.overlay.openLibrary()
                }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
