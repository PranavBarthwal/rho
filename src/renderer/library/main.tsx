import { createRoot } from 'react-dom/client'
import App from './App'
import './library.css'

// Only does anything when the preload bridge is missing, i.e. when this page
// is opened in a plain browser to work on the UI.
if (import.meta.env.DEV) {
  const { installDevMock } = await import('../shared/devMock')
  installDevMock()
}

createRoot(document.getElementById('root')!).render(<App />)
