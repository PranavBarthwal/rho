const input = document.getElementById('token')
const status = document.getElementById('status')

chrome.storage.local.get(['token'], ({ token }) => {
  if (token) input.value = token
})

document.getElementById('save').addEventListener('click', async () => {
  const token = input.value.trim()
  await chrome.storage.local.set({ token })
  status.textContent = 'Saved. Checking…'
  try {
    const res = await fetch('http://127.0.0.1:47113/tab', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rho-token': token },
      body: JSON.stringify({ url: 'about:pairing', title: '', browser: 'chrome.exe' })
    })
    status.textContent = res.ok ? 'Connected to rho.' : `rho rejected the token (${res.status}).`
  } catch {
    status.textContent = 'Could not reach rho. Is the app running?'
  }
})
