// Shared Supabase REST/Storage helpers for the partner app and the admin console.

export const SUPABASE_URL = "https://cjjksssylejwxwbalury.supabase.co";
export const ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNqamtzc3N5bGVqd3h3YmFsdXJ5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg0OTQ4MzEsImV4cCI6MjEwNDA3MDgzMX0.H2PkT7nkoXFDc2vBOM2lRNlih0xDUZyk9Sft1MqRzTI";

export async function sb(path, { method = "GET", body, token, prefer } = {}) {
  const headers = {
    apikey: ANON_KEY,
    Authorization: `Bearer ${token || ANON_KEY}`,
    "Content-Type": "application/json",
  };
  if (prefer) headers["Prefer"] = prefer;
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message = data?.message || data?.msg || data?.error_description || "Something went wrong";
    throw new Error(message);
  }
  return data;
}

const DOCS_BUCKET = "partner-documents";

// Upload a File to the private partner-documents bucket. The storage RLS policy
// requires the first path segment to be the partner's venue_id, so callers must
// pass that. Returns the stored object path (e.g. "<venueId>/gst-172...pdf").
export async function uploadPartnerDocument(token, venueId, file, kind) {
  const ext = (file.name.split(".").pop() || "bin").toLowerCase().replace(/[^a-z0-9]/g, "");
  const objectPath = `${venueId}/${kind}-${Date.now()}.${ext}`;
  const res = await fetch(
    `${SUPABASE_URL}/storage/v1/object/${DOCS_BUCKET}/${encodeURIComponent(objectPath).replace(/%2F/g, "/")}`,
    {
      method: "POST",
      headers: {
        apikey: ANON_KEY,
        Authorization: `Bearer ${token}`,
        "Content-Type": file.type || "application/octet-stream",
        "x-upsert": "true",
      },
      body: file,
    }
  );
  if (!res.ok) {
    const t = await res.text();
    throw new Error(JSON.parse(t || "{}")?.message || "Upload failed");
  }
  return objectPath;
}

// Create a short-lived signed URL for a stored document path. Used by the admin
// console to preview partner-submitted documents.
// NOTE: this needs a storage.objects SELECT policy that allows admin_users to
// read the partner-documents bucket. If that policy is missing this throws and
// the admin UI falls back to showing the raw path. See the report / spec gap.
export async function signedDocumentUrl(token, objectPath, expiresIn = 3600) {
  if (!objectPath) return null;
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${DOCS_BUCKET}/${objectPath}`, {
    method: "POST",
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ expiresIn }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(JSON.parse(t || "{}")?.message || "Could not sign URL");
  }
  const data = await res.json();
  return `${SUPABASE_URL}/storage/v1${data.signedURL}`;
}

export async function signIn(email, password) {
  const data = await sb("/auth/v1/token?grant_type=password", {
    method: "POST",
    body: { email, password },
  });
  return { token: data.access_token, userId: data.user.id, email: data.user.email };
}

// Returns the admin_users row for this user id, or null if they are not an admin.
export async function fetchAdminRow(token, userId) {
  const rows = await sb(`/rest/v1/admin_users?id=eq.${userId}&select=*`, { token });
  return rows[0] || null;
}
