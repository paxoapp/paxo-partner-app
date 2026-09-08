// Onboarding progress stepper, shared by the partner status screen (dark) and
// the admin venue-detail panel (light).
//
// Steps: 1 Submitted · 2 Basic Info Review · 3 Document Verification · 4 Approved
//
// Rejection freezes the stepper at the step where the rejection happened, using
// venues.stage1_cleared_at (set once, permanently, when an admin approves the
// submitted -> under_review transition):
//   - stage1_cleared_at IS NULL  -> rejected during Basic Info Review  -> freeze at step 2
//   - stage1_cleared_at NOT NULL -> rejected during Document Verification -> freeze at step 3

const STEPS = ["Submitted", "Basic Info Review", "Document Verification", "Approved"];

export function getStepState(venue) {
  const status = venue?.status;
  const clearedStage1 = !!venue?.stage1_cleared_at;
  if (status === "approved") return { active: null, rejectedAt: null, complete: true };
  if (status === "under_review") return { active: 3, rejectedAt: null, complete: false };
  if (status === "rejected") return { active: null, rejectedAt: clearedStage1 ? 3 : 2, complete: false };
  // "submitted" (or any unknown state) — sitting in Basic Info Review
  return { active: 2, rejectedAt: null, complete: false };
}

function Step({ n, label, state, last, dark }) {
  const p = {
    done: {
      ring: "bg-emerald-500 text-white border-emerald-500",
      text: dark ? "text-emerald-300" : "text-emerald-700",
      line: "bg-emerald-500",
    },
    current: {
      ring: "bg-[#F5A623] text-[#170D0B] border-[#F5A623]",
      text: dark ? "text-[#F5A623]" : "text-[#9A5F0F]",
      line: dark ? "bg-stone-700" : "bg-stone-300",
    },
    pending: {
      ring: dark ? "bg-transparent text-stone-500 border-stone-700" : "bg-white text-stone-400 border-stone-300",
      text: dark ? "text-stone-500" : "text-stone-400",
      line: dark ? "bg-stone-700" : "bg-stone-300",
    },
    rejected: {
      ring: "bg-rose-500 text-white border-rose-500",
      text: dark ? "text-rose-300" : "text-rose-700",
      line: dark ? "bg-stone-700" : "bg-stone-300",
    },
  }[state];

  return (
    <li className="flex-1 flex flex-col items-center">
      <div className="flex items-center w-full">
        <div
          className={`shrink-0 w-7 h-7 rounded-full border flex items-center justify-center text-xs font-semibold ${p.ring}`}
        >
          {state === "done" ? "✓" : state === "rejected" ? "✕" : n}
        </div>
        {!last && <div className={`h-0.5 flex-1 ${p.line}`} />}
      </div>
      <span className={`mt-1.5 text-[11px] text-center leading-tight ${p.text}`}>{label}</span>
      {state === "rejected" && (
        <span className={`text-[10px] font-medium ${dark ? "text-rose-400" : "text-rose-600"}`}>
          Rejected here
        </span>
      )}
    </li>
  );
}

export default function StatusStepper({ venue, dark = false }) {
  const { active, rejectedAt, complete } = getStepState(venue);
  return (
    <ol className="flex items-start">
      {STEPS.map((label, i) => {
        const n = i + 1;
        let state;
        if (rejectedAt != null) {
          state = n < rejectedAt ? "done" : n === rejectedAt ? "rejected" : "pending";
        } else if (complete) {
          state = "done";
        } else {
          state = n < active ? "done" : n === active ? "current" : "pending";
        }
        return <Step key={n} n={n} label={label} state={state} last={n === STEPS.length} dark={dark} />;
      })}
    </ol>
  );
}
