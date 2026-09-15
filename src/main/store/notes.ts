/**
 * Notes on disk: one markdown file per note plus a JSON index.
 *
 * No database. The files are the source of truth and the index is a cache
 * that is rebuilt from them on startup, so a note that arrives via OneDrive
 * or is edited by hand in another editor is picked up rather than lost.
 */
import { promises as fs, type Dirent } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { Note, NoteContext, NoteMeta } from '@shared/types'

export interface IndexEntry {
  id: string
  file: string
  contextKey: string
  app: string
  title: string
  url?: string
  updated: string
  preview: string
}

let root = ''
let index = new Map<string, IndexEntry>()
/** contextKey (including aliases) -> note id */
let byKey = new Map<string, string>()
let flushTimer: NodeJS.Timeout | null = null

export function notesRoot(): string {
  return root
}

function indexPath(): string {
  return path.join(root, 'index.json')
}

/** Monotonic-ish, sortable, collision-resistant enough for one machine. */
function newId(): string {
  const t = Date.now().toString(36).padStart(9, '0')
  const r = Math.random().toString(36).slice(2, 10)
  return `${t}${r}`
}

function fileFor(id: string, created: Date): string {
  const y = String(created.getFullYear())
  const m = String(created.getMonth() + 1).padStart(2, '0')
  return path.join('notes', y, m, `${id}.md`)
}

function escapeYaml(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function serialize(note: Note): string {
  const fm = [
    '---',
    `id: ${note.id}`,
    `contextKey: ${escapeYaml(note.contextKey)}`,
    `app: ${escapeYaml(note.app)}`,
    `title: ${escapeYaml(note.title)}`,
    note.url ? `url: ${escapeYaml(note.url)}` : null,
    `aliases: [${note.aliases.map(escapeYaml).join(', ')}]`,
    note.shot ? `shot: ${escapeYaml(note.shot)}` : null,
    `created: ${note.created}`,
    `updated: ${note.updated}`,
    `tags: [${note.tags.map(escapeYaml).join(', ')}]`,
    '---',
    ''
  ].filter((l): l is string => l !== null)
  return `${fm.join('\n')}\n${note.body}`
}

function unquote(v: string): string {
  const t = v.trim()
  if (t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  return t
}

function parseList(v: string): string[] {
  const t = v.trim().replace(/^\[/, '').replace(/\]$/, '').trim()
  if (!t) return []
  return (t.match(/"(?:[^"\\]|\\.)*"|[^,]+/g) ?? []).map((s) => unquote(s)).filter(Boolean)
}

/**
 * Deliberately a small hand-rolled parser rather than a YAML dependency: the
 * frontmatter is written only by us and is a flat set of scalars and string
 * lists. Anything it cannot parse falls back to a default rather than
 * throwing, so a hand-edit can never make a note unopenable.
 */
export function deserialize(text: string, fallbackId: string): Note {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  // serialize() writes one blank line between the frontmatter and the body so
  // the file reads well by hand. Consume exactly that one, and no more, or a
  // body that legitimately starts blank would lose a line on every save.
  const body = m ? text.slice(m[0].length).replace(/^\r?\n/, '') : text
  const meta: Record<string, string> = {}
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/.exec(line)
      if (kv) meta[kv[1]] = kv[2]
    }
  }
  const now = new Date().toISOString()
  return {
    id: meta.id?.trim() || fallbackId,
    contextKey: unquote(meta.contextKey ?? ''),
    app: unquote(meta.app ?? ''),
    title: unquote(meta.title ?? ''),
    url: meta.url ? unquote(meta.url) : undefined,
    aliases: meta.aliases ? parseList(meta.aliases) : [],
    shot: meta.shot ? unquote(meta.shot) : undefined,
    created: meta.created?.trim() || now,
    updated: meta.updated?.trim() || now,
    tags: meta.tags ? parseList(meta.tags) : [],
    body
  }
}

function previewOf(body: string): string {
  return body.replace(/\s+/g, ' ').trim().slice(0, 200)
}

function entryOf(note: Note, file: string): IndexEntry {
  return {
    id: note.id,
    file,
    contextKey: note.contextKey,
    app: note.app,
    title: note.title,
    url: note.url,
    updated: note.updated,
    preview: previewOf(note.body)
  }
}

function reindexKeys(): void {
  byKey = new Map()
  for (const e of index.values()) byKey.set(e.contextKey, e.id)
}

async function walkNotes(dir: string, out: string[]): Promise<void> {
  let entries: Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    return
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) await walkNotes(full, out)
    else if (e.name.endsWith('.md')) out.push(full)
  }
}

/**
 * Load the index, then reconcile it against what is actually on disk.
 *
 * The reconcile pass is what makes hand-editing and file sync safe. It is a
 * full stat of every note file, which is fine at the scale this app lives at
 * (thousands of small files) and happens once at startup, off the hot path.
 */
export async function initStore(customRoot?: string): Promise<void> {
  root = customRoot || path.join(app.getPath('home'), 'rho')
  await fs.mkdir(path.join(root, 'notes'), { recursive: true })
  await fs.mkdir(path.join(root, 'shots'), { recursive: true })

  index = new Map()
  try {
    const raw = await fs.readFile(indexPath(), 'utf8')
    for (const e of JSON.parse(raw) as IndexEntry[]) index.set(e.id, e)
  } catch {
    // Missing or corrupt index is not an error; the files rebuild it.
  }

  const files: string[] = []
  await walkNotes(path.join(root, 'notes'), files)
  const seen = new Set<string>()

  for (const full of files) {
    const rel = path.relative(root, full)
    const id = path.basename(full, '.md')
    seen.add(id)
    const existing = index.get(id)
    let stat: Awaited<ReturnType<typeof fs.stat>>
    try {
      stat = await fs.stat(full)
    } catch {
      continue
    }
    // Trust the index only if it is at least as new as the file.
    if (existing && new Date(existing.updated).getTime() >= stat.mtimeMs - 1000) continue
    try {
      const note = deserialize(await fs.readFile(full, 'utf8'), id)
      index.set(id, entryOf(note, rel))
    } catch {
      // Unreadable file: leave whatever the index already knew.
    }
  }

  // Drop index entries whose files are gone (deleted or moved elsewhere).
  for (const id of [...index.keys()]) if (!seen.has(id)) index.delete(id)

  reindexKeys()
  await flushIndex()
}

/** Atomic: write a temp file and rename, so a crash can never truncate. */
async function writeAtomic(full: string, data: string): Promise<void> {
  await fs.mkdir(path.dirname(full), { recursive: true })
  const tmp = `${full}.tmp`
  await fs.writeFile(tmp, data, 'utf8')
  await fs.rename(tmp, full)
}

async function flushIndex(): Promise<void> {
  await writeAtomic(indexPath(), JSON.stringify([...index.values()], null, 0))
}

function scheduleFlush(): void {
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flushIndex()
  }, 1000)
}

export async function readNote(id: string): Promise<Note | null> {
  const entry = index.get(id)
  if (!entry) return null
  try {
    return deserialize(await fs.readFile(path.join(root, entry.file), 'utf8'), id)
  } catch {
    return null
  }
}

/**
 * Find the note bound to this context, creating it if this is the first time.
 *
 * `candidates` are the fallback keys from the resolver; the first hit wins and
 * is then re-keyed to the primary, which is how a title-keyed note gets
 * promoted to a URL-keyed one without forking.
 */
export async function openForContext(ctx: NoteContext, candidates: string[], title: string): Promise<Note> {
  for (const key of candidates) {
    const id = byKey.get(key)
    if (!id) continue
    const note = await readNote(id)
    if (!note) continue
    if (note.contextKey !== ctx.contextKey) {
      if (!note.aliases.includes(note.contextKey)) note.aliases.push(note.contextKey)
      note.contextKey = ctx.contextKey
      byKey.set(ctx.contextKey, note.id)
      await saveNote(note)
    }
    return note
  }

  const now = new Date()
  const id = newId()
  const note: Note = {
    id,
    contextKey: ctx.contextKey,
    app: ctx.app,
    title,
    url: ctx.urlKey,
    aliases: [],
    created: now.toISOString(),
    updated: now.toISOString(),
    tags: [],
    body: ''
  }
  const file = fileFor(id, now)
  index.set(id, entryOf(note, file))
  byKey.set(ctx.contextKey, id)
  await writeAtomic(path.join(root, file), serialize(note))
  scheduleFlush()
  return note
}

export async function saveNote(note: Note): Promise<void> {
  const existing = index.get(note.id)
  const file = existing?.file ?? fileFor(note.id, new Date(note.created))
  note.updated = new Date().toISOString()
  await writeAtomic(path.join(root, file), serialize(note))
  index.set(note.id, entryOf(note, file))
  byKey.set(note.contextKey, note.id)
  for (const a of note.aliases) if (!byKey.has(a)) byKey.set(a, note.id)
  scheduleFlush()
}

export async function updateBody(id: string, body: string): Promise<void> {
  const note = await readNote(id)
  if (!note) return
  if (note.body === body) return
  note.body = body
  await saveNote(note)
}

/**
 * Attach a URL discovered after the note was already open.
 *
 * The note keeps whatever key it was opened under; the URL is recorded as an
 * alias so that a later, more accurate lookup finds this note instead of
 * starting a new one.
 */
export async function recordUrl(id: string, url: string, aliasKey?: string): Promise<void> {
  const note = await readNote(id)
  if (!note) return
  const needsAlias = !!aliasKey && aliasKey !== note.contextKey && !note.aliases.includes(aliasKey)
  if (note.url === url && !needsAlias) return
  note.url = url
  if (needsAlias) note.aliases.push(aliasKey!)
  await saveNote(note)
}

export async function setShot(id: string, shotFile: string): Promise<void> {
  const note = await readNote(id)
  if (!note || note.shot === shotFile) return
  note.shot = shotFile
  await saveNote(note)
}

export function listNotes(): IndexEntry[] {
  return [...index.values()].sort((a, b) => b.updated.localeCompare(a.updated))
}

/**
 * In-memory search over titles, URLs and previews.
 *
 * Substring rather than fuzzy on purpose: with a library keyed to real window
 * titles, the user almost always remembers an exact word from the page they
 * were on, and fuzzy matching mostly adds noise.
 */
export function searchNotes(query: string): IndexEntry[] {
  const q = query.trim().toLowerCase()
  if (!q) return listNotes()
  const terms = q.split(/\s+/)
  return listNotes().filter((e) => {
    const hay = `${e.title} ${e.app} ${e.url ?? ''} ${e.preview}`.toLowerCase()
    return terms.every((t) => hay.includes(t))
  })
}

export async function deleteNote(id: string): Promise<void> {
  const entry = index.get(id)
  if (!entry) return
  try {
    await fs.unlink(path.join(root, entry.file))
  } catch {
    // Already gone on disk; still drop it from the index.
  }
  index.delete(id)
  reindexKeys()
  scheduleFlush()
}

/** Flush pending index writes before quitting. */
export async function shutdownStore(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  await flushIndex()
}

export type { NoteMeta }
