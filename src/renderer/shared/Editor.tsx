import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { EditorContent, useEditor, type Editor as TipTapEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Link from '@tiptap/extension-link'
import { Markdown } from 'tiptap-markdown'
import { filterCommands, type SlashCommand } from './commands'

export interface EditorHandle {
  /** Replace the document. Used when the overlay switches notes. */
  setMarkdown: (md: string) => void
  getMarkdown: () => string
  focusEnd: () => void
  isEmpty: () => boolean
}

interface Props {
  placeholder?: string
  onChange?: (markdown: string) => void
  /** Escape and the close shortcuts belong to the host, not the editor. */
  onExit?: () => void
  onOpenLibrary?: () => void
  className?: string
}

interface MenuState {
  open: boolean
  query: string
  index: number
  /** Viewport coordinates of the slash, so the menu can sit under the caret. */
  left: number
  top: number
  /** Document position of the `/` that opened it, for replacing on commit. */
  from: number
}

const CLOSED: MenuState = { open: false, query: '', index: 0, left: 0, top: 0, from: 0 }

/** Where the selection toolbar sits, and whether there is a selection at all. */
interface BubbleState {
  open: boolean
  left: number
  top: number
}

const NO_BUBBLE: BubbleState = { open: false, left: 0, top: 0 }

/** The marks and blocks the toolbar can reach. */
const BUBBLE_ITEMS = [
  { id: 'bold', label: 'B', title: 'Bold', className: 'is-bold' },
  { id: 'italic', label: 'I', title: 'Italic', className: 'is-italic' },
  { id: 'strike', label: 'S', title: 'Strikethrough', className: 'is-strike' },
  { id: 'code', label: '<>', title: 'Code', className: 'is-code' },
  { id: 'h2', label: 'H', title: 'Heading', className: 'is-h' },
  { id: 'blockquote', label: '"', title: 'Quote', className: 'is-quote' },
  { id: 'bulletList', label: '•', title: 'Bulleted list', className: 'is-list' }
] as const

type BubbleId = (typeof BUBBLE_ITEMS)[number]['id']

/**
 * The note surface.
 *
 * Markdown is the storage format, so the editor is markdown-native rather than
 * HTML-with-a-converter: what you type as `## ` becomes a heading, and what
 * lands on disk is `## ` again. The file stays something you could open in any
 * other editor, which is the whole reason notes are files.
 */
const Editor = forwardRef<EditorHandle, Props>(function Editor(
  { placeholder = 'Type / for commands…', onChange, onExit, onOpenLibrary, className },
  ref
) {
  const [menu, setMenu] = useState<MenuState>(CLOSED)
  const [bubble, setBubble] = useState<BubbleState>(NO_BUBBLE)
  /** Re-read on every selection change so the toolbar shows what is active. */
  const [active, setActive] = useState<Record<string, boolean>>({})
  const menuRef = useRef<MenuState>(CLOSED)
  menuRef.current = menu
  const hostRef = useRef<HTMLDivElement>(null)

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        // Typing --- on its own line is a divider; keep the input rule.
        horizontalRule: {},
        link: false
      }),
      Link.configure({ openOnClick: false, autolink: true }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({
        placeholder: ({ node }) =>
          node.type.name === 'paragraph' ? placeholder : ''
      }),
      Markdown.configure({
        html: false,
        // Keep the on-disk file conventional: `-` bullets, `*` emphasis.
        bulletListMarker: '-',
        linkify: true,
        breaks: false,
        transformPastedText: true,
        transformCopiedText: true
      })
    ],
    content: '',
    autofocus: false,
    editorProps: {
      attributes: {
        class: 'prose',
        spellcheck: 'false'
      }
    },
    onUpdate: ({ editor: ed }) => {
      onChange?.(ed.storage.markdown.getMarkdown())
      syncMenu(ed)
    },
    onSelectionUpdate: ({ editor: ed }) => syncMenu(ed),
    // A selection can outlive focus — clicking another note in the library
    // leaves one behind — and a toolbar hovering over a note you are no longer
    // editing is just debris.
    onBlur: () => {
      setBubble(NO_BUBBLE)
      setMenu(CLOSED)
    }
  })

  /**
   * Track whether the caret is still inside a `/query` run, and where it is on
   * screen. Driven off the document rather than keystrokes so that arrow keys,
   * clicks and undo all close the menu correctly.
   */
  const syncMenu = useCallback((ed: TipTapEditor) => {
    const { state } = ed
    const { from, to, empty } = state.selection

    // The toolbar belongs to a selection; the slash menu belongs to a caret.
    // They are mutually exclusive, which is why both live in one pass.
    if (!empty) {
      const host = hostRef.current?.getBoundingClientRect()
      const a = ed.view.coordsAtPos(from)
      const b = ed.view.coordsAtPos(to)
      setActive({
        bold: ed.isActive('bold'),
        italic: ed.isActive('italic'),
        strike: ed.isActive('strike'),
        code: ed.isActive('code'),
        h2: ed.isActive('heading', { level: 2 }),
        blockquote: ed.isActive('blockquote'),
        bulletList: ed.isActive('bulletList')
      })
      setBubble({
        open: true,
        // Centred over the selection, clamped so a selection at the very edge
        // does not push the toolbar out of the note.
        left: Math.max(96, (a.left + b.left) / 2 - (host?.left ?? 0)),
        top: Math.min(a.top, b.top) - (host?.top ?? 0)
      })
    } else {
      setBubble(NO_BUBBLE)
    }

    if (!empty) {
      setMenu(CLOSED)
      return
    }
    const $pos = state.doc.resolve(from)
    const start = $pos.start()
    const before = state.doc.textBetween(start, from, '\n', '\n')
    const slash = before.lastIndexOf('/')
    // Only at the very start of a block, so paths and URLs never trigger it.
    if (slash !== 0) {
      setMenu(CLOSED)
      return
    }
    const query = before.slice(1)
    if (/\s/.test(query)) {
      setMenu(CLOSED)
      return
    }
    const coords = ed.view.coordsAtPos(start)
    const host = hostRef.current?.getBoundingClientRect()
    setMenu((prev) => ({
      open: true,
      query,
      index: prev.open && prev.query === query ? prev.index : 0,
      left: coords.left - (host?.left ?? 0),
      top: coords.bottom - (host?.top ?? 0),
      from: start
    }))
  }, [])

  const commit = useCallback(
    (cmd: SlashCommand) => {
      if (!editor) return
      const { from } = editor.state.selection
      // Delete the `/query` first so the command applies to a clean block.
      editor.chain().focus().deleteRange({ from: menuRef.current.from, to: from }).run()
      cmd.run(editor)
      setMenu(CLOSED)
    },
    [editor]
  )

  const applyBubble = useCallback(
    (id: BubbleId) => {
      if (!editor) return
      const c = editor.chain().focus()
      if (id === 'bold') c.toggleBold().run()
      else if (id === 'italic') c.toggleItalic().run()
      else if (id === 'strike') c.toggleStrike().run()
      else if (id === 'code') c.toggleCode().run()
      else if (id === 'h2') c.toggleHeading({ level: 2 }).run()
      else if (id === 'blockquote') c.toggleBlockquote().run()
      else if (id === 'bulletList') c.toggleBulletList().run()
    },
    [editor]
  )

  // A handle for poking at the editor from the console while working on it.
  useEffect(() => {
    if (import.meta.env.DEV && editor) {
      ;(window as unknown as { __editor?: unknown }).__editor = editor
    }
  }, [editor])

  useImperativeHandle(
    ref,
    () => ({
      setMarkdown: (md: string) => {
        if (!editor) return
        // `false` so loading a note is not an undoable edit and does not fire
        // onChange, which would immediately re-save what we just loaded.
        editor.commands.setContent(md || '', { emitUpdate: false })
        setMenu(CLOSED)
      },
      getMarkdown: () => editor?.storage.markdown.getMarkdown() ?? '',
      focusEnd: () => editor?.commands.focus('end'),
      isEmpty: () => !!editor?.isEmpty
    }),
    [editor]
  )

  // Menu navigation has to beat the editor to the keystroke, so it is bound on
  // the host in the capture phase rather than through editor shortcuts.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const onKeyDown = (e: KeyboardEvent): void => {
      const m = menuRef.current
      if (m.open) {
        const items = filterCommands(m.query)
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          e.stopPropagation()
          const dir = e.key === 'ArrowDown' ? 1 : -1
          setMenu((p) => ({ ...p, index: (p.index + dir + items.length) % items.length }))
          return
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          if (items.length) {
            e.preventDefault()
            e.stopPropagation()
            commit(items[m.index] ?? items[0])
            return
          }
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          setMenu(CLOSED)
          return
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        onExit?.()
        return
      }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        onExit?.()
        return
      }
      if (e.key.toLowerCase() === 'l' && e.ctrlKey && e.shiftKey) {
        e.preventDefault()
        onOpenLibrary?.()
      }
    }
    host.addEventListener('keydown', onKeyDown, true)
    return () => host.removeEventListener('keydown', onKeyDown, true)
  }, [commit, onExit, onOpenLibrary])

  const items = menu.open ? filterCommands(menu.query) : []

  return (
    <div className={`editor-host${className ? ` ${className}` : ''}`} ref={hostRef}>
      <EditorContent editor={editor} className="editor-scroll" />

      {bubble.open ? (
        <div className="bubble" style={{ left: bubble.left, top: bubble.top - 10 }} role="toolbar">
          {BUBBLE_ITEMS.map((it) => (
            <button
              key={it.id}
              type="button"
              title={it.title}
              aria-pressed={!!active[it.id]}
              className={`bubble__btn ${it.className}${active[it.id] ? ' is-on' : ''}`}
              // mousedown, not click: click blurs the editor first and the
              // command would apply to a selection that no longer exists.
              onMouseDown={(e) => {
                e.preventDefault()
                applyBubble(it.id)
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      ) : null}

      {menu.open && items.length > 0 ? (
        <div className="slash" style={{ left: menu.left, top: menu.top + 8 }} role="listbox">
          {items.map((c, i) => (
            <button
              key={c.id}
              type="button"
              role="option"
              aria-selected={i === menu.index}
              className={`slash__item${i === menu.index ? ' is-on' : ''}`}
              // mousedown, not click: click would blur the editor first and
              // the command would apply to a lost selection.
              onMouseDown={(e) => {
                e.preventDefault()
                commit(c)
              }}
              onMouseEnter={() => setMenu((p) => ({ ...p, index: i }))}
            >
              <span className="slash__title">{c.title}</span>
              <span className="slash__hint">{c.hint}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
})

export default Editor
