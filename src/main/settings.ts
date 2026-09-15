/** App settings, in a small JSON file next to the app's user data. */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { DEFAULT_ACCELERATOR } from './hotkey'

export interface Settings {
  accelerator: string
  notesRoot: string
  uiaEnabled: boolean
  captureShots: boolean
  launchOnLogin: boolean
}

let settings: Settings
let file = ''

function defaults(): Settings {
  return {
    accelerator: DEFAULT_ACCELERATOR,
    notesRoot: path.join(app.getPath('home'), 'rho'),
    uiaEnabled: true,
    captureShots: true,
    launchOnLogin: false
  }
}

export async function loadSettings(): Promise<Settings> {
  file = path.join(app.getPath('userData'), 'settings.json')
  settings = defaults()
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<Settings>
    settings = { ...settings, ...raw }
  } catch {
    // First run, or a corrupt file we would rather replace than fail on.
  }
  return settings
}

export function getSettings(): Settings {
  return settings ?? defaults()
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  settings = { ...getSettings(), ...patch }
  try {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify(settings, null, 2), 'utf8')
  } catch {
    // Non-fatal: the app keeps working with in-memory settings.
  }
  return settings
}
