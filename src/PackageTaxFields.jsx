import {
  computeTaxPerHead,
  effectiveAlcoholPercent,
  formatPercent,
  formatRupees,
} from "./tax";

// "Taxes" section of the package form: the includes-taxes / taxes-extra
// choice, the alcohol amount (only when it's needed) and a read-only preview.
// Partners never type tax rates — they come from the tax_rates row for the
// venue's city (`rate`; null when the city has no row).
export default function PackageTaxFields({ form, setForm, rate, rateStatus }) {
  const price = parseFloat(form.price_per_head);
  const validPrice = price > 0;
  const taxesExtra = form.gst_mode === "excluded";
  const rateReady = rateStatus === "ready" && !!rate;
  const noRateForCity = rateStatus === "ready" && !rate;
  const needsAlcohol = taxesExtra && !!form.includes_alcohol;
  const alcoholAmt = parseFloat(form.alcohol_amount_per_head);
  const alcoholValid = !!alcoholAmt && alcoholAmt > 0 && (!validPrice || alcoholAmt <= price);

  const choose = (mode) =>
    setForm({
      ...form,
      gst_mode: mode,
      // Switching back to "includes taxes" clears the alcohol amount.
      alcohol_amount_per_head: mode === "included" ? "" : form.alcohol_amount_per_head,
    });

  const btnClass = (active, disabled) =>
    `text-sm px-3 py-1.5 rounded border ${
      active ? "bg-slate-900 text-white border-slate-900" : "border-stone-300 text-stone-600"
    } ${disabled ? "opacity-50 cursor-not-allowed" : ""}`;

  let preview = null;
  if (taxesExtra && rateReady && validPrice && (!needsAlcohol || alcoholValid)) {
    const t = computeTaxPerHead({
      price,
      alcoholAmount: needsAlcohol ? alcoholAmt : 0,
      rate,
    });
    const vatPct = Number(rate.alcohol_vat_percent);
    const surchargePct = Number(rate.alcohol_surcharge_percent);
    preview = (
      <p className="text-xs text-stone-500 mt-1.5" data-testid="tax-preview">
        Customers will see {formatRupees(price)} + taxes.{" "}
        {t.foodBase > 0 && (
          <>
            Food {formatRupees(t.foodBase)} + {formatPercent(rate.food_gst_percent)}% GST{" "}
            {formatRupees(t.foodGst)}.{" "}
          </>
        )}
        {needsAlcohol &&
          (vatPct === 0 ? (
            <>Alcohol {formatRupees(t.alcoholBase)}. No tax added on alcohol. </>
          ) : surchargePct > 0 ? (
            <>
              Alcohol {formatRupees(t.alcoholBase)} + {formatPercent(effectiveAlcoholPercent(rate))}%
              VAT ({formatPercent(vatPct)}% + {formatPercent(surchargePct)}% surcharge){" "}
              {formatRupees(t.alcoholVat + t.alcoholSurcharge)}.{" "}
            </>
          ) : (
            <>
              Alcohol {formatRupees(t.alcoholBase)} + {formatPercent(vatPct)}% VAT{" "}
              {formatRupees(t.alcoholVat)}.{" "}
            </>
          ))}
        Total {formatRupees(t.totalPerHead)} per person.
      </p>
    );
  }

  // Preview for the includes-taxes mode: the price is shown as-is, no split.
  let includedPreview = null;
  if (!taxesExtra && validPrice) {
    includedPreview = (
      <p className="text-xs text-stone-500 mt-1.5">
        Customers will see {formatRupees(price)} per person. All taxes included.
      </p>
    );
  }

  return (
    <div>
      <label className="text-sm font-medium block mb-1">Taxes</label>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={btnClass(!taxesExtra, false)}
          onClick={() => choose("included")}
        >
          Price includes taxes
        </button>
        <button
          type="button"
          disabled={!rateReady}
          className={btnClass(taxesExtra, !rateReady)}
          onClick={() => choose("excluded")}
        >
          Taxes extra
        </button>
      </div>
      {noRateForCity && (
        <p className="text-xs text-amber-700 mt-1.5">
          Taxes extra isn't available for your city yet. Please contact PAXO support.
        </p>
      )}
      {rateStatus === "error" && (
        <p className="text-xs text-rose-600 mt-1.5">
          Couldn't load tax rates. Please refresh the page.
        </p>
      )}

      {needsAlcohol && (
        <div className="mt-3">
          <label className="text-sm font-medium block mb-1">
            Of this price, how much is for alcohol? (₹ per head)
          </label>
          <input
            type="number"
            min="0"
            step="0.01"
            required
            className="border border-stone-300 rounded px-3 py-2 text-sm w-full max-w-[200px]"
            value={form.alcohol_amount_per_head}
            onChange={(e) => setForm({ ...form, alcohol_amount_per_head: e.target.value })}
          />
          {form.alcohol_amount_per_head !== "" && !alcoholValid && (
            <p className="text-xs text-rose-600 mt-1">
              {alcoholAmt > price
                ? "The alcohol amount can't be more than the price per person."
                : "Enter an amount greater than 0."}
            </p>
          )}
          {form.alcohol_amount_per_head === "" && (
            <p className="text-xs text-stone-400 mt-1">Required when taxes are extra.</p>
          )}
        </div>
      )}

      {taxesExtra ? preview : includedPreview}
      <p className="text-xs text-stone-400 mt-1.5">The venue's final bill is the tax invoice.</p>
    </div>
  );
}
