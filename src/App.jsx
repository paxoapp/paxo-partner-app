import { useState, useEffect, useCallback } from "react";
import { Inbox, CalendarClock, UtensilsCrossed, User, Wallet } from "lucide-react";
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

const REJECT_REASONS = [
  "Date not available",
  "Guest count exceeds capacity",
  "Party slot / timing clash",
  "Other",
];

const FOOD_KINDS = ["starter_veg", "starter_non_veg", "main_veg", "main_non_veg", "dessert", "other"];
const BEVERAGE_KINDS = [
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
  ["dessert", "Desserts", 1],
];

const BEVERAGE_QUOTA_CATEGORIES = [
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
  other: ["Other", "Other"],
};

function quotaLabel(kind, count) {
  const forms = QUOTA_LABEL_FORMS[kind];
  if (!forms) return QUOTA_CATEGORIES.find(([k]) => k === kind)?.[1] || kind;
  return count === 1 ? forms[0] : forms[1];
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
    ["dessert", "Dessert"],
    ["wine", "Wine"],
    ["beer", "Beer"],
    ["whisky", "Whisky"],
    ["vodka", "Vodka"],
    ["rum", "Rum"],
    ["gin", "Gin"],
    ["classic_cocktails", "Classic Cocktails"],
    ["mocktails", "Mocktails"],
    ["soft_beverages", "Soft Beverages"],
    ["other", "Other"],
  ];

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
    }
  }, [screen, session, partnerVenue, loadMenu]);

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
    if (!name) return;
    const description = (newItemDesc[categoryId] || "").trim() || null;
    setMenuError("");
    try {
      await sb("/rest/v1/menu_items", {
        method: "POST",
        token: session.token,
        prefer: "return=minimal",
        body: { venue_id: partnerVenue.venue_id, category_id: categoryId, name, description },
      });
      setNewItemName({ ...newItemName, [categoryId]: "" });
      setNewItemDesc({ ...newItemDesc, [categoryId]: "" });
      await loadMenu(session.token, partnerVenue.venue_id);
    } catch (e) {
      setMenuError(e.message);
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
      const [data, pkgs, types] = await Promise.all([
        sb(`/rest/v1/partner_bookings_view?venue_id=eq.${venueId}&order=requested_at.desc`, { token }),
        sb(`/rest/v1/venue_packages?venue_id=eq.${venueId}&select=id,name,price_per_head`, { token }),
        sb(`/rest/v1/booking_types?select=id,name`, { token }),
      ]);
      const pkgById = Object.fromEntries(pkgs.map((p) => [p.id, p]));
      const typeById = Object.fromEntries(types.map((t) => [t.id, t]));
      setBookings(
        data.map((b) => ({
          ...b,
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
        `/rest/v1/venue_packages?venue_id=eq.${venueId}&select=*,menu_quota_rules(*)&order=price_per_head.asc`,
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
    }
  }, [partnerVenue]);

  useEffect(() => {
    if ((screen === "dashboard" || screen === "payments") && session && partnerVenue?.venue_id) {
      loadBookings(session.token, partnerVenue.venue_id);
    }
  }, [screen, session, partnerVenue, loadBookings]);

  useEffect(() => {
    if (screen === "packages" && session && partnerVenue?.venue_id) {
      loadPackages(session.token, partnerVenue.venue_id);
    }
  }, [screen, session, partnerVenue, loadPackages]);

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

  async function acceptBooking(id) {
    setActionError("");
    setActionLoading(id);
    try {
      await sb(`/rest/v1/bookings?id=eq.${id}`, {
        method: "PATCH",
        token: session.token,
        prefer: "return=minimal",
        body: { status: "accepted" },
      });
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
      quotas: {
        ...Object.fromEntries(
          FOOD_QUOTA_CATEGORIES.map(([kind, , def]) => [kind, { checked: true, count: def }])
        ),
        ...Object.fromEntries(
          BEVERAGE_QUOTA_CATEGORIES.map(([kind, , def]) => [kind, { checked: false, count: def }])
        ),
      },
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
      quotas,
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

      const quotaRows = QUOTA_CATEGORIES.filter(([kind]) => {
        if (!packageForm.quotas[kind]?.checked) return false;
        if (
          !packageForm.includes_alcohol &&
          BEVERAGE_KINDS.includes(kind) &&
          !NON_ALCOHOLIC_QUOTA_KINDS.includes(kind)
        ) {
          return false;
        }
        return true;
      }).map(
        ([kind]) => ({
          package_id: packageId,
          category_kind: kind,
          quota_count: packageForm.quotas[kind].count,
        })
      );
      if (quotaRows.length > 0) {
        await sb("/rest/v1/menu_quota_rules", {
          method: "POST",
          token: session.token,
          prefer: "return=minimal",
          body: quotaRows,
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
      <div className="min-h-screen bg-gradient-to-br from-teal-950 via-stone-950 to-stone-900 text-white flex flex-col justify-center px-6 py-16">
        <div className="max-w-sm mx-auto w-full">
          <h1 className="uppercase font-black leading-[0.95] tracking-tight mb-8">
            <span className="block text-4xl">
              <span className="text-white">Paxo</span> <span className="text-teal-400">partner</span>
            </span>
            <span className="block text-2xl text-stone-300 normal-case font-medium mt-1">
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
              className="bg-stone-900 border border-teal-900 rounded-full px-5 py-3.5 text-sm placeholder-stone-500 text-white focus:outline-none focus:border-teal-600"
              value={authEmail}
              onChange={(e) => setAuthEmail(e.target.value)}
            />
            <input
              type="password"
              required
              minLength={6}
              placeholder="Password"
              className="bg-stone-900 border border-teal-900 rounded-full px-5 py-3.5 text-sm placeholder-stone-500 text-white focus:outline-none focus:border-teal-600"
              value={authPassword}
              onChange={(e) => setAuthPassword(e.target.value)}
            />
            {authError && <p className="text-rose-400 text-sm px-1">{authError}</p>}
            {authMode === "login" && (
              <button
                type="button"
                className="text-teal-400 text-xs text-right -mt-1"
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
              className="bg-teal-400 text-stone-900 rounded-full px-5 py-3.5 text-sm font-semibold disabled:opacity-50 mt-1"
            >
              {authLoading ? "Please wait…" : authMode === "login" ? "Sign in" : "Create partner account"}
            </button>
          </form>

          <p className="text-center text-stone-500 text-sm mt-6">
            {authMode === "login" ? "New venue partner?" : "Already onboarded?"}{" "}
            <button
              className="text-teal-400 font-medium"
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
      <div className="min-h-screen bg-gradient-to-br from-teal-950 via-stone-950 to-stone-900 text-white flex flex-col justify-center px-6 py-16">
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
                resetMethod === "email" ? "bg-teal-400 text-stone-900" : "border border-stone-700 text-stone-300"
              }`}
              onClick={() => { setResetMethod("email"); setResetStep("request"); setResetError(""); }}
            >
              Email
            </button>
            <button
              className={`flex-1 rounded-full py-2 text-sm font-medium ${
                resetMethod === "phone" ? "bg-teal-400 text-stone-900" : "border border-stone-700 text-stone-300"
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
                className="bg-stone-900 border border-teal-900 rounded-full px-5 py-3.5 text-sm placeholder-stone-500 text-white focus:outline-none focus:border-teal-600"
                value={resetEmail}
                onChange={(e) => setResetEmail(e.target.value)}
              />
              {resetError && <p className="text-rose-400 text-sm px-1">{resetError}</p>}
              <button
                disabled={resetLoading}
                className="bg-teal-400 text-stone-900 rounded-full px-5 py-3.5 text-sm font-semibold disabled:opacity-50"
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
                className="bg-stone-900 border border-teal-900 rounded-full px-5 py-3.5 text-sm placeholder-stone-500 text-white focus:outline-none focus:border-teal-600"
                value={resetPhone}
                onChange={(e) => setResetPhone(e.target.value)}
              />
              {resetError && <p className="text-rose-400 text-sm px-1">{resetError}</p>}
              <button
                disabled={resetLoading}
                className="bg-teal-400 text-stone-900 rounded-full px-5 py-3.5 text-sm font-semibold disabled:opacity-50"
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
                className="bg-stone-900 border border-teal-900 rounded-full px-5 py-3.5 text-sm placeholder-stone-500 text-white focus:outline-none focus:border-teal-600"
                value={resetOtp}
                onChange={(e) => setResetOtp(e.target.value)}
              />
              <input
                type="password"
                required
                minLength={6}
                placeholder="New password"
                className="bg-stone-900 border border-teal-900 rounded-full px-5 py-3.5 text-sm placeholder-stone-500 text-white focus:outline-none focus:border-teal-600"
                value={resetNewPassword}
                onChange={(e) => setResetNewPassword(e.target.value)}
              />
              {resetError && <p className="text-rose-400 text-sm px-1">{resetError}</p>}
              <button
                disabled={resetLoading}
                className="bg-teal-400 text-stone-900 rounded-full px-5 py-3.5 text-sm font-semibold disabled:opacity-50"
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
      <div className="min-h-screen bg-gradient-to-br from-teal-950 via-stone-950 to-stone-900 text-white flex flex-col justify-center px-6 py-16">
        <div className="max-w-sm mx-auto w-full">
          <h1 className="font-black text-3xl mb-1">Set a new password</h1>
          <p className="text-stone-400 text-sm mb-6">Choose a new password for your account.</p>
          <form onSubmit={submitNewPassword} className="flex flex-col gap-3">
            <input
              type="password"
              required
              minLength={6}
              placeholder="New password"
              className="bg-stone-900 border border-teal-900 rounded-full px-5 py-3.5 text-sm placeholder-stone-500 text-white focus:outline-none focus:border-teal-600"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
            <input
              type="password"
              required
              minLength={6}
              placeholder="Confirm new password"
              className="bg-stone-900 border border-teal-900 rounded-full px-5 py-3.5 text-sm placeholder-stone-500 text-white focus:outline-none focus:border-teal-600"
              value={newPasswordConfirm}
              onChange={(e) => setNewPasswordConfirm(e.target.value)}
            />
            {newPasswordError && <p className="text-rose-400 text-sm px-1">{newPasswordError}</p>}
            <button
              disabled={newPasswordLoading}
              className="bg-teal-400 text-stone-900 rounded-full px-5 py-3.5 text-sm font-semibold disabled:opacity-50"
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
      <div className="min-h-screen bg-gradient-to-br from-teal-950 via-stone-950 to-stone-900 text-white flex flex-col justify-center px-6 py-16">
        <div className="max-w-sm mx-auto w-full">
          <h1 className="font-black text-3xl mb-1">Which venue do you manage?</h1>
          <p className="text-stone-400 text-sm mb-6">
            Link your account to your venue to see its booking requests. (Temporary self-select — this
            will require an admin-issued invite once the Admin console exists.)
          </p>
          <form onSubmit={claimVenue} className="flex flex-col gap-3">
            <select
              required
              className="bg-stone-900 border border-teal-900 rounded-full px-5 py-3.5 text-sm text-white focus:outline-none focus:border-teal-600"
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
              className="bg-teal-400 text-stone-900 rounded-full px-5 py-3.5 text-sm font-semibold disabled:opacity-50"
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
      <div className="min-h-screen bg-gradient-to-br from-teal-950 via-stone-950 to-stone-900 text-white px-6 py-10">
        <div className="max-w-md mx-auto w-full">
          <div className="flex items-center justify-between mb-8">
            <div className="flex items-baseline gap-2">
              <span className="font-black text-2xl">Paxo</span>
              <span className="text-xs text-teal-400 uppercase tracking-wide">partner</span>
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
  const visibleCategories = categories.filter((cat) => menuSectionKinds.includes(cat.kind));
  const settlementBookings = bookings.filter((b) => ["accepted", "confirmed", "completed"].includes(b.status));
  const pendingSettlementTotal = bookings
    .filter((b) => b.status === "accepted")
    .reduce((sum, b) => sum + Number(b.deposit_amount || 0), 0);

  return (
    <div className="min-h-screen bg-stone-50 text-stone-900 pb-20 sm:pb-0">
      <header className="bg-slate-900 text-white">
        <div className="max-w-4xl mx-auto px-5 py-4 flex items-center justify-between">
          <div className="flex items-baseline gap-2">
            <span className="font-serif text-2xl tracking-tight">Paxo</span>
            <span className="text-xs text-teal-400">partner</span>
          </div>
          <div className="flex items-center gap-5 text-sm relative">
            <nav className="hidden sm:flex items-center gap-5">
              <button
                className={`hover:text-teal-400 ${screen === "dashboard" ? "text-teal-400" : "text-slate-300"}`}
                onClick={() => setScreen("dashboard")}
              >
                Requests
              </button>
              <button
                className={`hover:text-teal-400 ${screen === "upcoming" ? "text-teal-400" : "text-slate-300"}`}
                onClick={() => setScreen("upcoming")}
              >
                Upcoming
              </button>
              <button
                className={`hover:text-teal-400 ${screen === "menu" ? "text-teal-400" : "text-slate-300"}`}
                onClick={() => setScreen("menu")}
              >
                Menu
              </button>
              <button
                className={`hover:text-teal-400 ${screen === "payments" ? "text-teal-400" : "text-slate-300"}`}
                onClick={() => setScreen("payments")}
              >
                Payments
              </button>
              <button
                className={`hover:text-teal-400 ${screen === "packages" ? "text-teal-400" : "text-slate-300"}`}
                onClick={() => setScreen("packages")}
              >
                Packages
              </button>
              <button
                className={`hover:text-teal-400 ${screen === "profile" ? "text-teal-400" : "text-slate-300"}`}
                onClick={() => setScreen("profile")}
              >
                Profile
              </button>
            </nav>
            <span className="text-slate-300 hidden sm:inline-flex items-center gap-1.5">
              {partnerVenue?.venues?.name}
              {partnerVenue?.venues?.is_verified && (
                <span className="text-[10px] font-semibold uppercase tracking-wide bg-teal-400/20 text-teal-300 px-1.5 py-0.5 rounded-full">
                  ✓ Verified
                </span>
              )}
            </span>
            <button
              className="w-8 h-8 rounded-full bg-teal-400 text-stone-900 font-semibold flex items-center justify-center text-xs"
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
        <p className="text-teal-600 text-sm font-medium mb-1">Welcome back, {partnerVenue?.venues?.name}</p>
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
          {["pending", "accepted", "rejected", "all"].map((t) => (
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
              <div key={b.id} className="border border-stone-200 rounded-lg p-4 bg-white">
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <p className="font-medium">{b.contact_name}</p>
                    <p className="text-sm text-stone-500">
                      {b.venue_packages?.name} · {b.event_date} at {b.event_time} · {b.headcount} guests
                    </p>
                    <p className="text-xs text-stone-400 font-mono mt-1">Booking ID: {b.id.slice(0, 8).toUpperCase()}</p>
                  </div>
                  <span className={`text-xs font-medium px-2 py-1 rounded ${statusColor[b.status]}`}>
                    {b.status.replace("_", " ")}
                  </span>
                </div>

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
                          onClick={() => acceptBooking(b.id)}
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
                  <p className="text-xs text-stone-400">Reason: {b.rejection_reason}</p>
                )}
              </div>
            );
          })}
        </div>
          </>
        )}

        {screen === "upcoming" && (
          <div>
            <h1 className="font-serif text-3xl mb-1">Upcoming events</h1>
            <p className="text-stone-500 text-sm mb-6">Accepted bookings for {partnerVenue?.venues?.name}.</p>
            {actionError && <p className="text-rose-600 text-sm mb-3">{actionError}</p>}
            <div className="flex flex-col gap-3">
              {bookings.filter((b) => b.status === "accepted").length === 0 && (
                <p className="text-stone-400 text-sm">No accepted bookings yet.</p>
              )}
              {bookings
                .filter((b) => b.status === "accepted")
                .sort((a, b) => new Date(a.event_date) - new Date(b.event_date))
                .map((b) => {
                  const eventPassed = new Date(`${b.event_date}T${b.event_time}`).getTime() < Date.now();
                  return (
                    <div key={b.id} className="border border-stone-200 rounded-lg p-4 bg-white">
                      <div className="flex items-start justify-between mb-2">
                        <div>
                          <p className="font-medium">{b.contact_name}</p>
                          <p className="text-sm text-stone-500">
                            {b.venue_packages?.name} · {b.event_date} at {b.event_time} · {b.headcount} guests
                          </p>
                          <p className="text-xs text-stone-400 font-mono mt-1">Booking ID: {b.id.slice(0, 8).toUpperCase()}</p>
                        </div>
                        <span className="text-xs font-medium px-2 py-1 rounded bg-blue-100 text-blue-800">accepted</span>
                      </div>
                      <p className="text-xs text-stone-500 mb-3">
                        Deposit share held — releases on OTP redemption at the event (payment collection not live yet).
                      </p>
                      {eventPassed ? (
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
            <h1 className="font-serif text-3xl mb-1">Menu & Beverages</h1>
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
              <button className="bg-teal-500 text-white text-sm font-medium px-4 py-2 rounded">Add category</button>
            </form>

            {menuError && <p className="text-rose-600 text-sm mb-3">{menuError}</p>}
            {menuLoading && <p className="text-stone-400 text-sm">Loading…</p>}

            <div className="flex flex-col gap-4">
              {visibleCategories.map((cat) => (
                <div key={cat.id} className="border border-stone-200 rounded-lg p-4 bg-white">
                  <div className="flex items-center justify-between mb-3">
                    <div>
                      <p className="font-medium">{cat.name}</p>
                      <p className="text-xs text-stone-400">{CATEGORY_KINDS.find(([k]) => k === cat.kind)?.[1]}</p>
                    </div>
                    <button className="text-xs text-rose-600" onClick={() => deleteCategory(cat.id)}>
                      Delete category
                    </button>
                  </div>
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
                              className="text-xs text-teal-600"
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
                  <div className="flex flex-col gap-2">
                    <div className="flex gap-2">
                      <input
                        type="text"
                        placeholder="Add item"
                        className="border border-stone-300 rounded px-3 py-1.5 text-sm flex-1"
                        value={newItemName[cat.id] || ""}
                        onChange={(e) => setNewItemName({ ...newItemName, [cat.id]: e.target.value })}
                        onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addItem(cat.id))}
                      />
                      <button className="text-sm border border-stone-300 rounded px-3 py-1.5" onClick={() => addItem(cat.id)}>
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
              ))}
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
                className="bg-teal-500 text-white text-sm font-medium px-4 py-2 rounded mb-6"
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
                      Non-alcoholic package — only Mocktails and Soft Beverages are available below.
                    </p>
                  )}
                </div>

                {(() => {
                  const renderQuotaRow = ([kind, label]) => {
                    const q = packageForm.quotas[kind];
                    if (!q) return null;
                    return (
                      <div key={kind} className="border border-stone-200 rounded-lg p-3">
                        <label className="flex items-center gap-2 text-sm font-medium mb-2">
                          <input
                            type="checkbox"
                            checked={q.checked}
                            onChange={(e) =>
                              setPackageForm({
                                ...packageForm,
                                quotas: { ...packageForm.quotas, [kind]: { ...q, checked: e.target.checked } },
                              })
                            }
                          />
                          {label}
                        </label>
                        {q.checked && (
                          <div className="flex gap-2">
                            {[1, 2, 3, 4, 5].map((n) => (
                              <button
                                type="button"
                                key={n}
                                className={`w-8 h-8 rounded-full border text-sm font-medium ${
                                  q.count === n
                                    ? "bg-teal-500 text-white border-teal-500"
                                    : "border-stone-300 text-stone-600"
                                }`}
                                onClick={() =>
                                  setPackageForm({
                                    ...packageForm,
                                    quotas: { ...packageForm.quotas, [kind]: { ...q, count: n } },
                                  })
                                }
                              >
                                {n}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  };
                  const beverageRows = packageForm.includes_alcohol
                    ? BEVERAGE_QUOTA_CATEGORIES
                    : BEVERAGE_QUOTA_CATEGORIES.filter(([k]) => NON_ALCOHOLIC_QUOTA_KINDS.includes(k));
                  return (
                    <>
                      <div>
                        <label className="text-sm font-medium block mb-2">Food quotas</label>
                        <div className="flex flex-col gap-3">{FOOD_QUOTA_CATEGORIES.map(renderQuotaRow)}</div>
                      </div>
                      <div>
                        <label className="text-sm font-medium block mb-2">Beverage quotas</label>
                        <div className="flex flex-col gap-3">{beverageRows.map(renderQuotaRow)}</div>
                      </div>
                    </>
                  );
                })()}

                {packageError && <p className="text-rose-600 text-sm">{packageError}</p>}
                <div className="flex gap-2">
                  <button
                    disabled={packageSaving}
                    className="bg-teal-500 text-white font-medium rounded px-4 py-2 text-sm disabled:opacity-50"
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
                          className={`text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-full ${
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
                      <button type="button" className="text-xs text-teal-600" onClick={() => openEditPackageForm(p)}>
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
                className="bg-teal-500 text-white font-medium rounded px-4 py-2 text-sm disabled:opacity-50 self-start"
              >
                {profileLoading ? "Saving…" : "Save changes"}
              </button>
            </form>
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
                className="bg-teal-500 text-white font-medium rounded px-4 py-2 text-sm disabled:opacity-50 self-start"
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
          { key: "upcoming", label: "Upcoming", Icon: CalendarClock },
          { key: "menu", label: "Menu", Icon: UtensilsCrossed },
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
              <Icon size={22} strokeWidth={active ? 2.4 : 1.8} className={active ? "text-teal-600" : "text-stone-400"} />
              <span className={`text-[11px] ${active ? "text-teal-600 font-medium" : "text-stone-400"}`}>{label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
