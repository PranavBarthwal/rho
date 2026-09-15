/**
 * A file log.
 *
 * A packaged Electron app on Windows has no console attached, so console.log
 * from the main process goes nowhere. Anything worth knowing about startup,
 * hotkey registration or the latency budget has to be written down.
 */
import { appendFileSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

let file = ''

export function initLog(): string {
  file = path.join(app.getPath('userData'), 'rho.log')
  log('---- start ----', { version: app.getVersion(), electron: process.versions.electron })
  return file
}

export function logPath(): string {
  return file
}

export function log(message: string, data?: unknown): void {
  const line = `${new Date().toISOString()} ${message}${data ? ` ${JSON.stringify(data)}` : ''}\n`
  if (process.env['RHO_TRACE']) process.stdout.write(line)
  if (!file) return
  try {
    appendFileSync(file, line)
  } catch {
    // Logging must never be the thing that breaks the app.
  }
}
