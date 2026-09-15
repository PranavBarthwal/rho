import { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, dialog } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { join } from 'node:path'
import { initLog, log, logPath } from './log'
import { createOverlay, whenOverlayReady } from './overlay/overlayWindow'
import { showLibrary } from './library/libraryWindow'
import { currentHotkey, registerWithFallback, unregisterHotkey } from './hotkey'
import { dismissOverlay, toggleOverlay } from './session'
import { deleteNote, initStore, listNotes, readNote, searchNotes, shutdownStore, updateBody } from './store/notes'
import { readShot } from './capture/screenCapture'
import { getSettings, loadSettings, saveSettings } from './settings'
import { setUiaEnabled, startUiaSidecar, stopUiaSidecar } from './url/uiaSidecar'
import { bridgeStatus, pairingToken, startExtensionBridge, stopExtensionBridge } from './url/extensionBridge'

let tray: Tray | null = null

// A second instance would fight the first for the hotkey and the index file.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showLibrary())
  void main()
}

async function main(): Promise<void> {
  await app.whenReady()
  electronApp.setAppUserModelId('dev.pranav.rho')
  initLog()

  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

  const settings = await loadSettings()
  await initStore(settings.notesRoot)

  setUiaEnabled(settings.uiaEnabled)
  if (settings.uiaEnabled) startUiaSidecar()
  startExtensionBridge()

  createOverlay()
  await whenOverlayReady()

  const bound = registerWithFallback(settings.accelerator, () => {
    log('hotkey fired')
    void toggleOverlay()
  })
  log('hotkey registration', { requested: settings.accelerator, bound })
  if (!bound) {
    dialog.showErrorBox(
      'rho could not register a hotkey',
      'Every candidate shortcut is already taken by another application. Open rho from the tray to choose a different one.'
    )
  } else if (bound.fellBack) {
    await saveSettings({ accelerator: bound.accelerator })
  }

  registerIpc()
  buildTray()
  log('ready', { notesRoot: settings.notesRoot, log: logPath() })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) showLibrary()
  })
}

function buildTray(): void {
  // A 1x1 transparent placeholder until there is real art in resources/.
  const icon = nativeImage.createFromPath(join(__dirname, '../../resources/tray.png'))
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  tray.setToolTip('rho')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Take a note  (${currentHotkey() || 'unbound'})`, click: () => void toggleOverlay() },
      { label: 'Open library', click: () => showLibrary() },
      { type: 'separator' },
      { label: 'Quit rho', click: () => app.quit() }
    ])
  )
  tray.on('click', () => showLibrary())
}

function registerIpc(): void {
  ipcMain.handle('notes:list', () => listNotes())
  ipcMain.handle('notes:search', (_e, q: string) => searchNotes(q))
  ipcMain.handle('notes:read', (_e, id: string) => readNote(id))
  ipcMain.handle('notes:update', (_e, id: string, body: string) => updateBody(id, body))
  ipcMain.handle('notes:delete', (_e, id: string) => deleteNote(id))
  ipcMain.handle('notes:shot', (_e, rel: string) => readShot(rel))

  ipcMain.handle('settings:get', () => ({
    ...getSettings(),
    accelerator: currentHotkey() || getSettings().accelerator,
    bridge: bridgeStatus(),
    pairingToken: pairingToken()
  }))
  ipcMain.handle('settings:set', async (_e, patch) => {
    const next = await saveSettings(patch)
    if (patch.uiaEnabled !== undefined) {
      setUiaEnabled(next.uiaEnabled)
      if (next.uiaEnabled) startUiaSidecar()
    }
    if (patch.launchOnLogin !== undefined) {
      app.setLoginItemSettings({ openAtLogin: next.launchOnLogin, args: ['--hidden'] })
    }
    if (patch.accelerator) {
      registerWithFallback(next.accelerator, () => void toggleOverlay())
    }
    return next
  })

  // Sent on every debounced keystroke so a crash can lose at most one moment.
  ipcMain.on('overlay:save', (_e, id: string, body: string) => void updateBody(id, body))
  ipcMain.on('overlay:turn-started', (_e, waitedMs: number, withShot: boolean) =>
    log('turn started', { waitedMs, withShot })
  )
  ipcMain.on('overlay:dismiss', (_e, body?: string) => void dismissOverlay(body))
  ipcMain.on('overlay:open-library', () => showLibrary())
}

app.on('window-all-closed', () => {
  // The tray and the hotkey are the app; closing the library is not quitting.
})

app.on('will-quit', () => {
  unregisterHotkey()
  stopUiaSidecar()
  stopExtensionBridge()
})

// Give the debounced index write a chance to land before the process dies.
let quitting = false
app.on('before-quit', (e) => {
  if (quitting) return
  quitting = true
  e.preventDefault()
  void shutdownStore().finally(() => app.exit(0))
})
