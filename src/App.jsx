import { useState, useEffect, useCallback } from "react";
import { Inbox, CalendarClock, UtensilsCrossed, User, Wallet } from "lucide-react";
import SocialLinks from "./SocialLinks";
import { sb, SUPABASE_URL } from "./supabase";
import { VenueSubmissionForm, VenueStatusScreen } from "./onboarding";
import OtpVerification from "./OtpVerification";

const inr = (n) =>
  Number(n || 0).toLocaleString("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });

function minutesLeft(deadline) {
  const ms = new Date(deadline).getTime() - Date.now();
  return Math.round(ms / 60000);
}

const statusColor = {
  pending: "bg-amber-100 text-amber-800",
  accepted: "bg-blue-100 text-blue-800",
  rejected: "bg-rose-100 text-rose-800",
  confirmed: "bg-emerald-100 text-emerald-800",
  completed: "bg-emerald-100 text-emerald-800",
  cancelled: "bg-rose-100 text-rose-800",
  unconfirmed: "bg-stone-200 text-stone-800",
  no_show: "bg-rose-100 text-rose-800",
};

// A pending request "conflicts" when the venue already has a committed
// (accepted / confirmed) booking on the same calendar date. Same-date is the
// trigger by design — we don't check time-range overlap, and we don't block
// the partner, just make sure they're never surprised. `all` is the venue's
// full booking list (every status), so no venue filter is needed here.
function dateConflicts(booking, all) {
  return all.filter(
    (o) =>
      o.id !== booking.id &&
      o.event_date === booking.event_date &&
      (o.status === "accepted" || o.status === "confirmed")
  );
}

const REJECT_REASONS = [
  "Date not available",
  "Guest count exceeds capacity",
  "Party slot / timing clash",
  "Other",
];

const FOOD_KINDS = ["starter_veg", "starter_non_veg", "main_veg", "main_non_veg", "side", "dessert", "other"];
const BEVERAGE_KINDS = [
  "single_malt",
  "wine",
  "beer",
  "whisky",
  "vodka",
  "rum",
  "gin",
  "classic_cocktails",
  "mocktails",
  "soft_beverages",
];

const NON_ALCOHOLIC_QUOTA_KINDS = ["mocktails", "soft_beverages"];

const FOOD_QUOTA_CATEGORIES = [
  ["starter_veg", "Veg Starters", 3],
  ["starter_non_veg", "Non-Veg Starters", 3],
  ["main_veg", "Veg Main Course", 2],
  ["main_non_veg", "Non-Veg Main Course", 2],
  ["side", "Sides", 1],
  ["dessert", "Desserts", 1],
];

const BEVERAGE_QUOTA_CATEGORIES = [
  ["single_malt", "Single Malts", 1],
  ["wine", "Wine", 1],
  ["beer", "Beer", 1],
  ["whisky", "Whisky", 1],
  ["vodka", "Vodka", 1],
  ["rum", "Rum", 1],
  ["gin", "Gin", 1],
  ["classic_cocktails", "Classic Cocktails", 1],
  ["mocktails", "Mocktails", 1],
  ["soft_beverages", "Soft Beverages", 1],
];

const QUOTA_CATEGORIES = [...FOOD_QUOTA_CATEGORIES, ...BEVERAGE_QUOTA_CATEGORIES];

// Hard-liquor / branded beverage categories that use a structured item pool:
// the partner picks which specific menu_items (brands) back the quota, written
// to package_item_pool. classic_cocktails / mocktails / soft_beverages are NOT
// here — they stay free-flow, described via the Inclusions text field.
const POOL_QUOTA_KINDS = ["single_malt", "wine", "beer", "whisky", "vodka", "rum", "gin"];

// [singular, plural] per quota category kind, for "1 Dessert" vs "2 Desserts".
const QUOTA_LABEL_FORMS = {
  starter_veg: ["Veg Starter", "Veg Starters"],
  starter_non_veg: ["Non-Veg Starter", "Non-Veg Starters"],
  main_veg: ["Veg Main Course", "Veg Main Courses"],
  main_non_veg: ["Non-Veg Main Course", "Non-Veg Main Courses"],
  dessert: ["Dessert", "Desserts"],
  wine: ["Wine", "Wines"],
  beer: ["Beer", "Beers"],
  whisky: ["Whisky", "Whiskies"],
  vodka: ["Vodka", "Vodkas"],
  rum: ["Rum", "Rums"],
  gin: ["Gin", "Gins"],
  classic_cocktails: ["Classic Cocktail", "Classic Cocktails"],
  mocktails: ["Mocktail", "Mocktails"],
  soft_beverages: ["Soft Beverage", "Soft Beverages"],
  single_malt: ["Single Malt", "Single Malts"],
  side: ["Side", "Sides"],
  other: ["Other", "Other"],
};

function quotaLabel(kind, count) {
  const forms = QUOTA_LABEL_FORMS[kind];
  if (!forms) return QUOTA_CATEGORIES.find(([k]) => k === kind)?.[1] || kind;
  return count === 1 ? forms[0] : forms[1];
}

// A booking's finalized menu selections, grouped by category kind, using this
// venue's own menu_categories/menu_items (loaded into `categories`).
function bookingSelectionGroups(booking, categories) {
  const sel = Array.isArray(booking?.booking_menu_selections)
    ? booking.booking_menu_selections
    : booking?.booking_menu_selections
    ? [booking.booking_menu_selections]
    : [];
  const itemById = {};
  const kindByItemId = {};
  (categories || []).forEach((c) =>
    (c.menu_items || []).forEach((it) => {
      itemById[it.id] = it;
      kindByItemId[it.id] = c.kind;
    })
  );
  const groups = {};
  sel.forEach((s) => {
    const kind = kindByItemId[s.menu_item_id] || "other";
    (groups[kind] ||= []).push(itemById[s.menu_item_id]?.name || "Item");
  });
  return Object.entries(groups)
    .map(([kind, names]) => ({ kind, names: names.slice().sort() }))
    .sort((a, b) => a.kind.localeCompare(b.kind));
}

export default function App() {
  const [screen, setScreen] = useState("auth");
  const [session, setSession] = useState(null);
  const [authMode, setAuthMode] = useState("login");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authFullName, setAuthFullName] = useState("");
  const [authPhone, setAuthPhone] = useState("");
  const [approvedVenues, setApprovedVenues] = useState([]);
  const [claimVenueId, setClaimVenueId] = useState("");
  const [authError, setAuthError] = useState("");
  const [authLoading, setAuthLoading] = useState(false);

  const [partnerVenue, setPartnerVenue] = useState(null);
  const [bookings, setBookings] = useState([]);
  const [bookingsLoading, setBookingsLoading] = useState(false);
  const [activeTab, setActiveTab] = useState("pending");
  const [rejectingId, setRejectingId] = useState(null);
  const [rejectReasonOption, setRejectReasonOption] = useState("");
  const [rejectReasonOther, setRejectReasonOther] = useState("");
  const [actionLoading, setActionLoading] = useState(null);
  const [actionError, setActionError] = useState("");
  // Accept-with-conflict flow: { id, conflicts: [...] } while the dialog is open.
  const [acceptDialog, setAcceptDialog] = useState(null);
  const [disclosureNote, setDisclosureNote] = useState("");
  const [checkinInput, setCheckinInput] = useState({}); // keyed by booking id
  const [checkinError, setCheckinError] = useState({}); // keyed by booking id
  const [checkinBusyId, setCheckinBusyId] = useState(null);

  const [claimVenuePending, setClaimVenuePending] = useState(""); // used on the post-Google "claim venue" screen

  const [resetMethod, setResetMethod] = useState("email");
  const [resetStep, setResetStep] = useState("request");
  const [resetEmail, setResetEmail] = useState("");
  const [resetPhone, setResetPhone] = useState("");
  const [resetOtp, setResetOtp] = useState("");
  const [resetNewPassword, setResetNewPassword] = useState("");
  const [resetError, setResetError] = useState("");
  const [resetLoading, setResetLoading] = useState(false);

  const [recoveryToken, setRecoveryToken] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newPasswordConfirm, setNewPasswordConfirm] = useState("");
  const [newPasswordError, setNewPasswordError] = useState("");
  const [newPasswordLoading, setNewPasswordLoading] = useState(false);

  const [menuOpen, setMenuOpen] = useState(false);
  const [profileForm, setProfileForm] = useState({ full_name: "", phone: "" });
  const [venueTerms, setVenueTerms] = useState("");
  const [venueTermsSaved, setVenueTermsSaved] = useState(false);
  const [venueTermsError, setVenueTermsError] = useState("");
  const [venueTermsSaving, setVenueTermsSaving] = useState(false);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileSaved, setProfileSaved] = useState(false);
  const [profileError, setProfileError] = useState("");

  const [settingsPassword, setSettingsPassword] = useState("");
  const [settingsPasswordConfirm, setSettingsPasswordConfirm] = useState("");
  const [settingsError, setSettingsError] = useState("");
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [settingsLoading, setSettingsLoading] = useState(false);

  const [categories, setCategories] = useState([]);
  const [menuLoading, setMenuLoading] = useState(false);
  const [menuSection, setMenuSection] = useState("food"); // 'food' | 'beverage'
  const [newCategoryName, setNewCategoryName] = useState("");
  const [newCategoryKind, setNewCategoryKind] = useState("starter_veg");
  const [newItemName, setNewItemName] = useState({}); // keyed by category_id
  const [newItemDesc, setNewItemDesc] = useState({}); // keyed by category_id
  const [editingItemId, setEditingItemId] = useState(null);
  const [editItemDesc, setEditItemDesc] = useState("");
  const [menuError, setMenuError] = useState("");
  const [menuErrorCat, setMenuErrorCat] = useState(null); // categoryId an add-item error belongs to
  const [openCats, setOpenCats] = useState({}); // { [categoryId]: true } — expanded; collapsed by default
  const [suggestions, setSuggestions] = useState([]); // item_suggestions rows: { category_kind, name }
  const [suggestionPicks, setSuggestionPicks] = useState({}); // { [categoryId]: { [name]: true } }
  const [addingSuggested, setAddingSuggested] = useState(null); // categoryId while bulk-inserting

  const [packages, setPackages] = useState([]);
  const [packagesLoading, setPackagesLoading] = useState(false);
  const [showPackageForm, setShowPackageForm] = useState(false);
  const [editingPackageId, setEditingPackageId] = useState(null);
  const [packageForm, setPackageForm] = useState(null);
  const [packageError, setPackageError] = useState("");
  const [packageSaving, setPackageSaving] = useState(false);

  const CATEGORY_KINDS = [
    ["starter_veg", "Starters (veg)"],
    ["starter_non_veg", "Starters (non-veg)"],
    ["main_veg", "Mains (veg)"],
    ["main_non_veg", "Mains (non-veg)"],
    ["side", "Side"],
    ["dessert", "Dessert"],
    ["wine", "Wine"],
    ["beer", "Beer"],
    ["whisky", "Whisky"],
    ["single_malt", "Single Malt"],
    ["vodka", "Vodka"],
    ["rum", "Rum"],
    ["gin", "Gin"],
    ["classic_cocktails", "Classic Cocktails"],
    ["mocktails", "Mocktails"],
    ["soft_beverages", "Soft Beverages"],
    ["other", "Other"],
  ];

  // This venue's menu items for a given category kind (e.g. all "beer" items),
  // across however many categories of that kind the venue has created.
  const itemsForKind = (kind) =>
    categories
      .filter((c) => c.kind === kind)
      .flatMap((c) => c.menu_items || [])
      .sort((a, b) => a.name.localeCompare(b.name));

  const menuItemById = {};
  categories.forEach((c) =>
    (c.menu_items || []).forEach((it) => {
      menuItemById[it.id] = { ...it, kind: c.kind };
    })
  );

  const loadMenu = useCallback(async (token, venueId) => {
    setMenuLoading(true);
    try {
      const cats = await sb(
        `/rest/v1/menu_categories?venue_id=eq.${venueId}&select=*,menu_items(*)&order=sort_order.asc`,
        { token }
      );
      setCategories(cats);
    } catch (e) {
      console.error(e);
    } finally {
      setMenuLoading(false);
    }
  }, []);

  useEffect(() => {
    if (screen === "menu" && session && partnerVenue?.venue_id) {
      loadMenu(session.token, partnerVenue.venue_id);
      // Curated reference list of common brands/dishes per category_kind. Small
      // table, read-only for partners — load once per visit.
      if (suggestions.length === 0) {
        sb("/rest/v1/item_suggestions?select=category_kind,name", { token: session.token })
          .then(setSuggestions)
          .catch(() => {});
      }
    }
  }, [screen, session, partnerVenue, loadMenu, suggestions.length]);

  async function addCategory(e) {
    e.preventDefault();
    setMenuError("");
    if (!newCategoryName.trim()) {
      setMenuError("Enter a category name.");
      return;
    }
    try {
      await sb("/rest/v1/menu_categories", {
        method: "POST",
        token: session.token,
        prefer: "return=minimal",
        body: {
          venue_id: partnerVenue.venue_id,
          name: newCategoryName.trim(),
          kind: newCategoryKind,
          sort_order: categories.length,
        },
      });
      setNewCategoryName("");
      await loadMenu(session.token, partnerVenue.venue_id);
    } catch (e) {
      setMenuError(e.message);
    }
  }

  async function deleteCategory(id) {
    try {
      await sb(`/rest/v1/menu_categories?id=eq.${id}`, { method: "DELETE", token: session.token, prefer: "return=minimal" });
      await loadMenu(session.token, partnerVenue.venue_id);
    } catch (e) {
      setMenuError(e.message);
    }
  }

  async function addItem(categoryId) {
    const name = (newItemName[categoryId] || "").trim();
    setMenuError("");
    setMenuErrorCat(null);
    if (!name) {
      setMenuError("Enter an item name first.");
      setMenuErrorCat(categoryId);
      return;
    }
    const description = (newItemDesc[categoryId] || "").trim() || null;
    try {
      await sb("/rest/v1/menu_items", {
        method: "POST",
        token: session.token,
        prefer: "return=minimal",
        body: { venue_id: partnerVenue.venue_id, category_id: categoryId, name, description },
      });
      setNewItemName({ ...newItemName, [categoryId]: "" });
      setNewItemDesc({ ...newItemDesc, [categoryId]: "" });
      setMenuError("");
      setMenuErrorCat(null);
      await loadMenu(session.token, partnerVenue.venue_id);
    } catch (e) {
      setMenuError(e.message);
      setMenuErrorCat(categoryId);
    }
  }

  // Suggestions for one category: everything seeded for its kind, minus names
  // this category already has (case-insensitive), sorted alphabetically.
  function suggestionsFor(cat) {
    const have = new Set((cat.menu_items || []).map((i) => i.name.trim().toLowerCase()));
    return suggestions
      .filter((s) => s.category_kind === cat.kind && !have.has(s.name.trim().toLowerCase()))
      .map((s) => s.name)
      .sort((a, b) => a.localeCompare(b));
  }

  const toggleSuggestionPick = (categoryId, name) =>
    setSuggestionPicks((m) => ({
      ...m,
      [categoryId]: { ...(m[categoryId] || {}), [name]: !m[categoryId]?.[name] },
    }));

  // Insert every checked suggestion for a category in one request.
  async function addSuggestedItems(categoryId) {
    const picks = suggestionPicks[categoryId] || {};
    const names = Object.keys(picks).filter((n) => picks[n]);
    if (names.length === 0) return;
    setMenuError("");
    setMenuErrorCat(null);
    setAddingSuggested(categoryId);
    try {
      await sb("/rest/v1/menu_items", {
        method: "POST",
        token: session.token,
        prefer: "return=minimal",
        body: names.map((name) => ({
          venue_id: partnerVenue.venue_id,
          category_id: categoryId,
          name,
        })),
      });
      setSuggestionPicks((m) => ({ ...m, [categoryId]: {} }));
      await loadMenu(session.token, partnerVenue.venue_id);
    } catch (e) {
      setMenuError(e.message);
      setMenuErrorCat(categoryId);
    } finally {
      setAddingSuggested(null);
    }
  }

  async function toggleItemAvailable(item) {
    try {
      await sb(`/rest/v1/menu_items?id=eq.${item.id}`, {
        method: "PATCH",
        token: session.token,
        prefer: "return=minimal",
        body: { is_available: !item.is_available },
      });
      await loadMenu(session.token, partnerVenue.venue_id);
    } catch (e) {
      setMenuError(e.message);
    }
  }

  async function deleteItem(id) {
    try {
      await sb(`/rest/v1/menu_items?id=eq.${id}`, { method: "DELETE", token: session.token, prefer: "return=minimal" });
      await loadMenu(session.token, partnerVenue.venue_id);
    } catch (e) {
      setMenuError(e.message);
    }
  }

  function startEditItemDesc(item) {
    setEditingItemId(item.id);
    setEditItemDesc(item.description || "");
  }

  async function saveItemDescription(id) {
    setMenuError("");
    try {
      await sb(`/rest/v1/menu_items?id=eq.${id}`, {
        method: "PATCH",
        token: session.token,
        prefer: "return=minimal",
        body: { description: editItemDesc.trim() || null },
      });
      setEditingItemId(null);
      setEditItemDesc("");
      await loadMenu(session.token, partnerVenue.venue_id);
    } catch (e) {
      setMenuError(e.message);
    }
  }

  async function markNoShow(id) {
    setActionError("");
    setActionLoading(id);
    try {
      await sb(`/rest/v1/bookings?id=eq.${id}`, {
        method: "PATCH",
        token: session.token,
        prefer: "return=minimal",
        body: { status: "no_show" },
      });
      await loadBookings(session.token, partnerVenue.venue_id);
    } catch (e) {
      setActionError(e.message);
    } finally {
      setActionLoading(null);
    }
  }

  // confirmed -> completed. The DB rejects this before the event has passed
  // ("Cannot mark an event completed before it has happened."); surface that.
  async function markCompleted(id) {
    setActionError("");
    setActionLoading(id);
    try {
      await sb(`/rest/v1/bookings?id=eq.${id}`, {
        method: "PATCH",
        token: session.token,
        prefer: "return=minimal",
        body: { status: "completed" },
      });
      await loadBookings(session.token, partnerVenue.venue_id);
    } catch (e) {
      setActionError(e.message);
    } finally {
      setActionLoading(null);
    }
  }

  // Partner enters the code the customer shows on arrival. Matched client-side;
  // on success the base table's event_started_at is stamped (partners are a
  // trusted caller for that column).
  async function confirmEventStarted(booking) {
    const entered = (checkinInput[booking.id] || "").trim();
    setCheckinError((m) => ({ ...m, [booking.id]: "" }));
    if (!entered || entered !== String(booking.checkin_otp || "")) {
      setCheckinError((m) => ({ ...m, [booking.id]: "Incorrect code, please try again." }));
      return;
    }
    setCheckinBusyId(booking.id);
    try {
      await sb(`/rest/v1/bookings?id=eq.${booking.id}`, {
        method: "PATCH",
        token: session.token,
        prefer: "return=minimal",
        body: { event_started_at: new Date().toISOString() },
      });
      setCheckinInput((m) => ({ ...m, [booking.id]: "" }));
      await loadBookings(session.token, partnerVenue.venue_id);
    } catch (e) {
      setCheckinError((m) => ({ ...m, [booking.id]: e.message || "Couldn't confirm. Please try again." }));
    } finally {
      setCheckinBusyId(null);
    }
  }

  useEffect(() => {
    if (screen === "auth" && authMode === "signup") {
      sb("/rest/v1/venues?select=id,name,city&status=eq.approved&order=name.asc")
        .then(setApprovedVenues)
        .catch(() => {});
    }
  }, [screen, authMode]);

  const loadPartnerVenue = useCallback(async (token, userId) => {
    const [row] = await sb(
      `/rest/v1/partner_users?id=eq.${userId}&select=*,venues(*)`,
      { token }
    );
    setPartnerVenue(row || null);
    return row || null;
  }, []);

  const refreshVenue = useCallback(async () => {
    if (session?.token && session?.userId) {
      return loadPartnerVenue(session.token, session.userId);
    }
  }, [session, loadPartnerVenue]);

  const loadBookings = useCallback(async (token, venueId) => {
    setBookingsLoading(true);
    try {
      const [data, pkgs, types, extra] = await Promise.all([
        sb(`/rest/v1/partner_bookings_view?venue_id=eq.${venueId}&order=requested_at.desc`, { token }),
        sb(`/rest/v1/venue_packages?venue_id=eq.${venueId}&select=id,name,price_per_head`, { token }),
        sb(`/rest/v1/booking_types?select=id,name`, { token }),
        // The partner view doesn't carry these; the base table does (RLS allows it).
        sb(
          `/rest/v1/bookings?venue_id=eq.${venueId}&select=id,booking_ref,checkin_otp,event_started_at,menu_finalized_at,cancellation_reason,cancelled_at,booking_menu_selections(menu_item_id)`,
          { token }
        ),
      ]);
      const pkgById = Object.fromEntries(pkgs.map((p) => [p.id, p]));
      const typeById = Object.fromEntries(types.map((t) => [t.id, t]));
      const extraById = Object.fromEntries((extra || []).map((r) => [r.id, r]));
      setBookings(
        data.map((b) => ({
          ...b,
          ...(extraById[b.id] || {}),
          venue_packages: pkgById[b.package_id] || null,
          booking_types: typeById[b.booking_type_id] || null,
        }))
      );
    } catch (e) {
      console.error(e);
    } finally {
      setBookingsLoading(false);
    }
  }, []);

  const loadPackages = useCallback(async (token, venueId) => {
    setPackagesLoading(true);
    try {
      const data = await sb(
        `/rest/v1/venue_packages?venue_id=eq.${venueId}&select=*,menu_quota_rules(*),package_item_pool(menu_item_id)&order=price_per_head.asc`,
        { token }
      );
      setPackages(data);
    } catch (e) {
      console.error(e);
    } finally {
      setPackagesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (partnerVenue) {
      setProfileForm({ full_name: partnerVenue.full_name || "", phone: partnerVenue.phone || "" });
      setVenueTerms(partnerVenue.venues?.terms_and_conditions || "");
    }
  }, [partnerVenue]);

  useEffect(() => {
    if (
      ["dashboard", "payments", "upcoming"].includes(screen) &&
      session &&
      partnerVenue?.venue_id
    ) {
      loadBookings(session.token, partnerVenue.venue_id);
      // Upcoming shows each finalized booking's menu, grouped by category.
      if (screen === "upcoming") loadMenu(session.token, partnerVenue.venue_id);
    }
  }, [screen, session, partnerVenue, loadBookings, loadMenu]);

  useEffect(() => {
    if (screen === "packages" && session && partnerVenue?.venue_id) {
      loadPackages(session.token, partnerVenue.venue_id);
      // Menu items back the package builder's brand-pool pickers.
      loadMenu(session.token, partnerVenue.venue_id);
    }
  }, [screen, session, partnerVenue, loadPackages, loadMenu]);

  // Establish the app's auth state from a real session, then route. Nothing that
  // writes to the DB (e.g. the Stage 1 venue INSERT) is reachable until this has
  // run, so auth.uid() is always populated by the time those requests fire.
  const enterSession = useCallback(
    async (token, user) => {
      const venueRow = await loadPartnerVenue(token, user.id);
      setSession({ token, userId: user.id, email: user.email });
      setScreen(venueRow ? "dashboard" : "submitVenue");
    },
    [loadPartnerVenue]
  );

  async function handleAuth(e) {
    e.preventDefault();
    setAuthError("");
    setAuthLoading(true);
    try {
      if (authMode === "signup") {
        // Inspect the signup result explicitly — never assume a session exists
        // just because it didn't error.
        const res = await sb("/auth/v1/signup", {
          method: "POST",
          body: { email: authEmail, password: authPassword },
        });
        if (res.access_token) {
          // "Confirm email" is OFF: the account is already active. Straight to
          // the Stage 1 venue form — no OTP screen while the project is in this
          // mode (keeps local testing frictionless).
          await enterSession(res.access_token, res.user);
        } else {
          // "Confirm email" is ON: user must verify a 6-digit code first. No
          // session, no navigation to the venue form, no DB writes yet.
          setScreen("otp");
        }
        return;
      }

      // Returning-user login — unchanged.
      const data = await sb("/auth/v1/token?grant_type=password", {
        method: "POST",
        body: { email: authEmail, password: authPassword },
      });
      await enterSession(data.access_token, data.user);
    } catch (e) {
      setAuthError(e.message);
    } finally {
      setAuthLoading(false);
    }
  }

  function logOut() {
    setSession(null);
    setPartnerVenue(null);
    setBookings([]);
    setMenuOpen(false);
    setScreen("auth");
  }

  // Handle the redirect back from Google. Distinguish a password-recovery link
  // (type=recovery) from a normal OAuth login, and for a normal login check whether
  // this user already has a venue linked — first-time Google partners need to claim one.
  useEffect(() => {
    if (!window.location.hash.includes("access_token")) return;
    const params = new URLSearchParams(window.location.hash.slice(1));
    const token = params.get("access_token");
    const type = params.get("type");
    if (!token) return;
    if (type === "recovery") {
      setRecoveryToken(token);
      setScreen("setNewPassword");
      window.history.replaceState(null, "", window.location.pathname);
      return;
    }
    (async () => {
      try {
        const user = await sb("/auth/v1/user", { token });
        setSession({ token, userId: user.id, email: user.email });
        const venueRow = await loadPartnerVenue(token, user.id);
        window.history.replaceState(null, "", window.location.pathname);
        setScreen(venueRow ? "dashboard" : "submitVenue");
      } catch (e) {
        setAuthError(e.message);
      }
    })();
  }, [loadPartnerVenue]);

  function handleGoogleSignIn() {
    if (window.self !== window.top) {
      setAuthError(
        "Google sign-in can't complete inside this preview — it needs to run on the app's real deployed URL. Use email sign-in here for now."
      );
      return;
    }
    const redirectTo = window.location.href.split("#")[0];
    window.location.href = `${SUPABASE_URL}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(
      redirectTo
    )}`;
  }

  async function claimVenue(e) {
    e.preventDefault();
    setAuthError("");
    if (!claimVenuePending) {
      setAuthError("Select the venue you manage.");
      return;
    }
    setAuthLoading(true);
    try {
      await sb("/rest/v1/partner_users", {
        method: "POST",
        token: session.token,
        prefer: "return=minimal",
        body: { id: session.userId, venue_id: claimVenuePending },
      });
      await loadPartnerVenue(session.token, session.userId);
      setScreen("dashboard");
    } catch (e) {
      setAuthError(e.message);
    } finally {
      setAuthLoading(false);
    }
  }

  async function requestEmailReset(e) {
    e.preventDefault();
    setResetError("");
    setResetLoading(true);
    try {
      const redirectTo = window.location.href.split("#")[0];
      await sb(`/auth/v1/recover?redirect_to=${encodeURIComponent(redirectTo)}`, {
        method: "POST",
        body: { email: resetEmail },
      });
      setResetStep("sent");
    } catch (e) {
      setResetError(e.message);
    } finally {
      setResetLoading(false);
    }
  }

  async function requestPhoneOtp(e) {
    e.preventDefault();
    setResetError("");
    setResetLoading(true);
    try {
      await sb("/auth/v1/otp", { method: "POST", body: { phone: resetPhone } });
      setResetStep("verify");
    } catch (e) {
      setResetError(e.message);
    } finally {
      setResetLoading(false);
    }
  }

  async function verifyPhoneOtpAndReset(e) {
    e.preventDefault();
    setResetError("");
    if (resetNewPassword.length < 6) {
      setResetError("Password must be at least 6 characters.");
      return;
    }
    setResetLoading(true);
    try {
      const verifyData = await sb("/auth/v1/verify", {
        method: "POST",
        body: { type: "sms", phone: resetPhone, token: resetOtp },
      });
      await sb("/auth/v1/user", {
        method: "PUT",
        token: verifyData.access_token,
        body: { password: resetNewPassword },
      });
      setSession({ token: verifyData.access_token, userId: verifyData.user.id, email: verifyData.user.email });
      const venueRow = await loadPartnerVenue(verifyData.access_token, verifyData.user.id);
      setScreen(venueRow ? "dashboard" : "submitVenue");
    } catch (e) {
      setResetError(e.message);
    } finally {
      setResetLoading(false);
    }
  }

  async function submitNewPassword(e) {
    e.preventDefault();
    setNewPasswordError("");
    if (newPassword.length < 6) {
      setNewPasswordError("Password must be at least 6 characters.");
      return;
    }
    if (newPassword !== newPasswordConfirm) {
      setNewPasswordError("Passwords don't match.");
      return;
    }
    setNewPasswordLoading(true);
    try {
      const user = await sb("/auth/v1/user", {
        method: "PUT",
        token: recoveryToken,
        body: { password: newPassword },
      });
      setSession({ token: recoveryToken, userId: user.id, email: user.email });
      const venueRow = await loadPartnerVenue(recoveryToken, user.id);
      setScreen(venueRow ? "dashboard" : "submitVenue");
    } catch (e) {
      setNewPasswordError(e.message);
    } finally {
      setNewPasswordLoading(false);
    }
  }

  async function saveProfile(e) {
    e.preventDefault();
    setProfileError("");
    setProfileSaved(false);
    setProfileLoading(true);
    try {
      await sb(`/rest/v1/partner_users?id=eq.${session.userId}`, {
        method: "PATCH",
        token: session.token,
        prefer: "return=minimal",
        body: { full_name: profileForm.full_name, phone: profileForm.phone },
      });
      setProfileSaved(true);
    } catch (e) {
      setProfileError(e.message);
    } finally {
      setProfileLoading(false);
    }
  }

  async function saveVenueTerms(e) {
    e.preventDefault();
    setVenueTermsError("");
    setVenueTermsSaved(false);
    setVenueTermsSaving(true);
    try {
      await sb(`/rest/v1/venues?id=eq.${partnerVenue.venue_id}`, {
        method: "PATCH",
        token: session.token,
        prefer: "return=minimal",
        body: { terms_and_conditions: venueTerms.trim() || null },
      });
      await refreshVenue();
      setVenueTermsSaved(true);
    } catch (e) {
      setVenueTermsError(e.message);
    } finally {
      setVenueTermsSaving(false);
    }
  }

  async function changePassword(e) {
    e.preventDefault();
    setSettingsError("");
    setSettingsSaved(false);
    if (settingsPassword.length < 6) {
      setSettingsError("Password must be at least 6 characters.");
      return;
    }
    if (settingsPassword !== settingsPasswordConfirm) {
      setSettingsError("Passwords don't match.");
      return;
    }
    setSettingsLoading(true);
    try {
      await sb("/auth/v1/user", {
        method: "PUT",
        token: session.token,
        body: { password: settingsPassword },
      });
      setSettingsSaved(true);
      setSettingsPassword("");
      setSettingsPasswordConfirm("");
    } catch (e) {
      setSettingsError(e.message);
    } finally {
      setSettingsLoading(false);
    }
  }

  async function acceptBooking(id, note) {
    // When a date conflict was flagged, the partner must disclose something to
    // the customer before the accept goes through — no empty / whitespace note.
    const trimmedNote = (note || "").trim();
    setActionError("");
    setActionLoading(id);
    try {
      const body = { status: "accepted" };
      if (trimmedNote) body.partner_disclosure_note = trimmedNote;
      await sb(`/rest/v1/bookings?id=eq.${id}`, {
        method: "PATCH",
        token: session.token,
        prefer: "return=minimal",
        body,
      });
      setAcceptDialog(null);
      setDisclosureNote("");
      await loadBookings(session.token, partnerVenue.venue_id);
    } catch (e) {
      setActionError(e.message);
    } finally {
      setActionLoading(null);
    }
  }

  async function rejectBooking(id) {
    if (!rejectReasonOption) {
      setActionError("Select a reason to reject this request.");
      return;
    }
    if (rejectReasonOption === "Other" && !rejectReasonOther.trim()) {
      setActionError("Please specify the reason.");
      return;
    }
    const reason = rejectReasonOption === "Other" ? rejectReasonOther.trim() : rejectReasonOption;
    setActionError("");
    setActionLoading(id);
    try {
      await sb(`/rest/v1/bookings?id=eq.${id}`, {
        method: "PATCH",
        token: session.token,
        prefer: "return=minimal",
        body: { status: "rejected", rejection_reason: reason },
      });
      setRejectingId(null);
      setRejectReasonOption("");
      setRejectReasonOther("");
      await loadBookings(session.token, partnerVenue.venue_id);
    } catch (e) {
      setActionError(e.message);
    } finally {
      setActionLoading(null);
    }
  }

  function openNewPackageForm() {
    setPackageForm({
      name: "",
      description: "",
      price_per_head: "",
      duration_hours: "",
      min_headcount: "",
      max_headcount: "",
      inclusions: "",
      includes_alcohol: true,
      gst_mode: "included",
      quotas: {
        ...Object.fromEntries(
          FOOD_QUOTA_CATEGORIES.map(([kind, , def]) => [kind, { checked: true, count: def }])
        ),
        ...Object.fromEntries(
          BEVERAGE_QUOTA_CATEGORIES.map(([kind, , def]) => [kind, { checked: false, count: def }])
        ),
      },
      poolItemIds: [],
    });
    setEditingPackageId(null);
    setPackageError("");
    setShowPackageForm(true);
  }

  function openEditPackageForm(pkg) {
    const quotas = Object.fromEntries(
      QUOTA_CATEGORIES.map(([kind, , def]) => {
        const existing = pkg.menu_quota_rules?.find((q) => q.category_kind === kind);
        return [kind, { checked: !!existing, count: existing ? existing.quota_count : def }];
      })
    );
    setPackageForm({
      name: pkg.name || "",
      description: pkg.description || "",
      price_per_head: pkg.price_per_head ?? "",
      duration_hours: pkg.duration_hours ?? "",
      min_headcount: pkg.min_headcount ?? "",
      max_headcount: pkg.max_headcount ?? "",
      inclusions: (pkg.inclusions || []).join("\n"),
      includes_alcohol: pkg.includes_alcohol ?? true,
      gst_mode: pkg.gst_mode === "excluded" ? "excluded" : "included",
      quotas,
      poolItemIds: (pkg.package_item_pool || []).map((r) => r.menu_item_id),
    });
    setEditingPackageId(pkg.id);
    setPackageError("");
    setShowPackageForm(true);
  }

  function closePackageForm() {
    setShowPackageForm(false);
    setPackageError("");
  }

  async function savePackage(e) {
    e.preventDefault();
    setPackageError("");
    if (!packageForm.name.trim()) {
      setPackageError("Enter a package name.");
      return;
    }
    const price = parseFloat(packageForm.price_per_head);
    if (!price || price <= 0) {
      setPackageError("Enter a valid price per person.");
      return;
    }
    const minGuests = parseInt(packageForm.min_headcount, 10);
    if (!minGuests || minGuests < 1) {
      setPackageError("Enter a valid minimum guest count.");
      return;
    }

    // Brand-pool categories: the quota can't promise more choice than exists.
    if (packageForm.includes_alcohol) {
      for (const kind of POOL_QUOTA_KINDS) {
        const q = packageForm.quotas[kind];
        if (!q?.checked) continue;
        const label = QUOTA_CATEGORIES.find(([k]) => k === kind)?.[1] || kind;
        const kindItems = itemsForKind(kind);
        if (kindItems.length === 0) {
          setPackageError(`Add ${label} items in Menu Management before using a ${label} quota.`);
          return;
        }
        const picked = kindItems.filter((it) => packageForm.poolItemIds.includes(it.id)).length;
        if (q.count > picked) {
          setPackageError(
            `${label}: “Any ${q.count}” needs at least ${q.count} items in the pool — only ${picked} selected.`
          );
          return;
        }
      }
    }

    setPackageSaving(true);
    try {
      const body = {
        venue_id: partnerVenue.venue_id,
        name: packageForm.name.trim(),
        description: packageForm.description.trim() || null,
        price_per_head: price,
        // No selection → let the column's default (3.0) apply; the column is NOT NULL.
        duration_hours: packageForm.duration_hours ? parseFloat(packageForm.duration_hours) : 3,
        min_headcount: minGuests,
        max_headcount: packageForm.max_headcount ? parseInt(packageForm.max_headcount, 10) : null,
        inclusions: packageForm.inclusions
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
        includes_alcohol: !!packageForm.includes_alcohol,
        gst_mode: packageForm.gst_mode === "excluded" ? "excluded" : "included",
      };

      let packageId = editingPackageId;
      if (editingPackageId) {
        await sb(`/rest/v1/venue_packages?id=eq.${editingPackageId}`, {
          method: "PATCH",
          token: session.token,
          prefer: "return=minimal",
          body,
        });
      } else {
        const [row] = await sb("/rest/v1/venue_packages", {
          method: "POST",
          token: session.token,
          prefer: "return=representation",
          body,
        });
        packageId = row.id;
      }

      await sb(`/rest/v1/menu_quota_rules?package_id=eq.${packageId}`, {
        method: "DELETE",
        token: session.token,
        prefer: "return=minimal",
      });

      // Structured quotas are written for food kinds and, when alcohol is
      // included, the six brand-pool kinds. Cocktails / mocktails / soft drinks
      // are free-flow and carry no quota row.
      const quotaRows = QUOTA_CATEGORIES.filter(([kind]) => {
        if (!packageForm.quotas[kind]?.checked) return false;
        if (FOOD_QUOTA_CATEGORIES.some(([k]) => k === kind)) return true;
        return packageForm.includes_alcohol && POOL_QUOTA_KINDS.includes(kind);
      }).map(([kind]) => ({
        package_id: packageId,
        category_kind: kind,
        quota_count: packageForm.quotas[kind].count,
      }));
      if (quotaRows.length > 0) {
        await sb("/rest/v1/menu_quota_rules", {
          method: "POST",
          token: session.token,
          prefer: "return=minimal",
          body: quotaRows,
        });
      }

      // Brand pools: replace the whole set for this package.
      await sb(`/rest/v1/package_item_pool?package_id=eq.${packageId}`, {
        method: "DELETE",
        token: session.token,
        prefer: "return=minimal",
      });
      const poolRows = POOL_QUOTA_KINDS.filter(
        (kind) => packageForm.includes_alcohol && packageForm.quotas[kind]?.checked
      ).flatMap((kind) =>
        itemsForKind(kind)
          .filter((it) => packageForm.poolItemIds.includes(it.id))
          .map((it) => ({ package_id: packageId, menu_item_id: it.id }))
      );
      if (poolRows.length > 0) {
        await sb("/rest/v1/package_item_pool", {
          method: "POST",
          token: session.token,
          prefer: "return=minimal",
          body: poolRows,
        });
      }

      setShowPackageForm(false);
      await loadPackages(session.token, partnerVenue.venue_id);
    } catch (e) {
      setPackageError(e.message);
    } finally {
      setPackageSaving(false);
    }
  }

  async function togglePackagePublished(pkg) {
    setPackageError("");
    try {
      await sb(`/rest/v1/venue_packages?id=eq.${pkg.id}`, {
        method: "PATCH",
        token: session.token,
        prefer: "return=minimal",
        body: { is_published: !pkg.is_published },
      });
      await loadPackages(session.token, partnerVenue.venue_id);
    } catch (e) {
      setPackageError(e.message);
    }
  }

  async function deletePackage(id) {
    setPackageError("");
    try {
      await sb(`/rest/v1/menu_quota_rules?package_id=eq.${id}`, {
        method: "DELETE",
        token: session.token,
        prefer: "return=minimal",
      });
      await sb(`/rest/v1/venue_packages?id=eq.${id}`, {
        method: "DELETE",
        token: session.token,
        prefer: "return=minimal",
      });
      await loadPackages(session.token, partnerVenue.venue_id);
    } catch (e) {
      setPackageError(e.message);
    }
  }

  if (screen === "auth") {
    return (
      <div className="min-h-screen bg-gradient-to-br from-stone-900 via-stone-950 to-stone-900 text-white flex flex-col justify-center px-6 py-16">
        <div className="max-w-sm mx-auto w-full">
          <h1 className="font-bold leading-[1.05] tracking-tight mb-8">
            <span className="block text-4xl">
              <span className="text-white">Paxo</span> <span className="text-accent">Partner</span>
            </span>
            <span className="block text-xl text-stone-300 font-medium mt-2">
              Manage your venue's bookings
            </span>
          </h1>

          <button
            type="button"
            onClick={handleGoogleSignIn}
            className="w-full bg-white text-stone-900 rounded-full px-5 py-3.5 text-sm font-semibold flex items-center justify-center gap-2 mb-4"
          >
            <span className="w-4 h-4 rounded-full bg-gradient-to-br from-sky-500 via-rose-500 to-amber-400 inline-block" />
            Continue with Google
          </button>

          <div className="flex items-center gap-3 mb-4">
            <div className="flex-1 h-px bg-stone-700" />
            <span className="text-xs text-stone-500">or</span>
            <div className="flex-1 h-px bg-stone-700" />
          </div>

          <form onSubmit={handleAuth} className="flex flex-col gap-3">
            {authMode === "signup" && (
              <p className="text-xs text-stone-500 px-1">
                Create your login, then submit your venue details for review.
              </p>
            )}
            <input
              type="email"
              required
              placeholder="Enter email address"
              className="bg-stone-900 border border-white/10 rounded-full px-5 py-3.5 text-sm placeholder-stone-500 text-white focus:outline-none focus:border-accent"
              value={authEmail}
              onChange={(e) => setAuthEmail(e.target.value)}
            />
            <input
              type="password"
              required
              minLength={6}
              placeholder="Password"
              className="bg-stone-900 border border-white/10 rounded-full px-5 py-3.5 text-sm placeholder-stone-500 text-white focus:outline-none focus:border-accent"
              value={authPassword}
              onChange={(e) => setAuthPassword(e.target.value)}
            />
            {authError && <p className="text-rose-400 text-sm px-1">{authError}</p>}
            {authMode === "login" && (
              <button
                type="button"
                className="text-accent text-xs text-right -mt-1"
                onClick={() => {
                  setResetError("");
                  setResetStep("request");
                  setScreen("forgot");
                }}
              >
                Forgot password?
              </button>
            )}
            <button
              disabled={authLoading}
              className="bg-accent text-[#170D0B] rounded-full px-5 py-3.5 text-sm font-semibold disabled:opacity-50 mt-1"
            >
              {authLoading ? "Please wait…" : authMode === "login" ? "Sign in" : "Create partner account"}
            </button>
          </form>

          <p className="text-center text-stone-500 text-sm mt-6">
            {authMode === "login" ? "New venue partner?" : "Already onboarded?"}{" "}
            <button
              className="text-accent font-medium"
              onClick={() => {
                setAuthMode(authMode === "login" ? "signup" : "login");
                setAuthError("");
              }}
            >
              {authMode === "login" ? "Register your venue" : "Sign in"}
            </button>
          </p>
        </div>
      </div>
    );
  }

  if (screen === "otp") {
    return (
      <OtpVerification
        email={authEmail}
        onVerified={enterSession}
        onBack={() => {
          setAuthError("");
          setScreen("auth");
        }}
      />
    );
  }

  if (screen === "forgot") {
    return (
      <div className="min-h-screen bg-gradient-to-br from-stone-900 via-stone-950 to-stone-900 text-white flex flex-col justify-center px-6 py-16">
        <div className="max-w-sm mx-auto w-full">
          <button className="text-sm text-stone-400 mb-6" onClick={() => setScreen("auth")}>
            ← Back to sign in
          </button>
          <h1 className="font-black text-3xl mb-1">Reset your password</h1>
          <p className="text-stone-400 text-sm mb-6">
            We'll help you set a new password using your email or phone number.
          </p>

          <div className="flex gap-2 mb-6">
            <button
              className={`flex-1 rounded-full py-2 text-sm font-medium ${
                resetMethod === "email" ? "bg-accent text-[#170D0B]" : "border border-stone-700 text-stone-300"
              }`}
              onClick={() => { setResetMethod("email"); setResetStep("request"); setResetError(""); }}
            >
              Email
            </button>
            <button
              className={`flex-1 rounded-full py-2 text-sm font-medium ${
                resetMethod === "phone" ? "bg-accent text-[#170D0B]" : "border border-stone-700 text-stone-300"
              }`}
              onClick={() => { setResetMethod("phone"); setResetStep("request"); setResetError(""); }}
            >
              Phone
            </button>
          </div>

          {resetMethod === "email" && resetStep === "request" && (
            <form onSubmit={requestEmailReset} className="flex flex-col gap-3">
              <input
                type="email"
                required
                placeholder="Enter email address"
                className="bg-stone-900 border border-white/10 rounded-full px-5 py-3.5 text-sm placeholder-stone-500 text-white focus:outline-none focus:border-accent"
                value={resetEmail}
                onChange={(e) => setResetEmail(e.target.value)}
              />
              {resetError && <p className="text-rose-400 text-sm px-1">{resetError}</p>}
              <button
                disabled={resetLoading}
                className="bg-accent text-[#170D0B] rounded-full px-5 py-3.5 text-sm font-semibold disabled:opacity-50"
              >
                {resetLoading ? "Sending…" : "Send reset link"}
              </button>
            </form>
          )}

          {resetMethod === "email" && resetStep === "sent" && (
            <div className="border border-emerald-800 bg-emerald-950 rounded-lg p-4 text-sm text-emerald-200">
              Check <span className="font-medium">{resetEmail}</span> for a reset link. Opening it will bring
              you back here to set a new password.
            </div>
          )}

          {resetMethod === "phone" && resetStep === "request" && (
            <form onSubmit={requestPhoneOtp} className="flex flex-col gap-3">
              <input
                type="tel"
                required
                placeholder="+91 98765 43210"
                className="bg-stone-900 border border-white/10 rounded-full px-5 py-3.5 text-sm placeholder-stone-500 text-white focus:outline-none focus:border-accent"
                value={resetPhone}
                onChange={(e) => setResetPhone(e.target.value)}
              />
              {resetError && <p className="text-rose-400 text-sm px-1">{resetError}</p>}
              <button
                disabled={resetLoading}
                className="bg-accent text-[#170D0B] rounded-full px-5 py-3.5 text-sm font-semibold disabled:opacity-50"
              >
                {resetLoading ? "Sending…" : "Send code"}
              </button>
            </form>
          )}

          {resetMethod === "phone" && resetStep === "verify" && (
            <form onSubmit={verifyPhoneOtpAndReset} className="flex flex-col gap-3">
              <p className="text-stone-400 text-xs -mt-1">Code sent to {resetPhone}</p>
              <input
                type="text"
                required
                placeholder="6-digit code"
                className="bg-stone-900 border border-white/10 rounded-full px-5 py-3.5 text-sm placeholder-stone-500 text-white focus:outline-none focus:border-accent"
                value={resetOtp}
                onChange={(e) => setResetOtp(e.target.value)}
              />
              <input
                type="password"
                required
                minLength={6}
                placeholder="New password"
                className="bg-stone-900 border border-white/10 rounded-full px-5 py-3.5 text-sm placeholder-stone-500 text-white focus:outline-none focus:border-accent"
                value={resetNewPassword}
                onChange={(e) => setResetNewPassword(e.target.value)}
              />
              {resetError && <p className="text-rose-400 text-sm px-1">{resetError}</p>}
              <button
                disabled={resetLoading}
                className="bg-accent text-[#170D0B] rounded-full px-5 py-3.5 text-sm font-semibold disabled:opacity-50"
              >
                {resetLoading ? "Resetting…" : "Reset password"}
              </button>
            </form>
          )}
        </div>
      </div>
    );
  }

  if (screen === "setNewPassword") {
    return (
      <div className="min-h-screen bg-gradient-to-br from-stone-900 via-stone-950 to-stone-900 text-white flex flex-col justify-center px-6 py-16">
        <div className="max-w-sm mx-auto w-full">
          <h1 className="font-black text-3xl mb-1">Set a new password</h1>
          <p className="text-stone-400 text-sm mb-6">Choose a new password for your account.</p>
          <form onSubmit={submitNewPassword} className="flex flex-col gap-3">
            <input
              type="password"
              required
              minLength={6}
              placeholder="New password"
              className="bg-stone-900 border border-white/10 rounded-full px-5 py-3.5 text-sm placeholder-stone-500 text-white focus:outline-none focus:border-accent"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
            <input
              type="password"
              required
              minLength={6}
              placeholder="Confirm new password"
              className="bg-stone-900 border border-white/10 rounded-full px-5 py-3.5 text-sm placeholder-stone-500 text-white focus:outline-none focus:border-accent"
              value={newPasswordConfirm}
              onChange={(e) => setNewPasswordConfirm(e.target.value)}
            />
            {newPasswordError && <p className="text-rose-400 text-sm px-1">{newPasswordError}</p>}
            <button
              disabled={newPasswordLoading}
              className="bg-accent text-[#170D0B] rounded-full px-5 py-3.5 text-sm font-semibold disabled:opacity-50"
            >
              {newPasswordLoading ? "Saving…" : "Save new password"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  if (screen === "claimVenue") {
    return (
      <div className="min-h-screen bg-gradient-to-br from-stone-900 via-stone-950 to-stone-900 text-white flex flex-col justify-center px-6 py-16">
        <div className="max-w-sm mx-auto w-full">
          <h1 className="font-black text-3xl mb-1">Which venue do you manage?</h1>
          <p className="text-stone-400 text-sm mb-6">
            Link your account to your venue to see its booking requests. (Temporary self-select — this
            will require an admin-issued invite once the Admin console exists.)
          </p>
          <form onSubmit={claimVenue} className="flex flex-col gap-3">
            <select
              required
              className="bg-stone-900 border border-white/10 rounded-full px-5 py-3.5 text-sm text-white focus:outline-none focus:border-accent"
              value={claimVenuePending}
              onChange={(e) => setClaimVenuePending(e.target.value)}
            >
              <option value="">Select your venue</option>
              {approvedVenues.map((v) => (
                <option key={v.id} value={v.id}>{v.name} — {v.city}</option>
              ))}
            </select>
            {authError && <p className="text-rose-400 text-sm px-1">{authError}</p>}
            <button
              disabled={authLoading}
              className="bg-accent text-[#170D0B] rounded-full px-5 py-3.5 text-sm font-semibold disabled:opacity-50"
            >
              {authLoading ? "Saving…" : "Continue"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  // --- Venue onboarding + status gating -----------------------------------
  // A logged-in partner without an approved venue never sees the dashboard.
  const venue = partnerVenue?.venues || null;

  if (session && (screen === "submitVenue" || !partnerVenue)) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-stone-900 via-stone-950 to-stone-900 text-white px-6 py-10">
        <div className="max-w-md mx-auto w-full">
          <div className="flex items-center justify-between mb-8">
            <div className="flex items-baseline gap-2">
              <span className="font-black text-2xl">Paxo</span>
              <span className="text-xs text-accent font-medium">Partner</span>
            </div>
            <button onClick={logOut} className="text-xs text-stone-400 hover:text-stone-200">Log out</button>
          </div>
          <div className="border border-stone-800 bg-stone-900/60 rounded-2xl p-5">
            <VenueSubmissionForm
              session={session}
              onSubmitted={async () => {
                await refreshVenue();
                setScreen("dashboard");
              }}
            />
          </div>
        </div>
      </div>
    );
  }

  if (session && venue && venue.status !== "approved") {
    return (
      <VenueStatusScreen
        session={session}
        venue={venue}
        onChanged={refreshVenue}
        onLogout={logOut}
      />
    );
  }

  const filtered = bookings.filter((b) => activeTab === "all" || b.status === activeTab);
  const pendingCount = bookings.filter((b) => b.status === "pending").length;
  const upcomingCount = bookings.filter((b) => b.status === "accepted").length;
  const menuSectionKinds = menuSection === "food" ? FOOD_KINDS : BEVERAGE_KINDS;
  // Render in the venue's curated sort_order (loadMenu already fetches that
  // order; sort again so it holds regardless of fetch/React ordering).
  const visibleCategories = categories
    .filter((cat) => menuSectionKinds.includes(cat.kind))
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  const settlementBookings = bookings.filter((b) => ["accepted", "confirmed", "completed"].includes(b.status));
  const pendingSettlementTotal = bookings
    .filter((b) => b.status === "accepted")
    .reduce((sum, b) => sum + Number(b.deposit_amount || 0), 0);

  return (
    <div className="min-h-screen bg-stone-50 text-stone-900 pb-20 sm:pb-0">
      <header className="bg-slate-900 text-white">
        <div className="max-w-4xl mx-auto px-5 py-4 flex items-center justify-between gap-4">
          <div className="flex items-baseline gap-2 shrink-0">
            <span className="font-display text-2xl tracking-tight">Paxo</span>
            <span className="text-xs text-accent">partner</span>
          </div>
          <div className="flex items-center gap-4 text-sm relative">
            <nav className="hidden sm:flex items-center gap-4 whitespace-nowrap">
              <button
                className={`hover:text-accent ${screen === "dashboard" ? "text-accent" : "text-slate-300"}`}
                onClick={() => setScreen("dashboard")}
              >
                Requests
              </button>
              <button
                className={`hover:text-accent ${screen === "upcoming" ? "text-accent" : "text-slate-300"}`}
                onClick={() => setScreen("upcoming")}
              >
                Upcoming Events
              </button>
              <button
                className={`hover:text-accent ${screen === "menu" ? "text-accent" : "text-slate-300"}`}
                onClick={() => setScreen("menu")}
              >
                Menu Management
              </button>
              <button
                className={`hover:text-accent ${screen === "payments" ? "text-accent" : "text-slate-300"}`}
                onClick={() => setScreen("payments")}
              >
                Payments
              </button>
              <button
                className={`hover:text-accent ${screen === "packages" ? "text-accent" : "text-slate-300"}`}
                onClick={() => setScreen("packages")}
              >
                Packages
              </button>
              <button
                className={`hover:text-accent ${screen === "profile" ? "text-accent" : "text-slate-300"}`}
                onClick={() => setScreen("profile")}
              >
                Profile
              </button>
            </nav>
            <span className="text-slate-300 hidden lg:inline-flex items-center gap-1.5 shrink-0">
              {partnerVenue?.venues?.name}
              {partnerVenue?.venues?.is_verified && (
                <span className="text-[11px] font-semibold bg-emerald-400/20 text-emerald-300 px-1.5 py-0.5 rounded-full">
                  ✓ Verified
                </span>
              )}
            </span>
            <button
              className="w-8 h-8 rounded-full bg-accent text-[#170D0B] font-semibold flex items-center justify-center text-xs"
              onClick={() => setMenuOpen((v) => !v)}
            >
              {(session.email || "?").slice(0, 1).toUpperCase()}
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-10 w-48 bg-white text-stone-900 rounded-lg border border-stone-200 shadow-lg overflow-hidden z-10">
                <p className="px-4 py-3 text-xs text-stone-400 border-b border-stone-100 truncate">{session.email}</p>
                <button className="w-full text-left px-4 py-2.5 text-sm hover:bg-stone-50 sm:hidden" onClick={() => { setScreen("packages"); setMenuOpen(false); }}>
                  Packages
                </button>
                <button className="w-full text-left px-4 py-2.5 text-sm hover:bg-stone-50" onClick={() => { setScreen("settings"); setMenuOpen(false); }}>
                  Settings
                </button>
                <button className="w-full text-left px-4 py-2.5 text-sm hover:bg-stone-50" onClick={() => { setScreen("help"); setMenuOpen(false); }}>
                  Help & support
                </button>
                <button className="w-full text-left px-4 py-2.5 text-sm text-rose-600 hover:bg-stone-50 border-t border-stone-100" onClick={logOut}>
                  Log out
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <main key={screen} className="max-w-4xl mx-auto px-5 py-8 animate-[fadein_0.2s_ease-out]">
        <style>{`@keyframes fadein { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }`}</style>
        {screen === "dashboard" && (
          <>
        <p className="text-accent-ink text-sm font-medium mb-1">Welcome back, {partnerVenue?.venues?.name}</p>
        <h1 className="font-serif text-3xl mb-1">Booking requests</h1>
        <p className="text-stone-500 text-sm mb-6">{partnerVenue?.venues?.name}</p>

        <div className="grid grid-cols-2 gap-4 mb-6 max-w-sm">
          <div className="bg-white border border-stone-200 rounded-lg p-4">
            <p className="text-xs text-stone-500">Awaiting your response</p>
            <p className="text-2xl font-medium">{pendingCount}</p>
          </div>
          <div className="bg-white border border-stone-200 rounded-lg p-4">
            <p className="text-xs text-stone-500">Upcoming (accepted)</p>
            <p className="text-2xl font-medium">{upcomingCount}</p>
          </div>
        </div>

        <div className="flex gap-2 mb-5">
          {["pending", "accepted", "rejected", "cancelled", "all"].map((t) => (
            <button
              key={t}
              className={`text-sm px-3 py-1.5 rounded-full border capitalize ${
                activeTab === t ? "bg-slate-900 text-white border-slate-900" : "border-stone-300 text-stone-600"
              }`}
              onClick={() => setActiveTab(t)}
            >
              {t}
            </button>
          ))}
        </div>

        {actionError && <p className="text-rose-600 text-sm mb-3">{actionError}</p>}
        {bookingsLoading && (
          <div className="flex flex-col gap-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="border border-stone-200 rounded-lg p-4 bg-white animate-pulse flex flex-col gap-2">
                <div className="h-4 bg-stone-200 rounded w-1/3" />
                <div className="h-3 bg-stone-200 rounded w-2/3" />
                <div className="h-3 bg-stone-200 rounded w-1/2" />
              </div>
            ))}
          </div>
        )}
        {!bookingsLoading && filtered.length === 0 && (
          <p className="text-stone-400 text-sm">No {activeTab === "all" ? "" : activeTab} requests.</p>
        )}

        <div className="flex flex-col gap-3">
          {filtered.map((b) => {
            const mins = b.status === "pending" ? minutesLeft(b.response_deadline) : null;
            return (
              <div key={b.id} className="border border-stone-200 rounded-xl p-5 bg-white">
                <div className="flex items-start justify-between gap-3 mb-4">
                  <div className="min-w-0">
                    <p className="text-base font-semibold text-stone-900">{b.contact_name}</p>
                    <p className="text-sm text-stone-600 mt-0.5">
                      {b.venue_packages?.name} · {b.headcount} guests
                    </p>
                    <p className="text-sm text-stone-600">{b.event_date} at {b.event_time}</p>
                    <p className="text-xs text-stone-400 font-mono mt-1.5">Booking ID: {b.id.slice(0, 8).toUpperCase()}</p>
                  </div>
                  <span className={`text-xs font-medium px-2 py-1 rounded shrink-0 capitalize ${statusColor[b.status]}`}>
                    {b.status.replace("_", " ")}
                  </span>
                </div>

                {b.status === "pending" && dateConflicts(b, bookings).length > 0 && (
                  <div className="flex items-start gap-1.5 text-xs font-medium text-amber-800 bg-amber-50 border border-amber-300 rounded-md px-2 py-1.5 mb-2">
                    <span aria-hidden>⚠</span>
                    <span>Date conflict — already an accepted booking on {b.event_date}</span>
                  </div>
                )}

                <div className="bg-stone-50 border border-stone-200 rounded-lg p-3 mb-3 text-xs text-stone-600 flex flex-col gap-1.5">
                  <div className="flex justify-between gap-3">
                    <span className="text-stone-400">Occasion</span>
                    <span className="font-medium text-stone-700 text-right">
                      {b.booking_types?.name === "Other" ? (b.occasion_other || "Other") : (b.booking_types?.name || "—")}
                    </span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-stone-400">Guests</span>
                    <span className="font-medium text-stone-700 text-right">
                      {b.headcount} ({b.male_count || 0} male, {b.female_count || 0} female)
                    </span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-stone-400">Contact</span>
                    {b.status === "confirmed" || b.status === "completed" ? (
                      <span className="font-medium text-stone-700 text-right">
                        {b.contact_mobile} · {b.contact_email}
                      </span>
                    ) : (
                      <span className="italic text-stone-400 text-right">Unlocks once payment is completed</span>
                    )}
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-stone-400">Booking type</span>
                    <span className={b.is_last_minute ? "font-bold text-rose-600" : "font-medium text-stone-700"}>
                      {b.is_last_minute ? "Express Booking" : "Advance Booking"}
                    </span>
                  </div>
                  {b.special_request && (
                    <div className="pt-1.5 mt-0.5 border-t border-stone-200">
                      <span className="text-stone-400 block mb-0.5">Special request</span>
                      <span className="text-stone-700">{b.special_request}</span>
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap gap-4 text-xs text-stone-500 mb-3">
                  <span>Estimated Package Value {inr(b.total_amount)}</span>
                  <span>
                    Deposit due {inr(b.deposit_amount)} ({b.deposit_tier === "full" ? "full payment" : b.deposit_tier === "50pct" ? "50%" : "20%"})
                  </span>
                  {b.is_last_minute && <span className="text-rose-600 font-medium">Non-cancellable if accepted</span>}
                </div>

                {b.status === "pending" && (
                  <>
                    {mins !== null && (
                      <p className={`text-xs mb-2 ${mins < 30 ? "text-rose-600" : "text-stone-400"}`}>
                        {mins > 0 ? `Respond within ${mins} min` : "Response window passed — auto-reject pending"}
                      </p>
                    )}
                    {rejectingId === b.id ? (
                      <div className="flex flex-col gap-2">
                        <select
                          className="border border-stone-300 rounded px-3 py-2 text-sm w-full"
                          value={rejectReasonOption}
                          onChange={(e) => setRejectReasonOption(e.target.value)}
                        >
                          <option value="">Select a reason</option>
                          {REJECT_REASONS.map((r) => (
                            <option key={r} value={r}>{r}</option>
                          ))}
                        </select>
                        {rejectReasonOption === "Other" && (
                          <input
                            type="text"
                            placeholder="Specify the reason"
                            className="border border-stone-300 rounded px-3 py-2 text-sm w-full"
                            value={rejectReasonOther}
                            onChange={(e) => setRejectReasonOther(e.target.value)}
                          />
                        )}
                        <div className="flex gap-2">
                          <button
                            disabled={actionLoading === b.id}
                            className="bg-rose-600 text-white text-sm font-medium px-3 py-1.5 rounded disabled:opacity-50"
                            onClick={() => rejectBooking(b.id)}
                          >
                            Confirm reject
                          </button>
                          <button
                            className="text-sm text-stone-500 px-3 py-1.5"
                            onClick={() => { setRejectingId(null); setRejectReasonOption(""); setRejectReasonOther(""); setActionError(""); }}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex gap-2">
                        <button
                          disabled={actionLoading === b.id}
                          className="bg-emerald-600 text-white text-sm font-medium px-3 py-1.5 rounded disabled:opacity-50"
                          onClick={() => {
                            const conflicts = dateConflicts(b, bookings);
                            if (conflicts.length > 0) {
                              setActionError("");
                              setDisclosureNote("");
                              setAcceptDialog({ id: b.id, conflicts });
                            } else {
                              acceptBooking(b.id);
                            }
                          }}
                        >
                          Accept
                        </button>
                        <button
                          disabled={actionLoading === b.id}
                          className="border border-rose-300 text-rose-700 text-sm font-medium px-3 py-1.5 rounded disabled:opacity-50"
                          onClick={() => setRejectingId(b.id)}
                        >
                          Reject
                        </button>
                      </div>
                    )}
                  </>
                )}

                {b.status === "rejected" && b.rejection_reason && (
                  b.rejection_reason.startsWith("Customer declined due to disclosed") ? (
                    <div className="border border-amber-300 bg-amber-50 rounded-lg p-3 text-xs">
                      <p className="font-semibold text-amber-800">Customer declined the disclosed conflict</p>
                      <p className="text-stone-600 mt-0.5">
                        They chose not to proceed after seeing your venue-conflict note. {b.event_date} has
                        freed back up — you can reconsider another request for that date.
                      </p>
                    </div>
                  ) : (
                    <p className="text-xs text-stone-400">Reason: {b.rejection_reason}</p>
                  )
                )}

                {b.status === "cancelled" && (
                  <div className="border border-rose-200 bg-rose-50 rounded-lg p-3 text-xs">
                    <p className="font-semibold text-rose-700">Cancelled by customer</p>
                    {b.cancellation_reason && (
                      <p className="text-stone-600 mt-0.5 whitespace-pre-wrap">
                        {b.cancellation_reason}
                      </p>
                    )}
                    <p className="text-stone-400 mt-1">No action needed.</p>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {acceptDialog && (() => {
          const noteReady = disclosureNote.trim().length >= 10;
          const busy = actionLoading === acceptDialog.id;
          return (
            <div
              className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
              role="dialog"
              aria-modal="true"
              aria-label="Confirm accept with date conflict"
              onClick={() => !busy && setAcceptDialog(null)}
            >
              <div
                className="bg-white rounded-xl max-w-md w-full p-5 shadow-xl"
                onClick={(e) => e.stopPropagation()}
              >
                <h2 className="font-serif text-xl mb-2">This date already has a booking</h2>
                <p className="text-sm text-stone-600 mb-3">
                  {partnerVenue?.venues?.name} already has{" "}
                  {acceptDialog.conflicts.length === 1 ? "an accepted booking" : "accepted bookings"} on this date:
                </p>
                <ul className="text-sm bg-amber-50 border border-amber-300 rounded-md px-3 py-2 mb-4 flex flex-col gap-1">
                  {acceptDialog.conflicts.map((c) => (
                    <li key={c.id} className="text-amber-900">
                      <span className="font-mono font-medium">{c.booking_ref || c.id.slice(0, 8).toUpperCase()}</span>
                      {" — "}
                      {c.event_date}
                      {c.slot ? ` (${String(c.slot).toLowerCase()})` : c.event_time ? ` at ${c.event_time}` : ""}
                    </li>
                  ))}
                </ul>
                <p className="text-sm text-stone-600 mb-2">
                  You can still accept this request. Before you do, tell the customer what they should know —
                  they'll see this note on their booking before they pay.
                </p>
                <textarea
                  className="border border-stone-300 rounded w-full px-3 py-2 text-sm mb-1 min-h-[90px]"
                  placeholder="e.g. We'll be hosting another private event on the same date — you'll have your own dedicated area, but shared common spaces may be busier than usual."
                  value={disclosureNote}
                  onChange={(e) => setDisclosureNote(e.target.value)}
                />
                {!noteReady && (
                  <p className="text-xs text-stone-400 mb-3">A disclosure note is required to accept this booking.</p>
                )}
                {noteReady && <div className="mb-3" />}
                {actionError && <p className="text-rose-600 text-sm mb-3">{actionError}</p>}
                <div className="flex gap-2 justify-end">
                  <button
                    className="text-sm text-stone-500 px-3 py-1.5"
                    disabled={busy}
                    onClick={() => { setAcceptDialog(null); setDisclosureNote(""); setActionError(""); }}
                  >
                    Cancel
                  </button>
                  <button
                    className="bg-emerald-600 text-white text-sm font-medium px-3 py-1.5 rounded disabled:opacity-50"
                    disabled={!noteReady || busy}
                    onClick={() => acceptBooking(acceptDialog.id, disclosureNote)}
                  >
                    {busy ? "Accepting…" : "Accept anyway"}
                  </button>
                </div>
              </div>
            </div>
          );
        })()}
          </>
        )}

        {screen === "upcoming" && (
          <div>
            <h1 className="font-serif text-3xl mb-1">Upcoming Events</h1>
            <p className="text-stone-500 text-sm mb-6">Accepted and confirmed bookings for {partnerVenue?.venues?.name}.</p>
            {actionError && <p className="text-rose-600 text-sm mb-3">{actionError}</p>}
            <div className="flex flex-col gap-3">
              {bookings.filter((b) => ["accepted", "confirmed"].includes(b.status)).length === 0 && (
                <p className="text-stone-400 text-sm">No upcoming bookings yet.</p>
              )}
              {bookings
                .filter((b) => ["accepted", "confirmed"].includes(b.status))
                .sort((a, b) => new Date(a.event_date) - new Date(b.event_date))
                .map((b) => {
                  const eventPassed = new Date(`${b.event_date}T${b.event_time}`).getTime() < Date.now();
                  const confirmed = b.status === "confirmed";
                  return (
                    <div key={b.id} className="border border-stone-200 rounded-xl p-5 bg-white">
                      <div className="flex items-start justify-between gap-3 mb-4">
                        <div className="min-w-0">
                          <p className="text-base font-semibold text-stone-900">{b.contact_name}</p>
                          <p className="text-sm text-stone-600 mt-0.5">
                            {b.venue_packages?.name} · {b.headcount} guests
                          </p>
                          <p className="text-sm text-stone-600">
                            {b.event_date} at {b.event_time}
                          </p>
                          <p className="text-xs text-stone-400 font-mono mt-1.5">
                            {b.booking_ref || `Booking ${b.id.slice(0, 8).toUpperCase()}`}
                          </p>
                        </div>
                        <span
                          className={`text-xs font-medium px-2 py-1 rounded shrink-0 capitalize ${
                            confirmed ? "bg-emerald-100 text-emerald-800" : "bg-blue-100 text-blue-800"
                          }`}
                        >
                          {b.status}
                        </span>
                      </div>

                      {confirmed && (
                        <div className="border border-stone-200 rounded-lg p-3 mb-4 bg-stone-50">
                          {b.event_started_at ? (
                            <p className="text-sm font-medium text-emerald-700">
                              ✓ Checked in at{" "}
                              {new Date(b.event_started_at).toLocaleString("en-IN", {
                                day: "numeric",
                                month: "short",
                                hour: "numeric",
                                minute: "2-digit",
                              })}
                            </p>
                          ) : !b.checkin_otp ? (
                            <p className="text-xs text-stone-500">
                              Waiting for the customer to generate their check-in code.
                            </p>
                          ) : (
                            <>
                              <p className="text-sm font-medium mb-1">Confirm event started</p>
                              <p className="text-xs text-stone-500 mb-2">
                                Enter the 6-digit code the customer shows you on arrival.
                              </p>
                              <div className="flex flex-wrap gap-2">
                                <input
                                  inputMode="numeric"
                                  maxLength={6}
                                  placeholder="6-digit code"
                                  value={checkinInput[b.id] || ""}
                                  onChange={(e) =>
                                    setCheckinInput((m) => ({
                                      ...m,
                                      [b.id]: e.target.value.replace(/\D/g, "").slice(0, 6),
                                    }))
                                  }
                                  className="border border-stone-300 rounded px-3 py-1.5 text-sm w-32 tracking-widest"
                                />
                                <button
                                  type="button"
                                  disabled={checkinBusyId === b.id}
                                  onClick={() => confirmEventStarted(b)}
                                  className="bg-accent text-[#170D0B] text-sm font-medium px-3 py-1.5 rounded disabled:opacity-50"
                                >
                                  {checkinBusyId === b.id ? "Confirming…" : "Confirm Event Started"}
                                </button>
                              </div>
                              {checkinError[b.id] && (
                                <p className="text-xs text-rose-600 mt-1">{checkinError[b.id]}</p>
                              )}
                            </>
                          )}
                        </div>
                      )}

                      {confirmed && (
                        <div className="border border-stone-200 rounded-lg p-3 mb-4">
                          <p className="text-sm font-semibold text-stone-500 mb-1.5">
                            Finalized menu
                          </p>
                          {b.menu_finalized_at ? (
                            <div className="flex flex-col gap-1.5">
                              {bookingSelectionGroups(b, categories).map((g) => (
                                <div key={g.kind}>
                                  <p className="text-sm font-medium text-stone-700">
                                    {quotaLabel(g.kind, g.names.length)}
                                  </p>
                                  <ul className="list-disc pl-5 text-sm text-stone-600">
                                    {g.names.map((n, i) => (
                                      <li key={i}>{n}</li>
                                    ))}
                                  </ul>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <p className="text-xs text-stone-500">Menu not yet finalized.</p>
                          )}
                        </div>
                      )}

                      <p className="text-xs text-stone-500 mb-3">
                        Deposit share held — releases on OTP redemption at the event (payment collection not live yet).
                      </p>
                      {confirmed ? (
                        eventPassed ? (
                          <button
                            disabled={actionLoading === b.id}
                            className="bg-accent text-[#170D0B] text-sm font-semibold px-4 py-2 rounded-lg disabled:opacity-50 hover:brightness-105 transition"
                            onClick={() => markCompleted(b.id)}
                          >
                            {actionLoading === b.id ? "Working…" : "Mark as Completed"}
                          </button>
                        ) : (
                          <p className="text-xs text-stone-400">
                            You'll be able to mark this event completed once it has taken place.
                          </p>
                        )
                      ) : eventPassed ? (
                        <button
                          disabled={actionLoading === b.id}
                          className="border border-rose-300 text-rose-700 text-sm font-medium px-3 py-1.5 rounded disabled:opacity-50"
                          onClick={() => markNoShow(b.id)}
                        >
                          Mark no-show
                        </button>
                      ) : (
                        <p className="text-xs text-stone-400">No-show marking unlocks after the event time passes.</p>
                      )}
                    </div>
                  );
                })}
            </div>
          </div>
        )}

        {screen === "menu" && (
          <div>
            <h1 className="font-serif text-3xl mb-1">Menu Management</h1>
            <p className="text-stone-500 text-sm mb-6">
              Manage categories and items for {partnerVenue?.venues?.name}. Changes are visible to customers immediately.
            </p>

            <div className="flex gap-2 mb-6">
              <button
                type="button"
                className={`text-sm px-4 py-2 rounded-full border ${
                  menuSection === "food" ? "bg-slate-900 text-white border-slate-900" : "border-stone-300 text-stone-600"
                }`}
                onClick={() => { setMenuSection("food"); setNewCategoryKind("starter_veg"); }}
              >
                Food Menu
              </button>
              <button
                type="button"
                className={`text-sm px-4 py-2 rounded-full border ${
                  menuSection === "beverage" ? "bg-slate-900 text-white border-slate-900" : "border-stone-300 text-stone-600"
                }`}
                onClick={() => { setMenuSection("beverage"); setNewCategoryKind("wine"); }}
              >
                Beverages
              </button>
            </div>

            <form onSubmit={addCategory} className="flex flex-wrap gap-2 mb-6 bg-white border border-stone-200 rounded-lg p-4">
              <input
                type="text"
                placeholder="Category name (e.g. Starters)"
                className="border border-stone-300 rounded px-3 py-2 text-sm flex-1 min-w-[160px]"
                value={newCategoryName}
                onChange={(e) => setNewCategoryName(e.target.value)}
              />
              <select
                className="border border-stone-300 rounded px-3 py-2 text-sm"
                value={newCategoryKind}
                onChange={(e) => setNewCategoryKind(e.target.value)}
              >
                {CATEGORY_KINDS.filter(([k]) => menuSectionKinds.includes(k)).map(([k, label]) => (
                  <option key={k} value={k}>{label}</option>
                ))}
              </select>
              <button className="bg-accent text-[#170D0B] text-sm font-medium px-4 py-2 rounded">Add category</button>
            </form>

            {menuError && !menuErrorCat && <p className="text-rose-600 text-sm mb-3">{menuError}</p>}
            {menuLoading && <p className="text-stone-400 text-sm">Loading…</p>}

            <div className="flex flex-col gap-4">
              {visibleCategories.map((cat) => {
                const kindLabel = CATEGORY_KINDS.find(([k]) => k === cat.kind)?.[1] || cat.kind;
                const isOpen = !!openCats[cat.id];
                const catSuggestions = suggestionsFor(cat);
                const picks = suggestionPicks[cat.id] || {};
                const pickCount = Object.values(picks).filter(Boolean).length;
                return (
                <div key={cat.id} className="border border-stone-200 rounded-lg bg-white">
                  <div className="flex items-center justify-between gap-3 p-4">
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      onClick={() => setOpenCats((m) => ({ ...m, [cat.id]: !m[cat.id] }))}
                      className="flex items-center gap-2.5 text-left min-w-0"
                    >
                      <span
                        aria-hidden
                        className="inline-flex shrink-0 items-center justify-center w-6 h-6 rounded-full border border-stone-300 bg-stone-50 text-stone-600 text-sm leading-none transition-colors hover:bg-stone-100"
                      >
                        {isOpen ? "−" : "+"}
                      </span>
                      <span className="min-w-0">
                        <span className="font-medium block truncate">{cat.name}</span>
                        <span className="text-xs text-stone-400">
                          {kindLabel} · {cat.menu_items?.length || 0} item{(cat.menu_items?.length || 0) === 1 ? "" : "s"}
                        </span>
                      </span>
                    </button>
                    <button type="button" className="text-xs text-rose-600 shrink-0" onClick={() => deleteCategory(cat.id)}>
                      Delete category
                    </button>
                  </div>

                  {isOpen && (
                  <div className="px-4 pb-4">
                  <div className="flex flex-col gap-2 mb-3">
                    {cat.menu_items?.map((item) => (
                      <div key={item.id} className="flex flex-col gap-1 text-sm border-b border-stone-100 pb-2 last:border-0">
                        <div className="flex items-center justify-between">
                          <span className={item.is_available ? "" : "text-stone-400 line-through"}>{item.name}</span>
                          <div className="flex items-center gap-3 shrink-0">
                            <button className="text-xs text-stone-500" onClick={() => toggleItemAvailable(item)}>
                              {item.is_available ? "Mark unavailable" : "Mark available"}
                            </button>
                            <button
                              className="text-xs text-accent-ink"
                              onClick={() => (editingItemId === item.id ? setEditingItemId(null) : startEditItemDesc(item))}
                            >
                              {editingItemId === item.id ? "Cancel" : item.description ? "Edit" : "Add description"}
                            </button>
                            <button className="text-xs text-rose-600" onClick={() => deleteItem(item.id)}>
                              Remove
                            </button>
                          </div>
                        </div>
                        {editingItemId === item.id ? (
                          <div className="flex gap-2">
                            <input
                              type="text"
                              autoFocus
                              placeholder="What's in this dish?"
                              className="border border-stone-300 rounded px-2 py-1 text-xs flex-1"
                              value={editItemDesc}
                              onChange={(e) => setEditItemDesc(e.target.value)}
                              onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), saveItemDescription(item.id))}
                            />
                            <button
                              className="text-xs border border-stone-300 rounded px-3 py-1"
                              onClick={() => saveItemDescription(item.id)}
                            >
                              Save
                            </button>
                          </div>
                        ) : (
                          item.description && <p className="text-xs text-stone-400">{item.description}</p>
                        )}
                      </div>
                    ))}
                    {(!cat.menu_items || cat.menu_items.length === 0) && (
                      <p className="text-xs text-stone-400">No items yet.</p>
                    )}
                  </div>
                  {catSuggestions.length > 0 && (
                    <div className="border border-stone-200 bg-stone-50 rounded-lg p-3 mb-3">
                      <p className="text-xs font-medium text-stone-600 mb-2">
                        Suggested {kindLabel.toLowerCase()} — tick what this venue serves
                      </p>
                      <div className="flex flex-wrap gap-x-4 gap-y-2 mb-3">
                        {catSuggestions.map((name) => (
                          <label key={name} className="flex items-center gap-1.5 text-sm cursor-pointer">
                            <input
                              type="checkbox"
                              className="rounded border-stone-300"
                              checked={!!picks[name]}
                              onChange={() => toggleSuggestionPick(cat.id, name)}
                            />
                            {name}
                          </label>
                        ))}
                      </div>
                      <button
                        type="button"
                        disabled={pickCount === 0 || addingSuggested === cat.id}
                        onClick={() => addSuggestedItems(cat.id)}
                        className="bg-accent text-[#170D0B] text-sm font-medium px-3 py-1.5 rounded disabled:opacity-50"
                      >
                        {addingSuggested === cat.id
                          ? "Adding…"
                          : `Add selected${pickCount ? ` (${pickCount})` : ""}`}
                      </button>
                    </div>
                  )}

                  {menuErrorCat === cat.id && menuError && (
                    <p className="text-xs text-rose-600 mb-2">{menuError}</p>
                  )}
                  <div className="flex flex-col gap-2">
                    <p className="text-xs text-stone-500">Don't see it? Add manually</p>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        placeholder="Item name"
                        className="border border-stone-300 rounded px-3 py-1.5 text-sm flex-1"
                        value={newItemName[cat.id] || ""}
                        onChange={(e) => setNewItemName({ ...newItemName, [cat.id]: e.target.value })}
                        onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addItem(cat.id))}
                      />
                      <button
                        type="button"
                        className="text-sm border border-stone-300 rounded px-3 py-1.5"
                        onClick={() => addItem(cat.id)}
                      >
                        Add
                      </button>
                    </div>
                    <input
                      type="text"
                      placeholder="Description (optional) — what's in this dish?"
                      className="border border-stone-300 rounded px-3 py-1 text-xs w-full"
                      value={newItemDesc[cat.id] || ""}
                      onChange={(e) => setNewItemDesc({ ...newItemDesc, [cat.id]: e.target.value })}
                      onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addItem(cat.id))}
                    />
                  </div>
                  </div>
                  )}
                </div>
                );
              })}
              {!menuLoading && visibleCategories.length === 0 && (
                <p className="text-stone-400 text-sm">No {menuSection === "food" ? "food" : "beverage"} categories yet — add one above to get started.</p>
              )}
            </div>
          </div>
        )}

        {screen === "payments" && (
          <div>
            <h1 className="font-serif text-3xl mb-1">Payments</h1>
            <p className="text-stone-500 text-sm mb-6">Deposit settlement status for {partnerVenue?.venues?.name}.</p>

            <div className="bg-white border border-stone-200 rounded-lg p-4 mb-6 max-w-sm">
              <p className="text-xs text-stone-500">Pending settlement (accepted, unpaid)</p>
              <p className="text-2xl font-medium">{inr(pendingSettlementTotal)}</p>
            </div>

            {bookingsLoading && <p className="text-stone-400 text-sm">Loading…</p>}
            <div className="flex flex-col gap-3">
              {settlementBookings.map((b) => (
                <div key={b.id} className="border border-stone-200 rounded-lg p-4 bg-white flex items-center justify-between gap-4">
                  <div>
                    <p className="text-xs text-stone-400 font-mono">Booking ID: {b.id.slice(0, 8).toUpperCase()}</p>
                    <p className="font-medium">{b.venue_packages?.name}</p>
                    <p className="text-sm text-stone-500">{b.event_date}</p>
                    <p className="text-xs text-stone-400 mt-1">
                      Deposit {inr(b.deposit_amount)} ({b.deposit_tier === "full" ? "full payment" : b.deposit_tier === "50pct" ? "50%" : "20%"})
                    </p>
                  </div>
                  <span
                    className={`text-xs font-medium px-2 py-1 rounded shrink-0 ${
                      b.status === "accepted" ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-800"
                    }`}
                  >
                    {b.status === "accepted" ? "Pending settlement" : "Settled"}
                  </span>
                </div>
              ))}
              {!bookingsLoading && settlementBookings.length === 0 && (
                <p className="text-stone-400 text-sm">No accepted, confirmed, or completed bookings yet.</p>
              )}
            </div>
          </div>
        )}

        {screen === "packages" && (
          <div>
            <h1 className="font-serif text-3xl mb-1">Packages</h1>
            <p className="text-stone-500 text-sm mb-6">
              Manage the packages customers can book at {partnerVenue?.venues?.name}.
            </p>

            {!showPackageForm && (
              <button
                type="button"
                className="bg-accent text-[#170D0B] text-sm font-medium px-4 py-2 rounded mb-6"
                onClick={openNewPackageForm}
              >
                + Add package
              </button>
            )}

            {showPackageForm && packageForm && (
              <form onSubmit={savePackage} className="bg-white border border-stone-200 rounded-lg p-5 flex flex-col gap-4 mb-6">
                <h2 className="font-medium">{editingPackageId ? "Edit package" : "New package"}</h2>
                <div>
                  <label className="text-sm font-medium block mb-1">Package name</label>
                  <input
                    type="text"
                    required
                    className="border border-stone-300 rounded px-3 py-2 text-sm w-full"
                    value={packageForm.name}
                    onChange={(e) => setPackageForm({ ...packageForm, name: e.target.value })}
                  />
                </div>
                <div>
                  <label className="text-sm font-medium block mb-1">Description</label>
                  <textarea
                    rows={2}
                    className="border border-stone-300 rounded px-3 py-2 text-sm w-full"
                    value={packageForm.description}
                    onChange={(e) => setPackageForm({ ...packageForm, description: e.target.value })}
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-sm font-medium block mb-1">Price per person</label>
                    <input
                      type="number"
                      min="0"
                      required
                      className="border border-stone-300 rounded px-3 py-2 text-sm w-full"
                      value={packageForm.price_per_head}
                      onChange={(e) => setPackageForm({ ...packageForm, price_per_head: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium block mb-1">Duration</label>
                    <div className="flex flex-wrap gap-2">
                      {[3, 4, 5, 6].map((h) => (
                        <button
                          type="button"
                          key={h}
                          className={`text-sm px-3 py-1.5 rounded border ${
                            Number(packageForm.duration_hours) === h
                              ? "bg-slate-900 text-white border-slate-900"
                              : "border-stone-300 text-stone-600"
                          }`}
                          onClick={() => setPackageForm({ ...packageForm, duration_hours: h })}
                        >
                          {h} hrs
                        </button>
                      ))}
                      <button
                        type="button"
                        className={`text-sm px-3 py-1.5 rounded border ${
                          Number(packageForm.duration_hours) === 24
                            ? "bg-slate-900 text-white border-slate-900"
                            : "border-stone-300 text-stone-600"
                        }`}
                        onClick={() => setPackageForm({ ...packageForm, duration_hours: 24 })}
                      >
                        Full day
                      </button>
                    </div>
                  </div>
                </div>

                <div>
                  <label className="text-sm font-medium block mb-1">GST</label>
                  <div className="flex gap-2">
                    {[
                      ["included", "Included in price"],
                      ["excluded", "Excluded from price"],
                    ].map(([val, lbl]) => (
                      <button
                        type="button"
                        key={val}
                        className={`text-sm px-3 py-1.5 rounded border ${
                          packageForm.gst_mode === val
                            ? "bg-slate-900 text-white border-slate-900"
                            : "border-stone-300 text-stone-600"
                        }`}
                        onClick={() => setPackageForm({ ...packageForm, gst_mode: val })}
                      >
                        {lbl}
                      </button>
                    ))}
                  </div>
                  {(() => {
                    const price = parseFloat(packageForm.price_per_head);
                    if (!price || price <= 0) return null;
                    const rate = packageForm.includes_alcohol ? 0.18 : 0.05;
                    const pct = Math.round(rate * 100);
                    if (packageForm.gst_mode === "excluded") {
                      return (
                        <p className="text-xs text-stone-500 mt-1.5">
                          Customers see ₹{price.toLocaleString("en-IN")}/head + GST as applicable.
                          The amount they pay is unchanged.
                        </p>
                      );
                    }
                    const base = Math.round((price / (1 + rate)) * 100) / 100;
                    const gst = Math.round((price - base) * 100) / 100;
                    return (
                      <p className="text-xs text-stone-500 mt-1.5">
                        Customers see ₹{base.toLocaleString("en-IN")} base + ₹
                        {gst.toLocaleString("en-IN")} GST ({pct}%) = ₹
                        {price.toLocaleString("en-IN")}/head.
                      </p>
                    );
                  })()}
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-sm font-medium block mb-1">Minimum guests</label>
                    <input
                      type="number"
                      min="1"
                      required
                      className="border border-stone-300 rounded px-3 py-2 text-sm w-full"
                      value={packageForm.min_headcount}
                      onChange={(e) => setPackageForm({ ...packageForm, min_headcount: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium block mb-1">Maximum guests (optional)</label>
                    <input
                      type="number"
                      min="1"
                      className="border border-stone-300 rounded px-3 py-2 text-sm w-full"
                      value={packageForm.max_headcount}
                      onChange={(e) => setPackageForm({ ...packageForm, max_headcount: e.target.value })}
                    />
                  </div>
                </div>
                <div>
                  <label className="text-sm font-medium block mb-1">Inclusions (one per line)</label>
                  <textarea
                    rows={4}
                    placeholder={"DJ & sound system\nStandard decor\nIn-house catering"}
                    className="border border-stone-300 rounded px-3 py-2 text-sm w-full"
                    value={packageForm.inclusions}
                    onChange={(e) => setPackageForm({ ...packageForm, inclusions: e.target.value })}
                  />
                  <p className="text-xs text-stone-400 mt-1">
                    Use this for things not already covered by your quota selections above (e.g. welcome
                    drink, decor, DJ). Avoid restating food or beverage counts you've already set as
                    quotas — customers see both, and mismatched numbers look confusing.
                  </p>
                </div>

                <div>
                  <label className="text-sm font-medium block mb-2">Does this package include alcohol?</label>
                  <div className="flex gap-2">
                    {[
                      ["Yes", true],
                      ["No", false],
                    ].map(([lbl, val]) => (
                      <button
                        type="button"
                        key={lbl}
                        className={`text-sm px-4 py-1.5 rounded-full border ${
                          packageForm.includes_alcohol === val
                            ? "bg-slate-900 text-white border-slate-900"
                            : "border-stone-300 text-stone-600"
                        }`}
                        onClick={() => setPackageForm({ ...packageForm, includes_alcohol: val })}
                      >
                        {lbl}
                      </button>
                    ))}
                  </div>
                  {!packageForm.includes_alcohol && (
                    <p className="text-xs text-stone-400 mt-2">
                      Non-alcoholic package — no beverage quotas. List any mocktails or soft drinks in
                      the Inclusions field above.
                    </p>
                  )}
                </div>

                {(() => {
                  const setQuota = (kind, patch) =>
                    setPackageForm((f) => ({
                      ...f,
                      quotas: { ...f.quotas, [kind]: { ...f.quotas[kind], ...patch } },
                    }));

                  const renderQuotaRow = ([kind, label]) => {
                    const q = packageForm.quotas[kind];
                    if (!q) return null;
                    const isPool = POOL_QUOTA_KINDS.includes(kind);
                    const kindItems = isPool ? itemsForKind(kind) : [];
                    const pickedCount = kindItems.filter((it) =>
                      packageForm.poolItemIds.includes(it.id)
                    ).length;
                    const shortfall = isPool && q.checked && kindItems.length > 0 && q.count > pickedCount;

                    return (
                      <div key={kind} className="border border-stone-200 rounded-lg p-3">
                        <label className="flex items-center gap-2 text-sm font-medium mb-2">
                          <input
                            type="checkbox"
                            checked={q.checked}
                            onChange={(e) => {
                              const checked = e.target.checked;
                              setPackageForm((f) => ({
                                ...f,
                                quotas: { ...f.quotas, [kind]: { ...f.quotas[kind], checked } },
                                // Unchecking a brand-pool quota drops its picked items.
                                poolItemIds:
                                  checked || !isPool
                                    ? f.poolItemIds
                                    : f.poolItemIds.filter(
                                        (id) => !kindItems.some((it) => it.id === id)
                                      ),
                              }));
                            }}
                          />
                          {label}
                        </label>
                        {q.checked && (
                          <>
                            <div className="flex gap-2">
                              {[1, 2, 3, 4, 5].map((n) => (
                                <button
                                  type="button"
                                  key={n}
                                  className={`w-8 h-8 rounded-full border text-sm font-medium ${
                                    q.count === n
                                      ? "bg-accent text-[#170D0B] border-accent"
                                      : "border-stone-300 text-stone-600"
                                  }`}
                                  onClick={() => setQuota(kind, { count: n })}
                                >
                                  {n}
                                </button>
                              ))}
                            </div>

                            {isPool && (
                              <div className="mt-3">
                                {kindItems.length === 0 ? (
                                  <p className="text-xs text-amber-700">
                                    You haven't added any {label} items yet —{" "}
                                    <button
                                      type="button"
                                      className="underline text-accent-ink"
                                      onClick={() => setScreen("menu")}
                                    >
                                      add them in Menu Management
                                    </button>{" "}
                                    first.
                                  </p>
                                ) : (
                                  <>
                                    <p className="text-xs text-stone-500 mb-1.5">
                                      Which {label} items are in this package's pool?{" "}
                                      <span className="text-stone-400">({pickedCount} selected)</span>
                                    </p>
                                    <div className="flex flex-col gap-1">
                                      {kindItems.map((it) => {
                                        const on = packageForm.poolItemIds.includes(it.id);
                                        const disabled = !it.is_available;
                                        return (
                                          <label
                                            key={it.id}
                                            className={`flex items-center gap-2 text-sm ${
                                              disabled ? "cursor-not-allowed" : ""
                                            }`}
                                          >
                                            <input
                                              type="checkbox"
                                              checked={on}
                                              disabled={disabled}
                                              onChange={() =>
                                                setPackageForm((f) => ({
                                                  ...f,
                                                  poolItemIds: on
                                                    ? f.poolItemIds.filter((x) => x !== it.id)
                                                    : [...f.poolItemIds, it.id],
                                                }))
                                              }
                                            />
                                            <span className={disabled ? "text-stone-400" : ""}>
                                              {it.name}
                                              {disabled && " (unavailable)"}
                                            </span>
                                          </label>
                                        );
                                      })}
                                    </div>
                                    {shortfall && (
                                      <p className="text-xs text-rose-600 mt-1.5">
                                        “Any {q.count}” needs at least {q.count} items selected —{" "}
                                        {pickedCount} checked.
                                      </p>
                                    )}
                                  </>
                                )}
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    );
                  };

                  const beverageRows = BEVERAGE_QUOTA_CATEGORIES.filter(([k]) =>
                    POOL_QUOTA_KINDS.includes(k)
                  );
                  return (
                    <>
                      <div>
                        <label className="text-sm font-medium block mb-2">Food quotas</label>
                        <div className="flex flex-col gap-3">{FOOD_QUOTA_CATEGORIES.map(renderQuotaRow)}</div>
                      </div>
                      <div>
                        <label className="text-sm font-medium block mb-2">Beverage quotas</label>
                        {packageForm.includes_alcohol ? (
                          <div className="flex flex-col gap-3">{beverageRows.map(renderQuotaRow)}</div>
                        ) : (
                          <p className="text-xs text-stone-400">
                            None — this is a non-alcoholic package.
                          </p>
                        )}
                        <p className="text-xs text-stone-400 mt-2">
                          Cocktails, mocktails and soft drinks are free-flow (no quota) — describe them
                          in the Inclusions field above.
                        </p>
                      </div>
                    </>
                  );
                })()}

                {packageError && <p className="text-rose-600 text-sm">{packageError}</p>}
                <div className="flex gap-2">
                  <button
                    disabled={packageSaving}
                    className="bg-accent text-[#170D0B] font-medium rounded px-4 py-2 text-sm disabled:opacity-50"
                  >
                    {packageSaving ? "Saving…" : "Save package"}
                  </button>
                  <button type="button" className="text-sm text-stone-500 px-4 py-2" onClick={closePackageForm}>
                    Cancel
                  </button>
                </div>
              </form>
            )}

            {packagesLoading && <p className="text-stone-400 text-sm">Loading…</p>}
            <div className="flex flex-col gap-3">
              {packages.map((p) => (
                <div key={p.id} className="border border-stone-200 rounded-lg p-4 bg-white">
                  <div className="flex items-start justify-between mb-2">
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="font-medium">{p.name}</p>
                        <span
                          className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${
                            p.is_published
                              ? "bg-emerald-100 text-emerald-700"
                              : "bg-stone-200 text-stone-500"
                          }`}
                        >
                          {p.is_published ? "Published" : "Draft"}
                        </span>
                      </div>
                      <p className="text-sm text-stone-500">
                        {inr(p.price_per_head)} / head · {p.min_headcount}–{p.max_headcount || "∞"} guests
                        {p.duration_hours ? ` · ${Number(p.duration_hours) === 24 ? "Full day" : `${p.duration_hours} hrs`}` : ""}
                      </p>
                    </div>
                    <div className="flex gap-3 shrink-0">
                      <button
                        type="button"
                        className={`text-xs ${p.is_published ? "text-stone-500" : "text-emerald-600 font-medium"}`}
                        onClick={() => togglePackagePublished(p)}
                      >
                        {p.is_published ? "Unpublish" : "Publish"}
                      </button>
                      <button type="button" className="text-xs text-accent-ink" onClick={() => openEditPackageForm(p)}>
                        Edit
                      </button>
                      <button type="button" className="text-xs text-rose-600" onClick={() => deletePackage(p.id)}>
                        Delete
                      </button>
                    </div>
                  </div>
                  {p.inclusions?.length > 0 && (
                    <ul className="list-disc pl-4 text-xs text-stone-500 flex flex-col gap-0.5 mb-2">
                      {p.inclusions.map((inc, i) => (
                        <li key={i}>{inc}</li>
                      ))}
                    </ul>
                  )}
                  {p.menu_quota_rules?.length > 0 && (
                    <p className="text-xs text-stone-400">
                      {p.menu_quota_rules
                        .slice()
                        .sort((a, b) => a.category_kind.localeCompare(b.category_kind))
                        .map((q) => `${q.quota_count} ${quotaLabel(q.category_kind, q.quota_count)}`)
                        .join(" · ")}
                    </p>
                  )}
                  {p.package_item_pool?.length > 0 && (
                    <p className="text-xs text-stone-400 mt-1">
                      {POOL_QUOTA_KINDS.map((kind) => {
                        const names = p.package_item_pool
                          .map((r) => menuItemById[r.menu_item_id])
                          .filter((it) => it && it.kind === kind)
                          .map((it) => it.name);
                        if (!names.length) return null;
                        const label = QUOTA_CATEGORIES.find(([k]) => k === kind)?.[1] || kind;
                        return `${label}: ${names.join(", ")}`;
                      })
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  )}
                </div>
              ))}
              {!packagesLoading && packages.length === 0 && (
                <p className="text-stone-400 text-sm">No packages yet — add one above to get started.</p>
              )}
            </div>
          </div>
        )}

        {screen === "profile" && (
          <div className="max-w-lg">
            <h1 className="font-serif text-3xl mb-1">Profile</h1>
            <p className="text-stone-500 text-sm mb-6">Your contact details, shown to customers on accepted bookings.</p>
            <form onSubmit={saveProfile} className="flex flex-col gap-4 bg-white border border-stone-200 rounded-lg p-5">
              <div>
                <label className="text-sm font-medium block mb-1">Full name</label>
                <input
                  type="text"
                  className="border border-stone-300 rounded px-3 py-2 text-sm w-full"
                  value={profileForm.full_name}
                  onChange={(e) => setProfileForm({ ...profileForm, full_name: e.target.value })}
                />
              </div>
              <div>
                <label className="text-sm font-medium block mb-1">Phone</label>
                <input
                  type="tel"
                  className="border border-stone-300 rounded px-3 py-2 text-sm w-full"
                  value={profileForm.phone}
                  onChange={(e) => setProfileForm({ ...profileForm, phone: e.target.value })}
                />
              </div>
              <div>
                <label className="text-sm font-medium block mb-1">Email</label>
                <input
                  type="email"
                  disabled
                  className="border border-stone-200 bg-stone-100 text-stone-500 rounded px-3 py-2 text-sm w-full"
                  value={session.email}
                />
              </div>
              <div>
                <label className="text-sm font-medium block mb-1">Venue</label>
                <input
                  type="text"
                  disabled
                  className="border border-stone-200 bg-stone-100 text-stone-500 rounded px-3 py-2 text-sm w-full"
                  value={partnerVenue?.venues?.name || ""}
                />
              </div>
              {profileError && <p className="text-rose-600 text-sm">{profileError}</p>}
              {profileSaved && <p className="text-emerald-600 text-sm">Profile saved.</p>}
              <button
                disabled={profileLoading}
                className="bg-accent text-[#170D0B] font-medium rounded px-4 py-2 text-sm disabled:opacity-50 self-start"
              >
                {profileLoading ? "Saving…" : "Save changes"}
              </button>
            </form>

            <form
              onSubmit={saveVenueTerms}
              className="flex flex-col gap-3 bg-white border border-stone-200 rounded-lg p-5 mt-6"
            >
              <div>
                <h2 className="text-sm font-medium mb-1">Terms &amp; Conditions</h2>
                <p className="text-stone-500 text-xs">
                  Shown to customers on the Review Menu, before they book any package at{" "}
                  {partnerVenue?.venues?.name || "your venue"}. Plain text — one rule per line.
                </p>
              </div>
              <textarea
                rows={9}
                className="border border-stone-300 rounded px-3 py-2 text-sm w-full leading-relaxed"
                value={venueTerms}
                onChange={(e) => setVenueTerms(e.target.value)}
                placeholder={"Only adults above 21 are served alcohol.\nPackages require a minimum of 20 people."}
              />
              {venueTermsError && <p className="text-rose-600 text-sm">{venueTermsError}</p>}
              {venueTermsSaved && (
                <p className="text-emerald-600 text-sm">Terms &amp; conditions saved.</p>
              )}
              <button
                disabled={venueTermsSaving}
                className="bg-accent text-[#170D0B] font-medium rounded px-4 py-2 text-sm disabled:opacity-50 self-start"
              >
                {venueTermsSaving ? "Saving…" : "Save terms"}
              </button>
            </form>

            <div className="mt-6 flex items-center gap-3">
              <span className="text-xs text-stone-500">Paxo official channels</span>
              <SocialLinks linkClass="text-accent-ink hover:opacity-70" />
            </div>
          </div>
        )}

        {screen === "settings" && (
          <div className="max-w-lg">
            <h1 className="font-serif text-3xl mb-1">Settings</h1>
            <p className="text-stone-500 text-sm mb-6">Manage your account security.</p>
            <form onSubmit={changePassword} className="flex flex-col gap-4 bg-white border border-stone-200 rounded-lg p-5">
              <h2 className="text-sm font-medium">Change password</h2>
              <input
                type="password"
                required
                minLength={6}
                placeholder="New password"
                className="border border-stone-300 rounded px-3 py-2 text-sm w-full"
                value={settingsPassword}
                onChange={(e) => setSettingsPassword(e.target.value)}
              />
              <input
                type="password"
                required
                minLength={6}
                placeholder="Confirm new password"
                className="border border-stone-300 rounded px-3 py-2 text-sm w-full"
                value={settingsPasswordConfirm}
                onChange={(e) => setSettingsPasswordConfirm(e.target.value)}
              />
              {settingsError && <p className="text-rose-600 text-sm">{settingsError}</p>}
              {settingsSaved && <p className="text-emerald-600 text-sm">Password updated.</p>}
              <button
                disabled={settingsLoading}
                className="bg-accent text-[#170D0B] font-medium rounded px-4 py-2 text-sm disabled:opacity-50 self-start"
              >
                {settingsLoading ? "Updating…" : "Update password"}
              </button>
            </form>
          </div>
        )}

        {screen === "help" && (
          <div className="max-w-lg">
            <h1 className="font-serif text-3xl mb-1">Help & support</h1>
            <p className="text-stone-500 text-sm mb-6">We're here if something doesn't look right.</p>
            <div className="bg-white border border-stone-200 rounded-lg p-5 flex flex-col gap-4">
              <div>
                <p className="text-sm font-medium">Email us</p>
                <p className="text-sm text-stone-500">hello.mypaxo@gmail.com</p>
              </div>
              <div className="border-t border-stone-100 pt-4">
                <p className="text-sm font-medium mb-1">Common questions</p>
                <ul className="text-sm text-stone-500 list-disc pl-4 flex flex-col gap-1">
                  <li>How long do I have to respond to a request? 2 hours, after which it auto-rejects.</li>
                  <li>When does my deposit share release? On OTP redemption at the event, not at payment.</li>
                  <li>What if a guest never shares their OTP? It's flagged "Unconfirmed" for PAXO review, not an automatic no-show.</li>
                </ul>
              </div>
            </div>
          </div>
        )}
      </main>

      <nav
        className="fixed bottom-0 left-0 right-0 bg-white border-t border-stone-200 flex justify-around items-stretch z-20 sm:hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        {[
          { key: "dashboard", label: "Requests", Icon: Inbox },
          { key: "upcoming", label: "Upcoming Events", Icon: CalendarClock },
          { key: "menu", label: "Menu Management", Icon: UtensilsCrossed },
          { key: "payments", label: "Payments", Icon: Wallet },
          { key: "profile", label: "Profile", Icon: User },
        ].map(({ key, label, Icon }) => {
          const active = screen === key;
          return (
            <button
              key={key}
              className="flex-1 flex flex-col items-center gap-1 py-2.5"
              onClick={() => { setScreen(key); setMenuOpen(false); }}
            >
              <Icon size={22} strokeWidth={active ? 2.4 : 1.8} className={active ? "text-accent-ink" : "text-stone-400"} />
              <span className={`text-[10px] leading-tight text-center ${active ? "text-accent-ink font-medium" : "text-stone-400"}`}>{label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
