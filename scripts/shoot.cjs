/**
 * Regenerates the screenshots in docs/.
 *
 * Loads the real renderer pages against the dev mock, so the images show the
 * actual interface with sample notes and never anything from the machine they
 * were taken on.
 *
 *   npx vite src/renderer --port 5199    # in one terminal
 *   npx electron scripts/shoot.cjs       # in another
 */
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const BASE = 'http://localhost:5199'
const OUT = path.join(__dirname, '..', 'docs')

/** A desktop to sit the overlay card on, since the page itself is transparent. */
const BACKDROP = `
  html, body { background: #2e2a3a !important; }
  body::before {
    content: ''; position: fixed; inset: 0; z-index: -1;
    background:
      radial-gradient(60% 50% at 22% 18%, #4b4070 0%, transparent 60%),
      radial-gradient(50% 45% at 82% 76%, #7a5c53 0%, transparent 62%),
      linear-gradient(160deg, #262232, #3a3347);
  }
`

const SHOTS = [
  {
    name: 'library',
    url: `${BASE}/library/index.html`,
    width: 1240,
    height: 800,
    // Show the note with the most formatting rather than whichever sorts first.
    setup: `
      const row = [...document.querySelectorAll('.row')]
        .find(r => r.innerText.includes('attention-residue'));
      if (row) row.click();
    `
  },
  {
    name: 'overlay',
    url: `${BASE}/overlay/index.html`,
    width: 1240,
    height: 800,
    css: BACKDROP,
    // The turn has settled by capture time; put the caret at the top so the
    // note reads from its first line.
    setup: `window.__editor && window.__editor.commands.focus('start');`
  }
]

// Destroying a shot's window leaves none open, and the default reaction to
// that on Windows is to quit — which would end the run after the first image.
app.on('window-all-closed', () => {})

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true })

  for (const shot of SHOTS) {
    try {
    const win = new BrowserWindow({
      width: shot.width,
      height: shot.height,
      show: false,
      backgroundColor: '#f7f3ec',
      webPreferences: { backgroundThrottling: false }
    })

    // Loading straight after destroying the previous window occasionally
    // fails with ERR_FAILED; one retry clears it.
    try {
      await win.loadURL(shot.url)
    } catch {
      await new Promise((r) => setTimeout(r, 600))
      await win.loadURL(shot.url)
    }
    if (shot.css) await win.webContents.insertCSS(shot.css)
    // Long enough for fonts, the mock's opening session, and the turn.
    await new Promise((r) => setTimeout(r, 2600))
    if (shot.setup) await win.webContents.executeJavaScript(shot.setup)
    await new Promise((r) => setTimeout(r, 700))

    const image = await win.webContents.capturePage()
    const file = path.join(OUT, `${shot.name}.png`)
    fs.writeFileSync(file, image.toPNG())
    const { width, height } = image.getSize()
    console.log(`${file}  ${width}x${height}`)
    win.destroy()
    } catch (err) {
      console.error(`FAILED ${shot.name}: ${err && err.message}`)
    }
    await new Promise((r) => setTimeout(r, 400))
  }

  app.quit()
})
