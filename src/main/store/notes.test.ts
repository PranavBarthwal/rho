import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// notes.ts imports electron only to find a default notes folder; every test
// passes an explicit root, so a stub is enough.
vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }))

const {
  deserialize,
  initStore,
  listNotes,
  openForContext,
  readNote,
  recordUrl,
  searchNotes,
  shutdownStore,
  updateBody,
  deleteNote
} = await import('./notes')

let root = ''

const ctx = {
  app: 'chrome.exe',
  titleKey: 'docs',
  contextKey: 'chrome.exe|docs'
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'rho-test-'))
  await initStore(root)
})

afterEach(async () => {
  await shutdownStore()
  await fs.rm(root, { recursive: true, force: true })
})

describe('round trip', () => {
  it('creates a note on first open and returns the same one after', async () => {
    const a = await openForContext(ctx, [ctx.contextKey], 'Docs')
    await updateBody(a.id, 'first thought')
    const b = await openForContext(ctx, [ctx.contextKey], 'Docs')
    expect(b.id).toBe(a.id)
    expect(b.body).toBe('first thought')
    expect(listNotes()).toHaveLength(1)
  })

  it('survives frontmatter values containing quotes and backslashes', async () => {
    const note = await openForContext(
      { app: 'x.exe', titleKey: 't', contextKey: 'x.exe|C:\\a "b"' },
      ['x.exe|C:\\a "b"'],
      'He said "hi" \\ there'
    )
    await updateBody(note.id, 'body')
    const again = await readNote(note.id)
    expect(again?.title).toBe('He said "hi" \\ there')
    expect(again?.contextKey).toBe('x.exe|C:\\a "b"')
  })

  it('treats a file with no frontmatter as all body rather than failing', () => {
    const note = deserialize('just some text', 'fallback')
    expect(note.id).toBe('fallback')
    expect(note.body).toBe('just some text')
  })
})

describe('key promotion', () => {
  it('reuses the title-keyed note once a URL becomes known, without forking', async () => {
    const byTitle = await openForContext(ctx, [ctx.contextKey], 'Docs')
    await updateBody(byTitle.id, 'written before the URL was known')

    const withUrl = {
      app: 'chrome.exe',
      titleKey: 'docs',
      urlKey: 'example.com/docs',
      contextKey: 'chrome.exe|example.com/docs'
    }
    const promoted = await openForContext(
      withUrl,
      ['chrome.exe|example.com/docs', 'chrome.exe|docs'],
      'Docs'
    )

    expect(promoted.id).toBe(byTitle.id)
    expect(promoted.body).toBe('written before the URL was known')
    expect(promoted.contextKey).toBe('chrome.exe|example.com/docs')
    expect(promoted.aliases).toContain('chrome.exe|docs')
    expect(listNotes()).toHaveLength(1)
  })

  it('finds the note again by its old title key after promotion', async () => {
    const first = await openForContext(ctx, [ctx.contextKey], 'Docs')
    await recordUrl(first.id, 'https://example.com/docs', 'chrome.exe|example.com/docs')
    const again = await openForContext(
      { app: 'chrome.exe', titleKey: 'docs', contextKey: 'chrome.exe|docs' },
      ['chrome.exe|docs'],
      'Docs'
    )
    expect(again.id).toBe(first.id)
    expect(again.url).toBe('https://example.com/docs')
  })
})

describe('index reconciliation', () => {
  it('picks up a note file that appeared without the index knowing', async () => {
    const created = await openForContext(ctx, [ctx.contextKey], 'Docs')
    const dir = path.join(root, 'notes', '2026', '01')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      path.join(dir, 'synced1.md'),
      '---\nid: synced1\ncontextKey: "code.exe|thing"\napp: "code.exe"\ntitle: "Arrived via sync"\naliases: []\ncreated: 2026-01-01T00:00:00.000Z\nupdated: 2026-01-01T00:00:00.000Z\ntags: []\n---\n\nfrom another machine',
      'utf8'
    )

    await initStore(root)
    const ids = listNotes().map((n) => n.id)
    expect(ids).toContain(created.id)
    expect(ids).toContain('synced1')
    expect(searchNotes('another machine').map((n) => n.id)).toEqual(['synced1'])
  })

  it('drops index entries whose files have been deleted behind our back', async () => {
    const note = await openForContext(ctx, [ctx.contextKey], 'Docs')
    const entry = listNotes().find((n) => n.id === note.id)!
    await fs.rm(path.join(root, entry.file))

    await initStore(root)
    expect(listNotes()).toHaveLength(0)
    expect(await readNote(note.id)).toBeNull()
  })

  it('rebuilds from the files when the index is corrupt', async () => {
    const note = await openForContext(ctx, [ctx.contextKey], 'Docs')
    await updateBody(note.id, 'still here')
    await shutdownStore()
    await fs.writeFile(path.join(root, 'index.json'), 'not json at all', 'utf8')

    await initStore(root)
    expect(listNotes()).toHaveLength(1)
    expect((await readNote(note.id))?.body).toBe('still here')
  })

  it('re-reads a note that was edited by hand after the index was written', async () => {
    const note = await openForContext(ctx, [ctx.contextKey], 'Docs')
    await updateBody(note.id, 'original')
    await shutdownStore()

    const entry = listNotes().find((n) => n.id === note.id)!
    const full = path.join(root, entry.file)
    const text = await fs.readFile(full, 'utf8')
    await fs.writeFile(full, text.replace('original', 'edited in another editor'), 'utf8')
    // Push mtime well past the indexed `updated` so the staleness check trips.
    const future = new Date(Date.now() + 60_000)
    await fs.utimes(full, future, future)

    await initStore(root)
    expect(searchNotes('another editor')).toHaveLength(1)
  })
})

describe('search', () => {
  it('requires every term to match, across title, app and body', async () => {
    const a = await openForContext(ctx, [ctx.contextKey], 'Docs')
    await updateBody(a.id, 'alpha beta')
    const b = await openForContext(
      { app: 'code.exe', titleKey: 'proj', contextKey: 'code.exe|proj' },
      ['code.exe|proj'],
      'Project'
    )
    await updateBody(b.id, 'gamma')

    expect(searchNotes('alpha').map((n) => n.id)).toEqual([a.id])
    expect(searchNotes('docs alpha').map((n) => n.id)).toEqual([a.id])
    expect(searchNotes('docs gamma')).toHaveLength(0)
    expect(searchNotes('')).toHaveLength(2)
  })
})

describe('delete', () => {
  it('removes the file and the index entry', async () => {
    const note = await openForContext(ctx, [ctx.contextKey], 'Docs')
    const entry = listNotes().find((n) => n.id === note.id)!
    await deleteNote(note.id)
    expect(listNotes()).toHaveLength(0)
    await expect(fs.access(path.join(root, entry.file))).rejects.toThrow()
  })
})
