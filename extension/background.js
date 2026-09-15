/**
 * Reports the active tab to the rho desktop app.
 *
 * This exists because reading the address bar through accessibility gives a
 * display string rather than a URL — no scheme, "www." hidden, and whatever
 * the user has half-typed when they are mid-edit. chrome.tabs gives the real
 * thing, and pushing it as tabs change means the desktop app already has it
 * in memory when the hotkey fires.
 *
 * MV3 service workers are killed aggressively, so there is no long-lived
 * connection to keep: every report is a fresh POST, and an alarm re-reports
 * periodically so a worker that was killed and respawned re-syncs.
 */

const ENDPOINT = 'http://127.0.0.1:47113/tab'

/** Which executable this browser is, so the app can match it to a window. */
function browserName() {
  const ua = navigator.userAgent
  if (ua.includes('Edg/')) return 'msedge.exe'
  if (ua.includes('Brave')) return 'brave.exe'
  if (ua.includes('OPR/')) return 'opera.exe'
  if (ua.includes('Vivaldi')) return 'vivaldi.exe'
  return 'chrome.exe'
}

async function report(tab) {
  if (!tab || !tab.url) return
  // Internal pages are not things you take notes "on"; reporting them would
  // just overwrite the last real page with noise.
  if (!/^https?:/i.test(tab.url)) return

  const { token } = await chrome.storage.local.get(['token'])
  if (!token) return

  try {
    await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rho-token': token },
      body: JSON.stringify({ url: tab.url, title: tab.title ?? '', browser: browserName() })
    })
  } catch {
    // The desktop app is not running. Nothing to do; it falls back on its own.
  }
}

async function reportActive() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    await report(tab)
  } catch {
    // No focused window, or the query raced a closing window.
  }
}

chrome.tabs.onActivated.addListener(() => void reportActive())

chrome.tabs.onUpdated.addListener((_id, changeInfo, tab) => {
  // Only on a committed navigation or a title change; onUpdated fires often.
  if (changeInfo.url || changeInfo.title) {
    if (tab.active) void report(tab)
  }
})

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) void reportActive()
})

// Re-sync after the service worker has been killed and respawned, which
// otherwise leaves the desktop app holding a stale URL until the next tab
// event. The app also expires reports on its own after 30s.
chrome.alarms.create('rho-heartbeat', { periodInMinutes: 0.25 })
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'rho-heartbeat') void reportActive()
})

// A fresh worker should report immediately rather than waiting for an event.
void reportActive()
