/**
 * The only place in the app where Windows DLLs are loaded.
 *
 * koffi is used rather than ffi-napi or a compiled addon because it ships a
 * prebuilt Node-API binary: no node-gyp, no electron-rebuild, no MSVC.
 * It must be marked external in the bundler config and unpacked from the asar.
 *
 * Conventions verified against koffi 3.3 on Win11 (see notes at each use):
 *  - `HWND` values arrive as BigInt and can be passed straight back in.
 *  - `_Out_ RECT *` accepts a plain `{}` which koffi fills in place.
 *  - `_Out_ uint32 *` accepts a one-element array.
 *  - Wide strings are decoded in Node, NOT with koffi.decode(buf, 'str16'),
 *    which returns null for empty strings and segfaults on large buffers.
 */
import koffi from 'koffi'

const user32 = koffi.load('user32.dll')
const kernel32 = koffi.load('kernel32.dll')
const dwmapi = koffi.load('dwmapi.dll')
const gdi32 = koffi.load('gdi32.dll')

export const HWND = koffi.pointer('HWND', koffi.opaque())
export const RECT = koffi.struct('RECT', {
  left: 'long',
  top: 'long',
  right: 'long',
  bottom: 'long'
})

export interface Win32Rect {
  left: number
  top: number
  right: number
  bottom: number
}

export const GetForegroundWindow = user32.func('HWND __stdcall GetForegroundWindow()')
export const GetAncestor = user32.func('HWND __stdcall GetAncestor(HWND hwnd, uint32 gaFlags)')
export const IsWindow = user32.func('bool __stdcall IsWindow(HWND hwnd)')
export const IsIconic = user32.func('bool __stdcall IsIconic(HWND hwnd)')
export const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(HWND hwnd)')
export const GetWindowRect = user32.func('bool __stdcall GetWindowRect(HWND hwnd, _Out_ RECT *lpRect)')
export const GetWindowTextW = user32.func(
  'int __stdcall GetWindowTextW(HWND hwnd, _Out_ uint16_t *lpString, int nMaxCount)'
)
export const GetClassNameW = user32.func(
  'int __stdcall GetClassNameW(HWND hwnd, _Out_ uint16_t *lpClassName, int nMaxCount)'
)
export const GetWindowThreadProcessId = user32.func(
  'uint32 __stdcall GetWindowThreadProcessId(HWND hwnd, _Out_ uint32 *lpdwProcessId)'
)
export const SetForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(HWND hwnd)')
export const ShowWindow = user32.func('bool __stdcall ShowWindow(HWND hwnd, int nCmdShow)')
export const AttachThreadInput = user32.func(
  'bool __stdcall AttachThreadInput(uint32 idAttach, uint32 idAttachTo, bool fAttach)'
)
export const GetCurrentThreadId = kernel32.func('uint32 __stdcall GetCurrentThreadId()')

export const OpenProcess = kernel32.func(
  'void* __stdcall OpenProcess(uint32 dwDesiredAccess, bool bInheritHandle, uint32 dwProcessId)'
)
export const QueryFullProcessImageNameW = kernel32.func(
  'bool __stdcall QueryFullProcessImageNameW(void* hProcess, uint32 dwFlags, _Out_ uint16_t *lpExeName, _Inout_ uint32 *lpdwSize)'
)
export const CloseHandle = kernel32.func('bool __stdcall CloseHandle(void* hObject)')

/** Returns an HRESULT; 0 === S_OK. */
export const DwmGetWindowAttributeRect = dwmapi.func(
  'int __stdcall DwmGetWindowAttribute(HWND hwnd, uint32 dwAttribute, _Out_ RECT *pvAttribute, uint32 cbAttribute)'
)
export const DwmGetWindowAttributeDword = dwmapi.func(
  'int __stdcall DwmGetWindowAttribute(HWND hwnd, uint32 dwAttribute, _Out_ uint32 *pvAttribute, uint32 cbAttribute)'
)

/*
 * GDI, for copying pixels off the screen. See win32/screengrab.ts for why this
 * is done by hand rather than through Electron's desktopCapturer.
 */
export const GetDC = user32.func('void* __stdcall GetDC(void* hWnd)')
export const ReleaseDC = user32.func('int __stdcall ReleaseDC(void* hWnd, void* hDC)')
export const CreateCompatibleDC = gdi32.func('void* __stdcall CreateCompatibleDC(void* hdc)')
export const CreateCompatibleBitmap = gdi32.func(
  'void* __stdcall CreateCompatibleBitmap(void* hdc, int cx, int cy)'
)
export const SelectObject = gdi32.func('void* __stdcall SelectObject(void* hdc, void* h)')
export const BitBlt = gdi32.func(
  'bool __stdcall BitBlt(void* hdc, int x, int y, int cx, int cy, void* hdcSrc, int x1, int y1, uint32 rop)'
)
export const GetDIBits = gdi32.func(
  'int __stdcall GetDIBits(void* hdc, void* hbm, uint32 start, uint32 lines, _Out_ void* bits, _Inout_ void* bmi, uint32 usage)'
)
export const DeleteObject = gdi32.func('bool __stdcall DeleteObject(void* ho)')
export const DeleteDC = gdi32.func('bool __stdcall DeleteDC(void* hdc)')

/** Plain copy. Deliberately not CAPTUREBLT, which can itself cause flicker. */
export const SRCCOPY = 0x00cc0020

export const GA_ROOT = 2
export const SW_RESTORE = 9
export const S_OK = 0

/** DWM window attributes we care about. */
export const DWMWA_EXTENDED_FRAME_BOUNDS = 9
export const DWMWA_CLOAKED = 14

/**
 * PROCESS_QUERY_LIMITED_INFORMATION. Deliberately not PROCESS_QUERY_INFORMATION
 * (0x0400), which gets ACCESS_DENIED against elevated or protected processes.
 */
export const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

/**
 * Decode a UTF-16LE out-param buffer.
 *
 * `chars` is the length the API reported; when it is omitted we scan to the
 * first NUL. koffi.decode(buf, 'str16') would be the obvious thing to use
 * here, but it returns null for an empty string and segfaults outright on a
 * 64KB buffer, so we do it in Node where the behaviour is ours.
 */
export function wideString(buf: Buffer, chars?: number): string {
  let end = chars !== undefined ? chars * 2 : -1
  if (end < 0 || end > buf.length) {
    end = buf.length
    for (let i = 0; i + 1 < buf.length; i += 2) {
      if (buf.readUInt16LE(i) === 0) {
        end = i
        break
      }
    }
  }
  return buf.subarray(0, end).toString('utf16le')
}

export { koffi }
