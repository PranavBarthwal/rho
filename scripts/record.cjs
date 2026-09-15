/**
 * Records docs/demo.gif — the flip, as the app actually performs it.
 *
 *   npx vite src/renderer --port 5199    # in one terminal
 *   npx electron scripts/record.cjs      # in another
 *
 * The animation is not captured in real time. `capturePage()` takes tens of
 * milliseconds, so recording live would drop frames unevenly. Instead the real
 * CSS animations are rebuilt as paused Web Animations — same keyframes, same
 * spring — and stepped one frame at a time, which is both frame-accurate and
 * true to what ships.
 *
 * Everything on screen is fabricated: a stand-in browser window and the sample
 * note from the dev mock. Nothing from the machine doing the recording.
 */
const { app, BrowserWindow } = require('electron')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const URL = 'http://localhost:5199/overlay/index.html'
const OUT = path.join(__dirname, '..', 'docs', 'demo.gif')

/** Logical window size; the card sits inside it with room to turn. */
const WIN = { width: 1120, height: 760 }
const MARGIN = 115
const FPS = 25
const WIDTH = 820 // final GIF width

/** Frame counts per phase, at FPS. */
const HOLD_WINDOW = 11
const FLIP_IN = 11 // 430ms
const HOLD_NOTE = 33
const FLIP_OUT = 6 // 240ms
const HOLD_END = 8

/** A desktop for the card to sit on, in the palette of the site. */
const BACKDROP = `
  html, body { background: #262232 !important; }
  body::before {
    content: ''; position: fixed; inset: 0; z-index: -1;
    background:
      radial-gradient(58% 48% at 20% 16%, #4b4070 0%, transparent 62%),
      radial-gradient(52% 46% at 84% 80%, #7a5c53 0%, transparent 64%),
      linear-gradient(160deg, #262232, #3a3347);
  }
`

/**
 * Stand-in for the window being turned over. In the app this is a screenshot;
 * here it is markup, so the recording needs no real window to photograph.
 */
const FAKE_WINDOW = `
<div class="fw">
  <div class="fw__tabs">
    <span class="fw__tab"><i style="background:#6b8afd"></i>Q3 planning</span>
    <span class="fw__tab fw__tab--on"><i style="background:#c06a35"></i>Attention residue and the cost…</span>
    <span class="fw__tab"><i style="background:#d05b5b"></i>Inbox (14)</span>
  </div>
  <div class="fw__bar"><span class="fw__url">ergodic.dev/writing/attention-residue</span></div>
  <div class="fw__body">
    <div class="fw__kicker">ESSAY · 9 MIN READ</div>
    <h1>Attention residue and the cost of a switch</h1>
    <p>The cost of moving your attention isn't the second it takes to move it. It's
       the part of your mind that stays behind, still running the last thing,
       quietly taking capacity from the next one.</p>
    <blockquote>People who switch tasks carry a residue of the previous task — and
       the residue is content, not just delay.</blockquote>
    <p>Which is why the advice to "just write it down" quietly asks you to pay the
       very cost you were trying to avoid: to leave the page, find the app, choose
       the note, and come back changed.</p>
    <p>The measurements are unkind about it. People asked to record a thought
       elsewhere and return took markedly longer to re-enter the original task.</p>
  </div>
</div>`

const FAKE_CSS = `
.fw { position:absolute; inset:0; background:#fff; display:flex; flex-direction:column;
      font-family:'Inter',system-ui,sans-serif; overflow:hidden; }
.fw__tabs { display:flex; gap:6px; padding:9px 12px 0; background:#e9e5ef; flex:0 0 auto; }
.fw__tab { display:flex; align-items:center; gap:7px; padding:8px 14px; border-radius:9px 9px 0 0;
           font-size:12px; color:#5b5566; background:#ded9e6; max-width:230px;
           white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.fw__tab--on { background:#fff; color:#221d2a; }
.fw__tab i { width:9px; height:9px; border-radius:2.5px; flex:0 0 auto; display:block; }
.fw__bar { padding:8px 14px; background:#fff; border-bottom:1px solid #eceaf0; flex:0 0 auto; }
.fw__url { display:inline-block; padding:6px 13px; border-radius:999px; background:#f2f0f5;
           font-size:12px; color:#6f6675; }
.fw__body { padding:26px 40px; color:#221d2a; flex:1; }
.fw__kicker { font-size:10px; letter-spacing:.16em; color:#c06a35; margin-bottom:12px; }
.fw h1 { font-family:'Instrument Serif',Georgia,serif; font-weight:400; font-size:31px;
         letter-spacing:-.02em; margin:0 0 16px; }
.fw p { font-size:13.5px; line-height:1.75; margin:0 0 13px; color:#453d4d; max-width:62ch; }
.fw blockquote { margin:0 0 13px; padding-left:15px; border-left:2px solid #c06a3566;
                 font-family:'Instrument Serif',Georgia,serif; font-style:italic;
                 font-size:15px; color:#453d4d; max-width:62ch; }
`

/**
 * Rebuilds the CSS animations as paused Web Animations so they can be stepped.
 * Reads the spring straight out of the stylesheet, so the recording cannot
 * drift from what the app does.
 */
const DIRECTOR = `
(() => {
  const css = getComputedStyle(document.documentElement);
  const spring = css.getPropertyValue('--spring').trim();
  const easeOut = css.getPropertyValue('--ease-out').trim();

  const frame = document.querySelector('.frame');
  const card = document.querySelector('.card');
  const depth = document.querySelector('.depth');
  const sheen = document.querySelector('.sheen');
  const front = document.querySelector('.face--front');
  const recess = document.querySelector('.recess');

  // Place the card with room to turn, independent of the mock's sizing.
  const M = ${MARGIN};
  frame.style.left = M + 'px';
  frame.style.top = M + 'px';
  frame.style.width = (innerWidth - M * 2) + 'px';
  frame.style.height = (innerHeight - M * 2) + 'px';
  frame.style.perspective =
    Math.round(Math.max(innerWidth - M * 2, innerHeight - M * 2) * 1.9) + 'px';
  frame.classList.add('is-flipping');

  const style = document.createElement('style');
  style.textContent = \`${FAKE_CSS}\`;
  document.head.appendChild(style);

  // The window being turned over, and its blurred echo in the recess.
  front.querySelectorAll('img').forEach((n) => n.remove());
  front.insertAdjacentHTML('afterbegin', \`${FAKE_WINDOW}\`);
  recess.innerHTML = \`${FAKE_WINDOW}\`;
  const echo = recess.firstElementChild;
  echo.style.filter = 'blur(28px) brightness(0.28) saturate(0.75)';
  echo.style.inset = '-8%';
  echo.style.width = '116%';
  echo.style.height = '116%';

  // The card is driven here, so the class-based transition must not fight it.
  card.classList.remove('flipped');
  card.style.transition = 'none';
  depth.classList.remove('is-opening', 'is-closing');

  const mk = (el, frames, duration, easing) => {
    const a = el.animate(frames, { duration, easing, fill: 'both' });
    a.pause();
    return a;
  };

  const IN = ${(FLIP_IN / FPS) * 1000};
  const OUT = ${(FLIP_OUT / FPS) * 1000};

  const phases = {
    in: [
      mk(card, [{ transform: 'rotateY(0deg)' }, { transform: 'rotateY(180deg)' }], IN, spring),
      mk(depth, [
        { transform: 'translateZ(0)' },
        { transform: 'translateZ(-95px)' },
        { transform: 'translateZ(0)' }
      ], IN, 'cubic-bezier(0.45, 0, 0.55, 1)'),
      mk(sheen, [
        { opacity: 0, transform: 'translateX(-24%)' },
        { opacity: 1, offset: 0.4 },
        { opacity: 0, transform: 'translateX(22%)' }
      ], IN, 'ease-out')
    ],
    out: [
      mk(card, [{ transform: 'rotateY(180deg)' }, { transform: 'rotateY(0deg)' }], OUT, easeOut),
      mk(depth, [
        { transform: 'translateZ(0)' },
        { transform: 'translateZ(-55px)' },
        { transform: 'translateZ(0)' }
      ], OUT, easeOut)
    ]
  };

  // Both phases fill, and the later one wins — so the 'out' animation, which
  // starts at 180deg, would otherwise cover the whole recording from frame one.
  // Only the active phase may be live.
  phases.out.forEach((a) => a.cancel());
  let active = 'in';
  window.__phase = (name, t) => {
    if (name !== active) {
      phases[active].forEach((a) => a.cancel());
      active = name;
    }
    phases[name].forEach((a) => {
      if (a.playState === 'idle') a.pause();
      a.currentTime = t;
    });
  };
  window.__phase('in', 0);
  return true;
})()
`

app.on('window-all-closed', () => {})

app.whenReady().then(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rho-rec-'))
  const win = new BrowserWindow({
    ...WIN,
    show: false,
    backgroundColor: '#262232',
    webPreferences: { backgroundThrottling: false }
  })

  try {
    await win.loadURL(URL)
  } catch {
    await new Promise((r) => setTimeout(r, 600))
    await win.loadURL(URL)
  }
  await win.webContents.insertCSS(BACKDROP)
  // Fonts, the mock's opening session, and its own turn all need to settle
  // before the scene is taken over.
  await new Promise((r) => setTimeout(r, 3000))
  await win.webContents.executeJavaScript(DIRECTOR)

  const IN_MS = (FLIP_IN / FPS) * 1000
  const OUT_MS = (FLIP_OUT / FPS) * 1000

  /** The whole loop, as (phase, time) pairs — one entry per frame. */
  const timeline = []
  for (let i = 0; i < HOLD_WINDOW; i++) timeline.push(['in', 0])
  for (let i = 1; i <= FLIP_IN; i++) timeline.push(['in', (i / FLIP_IN) * IN_MS])
  for (let i = 0; i < HOLD_NOTE; i++) timeline.push(['in', IN_MS])
  for (let i = 1; i <= FLIP_OUT; i++) timeline.push(['out', (i / FLIP_OUT) * OUT_MS])
  for (let i = 0; i < HOLD_END; i++) timeline.push(['out', OUT_MS])

  let n = 0
  for (const [phase, t] of timeline) {
    await win.webContents.executeJavaScript(`window.__phase(${JSON.stringify(phase)}, ${t})`)
    const img = await win.webContents.capturePage()
    const file = path.join(dir, `f${String(++n).padStart(4, '0')}.png`)
    fs.writeFileSync(file, img.resize({ width: WIDTH }).toPNG())
  }
  win.destroy()

  // Two passes: build a palette from the whole clip, then apply it. A single
  // pass would quantise per frame and make the flat paper crawl.
  const pattern = path.join(dir, 'f%04d.png')
  const palette = path.join(dir, 'palette.png')
  const common = ['-y', '-framerate', String(FPS), '-i', pattern]
  execFileSync('ffmpeg', [...common, '-vf', 'palettegen=max_colors=192:stats_mode=full', palette], {
    stdio: 'ignore'
  })
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  execFileSync(
    'ffmpeg',
    [
      ...common,
      '-i',
      palette,
      '-lavfi',
      'paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle',
      '-loop',
      '0',
      OUT
    ],
    { stdio: 'ignore' }
  )

  fs.rmSync(dir, { recursive: true, force: true })
  const kb = Math.round(fs.statSync(OUT).size / 1024)
  console.log(`${OUT}  ${n} frames @ ${FPS}fps  ${WIDTH}px  ${kb} KB`)
  app.quit()
})
