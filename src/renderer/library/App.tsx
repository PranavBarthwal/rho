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

export default function App(): React.JSX.Element {
  const [entries, setEntries] = useState<IndexEntry[]>([])
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [note, setNote] = useState<Note | null>(null)
  const [shot, setShot] = useState<string | null>(null)
  const [settings, setSettings] = useState<SettingsShape | null>(null)
  const [showSettings, setShowSettings] = useState(false)

  const editorRef = useRef<EditorHandle>(null)
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

  const onEdit = (markdown: string): void => {
    const id = editingId.current
    if (!id) return
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      void window.rho.notes.update(id, markdown).then(() => void refresh(query))
    }, SAVE_DEBOUNCE_MS)
  }

  const onDelete = async (): Promise<void> => {
    if (!note) return
    await window.rho.notes.remove(note.id)
    const rows = await refresh(query)
    setSelectedId(rows[0]?.id ?? null)
  }

  const patch = async (p: Partial<SettingsShape>): Promise<void> => {
    const next = (await window.rho.settings.set(p)) as SettingsShape
    setSettings((s) => (s ? { ...s, ...next } : next))
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar__head">
          <div className="brand">
            <span className="brand__mark">ρ</span>
            <span className="brand__name">rho</span>
          </div>
          <button
            className={`icon-btn${showSettings ? ' is-on' : ''}`}
            onClick={() => setShowSettings((v) => !v)}
            title="Settings"
            aria-label="Settings"
          >
            ⚙
          </button>
        </div>

        <input
          className="search"
          placeholder="Search everything…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />

        <div className="list">
          {grouped.length === 0 ? (
            <p className="empty">
              {query ? (
                'Nothing matches.'
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
                  <button className="btn btn--danger" onClick={() => void onDelete()}>
                    Delete
                  </button>
                </div>
              ) : null}
            </header>

            {shot ? (
              <div className="pane__shot">
                <img src={shot} alt="" />
              </div>
            ) : null}

            {/* Kept mounted across selections so the editor is never rebuilt. */}
            <Editor
              ref={editorRef}
              onChange={onEdit}
              placeholder={note ? 'Type / for commands…' : ''}
            />
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
        <small>Plain markdown files. Safe to sync, grep, or edit by hand.</small>
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
