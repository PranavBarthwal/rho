import type { Editor } from '@tiptap/react'

/**
 * The slash menu's repertoire.
 *
 * Deliberately short. Every entry here is also reachable by typing its
 * markdown prefix — `## `, `- `, `> ` — and the menu exists for the times you
 * cannot remember which prefix, not as the primary way to work.
 */
export interface SlashCommand {
  id: string
  title: string
  hint: string
  keywords: string
  run: (editor: Editor) => void
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    id: 'h1',
    title: 'Heading 1',
    hint: '#',
    keywords: 'h1 heading title large',
    run: (e) => e.chain().focus().toggleHeading({ level: 1 }).run()
  },
  {
    id: 'h2',
    title: 'Heading 2',
    hint: '##',
    keywords: 'h2 heading subtitle',
    run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run()
  },
  {
    id: 'h3',
    title: 'Heading 3',
    hint: '###',
    keywords: 'h3 heading small',
    run: (e) => e.chain().focus().toggleHeading({ level: 3 }).run()
  },
  {
    id: 'bullet',
    title: 'Bulleted list',
    hint: '-',
    keywords: 'bullet list unordered ul point',
    run: (e) => e.chain().focus().toggleBulletList().run()
  },
  {
    id: 'ordered',
    title: 'Numbered list',
    hint: '1.',
    keywords: 'number ordered list ol steps',
    run: (e) => e.chain().focus().toggleOrderedList().run()
  },
  {
    id: 'task',
    title: 'To-do',
    hint: '[ ]',
    keywords: 'todo task check checkbox done',
    run: (e) => e.chain().focus().toggleTaskList().run()
  },
  {
    id: 'quote',
    title: 'Quote',
    hint: '>',
    keywords: 'quote blockquote cite',
    run: (e) => e.chain().focus().toggleBlockquote().run()
  },
  {
    id: 'code',
    title: 'Code block',
    hint: '```',
    keywords: 'code block pre snippet',
    run: (e) => e.chain().focus().toggleCodeBlock().run()
  },
  {
    id: 'rule',
    title: 'Divider',
    hint: '---',
    keywords: 'divider rule hr separator line',
    run: (e) => e.chain().focus().setHorizontalRule().run()
  }
]

export function filterCommands(query: string): SlashCommand[] {
  const q = query.trim().toLowerCase()
  if (!q) return SLASH_COMMANDS
  return SLASH_COMMANDS.filter(
    (c) => c.title.toLowerCase().includes(q) || c.keywords.includes(q)
  )
}
