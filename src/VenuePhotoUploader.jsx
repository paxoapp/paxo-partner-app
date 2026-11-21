import { useState, useRef } from "react";
import { sb, uploadVenuePhoto } from "./supabase";

// Multi-photo upload for the partner Profile → Venue Photos (also what PAXO uses for a managed venue, signed in
// with the managed login). Same bucket, file naming and venue_images insert as the old single-photo upload.
// Each selected file gets its sort_order up front, in selection order and after every photo already there (and
// after any still uploading), so uploads can finish in any order and the cover photo never changes.

const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];
const ALLOWED_EXTS = ["jpg", "jpeg", "png", "webp"];
const MAX_BYTES = 5 * 1024 * 1024;
const PARALLEL = 3;

function rejectReason(file) {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  const typeOk = file.type ? ALLOWED_TYPES.includes(file.type) : ALLOWED_EXTS.includes(ext);
  if (!typeOk) return "only JPG, PNG or WEBP are allowed";
  if (file.size > MAX_BYTES) return `larger than 5 MB (${(file.size / 1024 / 1024).toFixed(1)} MB)`;
  return null;
}

let nextKey = 0;

export default function VenuePhotoUploader({ token, venueId, photos, limit, onUploaded }) {
  // itemsRef is the source of truth so the upload pump never reads stale state; `items` mirrors it for rendering.
  const itemsRef = useRef([]);
  const [items, setItems] = useState([]);
  const [rejected, setRejected] = useState([]);
  const [dragOver, setDragOver] = useState(false);
  const reservedSortRef = useRef(-1);

  function update(fn) {
    itemsRef.current = fn(itemsRef.current);
    setItems(itemsRef.current);
  }
  const patch = (key, changes) => update((list) => list.map((it) => (it.key === key ? { ...it, ...changes } : it)));

  // Slots held by this session's files: queued, uploading, failed (can be retried), and done-but-not-yet-reloaded.
  function slotsLeftFor(list) {
    const savedUrls = new Set(photos.map((p) => p.image_url));
    const pending = list.filter((it) => it.status !== "done" || !savedUrls.has(it.imageUrl)).length;
    return Math.max(0, limit - photos.length - pending);
  }
  const slotsLeft = slotsLeftFor(items);
  const busy = items.some((it) => it.status === "waiting" || it.status === "uploading");

  async function run(item) {
    try {
      let imageUrl = item.imageUrl;
      if (!imageUrl) {
        imageUrl = await uploadVenuePhoto(token, venueId, item.file, (p) => patch(item.key, { progress: p }));
        // Remember the stored file so a retry after a failed row insert does not upload it twice.
        patch(item.key, { imageUrl, progress: 1 });
      }
      await sb("/rest/v1/venue_images", {
        method: "POST",
        token,
        prefer: "return=minimal",
        body: { venue_id: venueId, image_url: imageUrl, sort_order: item.sortOrder },
      });
      patch(item.key, { status: "done" });
      onUploaded();
    } catch (e) {
      patch(item.key, { status: "failed", error: e.message || "Upload failed" });
    } finally {
      pump();
    }
  }

  // Start waiting files, in selection order, until PARALLEL are uploading.
  function pump() {
    let active = itemsRef.current.filter((it) => it.status === "uploading").length;
    for (const it of itemsRef.current) {
      if (active >= PARALLEL) break;
      if (it.status !== "waiting") continue;
      active += 1;
      patch(it.key, { status: "uploading", progress: 0, error: "" });
      run(it);
    }
  }

  function addFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const messages = [];
    const valid = [];
    for (const file of files) {
      const reason = rejectReason(file);
      if (reason) messages.push(`${file.name}: ${reason}`);
      else valid.push(file);
    }
    const room = slotsLeftFor(itemsRef.current);
    const accepted = valid.slice(0, room);
    for (const file of valid.slice(room)) {
      messages.push(`${file.name}: skipped — a venue can have up to ${limit} photos`);
    }
    const maxExisting = photos.reduce((m, p) => Math.max(m, p.sort_order ?? 0), -1);
    let sort = Math.max(maxExisting, reservedSortRef.current);
    const fresh = accepted.map((file) => {
      sort += 1;
      return { key: ++nextKey, file, name: file.name, status: "waiting", progress: 0, error: "", sortOrder: sort, imageUrl: null };
    });
    reservedSortRef.current = sort;
    setRejected(messages);
    // A new selection clears finished rows from the last one; failed rows stay until retried or dismissed.
    update((list) => [...list.filter((it) => it.status !== "done"), ...fresh]);
    pump();
  }

  function retry(key) {
    patch(key, { status: "waiting", error: "" });
    pump();
  }

  const disabled = slotsLeft === 0;

  return (
    <div>
      <label
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (!disabled) addFiles(e.dataTransfer.files);
        }}
        className={`flex flex-col items-center justify-center gap-1 text-center rounded-lg border-2 border-dashed px-4 py-5 ${
          disabled
            ? "border-stone-200 bg-stone-50 text-stone-400 cursor-not-allowed"
            : dragOver
            ? "border-accent bg-amber-50 cursor-pointer"
            : "border-stone-300 hover:border-accent cursor-pointer"
        }`}
        data-testid="venue-photo-dropzone"
      >
        <span
          className={`text-sm font-medium px-4 py-2 rounded ${disabled ? "bg-stone-100 text-stone-400" : "bg-accent text-[#170D0B]"}`}
        >
          {busy ? "Add more photos" : "Add photos"}
        </span>
        <span className="text-xs text-stone-500">
          {disabled
            ? `This venue has the maximum of ${limit} photos.`
            : `Select several at once, or drop them here. JPG, PNG or WEBP, up to 5 MB each. ${slotsLeft} more allowed.`}
        </span>
        <input
          type="file"
          multiple
          accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
          className="hidden"
          disabled={disabled}
          data-testid="venue-photo-input"
          onChange={(e) => {
            const files = e.target.files;
            addFiles(files);
            e.target.value = "";
          }}
        />
      </label>

      {rejected.length > 0 && (
        <ul className="mt-3 text-sm text-rose-600 space-y-0.5" data-testid="venue-photo-rejected">
          {rejected.map((m, i) => (
            <li key={i}>{m}</li>
          ))}
        </ul>
      )}

      {items.length > 0 && (
        <ul className="mt-3 flex flex-col gap-2" data-testid="venue-photo-queue">
          {items.map((it) => (
            <li key={it.key} className="border border-stone-200 rounded px-3 py-2 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate min-w-0">{it.name}</span>
                <span className="shrink-0 flex items-center gap-2">
                  {it.status === "waiting" && <span className="text-stone-400 text-xs">Waiting</span>}
                  {it.status === "uploading" && <span className="text-stone-500 text-xs">Uploading {Math.round(it.progress * 100)}%</span>}
                  {it.status === "done" && <span className="text-emerald-700 text-xs font-medium">Done</span>}
                  {it.status === "failed" && (
                    <>
                      <span className="text-rose-600 text-xs font-medium">Failed</span>
                      <button type="button" onClick={() => retry(it.key)} className="text-xs border border-stone-300 rounded px-2 py-0.5 hover:bg-stone-50">
                        Retry
                      </button>
                      <button
                        type="button"
                        onClick={() => update((list) => list.filter((x) => x.key !== it.key))}
                        className="text-xs text-stone-400 hover:text-stone-600"
                        aria-label={`Dismiss ${it.name}`}
                      >
                        ×
                      </button>
                    </>
                  )}
                </span>
              </div>
              {it.status === "uploading" && (
                <div className="mt-1.5 h-1.5 bg-stone-100 rounded overflow-hidden">
                  <div className="h-full bg-accent transition-[width]" style={{ width: `${Math.round(it.progress * 100)}%` }} />
                </div>
              )}
              {it.status === "failed" && it.error && <p className="text-rose-600 text-xs mt-1">{it.error}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
