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
    onSelectionUpdate: ({ editor: ed }) => syncMenu(ed)
  })

  /**
   * Track whether the caret is still inside a `/query` run, and where it is on
   * screen. Driven off the document rather than keystrokes so that arrow keys,
   * clicks and undo all close the menu correctly.
   */
  const syncMenu = useCallback((ed: TipTapEditor) => {
    const { state } = ed
    const { from, empty } = state.selection
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
