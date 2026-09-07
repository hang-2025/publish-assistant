import React from 'react'
import { createRoot } from 'react-dom/client'
import { LocalImport } from './page'
import './style.css'

createRoot(document.getElementById('root')!).render(<React.StrictMode><LocalImport /></React.StrictMode>)
