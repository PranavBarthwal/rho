/**
 * Where the companion browser extension reports the active tab.
 *
 * This is the accurate path: the extension pushes the real, canonical URL as
 * tabs change, so by the time the hotkey fires it is already in memory and
 * costs nothing to read. UIA is the fallback for when it is not installed.
 *
 * Bound to 127.0.0.1 and gated on a pairing token the user copies out of the
 * app once, because any page in any browser can reach a localhost port.
 */
import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { WindowSnapshot } from '@shared/types'

interface TabReport {
  url: string
  title: string
  browser: string
  at: number
}

/** The most recent report, per browser executable. */
const latest = new Map<string, TabReport>()
let server: Server | null = null
let token = ''

/** A report older than this is assumed stale — the user has moved on. */
const MAX_AGE_MS = 30_000

export function pairingToken(): string {
  if (!token) token = randomBytes(16).toString('hex')
  return token
}

export function startExtensionBridge(port = 47_113): void {
  if (server) return
  pairingToken()

  server = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'content-type, x-rho-token')
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end()
      return
    }
    if (req.method !== 'POST' || req.url !== '/tab') {
      res.writeHead(404).end()
      return
    }
    if (req.headers['x-rho-token'] !== token) {
      res.writeHead(401).end()
      return
    }

    let body = ''
    req.on('data', (c) => {
      body += c
      // Nothing legitimate is this large; drop rather than buffer forever.
      if (body.length > 64_000) req.destroy()
    })
    req.on('end', () => {
      try {
        const msg = JSON.parse(body) as { url?: string; title?: string; browser?: string }
        if (msg.url && msg.browser) {
          latest.set(msg.browser.toLowerCase(), {
            url: msg.url,
            title: msg.title ?? '',
            browser: msg.browser.toLowerCase(),
            at: Date.now()
          })
        }
        res.writeHead(200).end('{"ok":true}')
      } catch {
        res.writeHead(400).end()
      }
    })
  })

  server.on('error', () => {
    // Port taken, most likely by a second instance. The UIA path still works.
    server = null
  })
  server.listen(port, '127.0.0.1')
}

export function stopExtensionBridge(): void {
  server?.close()
  server = null
}

export function cachedTabFor(snapshot: WindowSnapshot): string | undefined {
  const report = latest.get(snapshot.exeName)
  if (!report) return undefined
  if (Date.now() - report.at > MAX_AGE_MS) return undefined
  return report.url
}

export function bridgeStatus(): { listening: boolean; browsers: string[] } {
  return { listening: !!server, browsers: [...latest.keys()] }
}
