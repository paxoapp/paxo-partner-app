import { useState, useEffect, useCallback } from "react";
import { rpc } from "./supabase";

// Admin-only guest list and invoice list for one party, each with a CSV export. Data comes from admin-only database
// functions. Invoices carry no tax details yet (GST fields stay empty until the CA confirms the layout).

const inr = (n) => "₹" + Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });
const fmtAt = (iso) => (iso ? new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" }) : "");

// CSV with quoted cells; a cell that starts with = + - @ is prefixed so a spreadsheet never runs it as a formula.
export function toCsv(headers, rows) {
  const cell = (v) => {
    let s = v == null ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
    return `"${s.replace(/"/g, '""')}"`;
  };
  return [headers, ...rows].map((r) => r.map(cell).join(",")).join("\r\n");
}
function download(name, csv) {
  const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const slug = (s) => String(s || "party").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export const guestCsv = (guests) =>
  toCsv(["Booker name", "Phone", "Email", "Seats", "Male", "Female", "Amount paid", "Balance due", "Balance status"],
    guests.map((g) => [g.booker_name, g.phone, g.email, g.seats, g.male, g.female, g.amount_paid, g.balance_due, g.balance_status]));
export const invoiceCsv = (inv) =>
  toCsv(["Invoice no", "Status", "Issued at", "Buyer name", "Buyer phone", "Buyer email", "Party", "Venue", "Party date", "Seats", "Male", "Female", "Amount paid",
    "Buyer GSTIN", "Taxable value", "GST rate", "CGST", "SGST", "IGST"],
  inv.map((i) => [i.invoice_no, i.status, fmtAt(i.issued_at), i.buyer_name, i.buyer_phone, i.buyer_email, i.party_title, i.venue_name, i.party_date, i.seats, i.male, i.female, i.amount_paid,
    i.buyer_gstin, i.taxable_value, i.gst_rate, i.cgst, i.sgst, i.igst]));

export default function PartyGuests({ session, party }) {
  const [guests, setGuests] = useState(null);
  const [invoices, setInvoices] = useState(null);
  const [people, setPeople] = useState([]);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      const [g, i, pe] = await Promise.all([
        rpc(session.token, "party_admin_guest_list", { p_party_id: party.id }),
        rpc(session.token, "party_admin_invoices", { p_party_id: party.id }),
        rpc(session.token, "party_admin_guests", { p_party_id: party.id }).catch(() => []),
      ]);
      setPeople(pe || []);
      setGuests(g || []);
      setInvoices(i || []);
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }, [session.token, party.id]);
  useEffect(() => {
    load();
  }, [load, party.status]);

  if (error) return <p className="text-sm text-rose-700 mb-4" data-testid="guests-error">{error}</p>;
  if (!guests) return <p className="text-sm text-slate-500 mb-4">Loading guest list…</p>;
  const seatTotal = guests.reduce((n, g) => n + g.seats, 0);

  return (
    <div className="mb-6" data-testid="party-guests">
      <div className="bg-white border border-slate-200 rounded-lg p-4 mb-4">
        <div className="flex items-center justify-between gap-3 mb-2">
          <p className="text-sm font-medium">Guest list ({guests.length} bookings · {seatTotal} paid seats)</p>
          <button type="button" disabled={!guests.length} onClick={() => download(`guest-list-${slug(party.title)}.csv`, guestCsv(guests))}
            className="bg-slate-900 text-white rounded px-3 py-1.5 text-xs disabled:opacity-50" data-testid="guests-csv">Export CSV</button>
        </div>
        {guests.length === 0 ? (
          <p className="text-sm text-slate-500">No paid guests yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm" data-testid="guest-list-table">
              <thead className="text-xs text-slate-500"><tr><th className="pr-3">Booker</th><th className="pr-3">Phone</th><th className="pr-3">Seats</th><th className="pr-3">M / F</th><th className="pr-3">Paid</th><th>Balance</th></tr></thead>
              <tbody>
                {guests.map((g) => (
                  <tr key={g.booking_id} className="border-t border-slate-200 align-top">
                    <td className="py-2 pr-3">{g.booker_name || "Customer"}</td>
                    <td className="py-2 pr-3">{g.phone || "—"}</td>
                    <td className="py-2 pr-3">{g.seats}</td>
                    <td className="py-2 pr-3">{g.male} / {g.female}</td>
                    <td className="py-2 pr-3">{inr(g.amount_paid)}</td>
                    <td className="py-2">{g.balance_status}{Number(g.balance_due) > 0 ? <p className="text-xs text-slate-500">{inr(g.balance_due)} due{g.balance_due_by ? ` by ${fmtAt(g.balance_due_by)}` : ""}</p> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="bg-white border border-slate-200 rounded-lg p-4 mb-4">
        <div className="flex items-center justify-between gap-3 mb-2">
          <p className="text-sm font-medium">Every guest ({people.length})</p>
          <button type="button" disabled={!people.length} onClick={() => download(`every-guest-${slug(party.title)}.csv`, toCsv(["Guest name", "Age", "Gender", "Booked by", "Booker phone"], people.map((p) => [p.guest_name, p.guest_age, p.gender, p.booker_name, p.booker_phone])))}
            className="bg-slate-900 text-white rounded px-3 py-1.5 text-xs disabled:opacity-50" data-testid="people-csv">Export CSV</button>
        </div>
        {people.length === 0 ? (
          <p className="text-sm text-slate-500">No guest names yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm" data-testid="people-table">
              <thead className="text-xs text-slate-500"><tr><th className="pr-3">Name</th><th className="pr-3">Age</th><th className="pr-3">Gender</th><th>Booked by</th></tr></thead>
              <tbody>
                {people.map((p, i) => (
                  <tr key={i} className="border-t border-slate-200">
                    <td className="py-1.5 pr-3">{p.guest_name || "—"}</td>
                    <td className="py-1.5 pr-3">{p.guest_age ?? "—"}</td>
                    <td className="py-1.5 pr-3 capitalize">{p.gender}</td>
                    <td className="py-1.5">{p.booker_name || "Customer"} <span className="text-xs text-slate-500">{p.booker_phone || ""}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="bg-white border border-slate-200 rounded-lg p-4">
        <div className="flex items-center justify-between gap-3 mb-2">
          <p className="text-sm font-medium">Invoices ({invoices.length})</p>
          <button type="button" disabled={!invoices.length} onClick={() => download(`invoices-${slug(party.title)}.csv`, invoiceCsv(invoices))}
            className="bg-slate-900 text-white rounded px-3 py-1.5 text-xs disabled:opacity-50" data-testid="invoices-csv">Export CSV</button>
        </div>
        <p className="text-xs text-slate-500 mb-2">Created when a booking is fully paid. GST details and layout are pending, so the tax columns are empty.</p>
        {invoices.length === 0 ? (
          <p className="text-sm text-slate-500">No invoices yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm" data-testid="invoice-table">
              <thead className="text-xs text-slate-500"><tr><th className="pr-3">No.</th><th className="pr-3">Buyer</th><th className="pr-3">Seats</th><th className="pr-3">Amount</th><th className="pr-3">Issued</th><th>Status</th></tr></thead>
              <tbody>
                {invoices.map((i) => (
                  <tr key={i.id} className="border-t border-slate-200">
                    <td className="py-2 pr-3 font-mono text-xs">{i.invoice_no}</td>
                    <td className="py-2 pr-3">{i.buyer_name || "Customer"}<p className="text-xs text-slate-500">{i.buyer_phone || ""} {i.buyer_email || ""}</p></td>
                    <td className="py-2 pr-3">{i.seats}</td>
                    <td className="py-2 pr-3">{inr(i.amount_paid)}</td>
                    <td className="py-2 pr-3">{fmtAt(i.issued_at)}</td>
                    <td className="py-2">{i.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
