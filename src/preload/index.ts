import { contextBridge, ipcRenderer } from 'electron'
import type { Note, OverlaySession, ShotPayload, UrlUpdate } from '../shared/types'

const api = {
  overlay: {
    /** Fires when the hotkey opens the overlay, with the note already loaded. */
    onOpen: (fn: (session: OverlaySession) => void) => {
      const h = (_e: unknown, s: OverlaySession): void => fn(s)
      ipcRenderer.on('overlay:open', h)
      return (): void => {
        ipcRenderer.removeListener('overlay:open', h)
      }
    },
    /** The window screenshot, which lands after the flip has already begun. */
    onShot: (fn: (shot: ShotPayload) => void) => {
      const h = (_e: unknown, s: ShotPayload): void => fn(s)
      ipcRenderer.on('overlay:shot', h)
      return (): void => {
        ipcRenderer.removeListener('overlay:shot', h)
      }
    },
    onShotFailed: (fn: () => void) => {
      const h = (): void => fn()
      ipcRenderer.on('overlay:shot-failed', h)
      return (): void => {
        ipcRenderer.removeListener('overlay:shot-failed', h)
      }
    },
    onContext: (fn: (ctx: UrlUpdate) => void) => {
      const h = (_e: unknown, c: UrlUpdate): void => fn(c)
      ipcRenderer.on('overlay:context', h)
      return (): void => {
        ipcRenderer.removeListener('overlay:context', h)
      }
    },
    /** The main process asking us to close so we can hand over the buffer. */
    onRequestDismiss: (fn: () => void) => {
      const h = (): void => fn()
      ipcRenderer.on('overlay:request-dismiss', h)
      return (): void => {
        ipcRenderer.removeListener('overlay:request-dismiss', h)
      }
    },
    /** Reports when the turn actually begins, for the latency budget. */
    turnStarted: (waitedMs: number, withShot: boolean) =>
      ipcRenderer.send('overlay:turn-started', waitedMs, withShot),
    save: (id: string, body: string) => ipcRenderer.send('overlay:save', id, body),
    dismiss: (body?: string) => ipcRenderer.send('overlay:dismiss', body),
    openLibrary: () => ipcRenderer.send('overlay:open-library')
  },
  notes: {
    list: () => ipcRenderer.invoke('notes:list'),
    search: (q: string) => ipcRenderer.invoke('notes:search', q),
    read: (id: string): Promise<Note | null> => ipcRenderer.invoke('notes:read', id),
    update: (id: string, body: string) => ipcRenderer.invoke('notes:update', id, body),
    remove: (id: string) => ipcRenderer.invoke('notes:delete', id),
    shot: (rel: string): Promise<string | null> => ipcRenderer.invoke('notes:shot', rel)
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch: Record<string, unknown>) => ipcRenderer.invoke('settings:set', patch)
  }
}

contextBridge.exposeInMainWorld('rho', api)

export type RhoApi = typeof api
