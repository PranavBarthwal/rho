/** The main window: everything written behind every window, in one place. */
import { BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import { log } from '../log'

let library: BrowserWindow | null = null

export function showLibrary(): BrowserWindow {
  if (library && !library.isDestroyed()) {
    if (library.isMinimized()) library.restore()
    library.show()
    library.focus()
    return library
  }

  library = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 720,
    minHeight: 480,
    show: false,
    backgroundColor: '#f7f3ec',
    title: 'rho',
    autoHideMenuBar: true,
    // Hidden title bar with the native buttons kept as an overlay: the app
    // gets its own chrome without giving up real minimise/maximise/close.
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#efe8dc',
      symbolColor: '#6f6675',
      height: 44
    },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  library.once('ready-to-show', () => {
    library?.show()
    log('library shown')
  })
  library.webContents.on('did-fail-load', (_e, code, desc) =>
    log('library failed to load', { code, desc })
  )
  library.on('closed', () => {
    library = null
  })
  library.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void library.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/library/index.html`)
  } else {
    void library.loadFile(join(__dirname, '../renderer/library/index.html'))
  }

  return library
}

export function getLibrary(): BrowserWindow | null {
  return library && !library.isDestroyed() ? library : null
}
