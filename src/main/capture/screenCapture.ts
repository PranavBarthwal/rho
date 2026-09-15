/**
 * Grabbing the picture of the window we are flipping over.
 *
 * We capture the whole screen and crop, rather than asking desktopCapturer
 * for window sources. Window enumeration captures a thumbnail for *every*
 * open window before returning any of them, so it costs 150-600ms and gets
 * worse the more windows you have open; a screen capture is a flat cost that
 * does not care. The usual objection to screen capture — occlusion — does not
 * apply here, because the window we want is the foreground window by
 * construction.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { desktopCapturer, screen } from 'electron'
import type { PhysRect } from '@shared/types'
import { notesRoot } from '../store/notes'

/**
 * Full resolution, deliberately.
 *
 * The turn is gated on this capture returning, so it is worth being slow
 * about — but the resolution is not where the time goes. Measured on a
 * 1920x1080 display: 271ms median at full resolution, 268ms at 0.6x, 275ms at
 * 0.4x. `getSources` costs what it costs regardless of the pixels asked for,
 * so downscaling trades image quality for nothing. Don't re-try it.
 *
 * The ~270ms is `getSources` itself; the JPEG encode is 9-29ms and the crop is
 * under a millisecond. Getting below it means a permanently warm capture
 * stream, which is a real CPU and privacy cost for an app that sits idle all
 * day, so it is not taken here without asking.
 */
const CAPTURE_SCALE = 1

export interface Capture {
  /** JPEG data URL for the live flip. */
  dataUrl: string
  /** The same bytes, so the on-disk copy costs no second encode. */
  jpeg: Buffer
  /** Physical pixel size of the crop, for the renderer's aspect handling. */
  width: number
  height: number
  /** Where the time went, since the flip is gated on this finishing. */
  timing: { sources: number; crop: number; encode: number }
}

/**
 * Capture `rect` (physical pixels) from whichever display contains it.
 *
 * Returns null rather than throwing: the flip has a scrim fallback and a
 * missing screenshot must never block note-taking.
 */
export async function captureRect(rect: PhysRect, dipRect: Electron.Rectangle): Promise<Capture | null> {
  try {
    const t0 = Date.now()
    const display = screen.getDisplayMatching(dipRect)
    const sf = display.scaleFactor
    const ask = {
      width: Math.round(display.size.width * sf * CAPTURE_SCALE),
      height: Math.round(display.size.height * sf * CAPTURE_SCALE)
    }
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: ask,
      fetchWindowIcons: false
    })
    const tSources = Date.now() - t0
    if (!sources.length) return null

    const source =
      sources.find((s) => String(s.display_id) === String(display.id)) ?? sources[0]
    const thumb = source.thumbnail
    if (thumb.isEmpty()) return null

    // The thumbnail may come back at a different size than we asked for;
    // scale our crop into its coordinate space rather than assuming.
    const size = thumb.getSize()
    const originPhys = screen.dipToScreenRect(null, display.bounds)
    const kx = size.width / (display.size.width * sf)
    const ky = size.height / (display.size.height * sf)

    const crop = {
      x: Math.max(0, Math.round((rect.x - originPhys.x) * kx)),
      y: Math.max(0, Math.round((rect.y - originPhys.y) * ky)),
      width: Math.round(rect.width * kx),
      height: Math.round(rect.height * ky)
    }
    crop.width = Math.min(crop.width, size.width - crop.x)
    crop.height = Math.min(crop.height, size.height - crop.y)
    if (crop.width <= 0 || crop.height <= 0) return null

    const t1 = Date.now()
    const cropped = thumb.crop(crop)
    const tCrop = Date.now() - t1

    // JPEG, not toDataURL().
    //
    // toDataURL() encodes PNG, which on a full-screen crop of photographic
    // content costs more than the capture itself — and the turn is gated on
    // this returning. The same buffer is what goes to disk, so this is also
    // one encode instead of two.
    const t2 = Date.now()
    const jpeg = cropped.toJPEG(82)
    const tEncode = Date.now() - t2

    return {
      dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
      jpeg,
      width: crop.width,
      height: crop.height,
      timing: { sources: tSources, crop: tCrop, encode: tEncode }
    }
  } catch {
    return null
  }
}

/** Persist a capture next to the note it belongs to. Returns the relative path. */
export async function saveShot(noteId: string, capture: Capture): Promise<string | null> {
  try {
    const rel = path.join('shots', `${noteId}.jpg`)
    await fs.writeFile(path.join(notesRoot(), rel), capture.jpeg)
    return rel
  } catch {
    return null
  }
}

export async function readShot(rel: string): Promise<string | null> {
  try {
    const buf = await fs.readFile(path.join(notesRoot(), rel))
    return `data:image/jpeg;base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}
