/**
 * tiptap-markdown predates TipTap v3 and does not augment its `Storage`
 * interface, so `editor.storage.markdown` is untyped. The extension is present
 * and works; this just tells TypeScript what it puts there.
 */
import '@tiptap/core'

declare module '@tiptap/core' {
  interface Storage {
    markdown: {
      getMarkdown: () => string
    }
  }
}
