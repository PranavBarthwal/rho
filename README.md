# rho

Every window has a back side. Press a hotkey and the window you're looking at
flips over; you type on the back of it. Press it again and you're back where
you were.

Notes bind themselves to the window they were taken behind — the app, the
window title, and the browser URL — so coming back to that tab tomorrow and
hitting the hotkey brings back the same note. Individually they're scattered
across everything you do. Together they're one searchable library.

Windows only. The whole thing leans on Win32 and DWM.

## Running it

```bash
npm install
npm run dev
```

The hotkey defaults to `Control+Alt+Space`. If another app already owns that
combination, rho falls back to the next free one from a short list and records
what it actually got — check the tray menu or Settings to see which. The app
lives in the tray; closing the library window doesn't quit it.

```bash
npm test          # resolver and store tests
npm run typecheck
npm run dist      # NSIS installer into dist/
```

## Looks

The app uses the same design language as the landing page: warm paper
(`#f7f3ec`) rather than the cool greys most note apps reach for, near-black ink
with a violet cast, and a single burnt ember accent (`#c06a35`) spent on one
thing per screen. Instrument Serif carries display text and headings; Inter
carries everything functional. The tokens live in
`src/renderer/shared/tokens.css` and both windows import them; change a value
there and it moves everywhere.

Fonts are bundled from npm rather than fetched from a CDN, so a desktop app
that may be offline still renders as designed.

## Where notes live

`%USERPROFILE%\rho\` by default:

```
notes/2026/09/<id>.md   one markdown file per note, YAML frontmatter
shots/<id>.jpg          the window as it looked when you wrote the note
index.json              a cache, rebuilt from the files on startup
```

The files are the source of truth. The index is reconciled against them every
launch, so editing a note by hand, or having one arrive via OneDrive or git,
works rather than corrupting anything.

## How it fits together

```
hotkey ─► snapshot the foreground window   (synchronous — see below)
       ─► look up the note, show the overlay, focus the editor   (~20ms)
       ─► hold still, drawing nothing, until the window is photographed
       ─► turn, over the recess                                  (~255ms)
       ─► URL lookup lands, attaches to the note
```

The ordering is the design. The snapshot is synchronous because the foreground
window is only knowable in the instant the hotkey fires — one `await` first and
you're describing your own overlay. Everything slow happens after the editor
already has focus, so you're typing before the animation finishes.

### The editor

The note surface is a real rich-text editor — TipTap over ProseMirror — but
markdown is the storage format, not an export. What you type as `## ` becomes a
heading as you type it, and what lands on disk is `## ` again. The file stays
something you could open in any other editor, which is the entire reason notes
are files.

Typing the prefix is the primary way to format: `# `, `- `, `1. `, `> `,
` ``` `, `---`, `[] `, and inline `**bold**`, `*italic*`, `` `code` ``. `/` opens
a short command menu for the times you cannot remember which prefix — it is a
fallback, not the main road, which is why it holds nine entries and not fifty.

Both windows share one `Editor` component. It is never unmounted: switching
notes swaps the document through an imperative handle, because remounting would
cost the overlay its focus on the very frame it needs it.

**Working on the UI:** `npx vite src/renderer` serves the real components in an
ordinary browser at `/library/index.html` and `/overlay/index.html`. A dev-only
mock (`src/renderer/shared/devMock.ts`) stands in for the preload bridge with
sample notes, so the interface can be worked on without launching Electron or
screenshotting the desktop. It installs itself only when the real bridge is
absent and is stripped from production builds.

### The flip

The motion follows Apple's, which comes down to four things that are easy to
get wrong:

**The window must not be visible behind its own flip.** This is the one that
decides whether the effect works at all. rho never touches the real window —
it belongs to another process and keeps painting throughout — so the moment
the card rotates far enough to stop covering its own rectangle, the untouched
window shows through and the whole thing reads as a second panel flipping in
front of the window. Two things prevent it:

- A **recess** sits directly behind the card at exactly its size: a heavily
  blurred, darkened echo of the screenshot, so the turn exposes what looks
  like depth instead of a sharp duplicate. It is hidden at rest and switches
  on without a fade, in the same frame the turn starts, while the card still
  covers it.
- The turn **does not begin until the screenshot exists**. Rotating early
  means rotating an empty panel in front of the real window, which is the
  fake-looking flip in its purest form. Focus is never gated on this — the
  editor takes it on the first frame — so the wait costs nothing but a moment
  where the window sits there looking untouched, which is the honest thing to
  show when there is no picture of it yet.

**Springs, not ease curves.** The rotation runs on a `linear()` easing solved
from SwiftUI's `.spring(response: 0.42, dampingFraction: 0.78)`. It turns about
2% past 180° and settles back. A cubic-bezier cannot overshoot, and that
settle is most of what makes the motion feel like an object rather than a
tween. Regenerate it by solving the damped-oscillator equation and emitting the
stops; the constants are in the comment beside it.

**Perspective proportional to the card.** A fixed focal length that flatters a
small window tears a maximized one apart, so it is set from the card's longest
edge (1.9×) at runtime. This is what makes the near edge swing toward you and
the far edge recede.

**Room to turn.** Under perspective the card's projection spills outside its own
rectangle — measured at up to 93px vertically at 90° for a mid-sized window. So
the overlay window is inflated by a margin (`FLIP_MARGIN`) and the card is
placed inside it at an offset the main process computes. Without that the turn
is sliced off against the window edge and the drop shadow has nowhere to fall.
Clicking the margin dismisses, so it is a target rather than dead space.

Depth and rotation are separate layers because they need different timing: the
card recedes through the turn and comes back, which one interpolated transform
cannot express.

Closing runs the turn in reverse over 240ms before dismissing. That delay is
the only place the animation is allowed to cost anything.

**The latency budget**, measured on a 1920×1080 display:

| | |
|---|---|
| hotkey → editor focused, typing lands | ~20ms |
| → screenshot ready, turn begins | ~255ms |
| → note fully facing you | ~690ms |

That middle number is `desktopCapturer.getSources`, and it is the whole cost —
the JPEG encode is 9–29ms and the crop is under a millisecond. It does not
respond to asking for fewer pixels: 271ms at full resolution, 268ms at 0.6×,
275ms at 0.4×, so don't bother re-trying that. The only way below it is a
permanently warm capture stream (~16–33ms per frame), which means rho capturing
the screen continuously while it sits idle — a real CPU and privacy cost that
isn't worth taking without asking first.

**Working on it:** `src/renderer/overlay/harness.html` loads the real
`overlay.css` against the real markup over a stand-in window, with a scrubber to
hold any angle still. Run `npx vite src/renderer --port 5199` and open
`/overlay/harness.html`. It is not bundled — only the entry points named in
`electron.vite.config.ts` are. For inspecting the real overlay instead, launch
with `RHO_NO_PROTECT=1`, which lifts the content protection that otherwise makes
it invisible to every screenshot.

### The parts worth knowing about

**`src/main/win32/`** — koffi bindings to `user32`/`kernel32`/`dwmapi`. koffi
ships a prebuilt Node-API binary, so there's no node-gyp, no electron-rebuild
and no compiler needed. It must stay external to the bundler and unpacked from
the asar, which `electron-builder.yml` handles.

Window bounds come from `DWMWA_EXTENDED_FRAME_BOUNDS`, not `GetWindowRect`.
`GetWindowRect` includes an invisible ~8px resize border, overhangs the monitor
when maximized, and — because it respects the process's DPI awareness — reports
virtualized coordinates. DWM always gives the true visible frame in real pixels.

**`src/main/capture/`** — captures the whole screen and crops, rather than
asking `desktopCapturer` for window sources. Window enumeration thumbnails
*every* open window before returning any of them. The overlay keeps itself out
of its own screenshot via `setContentProtection(true)`, reapplied on every
show because Windows has been known to drop it across hide/show.

**`src/main/url/`** — two ways to know which page a browser is on. The
extension in `extension/` pushes the real URL as tabs change, so it's already
in memory when the hotkey fires. Without it, a long-lived PowerShell sidecar
reads the address bar through UI Automation: ~740ms on the first read while
Chrome spins up its accessibility tree, ~16ms after that.

Be honest about the fallback's limits. It returns the omnibox *display string*,
not a URL — no scheme, `www.` hidden, and whatever you've half-typed if you're
mid-edit. It sees nothing in `--app`-mode PWA windows or an elevated browser.
And it switches Chrome into accessibility mode, which costs it some memory;
Settings can turn it off and key notes by window title instead.

**`src/main/context/resolve.ts`** — turns a window into a stable key, falling
through URL → title → app so there's always something to bind to. Notes record
every key they've been seen under, so one created before the URL was known gets
adopted rather than forked once it is.

## The browser extension

Unpacked, for now: `chrome://extensions` → Developer mode → Load unpacked →
pick `extension/`. Open its options page and paste the pairing token from rho's
Settings. It binds to `127.0.0.1` only and won't accept anything without the
token, because any page in any tab can reach a localhost port.

## Known edges

- A hotkey registered with `RegisterHotKey` *does* fire over an elevated
  window, and the title, bounds and overlay all still work there. Only the UIA
  URL read fails against an elevated browser.
- Content protection also hides the overlay from screen shares and recordings.
  For a private notes overlay that's the point, but it is deliberate.
- A window straddling two monitors with different scale factors can't be
  represented exactly in DIP space; rho snaps to the monitor containing it and
  overscans the bitmap by a pixel to avoid a visible seam.
- Focus on the desktop lands on a cloaked 1×1 shell helper rather than a real
  window. rho opens a centered panel in that case instead of doing nothing.
- Hiding the overlay does not always move the foreground with it, so rho skips
  windows that are invisible or belong to its own process. Otherwise the press
  after a dismiss binds a note to rho's own overlay.
- A maximized window has no room on screen for the flip margin, so the turn is
  clipped at the display edge. Unavoidable, and unnoticeable in practice —
  there is no visible surround on a maximized window anyway.
