# Architecture

Notes on how rho is built, and on the decisions that are not obvious from the
code. If you only want to *use* rho, the [README](../README.md) is enough.

## The hotkey path

```
hotkey ─► snapshot the foreground window   (synchronous — see below)
       ─► look up the note, show the overlay, focus the editor   (~20ms)
       ─► hold still, drawing nothing, until the window is photographed
       ─► turn, over the recess                                  (~255ms)
       ─► URL lookup lands, attaches to the note
```

The ordering *is* the design. The snapshot is synchronous because the
foreground window is only knowable in the instant the hotkey fires — one
`await` first and you are describing your own overlay. Everything slow happens
after the editor already has focus, so you are typing before the animation
finishes.

### Latency budget

Measured on a 1920×1080 display:

| | |
|---|---|
| hotkey → editor focused, typing lands | ~20ms |
| → screenshot ready, turn begins | ~255ms |
| → note fully facing you | ~690ms |

That middle number is `desktopCapturer.getSources`, and it is the whole cost —
the JPEG encode is 9–29ms and the crop is under a millisecond. It does **not**
respond to asking for fewer pixels: 271ms at full resolution, 268ms at 0.6×,
275ms at 0.4×. Don't re-try that.

The only way below it is a permanently warm capture stream (~16–33ms per
frame), which means rho capturing the screen continuously while it sits idle —
a real CPU and privacy cost, not taken without asking.

## The flip

The motion is modelled on Apple's, which comes down to four things that are
easy to get wrong.

**The window must not be visible behind its own flip.** This decides whether
the effect works at all. rho never touches the real window — it belongs to
another process and keeps painting throughout — so the moment the card rotates
far enough to stop covering its own rectangle, the untouched window shows
through and the whole thing reads as a second panel flipping *in front of* the
window. Two things prevent it:

- A **recess** sits directly behind the card at exactly its size: a heavily
  blurred, darkened echo of the screenshot, so the turn exposes what looks like
  depth instead of a sharp duplicate. It is hidden at rest and switches on
  without a fade, in the same frame the turn starts, while the card still
  covers it.
- The turn **does not begin until the screenshot exists**. Rotating early means
  rotating an empty panel in front of the real window — the fake-looking flip
  in its purest form. Focus is never gated on this, so the wait costs nothing
  but a moment where the window sits there looking untouched, which is the
  honest thing to show when there is no picture of it yet.

**Light, not just rotation.** A surface angling away from the light loses it.
Each face carries a shading layer that darkens as it turns edge-on and recovers
as it comes back — opacity there is linear in the rotation, so those animations
carry the same spring easing as the card itself and track the true angle rather
than wall-clock time. This is the single biggest thing separating a turning
object from a rotating picture.

**A slab, not a plane.** The two faces sit half a thickness either side of
centre, with edge strips closing the box. Only a few pixels, and only visible
for the couple of frames either side of edge-on — but something that vanishes
completely when it turns side-on reads as a texture, and something that shows
an edge reads as a thing.

Everything that is not linear in the rotation — the recede, the sheen — peaks at
21%, which is where the spring actually puts the card edge-on rather than
halfway through the duration. Solve the easing for 0.5: it crosses between its
sixth and seventh stops, at t ≈ 0.2075.

**Springs, not ease curves.** The rotation runs on a `linear()` easing solved
from SwiftUI's `.spring(response: 0.42, dampingFraction: 0.78)`. It turns about
2% past 180° and settles back. A cubic-bezier cannot overshoot, and that settle
is most of what makes the motion read as an object rather than a tween.
Regenerate it by solving the damped-oscillator equation and emitting the stops;
the constants are in the comment beside it.

**Perspective proportional to the card.** A fixed focal length that flatters a
small window tears a maximized one apart, so it is set from the card's longest
edge (1.9×) at runtime. This is what makes the near edge swing toward you and
the far edge recede.

**Room to turn.** Under perspective the card's projection spills outside its own
rectangle — measured at up to 93px vertically at 90° for a mid-sized window. The
overlay window is therefore inflated by a margin (`FLIP_MARGIN`) and the card
placed inside it at an offset the main process computes. Without that, the turn
is sliced off against the window edge and the drop shadow has nowhere to fall.
Clicking the margin dismisses, so it is a target rather than dead space.

Depth and rotation are separate layers because they need different timing: the
card recedes through the turn and comes back, which one interpolated transform
cannot express. Closing runs the turn in reverse over 240ms before dismissing —
the only place the animation is allowed to cost anything.

## Windows internals

`src/main/win32/` holds koffi bindings to `user32` / `kernel32` / `dwmapi`.
koffi ships a prebuilt Node-API binary, so there is no node-gyp, no
electron-rebuild and no compiler needed. It must stay external to the bundler
and unpacked from the asar; `electron-builder.yml` handles both, and the
platform binary lives under `@koromix/`, not `@koffi/`.

Window bounds come from `DWMWA_EXTENDED_FRAME_BOUNDS`, never `GetWindowRect`.
`GetWindowRect` includes an invisible ~8px resize border, overhangs the monitor
when maximized, and — because it respects the process's DPI awareness — reports
virtualized coordinates. DWM always gives the true visible frame in real pixels.

Two koffi conventions worth knowing, both found the hard way:

- `koffi.decode(buf, 'str16')` returns `null` for an empty string and
  **segfaults** on a 64KB buffer. Wide strings are decoded in Node instead.
- `HWND` values arrive as `BigInt` and can be passed straight back in.

## Capture

`src/main/capture/` captures the whole screen and crops, rather than asking
`desktopCapturer` for window sources — window enumeration thumbnails *every*
open window before returning any of them.

The overlay keeps itself out of its own screenshot with
`setContentProtection(true)`, reapplied on every show because Windows has been
known to drop it across hide/show. A side effect is that the overlay is
invisible to screen shares and recordings too; for a private notes overlay that
is the point, but it is deliberate rather than accidental.

Encoding is JPEG, not `toDataURL()`. PNG on a full-screen crop of photographic
content costs more than the capture itself, and the same buffer goes to disk, so
it is one encode instead of two.

## Knowing which page a browser is on

Two sources, in order of trust.

The **extension** in `extension/` pushes the real URL as tabs change, so it is
already in memory when the hotkey fires. It posts to `127.0.0.1` behind a
pairing token, because any page in any tab can reach a localhost port.

Without it, a long-lived **PowerShell sidecar** reads the address bar through UI
Automation: ~740ms on the first read while Chrome spins up its accessibility
tree, ~16ms after that. Spawning `powershell.exe` per lookup would cost ~350ms,
hence the persistent process speaking JSON lines.

Be honest about the fallback's limits. It returns the omnibox *display string*,
not a URL — no scheme, `www.` hidden, and whatever you have half-typed if you
are mid-edit. It sees nothing in `--app`-mode PWA windows or an elevated
browser. And it switches Chrome into accessibility mode, which costs Chrome some
memory; Settings can turn it off and key notes by window title instead.

UI Automation is COM-only, so calling it from koffi would mean hand-rolled
vtable dispatch where one wrong index is a hard crash. Reading Chrome's
History/Session SQLite is worse: WAL-locked, lagging, undocumented, and with no
concept of which tab is active.

## Note identity

`src/main/context/resolve.ts` turns a window into a stable key, falling through
URL → title → app so there is always something to bind to. Volatile title
prefixes — unread counts, playing markers — are stripped, or every notification
would orphan the note.

Notes record every key they have been seen under, so one created before the URL
was known gets adopted rather than forked once it is.

## Storage

The files are the source of truth; `index.json` is a cache, reconciled against
the folder on every launch. That is what makes hand-editing and file sync safe
rather than corrupting. Writes are atomic (temp file plus rename) so a crash
cannot truncate a note.

The frontmatter parser is hand-rolled rather than a YAML dependency: it is a
flat set of scalars and string lists, written only by us, and anything it cannot
parse falls back to a default rather than throwing — a hand-edit can never make
a note unopenable.

## Working on it

`npx vite src/renderer` serves the real renderer pages in an ordinary browser:

| | |
|---|---|
| `/library/index.html` | the library |
| `/overlay/index.html` | the note surface |
| `/overlay/harness.html` | the flip, with an angle scrubber |

A dev-only mock (`src/renderer/shared/devMock.ts`) stands in for the preload
bridge with sample notes, so the interface can be worked on without launching
Electron. It installs itself only when the real bridge is absent and is stripped
from production builds.

The flip harness exists because the animation is otherwise nearly impossible to
inspect: the overlay excludes itself from every screen-capture pipeline, and its
front face is a screenshot of the very window it covers, so a still frame of the
real thing is ambiguous. The harness puts a simulated *untouched window* behind
the card — the thing that used to bleed through — so any regression is obvious.

To inspect the real overlay instead, launch with `RHO_NO_PROTECT=1`, which lifts
the content protection that otherwise makes it invisible to screenshots.

Two scripts regenerate the media in `docs/`, both against the mock, so neither
can pick up anything from the machine that ran them:

- `scripts/shoot.cjs` — the still screenshots.
Both open their window off the side of the desktop rather than using
`show: false`. A hidden window composites lazily and `capturePage()` returns
frames where some layers never repainted — the editor showing one note while
the header still shows the last. The DOM is correct in that state; only the
pixels are stale, which makes it an easy thing to misread as a state bug.

- `scripts/record.cjs` — the demo GIF. It does not record in real time;
  `capturePage()` costs tens of milliseconds, so a live capture would drop
  frames unevenly. Instead the CSS animations are rebuilt as *paused* Web
  Animations — reading the spring straight out of the stylesheet, so the
  recording cannot drift from what ships — and stepped one frame at a time.
  ffmpeg then builds a palette across the whole clip before applying it;
  quantising per frame would make the flat paper crawl.

  Both phases of the turn fill, and the later one wins, so the closing animation
  has to be cancelled at setup or it covers the recording from the first frame.

## Known edges

- A hotkey registered with `RegisterHotKey` *does* fire over an elevated window,
  and the title, bounds and overlay all still work there. Only the UIA URL read
  fails against an elevated browser. (The widespread belief otherwise comes from
  AutoHotkey-style low-level hooks, which are a different mechanism.)
- A window straddling two monitors with different scale factors cannot be
  represented exactly in DIP space. rho snaps to the monitor containing it and
  overscans the bitmap by a pixel to avoid a visible seam.
- Focus on the desktop lands on a cloaked 1×1 shell helper rather than a real
  window, so rho opens a centered panel instead of doing nothing.
- Hiding the overlay does not always move the foreground with it, so rho skips
  windows that are invisible or belong to its own process. Otherwise the press
  after a dismiss binds a note to rho's own overlay.
- A maximized window has no room on screen for the flip margin, so the turn is
  clipped at the display edge. Unavoidable, and unnoticeable in practice — a
  maximized window has no visible surround anyway.
