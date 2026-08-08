import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { redirectEvalQueryToBenchmarkPage } from './eval/evalMode'
import './styles.css'

if (!redirectEvalQueryToBenchmarkPage()) {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
