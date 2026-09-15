import { describe, expect, it } from 'vitest'
import { candidateKeys, normalizeTitle, normalizeUrl, resolveContext } from './resolve'
import type { WindowSnapshot } from '@shared/types'

function snap(over: Partial<WindowSnapshot> = {}): WindowSnapshot {
  return {
    hwnd: '1',
    title: '',
    className: 'Chrome_WidgetWin_1',
    exePath: 'C:\\Program Files\\Google\\Chrome\\chrome.exe',
    exeName: 'chrome.exe',
    pid: 1,
    rect: { x: 0, y: 0, width: 800, height: 600 },
    boundsFromDwm: true,
    minimized: false,
    capturedAt: 0,
    ...over
  }
}

describe('normalizeTitle', () => {
  it('drops the browser name so the key is about the page', () => {
    expect(normalizeTitle('Some Article - Google Chrome')).toBe('some article')
    expect(normalizeTitle('Docs — Mozilla Firefox')).toBe('docs')
  })

  it('drops unread counts and playing markers, which churn constantly', () => {
    expect(normalizeTitle('(3) Inbox - Google Chrome')).toBe('inbox')
    expect(normalizeTitle('● Meeting notes')).toBe('meeting notes')
    expect(normalizeTitle('(12+) ● Slack')).toBe('slack')
  })

  it('leaves an ordinary title alone apart from case', () => {
    expect(normalizeTitle('  Budget 2026  ')).toBe('budget 2026')
  })
})

describe('normalizeUrl', () => {
  it('reduces a URL to host and path', () => {
    expect(normalizeUrl('https://www.example.com/docs/intro/')).toBe('example.com/docs/intro')
  })

  it('drops query and fragment so tracking params do not fork the note', () => {
    expect(normalizeUrl('https://example.com/a?utm_source=x#section-2')).toBe('example.com/a')
  })

  it('accepts the scheme-less display string the omnibox actually gives us', () => {
    expect(normalizeUrl('example.com/page')).toBe('example.com/page')
  })

  it('rejects a half-typed search rather than keying a note to it', () => {
    expect(normalizeUrl('how to center a div')).toBeUndefined()
    expect(normalizeUrl('')).toBeUndefined()
    expect(normalizeUrl('localhost')).toBeUndefined()
  })
})

describe('resolveContext', () => {
  it('prefers the URL when one is available', () => {
    const ctx = resolveContext(snap({ title: 'Anything - Google Chrome' }), {
      value: 'https://example.com/a',
      source: 'extension'
    })
    expect(ctx.contextKey).toBe('chrome.exe|example.com/a')
    expect(ctx.urlSource).toBe('extension')
  })

  it('falls back to the title when there is no URL', () => {
    const ctx = resolveContext(snap({ title: 'Quarterly plan - Google Chrome' }))
    expect(ctx.contextKey).toBe('chrome.exe|quarterly plan')
    expect(ctx.urlKey).toBeUndefined()
  })

  it('falls back to the app alone for a generic or missing title', () => {
    expect(resolveContext(snap({ title: 'New Tab - Google Chrome' })).contextKey).toBe('chrome.exe')
    expect(resolveContext(snap({ title: '' })).contextKey).toBe('chrome.exe')
  })

  it('still produces a key when the process could not be identified', () => {
    const ctx = resolveContext(snap({ exeName: '', exePath: '', title: 'Thing' }))
    expect(ctx.contextKey).toBe('chrome_widgetwin_1|thing')
  })

  it('ignores a URL that is really a search the user was typing', () => {
    const ctx = resolveContext(snap({ title: 'Real Page - Google Chrome' }), {
      value: 'how to center a div',
      source: 'uia'
    })
    expect(ctx.contextKey).toBe('chrome.exe|real page')
  })
})

describe('candidateKeys', () => {
  it('offers the title key as a fallback so a pre-URL note is found again', () => {
    const ctx = resolveContext(snap({ title: 'Docs - Google Chrome' }), {
      value: 'https://example.com/docs',
      source: 'uia'
    })
    expect(candidateKeys(ctx)).toEqual(['chrome.exe|example.com/docs', 'chrome.exe|docs'])
  })

  it('offers only the one key when there is no URL to have been promoted from', () => {
    const ctx = resolveContext(snap({ title: 'Docs - Google Chrome' }))
    expect(candidateKeys(ctx)).toEqual(['chrome.exe|docs'])
  })
})
