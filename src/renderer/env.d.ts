/// <reference types="vite/client" />
import type { RhoApi } from '../preload'

declare global {
  interface Window {
    rho: RhoApi
  }
}

export {}
