import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import AdminApp from './AdminApp.jsx'
import AgreementPage from './agreementPage.jsx'
import './index.css'

// The standalone admin console is served two ways: at partner.mypaxo.in/admin*
// and at its own host, admin.mypaxo.in (vercel.json serves the SPA shell for
// that host). A Vercel rewrite can't change window.location, so the host is
// matched here rather than relying on the rewritten path. Everything else is
// the partner-facing app. Both share Supabase auth but nothing else.
const isAdmin =
  window.location.hostname === "admin.mypaxo.in" ||
  window.location.pathname.replace(/\/+$/, "").startsWith("/admin");

// Public, no login: the one-time link a venue owner gets by email to accept the Partner Agreement.
// It never mounts the partner app, so no session is read or restored on this page.
const agreementMatch = window.location.pathname.match(/^\/agreement\/([A-Za-z0-9_-]+)\/?$/);

if (isAdmin) {
  const meta = document.createElement("meta");
  meta.name = "robots";
  meta.content = "noindex, nofollow";
  document.head.appendChild(meta);
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {agreementMatch ? <AgreementPage token={agreementMatch[1]} /> : isAdmin ? <AdminApp /> : <App />}
  </React.StrictMode>,
)
