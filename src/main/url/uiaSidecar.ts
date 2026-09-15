/**
 * Reading the browser's address bar via UI Automation.
 *
 * UIA is COM-only, which rules out calling it from koffi (hand-rolled vtable
 * dispatch, where one wrong index is a hard crash rather than an exception).
 * PowerShell 5.1 and the UIAutomationClient assembly are in-box on Windows 11
 * though, so we drive it from there instead — as ONE long-lived process
 * speaking JSON lines. Spawning powershell.exe per lookup costs ~350ms;
 * through a warm process a read is ~20ms.
 *
 * Be honest about what this returns: the omnibox *display string*, not a URL.
 * The scheme is stripped, "www." may be hidden, and while the user is typing
 * it contains whatever they have typed. The caller normalizes it and treats
 * it as a fuzzy key.
 */
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'

interface Pending {
  resolve: (value: string | undefined) => void
  timer: NodeJS.Timeout
}

let proc: ChildProcessWithoutNullStreams | null = null
let seq = 0
let enabled = true
const pending = new Map<number, Pending>()
let buffer = ''

/**
 * The sidecar script. It caches the omnibox AutomationElement per HWND
 * because the element survives navigation — finding it is the expensive part
 * (~120ms cold), reading its value afterwards is a few milliseconds.
 */
const SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$cache = @{}

function Get-Omnibox([IntPtr]$h) {
  $key = $h.ToString()
  $el = $cache[$key]
  if ($el -ne $null) {
    try { $null = $el.Current.Name; return $el } catch { $cache.Remove($key) }
  }
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($h)
  if ($root -eq $null) { return $null }
  $cond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Edit)
  $found = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
  foreach ($e in $found) {
    $n = $e.Current.Name
    if ($n -match 'address|Adresse|URL|search bar') { $cache[$key] = $e; return $e }
  }
  if ($found.Count -gt 0) { $cache[$key] = $found[0]; return $found[0] }
  return $null
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  if ($line.Trim() -eq '') { continue }
  $parts = $line.Split(' ')
  $id = $parts[0]
  $value = ''
  try {
    $h = [IntPtr][int64]$parts[1]
    $el = Get-Omnibox $h
    if ($el -ne $null) {
      $p = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
      $value = $p.Current.Value
    }
  } catch { $value = '' }
  $out = @{ id = $id; value = $value } | ConvertTo-Json -Compress
  [Console]::Out.WriteLine($out)
  [Console]::Out.Flush()
}
`

export function startUiaSidecar(): void {
  if (proc || !enabled) return
  try {
    proc = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
    )
  } catch {
    proc = null
    return
  }

  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', onData)
  proc.on('exit', () => {
    proc = null
    for (const [, p] of pending) {
      clearTimeout(p.timer)
      p.resolve(undefined)
    }
    pending.clear()
  })
  // The sidecar is best-effort; a crashed one must never take the app with it.
  proc.on('error', () => {
    proc = null
  })
}

function onData(chunk: string): void {
  buffer += chunk
  let nl: number
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim()
    buffer = buffer.slice(nl + 1)
    if (!line) continue
    try {
      const msg = JSON.parse(line) as { id: string; value: string }
      const p = pending.get(Number(msg.id))
      if (p) {
        clearTimeout(p.timer)
        pending.delete(Number(msg.id))
        p.resolve(msg.value || undefined)
      }
    } catch {
      // Ignore anything that is not one of our replies.
    }
  }
}

/**
 * Ask the sidecar for a window's address bar text.
 *
 * Times out rather than hanging: the UIA tree of a hung or elevated browser
 * can block indefinitely, and the caller is decorating an already-open
 * overlay, so a miss is free.
 *
 * The timeout is generous because the first read against a given browser is
 * slow — measured at ~740ms while Chrome spins up its accessibility tree,
 * against ~16ms for every read after that. Being impatient would mean never
 * getting past the cold call and so never reaching the warm ones.
 */
export function readOmnibox(hwnd: string, timeoutMs = 2500): Promise<string | undefined> {
  if (!enabled) return Promise.resolve(undefined)
  if (!proc) startUiaSidecar()
  if (!proc) return Promise.resolve(undefined)

  const id = ++seq
  return new Promise<string | undefined>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      resolve(undefined)
    }, timeoutMs)
    pending.set(id, { resolve, timer })
    try {
      proc!.stdin.write(`${id} ${hwnd}\n`)
    } catch {
      clearTimeout(timer)
      pending.delete(id)
      resolve(undefined)
    }
  })
}

/**
 * Reading the UIA tree forces Chrome into accessibility mode, which is sticky
 * and costs it memory. Users who notice should be able to turn this off and
 * fall back to title-based keys.
 */
export function setUiaEnabled(value: boolean): void {
  enabled = value
  if (!value) stopUiaSidecar()
}

export function isUiaEnabled(): boolean {
  return enabled
}

export function stopUiaSidecar(): void {
  if (!proc) return
  try {
    proc.stdin.end()
    proc.kill()
  } catch {
    // Already gone.
  }
  proc = null
}
