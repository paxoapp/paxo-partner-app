import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import AdminApp from './AdminApp.jsx'
import './index.css'

// Path-based split: /admin* renders the standalone admin console, everything
// else is the partner-facing app. Both share Supabase auth but nothing else.
const isAdmin = window.location.pathname.replace(/\/+$/, "").startsWith("/admin");

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {isAdmin ? <AdminApp /> : <App />}
  </React.StrictMode>,
)
