import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { OperatingModeProvider } from './contexts/OperatingModeContext'
import { SearchTabsProvider } from './contexts/SearchTabsContext'
import './styles/index.css'

// OperatingModeProvider is at the top to provide API
// BooksProvider is now inside App because it needs the API from OperatingModeContext
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <OperatingModeProvider>
      <SearchTabsProvider>
        <App />
      </SearchTabsProvider>
    </OperatingModeProvider>
  </React.StrictMode>,
)
