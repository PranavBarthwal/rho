/**
 * A stand-in for the preload bridge, so the renderers can be opened in an
 * ordinary browser.
 *
 * Without this, working on the UI means launching Electron and screenshotting
 * the whole desktop — which is slow, and captures whatever else happens to be
 * on screen. With it, `npx vite src/renderer` serves the real components
 * against sample data.
 *
 * Installs itself only when the real bridge is absent, so it can never shadow
 * the app's own API.
 */
import type { Note } from '../../shared/types'

interface MockEntry {
  id: string
  file: string
  contextKey: string
  app: string
  title: string
  url?: string
  updated: string
  preview: string
}

const NOTES: Note[] = [
  {
    id: 'sample1',
    contextKey: 'chrome.exe|ergodic.dev/writing/attention-residue',
    app: 'chrome.exe',
    title: 'Attention residue and the cost of a switch',
    url: 'ergodic.dev/writing/attention-residue',
    aliases: [],
    created: '2026-09-15T10:02:00.000Z',
    updated: '2026-09-15T10:40:00.000Z',
    tags: [],
    body: `## What survives a switch

The cost of moving your attention isn't the second it takes to move it. It's the part of your mind that **stays behind**, still running the last thing.

- Residue is *content*, not just delay
- "Just write it down" asks you to pay the very cost you were avoiding
- What survives is whatever was written down

> The useful question isn't how to remember more. It's how to make writing something down cost less than the thought is worth.

### To follow up

- [ ] Find the original Leroy paper
- [x] Check the re-entry timing numbers
- [ ] Ask Dana about the 2019 replication`
  },
  {
    id: 'sample2',
    contextKey: 'code.exe|session.ts',
    app: 'code.exe',
    title: 'session.ts — rho',
    aliases: [],
    created: '2026-09-15T14:10:00.000Z',
    updated: '2026-09-15T15:05:00.000Z',
    tags: [],
    body: `# Ordering is the product

The snapshot has to be synchronous or the foreground window is gone.

\`\`\`ts
const snapshot = snapshotForeground() ?? desktopSnapshot()
\`\`\`

1. Snapshot, before any await
2. Show and focus the editor
3. Wait for the capture
4. Turn

---

Capture costs ~270ms and does **not** respond to asking for fewer pixels.`
  },
  {
    id: 'sample3',
    contextKey: 'chrome.exe|figma.com/file/rho-marks',
    app: 'chrome.exe',
    title: 'rho marks — Figma',
    url: 'figma.com/file/rho-marks',
    aliases: [],
    created: '2026-09-16T09:00:00.000Z',
    updated: '2026-09-16T09:12:00.000Z',
    tags: [],
    body: 'Ember only on the one thing that matters per screen. Everything else is ink, muted, faint.'
  }
]

function entryOf(n: Note): MockEntry {
  return {
    id: n.id,
    file: `notes/2026/09/${n.id}.md`,
    contextKey: n.contextKey,
    app: n.app,
    title: n.title,
    url: n.url,
    updated: n.updated,
    preview: n.body.replace(/[#*`>\-[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)
  }
}

export function installDevMock(): void {
  if (typeof window === 'undefined' || (window as { rho?: unknown }).rho) return

  const notes = new Map(NOTES.map((n) => [n.id, { ...n }]))
  const list = (): MockEntry[] =>
    [...notes.values()].sort((a, b) => b.updated.localeCompare(a.updated)).map(entryOf)

  // The overlay normally waits to be handed a session by the main process.
  // In the browser we hand it one ourselves so the note surface can be seen.
  let openFn: ((s: unknown) => void) | null = null
  let shotFn: (() => void) | null = null

  const api = {
    overlay: {
      onOpen: (fn: (s: unknown) => void) => {
        openFn = fn
        queueMicrotask(() => {
          // Proportional, so the card stays a card in a small browser pane
          // instead of collapsing to a sliver under a fixed app-sized margin.
          const m = Math.max(16, Math.min(120, Math.round(Math.min(innerWidth, innerHeight) * 0.08)))
          openFn?.({
            note: notes.get('sample1'),
            snapshot: {
              hwnd: '1',
              title: 'Attention residue and the cost of a switch — Google Chrome',
              className: 'Chrome_WidgetWin_1',
              exePath: 'C:/chrome.exe',
              exeName: 'chrome.exe',
              pid: 1,
              rect: { x: 0, y: 0, width: 0, height: 0 },
              boundsFromDwm: true,
              minimized: false,
              capturedAt: Date.now()
            },
            card: {
              x: m,
              y: m,
              // Floored, because a collapsed browser pane reports a viewport
              // small enough to produce a zero-sized card.
              width: Math.max(320, window.innerWidth - m * 2),
              height: Math.max(200, window.innerHeight - m * 2)
            }
          })
          // No bitmap to turn, so the turn starts on the failure path.
          setTimeout(() => shotFn?.(), 260)
        })
        return () => {
          openFn = null
        }
      },
      onShot: () => () => {},
      onShotFailed: (fn: () => void) => {
        shotFn = fn
        return () => {
          shotFn = null
        }
      },
      onContext: () => () => {},
      onRequestDismiss: () => () => {},
      turnStarted: () => {},
      save: () => {},
      dismiss: () => {},
      openLibrary: () => {}
    },
    notes: {
      list: async () => list(),
      search: async (q: string) => {
        const t = q.toLowerCase().split(/\s+/).filter(Boolean)
        return list().filter((e) =>
          t.every((x) => `${e.title} ${e.app} ${e.url ?? ''} ${e.preview}`.toLowerCase().includes(x))
        )
      },
      read: async (id: string) => notes.get(id) ?? null,
      update: async (id: string, body: string) => {
        const n = notes.get(id)
        if (n) {
          n.body = body
          n.updated = new Date().toISOString()
        }
      },
      remove: async (id: string) => void notes.delete(id),
      shot: async () => null,
      reveal: async () => true,
      openFolder: async () => ''
    },
    shell: {
      openUrl: async (url: string) => {
        console.info('[mock] would open', url)
        return true
      }
    },
    settings: {
      get: async () => ({
        accelerator: 'Alt+`',
        notesRoot: 'C:\\Users\\you\\rho',
        uiaEnabled: true,
        captureShots: true,
        launchOnLogin: false,
        bridge: { listening: true, browsers: [] },
        pairingToken: '4f2c9a1b7e3d5068a1c4b9f2e6d70835'
      }),
      set: async (patch: Record<string, unknown>) => ({
        accelerator: 'Alt+`',
        notesRoot: 'C:\\Users\\you\\rho',
        uiaEnabled: true,
        captureShots: true,
        launchOnLogin: false,
        bridge: { listening: true, browsers: [] },
        pairingToken: '4f2c9a1b7e3d5068a1c4b9f2e6d70835',
        ...patch
      })
    }
  }

  ;(window as unknown as { rho: unknown }).rho = api
  document.documentElement.dataset.rhoMock = 'true'
}
