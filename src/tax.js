// Shared "taxes extra" helpers (package-pricing-and-tax-policy-v1).
// Pure functions, no React / network. The customer app carries an identical
// copy of this file — keep the two in sync.

// Round half up to 2 decimals. Only for display/saving — never round in
// between steps of a calculation.
export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Rate row lookup by venue city: exact match, case-insensitive. Returns null
// when the city has no row (e.g. Punjab, Dehradun).
export function findTaxRate(rates, city) {
  const key = String(city || "").trim().toLowerCase();
  if (!key || !Array.isArray(rates)) return null;
  return rates.find((r) => String(r.city || "").trim().toLowerCase() === key) || null;
}

// Per-person tax breakdown. The alcohol surcharge is a percentage of the VAT
// amount (never added to the VAT percent), so Gurugram's 18 + 5 is 18.9%.
// `discountPercent` (default 0) is the package discount: tax is charged on the
// price the customer actually pays, so both the price and the alcohol amount
// are reduced by the same percentage before any tax is worked out.
// Values are unrounded; round with round2 when displaying or saving.
export function computeTaxPerHead({ price, alcoholAmount, rate, discountPercent = 0 }) {
  const factor = 1 - (Number(discountPercent) || 0) / 100;
  const effectivePrice = (Number(price) || 0) * factor;
  const effectiveAlcohol = (Number(alcoholAmount) || 0) * factor;
  const foodBase = effectivePrice - effectiveAlcohol;
  const foodGst = (foodBase * Number(rate.food_gst_percent)) / 100;
  const alcoholVat = (effectiveAlcohol * Number(rate.alcohol_vat_percent)) / 100;
  const alcoholSurcharge = (alcoholVat * Number(rate.alcohol_surcharge_percent)) / 100;
  return {
    effectivePrice,
    foodBase,
    foodGst,
    alcoholBase: effectiveAlcohol,
    alcoholVat,
    alcoholSurcharge,
    totalPerHead: effectivePrice + foodGst + alcoholVat + alcoholSurcharge,
  };
}

// How a package's price is shown to customers (package-pricing-and-tax-policy-v1):
//   "included"   -> price includes taxes
//   "extra"      -> taxes extra, all figures known (`t` = per-head breakdown)
//   "applicable" -> taxes extra but the tax can't be worked out yet (alcohol
//                   amount 0, the city's alcohol rate still pending, or no rate
//                   row): show "+ applicable taxes", never a made-up figure
//   "other"      -> non_gst / pending_verification: unchanged
export function packageTaxView(pkg, rates, city) {
  if (!pkg) return { kind: "other" };
  if (pkg.gst_mode === "included") return { kind: "included" };
  if (pkg.gst_mode !== "excluded") return { kind: "other" };
  const rate = findTaxRate(rates, city);
  if (!rate) return { kind: "applicable" };
  const alcoholAmount = pkg.includes_alcohol ? Number(pkg.alcohol_amount_per_head) || 0 : 0;
  if (pkg.includes_alcohol && (alcoholAmount <= 0 || rate.alcohol_status === "pending")) {
    return { kind: "applicable", rate };
  }
  const t = computeTaxPerHead({
    price: pkg.price_per_head,
    alcoholAmount,
    rate,
    discountPercent: pkg.discount_percent,
  });
  return { kind: "extra", rate, t, hasAlcohol: alcoholAmount > 0 };
}

// Whole-booking lines for the booking summary. Mirrors the database trigger
// that stores bookings.package_value / tax_amount / total_amount: each line is
// rounded to paise on its own and the total is the sum of the rounded lines.
// Alcohol VAT and its surcharge are one combined line.
export function computeBookingTax({ price, alcoholAmount = 0, discountPercent = 0, headcount, rate }) {
  const n = Number(headcount) || 0;
  const t = computeTaxPerHead({ price, alcoholAmount, rate, discountPercent });
  const packageTotal = round2(t.effectivePrice * n);
  const gst = round2(t.foodGst * n);
  const vat = round2((t.alcoholVat + t.alcoholSurcharge) * n);
  return { packageTotal, gst, vat, taxTotal: round2(gst + vat), total: round2(packageTotal + gst + vat) };
}

// Effective alcohol tax percent: vat * (1 + surcharge / 100).
export function effectiveAlcoholPercent(rate) {
  return (Number(rate.alcohol_vat_percent) * (100 + Number(rate.alcohol_surcharge_percent))) / 100;
}

// "₹1,130" or "₹1,105.60" — whole rupees get no decimals.
export function formatRupees(n) {
  const v = round2(n);
  return (
    "₹" +
    v.toLocaleString("en-IN", {
      minimumFractionDigits: Number.isInteger(v) ? 0 : 2,
      maximumFractionDigits: 2,
    })
  );
}

// Percent without trailing zeros: 18.9, 25, 5.
export const formatPercent = (n) => String(parseFloat(Number(n).toFixed(2)));

// The alcohol amount that gets saved on venue_packages. Zero unless the
// package is "taxes extra" AND includes alcohol.
export function alcoholAmountToSave({ gst_mode, includes_alcohol, alcohol_amount_per_head }) {
  if (gst_mode !== "excluded" || !includes_alcohol) return 0;
  return round2(parseFloat(alcohol_amount_per_head));
}

// Save-time validation for the tax fields. Returns an error message, or null.
// `rateStatus` is "loading" | "ready" | "error"; `rate` is the city's row or null.
export function validatePackageTax({
  gst_mode,
  includes_alcohol,
  alcohol_amount_per_head,
  price,
  rate,
  rateStatus,
}) {
  if (gst_mode !== "excluded") return null;
  if (rateStatus === "error") {
    return "Couldn't load tax rates. Please refresh and try again.";
  }
  if (rateStatus === "ready" && !rate) {
    return "Taxes extra isn't available for your city yet. Please contact PAXO support.";
  }
  if (includes_alcohol) {
    const amt = parseFloat(alcohol_amount_per_head);
    if (!amt || amt <= 0) {
      return "Enter how much of the price per person is for alcohol — it's needed to work out the taxes.";
    }
    if (amt > price) {
      return "The alcohol amount can't be more than the price per person.";
    }
  }
  return null;
}
