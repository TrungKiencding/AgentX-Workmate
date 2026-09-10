import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import '../tokens.css'
import './styles/base.css'
import './styles/sections.css'

import { App } from './App'
import { I18nProvider } from './i18n'

const root = document.getElementById('root')

if (!root) {
  throw new Error('#root is missing from index.html')
}

createRoot(root).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>
)
