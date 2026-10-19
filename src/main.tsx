import { createRoot } from 'react-dom/client'
// Base layout first; App ends with product.css, which owns the desktop surfaces.
import './styles.css'
import App from './App'

createRoot(document.getElementById('root')!).render(<App />)
