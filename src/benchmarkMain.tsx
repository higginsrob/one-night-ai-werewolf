import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import BenchmarkApp from './eval/BenchmarkApp'
import './styles.css'

document.documentElement.classList.add('benchmark-page')
document.body.classList.add('benchmark-page')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BenchmarkApp />
  </StrictMode>,
)
