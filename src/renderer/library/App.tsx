import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Note } from '../../shared/types'
import Editor, { type EditorHandle } from '../shared/Editor'

interface IndexEntry {
  id: string
  file: string
  contextKey: string
  app: string
  title: string
  url?: string
  updated: string
  preview: string
}

interface SettingsShape {
  accelerator: string
  notesRoot: string
  uiaEnabled: boolean
  captureShots: boolean
  launchOnLogin: boolean
  bridge: { listening: boolean; browsers: string[] }
  pairingToken: string
}

const SAVE_DEBOUNCE_MS = 400

function appLabel(app: string): string {
  return app.replace(/\.exe$/, '')
}

function relativeTime(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(iso).toLocaleDateString()
}

function wordCount(md: string): number {
  const words = md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#*`>_~[\]()-]/g, ' ')
    .trim()
  return words ? words.split(/\s+/).length : 0
}

export default function App(): React.JSX.Element {
  const [entries, setEntries] = useState<IndexEntry[]>([])
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [note, setNote] = useState<Note | null>(null)
  const [shot, setShot] = useState<string | null>(null)
  const [settings, setSettings] = useState<SettingsShape | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [words, setWords] = useState(0)

  const editorRef = useRef<EditorHandle>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const saveTimer = useRef<number | null>(null)
  const editingId = useRef<string | null>(null)

  const refresh = useCallback(async (q: string) => {
    const rows = (await (q ? window.rho.notes.search(q) : window.rho.notes.list())) as IndexEntry[]
    setEntries(rows)
    return rows
  }, [])

  useEffect(() => {
    void refresh('').then((rows) => {
      if (rows.length) setSelectedId(rows[0].id)
    })
    void window.rho.settings.get().then(setSettings)
  }, [refresh])

  useEffect(() => {
    const t = window.setTimeout(() => void refresh(query), 120)
    return () => window.clearTimeout(t)
  }, [query, refresh])

  // Load the selected note into the editor. The editor is never remounted, so
  // switching notes is a content swap rather than a new instance.
  useEffect(() => {
    setConfirmDelete(false)
    if (!selectedId) {
      setNote(null)
      setShot(null)
      editingId.current = null
      return
    }
    let stale = false
    void window.rho.notes.read(selectedId).then(async (n) => {
      if (stale || !n) return
      setNote(n)
      setWords(wordCount(n.body))
      editingId.current = n.id
      editorRef.current?.setMarkdown(n.body)
      setShot(null)
      if (n.shot) {
        const data = await window.rho.notes.shot(n.shot)
        if (!stale) setShot(data)
      }
    })
    return () => {
      stale = true
    }
  }, [selectedId])

  /** Grouped by app, which is how the notes were actually made. */
  const grouped = useMemo(() => {
    const byApp = new Map<string, IndexEntry[]>()
    for (const e of entries) {
      const key = appLabel(e.app || 'unknown')
      const list = byApp.get(key)
      if (list) list.push(e)
      else byApp.set(key, [e])
    }
    return [...byApp.entries()].sort((a, b) => b[1].length - a[1].length)
  }, [entries])

  /** The list as it actually reads top to bottom, for arrow-key movement. */
  const ordered = useMemo(() => grouped.flatMap(([, rows]) => rows), [grouped])

  const step = useCallback(
    (dir: 1 | -1) => {
      if (!ordered.length) return
      const i = ordered.findIndex((e) => e.id === selectedId)
      const next = i < 0 ? 0 : (i + dir + ordered.length) % ordered.length
      setSelectedId(ordered[next].id)
    },
    [ordered, selectedId]
  )

  // Window-level shortcuts. Bound on the window so they work wherever focus
  // is, and stood down while typing so they never eat a keystroke.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement | null
      const typing =
        !!el && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setShowSettings(false)
        searchRef.current?.focus()
        searchRef.current?.select()
        return
      }
      if (e.key === 'Escape') {
        if (el === searchRef.current && query) {
          setQuery('')
          return
        }
        if (confirmDelete) setConfirmDelete(false)
        return
      }
      // Arrows move through the list from the search box too, so you can type
      // a query and go straight to the result without reaching for the mouse.
      if (typing && el !== searchRef.current) return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        step(1)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        step(-1)
      } else if (e.key === 'Enter' && el === searchRef.current) {
        e.preventDefault()
        editorRef.current?.focusEnd()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [step, query, confirmDelete])

  const onEdit = (markdown: string): void => {
    const id = editingId.current
    if (!id) return
    setWords(wordCount(markdown))
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      void window.rho.notes.update(id, markdown).then(() => void refresh(query))
    }, SAVE_DEBOUNCE_MS)
  }

  const onDelete = async (): Promise<void> => {
    if (!note) return
    await window.rho.notes.remove(note.id)
    setConfirmDelete(false)
    const rows = await refresh(query)
    setSelectedId(rows[0]?.id ?? null)
  }

  const patch = async (p: Partial<SettingsShape>): Promise<void> => {
    const next = (await window.rho.settings.set(p)) as SettingsShape
    setSettings((s) => (s ? { ...s, ...next } : next))
  }

  return (
    <div className="app">
      {/* Sits under the native window buttons; doubles as the drag handle. */}
      <header className="titlebar">
        <div className="brand">
          <span className="brand__mark">ρ</span>
          <span className="brand__name">rho</span>
        </div>
        <span className="titlebar__count">
          {entries.length} {entries.length === 1 ? 'note' : 'notes'}
        </span>
        <button
          className={`icon-btn${showSettings ? ' is-on' : ''}`}
          onClick={() => setShowSettings((v) => !v)}
          title="Settings"
          aria-label="Settings"
        >
          ⚙
        </button>
      </header>

      <aside className="sidebar">
        <div className="search-wrap">
          <input
            ref={searchRef}
            className="search"
            placeholder="Search everything…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
          <kbd className="search__kbd">Ctrl F</kbd>
        </div>

        <div className="list">
          {grouped.length === 0 ? (
            <p className="empty">
              {query ? (
                <>
                  Nothing matches <strong>{query}</strong>.
                </>
              ) : (
                <>
                  No notes yet. Press <kbd>{settings?.accelerator ?? 'the hotkey'}</kbd> behind any
                  window and start typing.
                </>
              )}
            </p>
          ) : (
            grouped.map(([app, rows]) => (
              <section key={app} className="group">
                <header className="group__head">
                  <span className="kicker">{app}</span>
                  <span className="group__count">{rows.length}</span>
                </header>
                {rows.map((e) => (
                  <button
                    key={e.id}
                    className={`row${e.id === selectedId ? ' row--on' : ''}`}
                    onClick={() => setSelectedId(e.id)}
                  >
                    <span className="row__title">{e.url || e.title || 'Untitled'}</span>
                    <span className="row__preview">{e.preview || 'Empty note'}</span>
                    <span className="row__time">{relativeTime(e.updated)}</span>
                  </button>
                ))}
              </section>
            ))
          )}
        </div>
      </aside>

      <main className="pane">
        {showSettings && settings ? (
          <Settings settings={settings} onPatch={patch} />
        ) : (
          <>
            <header className="pane__head">
              <div className="pane__id">
                <span className="pane__app">{note ? appLabel(note.app) : 'rho'}</span>
                <span className="pane__where" title={note?.url ?? note?.title}>
                  {note ? (note.url ?? note.title) : 'Select a note'}
                </span>
              </div>

              {note ? (
                <div className="pane__actions">
                  {note.url ? (
                    <button
                      className="btn"
                      title="Open the page this note was taken behind"
                      onClick={() => void window.rho.shell.openUrl(note.url!)}
                    >
                      Open page
                    </button>
                  ) : null}
                  <button
                    className="btn"
                    title="Show the markdown file in Explorer"
                    onClick={() => void window.rho.notes.reveal(note.id)}
                  >
                    Show file
                  </button>
                  {confirmDelete ? (
                    <>
                      <button className="btn btn--solid" onClick={() => void onDelete()}>
                        Delete for good
                      </button>
                      <button className="btn" onClick={() => setConfirmDelete(false)}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button className="btn btn--danger" onClick={() => setConfirmDelete(true)}>
                      Delete
                    </button>
                  )}
                </div>
              ) : null}
            </header>

            {/*
              Hidden rather than unmounted when nothing is selected. The editor
              is handed its content imperatively the moment a note loads, so it
              has to already exist by then — unmounting it means the first note
              you open arrives before there is anything to put it in.
            */}
            <div className="pane__body" hidden={!note}>
              {shot ? (
                <div className="pane__shot">
                  <img src={shot} alt="" />
                </div>
              ) : null}

              <Editor ref={editorRef} onChange={onEdit} placeholder="Type / for commands…" />

              <footer className="pane__foot">
                <span>{words === 1 ? '1 word' : `${words} words`}</span>
                {note ? (
                  <>
                    <span className="pane__dot">·</span>
                    <span title={new Date(note.updated).toLocaleString()}>
                      edited {relativeTime(note.updated)}
                    </span>
                    <span className="pane__dot">·</span>
                    <span title={new Date(note.created).toLocaleString()}>
                      written {relativeTime(note.created)}
                    </span>
                  </>
                ) : null}
              </footer>
            </div>

            {!note ? (
              <div className="pane__blank">
                <p>
                  {entries.length
                    ? 'Select a note, or use ↑ ↓ to move through them.'
                    : 'Notes you take behind a window show up here.'}
                </p>
              </div>
            ) : null}
          </>
        )}
      </main>
    </div>
  )
}

function Settings({
  settings,
  onPatch
}: {
  settings: SettingsShape
  onPatch: (p: Partial<SettingsShape>) => Promise<void>
}): React.JSX.Element {
  return (
    <div className="settings">
      <h2>Settings</h2>

      <div className="field">
        <label className="field__label" htmlFor="accel">
          Hotkey
        </label>
        <input
          id="accel"
          type="text"
          defaultValue={settings.accelerator}
          onBlur={(e) => void onPatch({ accelerator: e.target.value })}
        />
        <small>
          An Electron accelerator, e.g. <code>Control+Alt+Space</code>. If another app already owns
          it, rho falls back to the next free combination and tells you which.
        </small>
      </div>

      <label className="toggle">
        <input
          type="checkbox"
          checked={settings.captureShots}
          onChange={(e) => void onPatch({ captureShots: e.target.checked })}
        />
        <span className="toggle__text">
          <span className="toggle__title">Keep a picture of the window with each note</span>
          <small>Also what the flip turns over. Without it the turn shows a blank face.</small>
        </span>
      </label>

      <label className="toggle">
        <input
          type="checkbox"
          checked={settings.uiaEnabled}
          onChange={(e) => void onPatch({ uiaEnabled: e.target.checked })}
        />
        <span className="toggle__text">
          <span className="toggle__title">Read browser addresses via accessibility</span>
          <small>
            How notes bind to a specific tab without the extension. It reads the address bar
            directly, which is approximate — what is shown is a display string, not the real URL,
            and app-mode windows have no address bar at all. It also switches Chrome into
            accessibility mode, which costs it some memory. Off means notes key by window title.
          </small>
        </span>
      </label>

      <label className="toggle">
        <input
          type="checkbox"
          checked={settings.launchOnLogin}
          onChange={(e) => void onPatch({ launchOnLogin: e.target.checked })}
        />
        <span className="toggle__text">
          <span className="toggle__title">Start rho when I sign in</span>
        </span>
      </label>

      <div className="field">
        <span className="field__label">Notes folder</span>
        <code className="path">{settings.notesRoot}</code>
        <div className="field__row">
          <button className="btn" onClick={() => void window.rho.notes.openFolder()}>
            Open folder
          </button>
          <small>Plain markdown files. Safe to sync, grep, or edit by hand.</small>
        </div>
      </div>

      <div className="field">
        <span className="field__label">Browser extension</span>
        <small>
          {settings.bridge.listening
            ? settings.bridge.browsers.length
              ? `Connected: ${settings.bridge.browsers.join(', ')}`
              : 'Waiting for a browser to connect.'
            : 'Not listening.'}
        </small>
        <code className="path">{settings.pairingToken}</code>
        <small>Paste this pairing token into the extension’s options page.</small>
      </div>
    </div>
  )
}
