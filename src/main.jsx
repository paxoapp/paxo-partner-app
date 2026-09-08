import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import AdminApp from './AdminApp.jsx'
import './index.css'

// The standalone admin console is served two ways: at partner.mypaxo.in/admin*
// and at its own host, admin.mypaxo.in (vercel.json serves the SPA shell for
// that host). A Vercel rewrite can't change window.location, so the host is
// matched here rather than relying on the rewritten path. Everything else is
// the partner-facing app. Both share Supabase auth but nothing else.
const isAdmin =
  window.location.hostname === "admin.mypaxo.in" ||
  window.location.pathname.replace(/\/+$/, "").startsWith("/admin");

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {isAdmin ? <AdminApp /> : <App />}
  </React.StrictMode>,
)
