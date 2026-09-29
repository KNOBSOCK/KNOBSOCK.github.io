(function () {
  "use strict";
  const app =
    firebase.apps[0] ||
    firebase.initializeApp({
      apiKey: "AIzaSyAPOqBlb2ZegRCAbBqIyHqziJywB453pTM",
      authDomain: "chat-for-website-efee2.firebaseapp.com",
      projectId: "chat-for-website-efee2",
    });
  const db = app.firestore(),
    stamp = () => firebase.firestore.FieldValue.serverTimestamp();
  const $ = (id) => document.getElementById(id),
    esc = (value) =>
      String(value == null ? "" : value).replace(
        /[&<>"']/g,
        (c) =>
          ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;",
          })[c],
      );
  const time = (v) => (v && v.toMillis ? v.toMillis() : 0);
  const officialBadge = (isOfficial) =>
    isOfficial
      ? '<img class="official-badge" src="/forum-official-badge.png" alt="Official KNOBSOCK account" title="Official KNOBSOCK account">'
      : "";
  const date = (v) =>
    time(v)
      ? new Date(time(v)).toLocaleString([], {
          dateStyle: "short",
          timeStyle: "short",
        })
      : "just now";
  const ref = (name) => db.collection("forum_" + name);
  const DEFAULT_CENSORED_WORDS = [
    "nigger", "nigga", "faggot", "fag", "dyke", "tranny", "chink", "gook",
    "spic", "kike", "wetback", "beaner", "coon", "paki", "retard", "cracker",
    "towelhead", "raghead", "cunt",
  ];
  function buildCensorRegex(word) {
    const subs = {
      a: "[a@4]", e: "[e3]", i: "[i1!]", o: "[o0]", u: "[u]",
      s: "[s$5]", g: "[g9]", t: "[t7]",
    };
    const pattern = word
      .split("")
      .map((c) => subs[c] || c)
      .join("[\\W_]*");
    return new RegExp("\\b" + pattern + "\\b", "gi");
  }
  function buildUsernameCensorRegex(word) {
    const subs = {
      a: "[a@4]", e: "[e3]", i: "[i1!]", o: "[o0]", u: "[u]",
      s: "[s$5]", g: "[g9]", t: "[t7]",
    };
    const pattern = word
      .split("")
      .map((c) => subs[c] || c)
      .join("[\\W_]*");
    return new RegExp(pattern, "i");
  }
  let censorRegexes = DEFAULT_CENSORED_WORDS.map(buildCensorRegex),
    usernameCensorRegexes = DEFAULT_CENSORED_WORDS.map(buildUsernameCensorRegex);
  function usernameContainsCensoredWord(name) {
    return usernameCensorRegexes.some((re) => re.test(name));
  }
  function censorText(text) {
    let result = text;
    censorRegexes.forEach((re) => {
      result = result.replace(re, (m) => "*".repeat(m.length));
    });
    return result;
  }
  db.collection("chat_config")
    .doc("censoredWords")
    .onSnapshot(
      (d) => {
        const data = d.exists ? d.data() : null,
          words =
            data && Array.isArray(data.words) && data.words.length
              ? data.words
              : DEFAULT_CENSORED_WORDS;
        censorRegexes = words.map(buildCensorRegex);
        usernameCensorRegexes = words.map(buildUsernameCensorRegex);
      },
      () => {},
    );
  let device,
    secret,
    username = "",
    ban = null,
    categories = [],
    boards = [],
    threads = [],
    settings = {},
    unsubView = null,
    version = 0,
    threadLimit = 200;
  const status = (s, error = false) => {
    $("forumStatus").textContent = s;
    $("forumStatus").className = error ? "error" : "";
  };
  function saved(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key)) || fallback;
    } catch {
      return fallback;
    }
  }
  function save(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }
  function activeBan() {
    return ban && (!ban.expiresAt || ban.expiresAt > Date.now());
  }
  function blocked() {
    if (activeBan())
      throw Error(
        "You are banned from forums and live chat" +
          (ban.reason ? ": " + ban.reason : "."),
      );
    if (!username) throw Error("Choose a username before posting.");
    if (settings.readOnly) throw Error("The forum is currently read-only.");
  }
  let pendingSecret;
  function credential(batch) {
    blocked();
    secret = localStorage.getItem("forum_write_secret") || secret;
    pendingSecret = crypto.randomUUID() + crypto.randomUUID();
    localStorage.setItem("forum_pending_secret", pendingSecret);
    batch.set(ref("sessions").doc(device), {
      secret: pendingSecret,
      proof: secret,
      deviceId: device,
      username,
      touched: stamp(),
    });
  }
  function savedCredential() {
    if (pendingSecret) {
      secret = pendingSecret;
      localStorage.setItem("forum_write_secret", secret);
      localStorage.removeItem("forum_pending_secret");
      pendingSecret = null;
    }
  }
  async function commit(build) {
    const batch = db.batch();
    credential(batch);
    build(batch);
    await batch.commit();
    savedCredential();
  }
  async function act(button, fn) {
    button.disabled = true;
    status("");
    try {
      await fn();
    } catch (e) {
      status(
        e.code === "permission-denied"
          ? "Could not save. Check your login or ban status, wait 10 seconds between posts, and try again."
          : e.message,
        true,
      );
    } finally {
      button.disabled = false;
    }
  }
  const ZOOM_BTN = { x: 5744, y: 4023, w: 197, h: 120 },
    ART_OVERSHOOT = 1.15,
    ZOOM_FONT_PX = 22.5,
    WIGGLE_RATIO = 0.05,
    WIGGLE_MIN_PX = 1.4;
  let zoomed = false,
    zoomAnimTimer = null;
  function layout() {
    const w = innerWidth,
      h = innerHeight,
      m = w <= 860,
      iw = m ? 4511 : 8000,
      ih = m ? 8000 : 4511,
      s = Math.max(w / iw, h / ih),
      x = (w - iw * s) / 2,
      y = (h - ih * s) / 2;
    const box = m
      ? { x: 0, y: 375, w: 4511, h: 7200 }
      : { x: 1895, y: 375, w: 4130, h: 3050 };
    if (m && zoomed) {
      zoomed = false;
      document.querySelector(".forums-scene").classList.remove("is-zoomed");
    }
    let k = 1,
      ka = 1,
      tx = 0,
      ty = 0,
      tax = 0,
      tay = 0;
    if (zoomed) {
      const bcx = x + (box.x + box.w / 2) * s,
        bcy = y + (box.y + box.h / 2) * s;
      k = Math.max(w / (box.w * s), h / (box.h * s));
      ka = k * ART_OVERSHOOT;
      tx = w / 2 - bcx * k;
      ty = h / 2 - bcy * k;
      tax = w / 2 - bcx * ka;
      tay = h / 2 - bcy * ka;
    }
    const mapX = (v) => tx + v * k,
      mapY = (v) => ty + v * k,
      artX = (v) => tax + v * ka,
      artY = (v) => tay + v * ka;
    let left = Math.max(0, mapX(x + box.x * s)),
      top = Math.max(0, mapY(y + box.y * s)),
      right = Math.min(w, mapX(x + (box.x + box.w) * s)),
      bottom = Math.min(h, mapY(y + (box.y + box.h) * s));
    const fontPx = zoomed
      ? ZOOM_FONT_PX
      : Math.max(14, s * (m ? 171 : 120));
    Object.assign($("terminal").style, {
      left: left + "px",
      top: top + "px",
      width: Math.max(0, right - left) + "px",
      height: Math.max(0, bottom - top) + "px",
      fontSize: fontPx + "px",
    });
    const wiggle = $("feWiggle");
    if (wiggle)
      wiggle.setAttribute(
        "scale",
        Math.max(WIGGLE_MIN_PX, fontPx * WIGGLE_RATIO).toFixed(2),
      );
    const art = document.querySelector(".scene-art");
    if (art)
      Object.assign(art.style, {
        left: artX(x) + "px",
        top: artY(y) + "px",
        width: iw * s * ka + "px",
        height: ih * s * ka + "px",
      });
    const trigger = $("crtZoomTrigger");
    if (trigger)
      Object.assign(trigger.style, {
        left: artX(x + ZOOM_BTN.x * s) + "px",
        top: artY(y + ZOOM_BTN.y * s) + "px",
        width: ZOOM_BTN.w * s * ka + "px",
        height: ZOOM_BTN.h * s * ka + "px",
        borderRadius: ZOOM_BTN.h * s * ka * 0.26 + "px",
      });
    const scaleAttr = (id, attr, base) => {
      const el = $(id);
      if (el) el.setAttribute(attr, base * s * k);
    };
    scaleAttr("feBulgeX", "scale", 460);
    scaleAttr("feBulgeY", "scale", 460);
    positionScrollRail();
    syncScroll();
  }
  function setZoom(next) {
    if (zoomed === next) return;
    if (next && innerWidth <= 860) return;
    zoomed = next;
    const scene = document.querySelector(".forums-scene");
    scene.classList.add("is-zoom-animating");
    scene.classList.toggle("is-zoomed", zoomed);
    clearTimeout(zoomAnimTimer);
    zoomAnimTimer = setTimeout(() => {
      scene.classList.remove("is-zoom-animating");
      positionScrollRail();
      syncScroll();
    }, 520);
    void scene.offsetWidth;
    layout();
  }
  const scroll = $("forumScroll"),
    track = $("scrollTrack"),
    thumb = $("scrollThumb"),
    rail = $("scrollRail");
  let railHideTimer, railHovered = false, railDragging = false;
  function positionScrollRail() {
    const terminal = $("terminal");
    const logo = terminal && terminal.querySelector(".forum-logo");
    if (!terminal || !logo) return;
    if (zoomed) {
      rail.style.marginTop = "0px";
      return;
    }
    const top = Math.max(0, logo.offsetTop);
    rail.style.marginTop = Math.round(top) + "px";
  }
  function hideRailSoon() {
    clearTimeout(railHideTimer);
    railHideTimer = setTimeout(() => {
      if (!railHovered && !railDragging) rail.classList.remove("is-visible");
    }, 900);
  }
  function showRail() {
    rail.classList.add("is-visible");
    hideRailSoon();
  }
  rail.addEventListener("pointerenter", () => {
    railHovered = true;
    showRail();
  });
  rail.addEventListener("pointerleave", () => {
    railHovered = false;
    hideRailSoon();
  });
  function syncScroll() {
    const max = scroll.scrollHeight - scroll.clientHeight,
      top = Math.min(max, Math.max(0, scroll.scrollTop)),
      h = track.clientHeight,
      th = Math.min(
        h,
        Math.max(
          22,
          (h * scroll.clientHeight) / Math.max(1, scroll.scrollHeight),
        ),
      );
    thumb.style.height = th + "px";
    thumb.style.top = (max > 0 ? ((h - th) * top) / max : 0) + "px";
    thumb.setAttribute(
      "aria-valuenow",
      String(Math.round(max > 0 ? (top / max) * 100 : 0)),
    );
  }
  scroll.addEventListener(
    "scroll",
    () => {
      syncScroll();
      showRail();
    },
    { passive: true },
  );
  new ResizeObserver(syncScroll).observe(scroll);
  new ResizeObserver(positionScrollRail).observe(document.querySelector(".forum-logo"));
  new ResizeObserver(positionScrollRail).observe(document.querySelector(".terminal-content"));
  const forumLogo = document.querySelector(".forum-logo img");
  if (forumLogo) forumLogo.addEventListener("load", positionScrollRail);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(positionScrollRail);
  new MutationObserver(syncScroll).observe($("forumView"), {
    childList: true,
    subtree: true,
  });
  $("scrollUp").onclick = () => scroll.scrollBy({ top: -120 });
  $("scrollDown").onclick = () => scroll.scrollBy({ top: 120 });
  track.addEventListener("pointerdown", (e) => {
    if (e.target === thumb) return;
    const r = track.getBoundingClientRect();
    scroll.scrollTop =
      ((e.clientY - r.top) / r.height) *
      (scroll.scrollHeight - scroll.clientHeight);
  });
  thumb.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    thumb.setPointerCapture(e.pointerId);
    railDragging = true;
    showRail();
    const y = e.clientY,
      start = scroll.scrollTop;
    const move = (m) => {
      scroll.scrollTop =
        start +
        ((m.clientY - y) * (scroll.scrollHeight - scroll.clientHeight)) /
          Math.max(1, track.clientHeight - thumb.clientHeight);
    };
    const end = () => {
      railDragging = false;
      hideRailSoon();
      thumb.removeEventListener("pointermove", move);
      thumb.removeEventListener("pointerup", end);
      thumb.removeEventListener("pointercancel", end);
    };
    thumb.addEventListener("pointermove", move);
    thumb.addEventListener("pointerup", end);
    thumb.addEventListener("pointercancel", end);
  });
  thumb.addEventListener("keydown", (e) => {
    const amounts = {
      ArrowDown: 40,
      ArrowUp: -40,
      PageDown: scroll.clientHeight * 0.8,
      PageUp: -scroll.clientHeight * 0.8,
    };
    if (e.key in amounts) {
      e.preventDefault();
      scroll.scrollTop += amounts[e.key];
    }
    if (e.key === "Home") {
      e.preventDefault();
      scroll.scrollTop = 0;
    }
    if (e.key === "End") {
      e.preventDefault();
      scroll.scrollTop = scroll.scrollHeight;
    }
  });
  addEventListener("resize", layout);
  if (window.visualViewport) visualViewport.addEventListener("resize", layout);
  const zoomTrigger = $("crtZoomTrigger");
  if (zoomTrigger)
    zoomTrigger.addEventListener("click", (e) => {
      e.stopPropagation();
      setZoom(true);
    });
  const zoomExit = $("crtExit");
  if (zoomExit) zoomExit.addEventListener("click", () => setZoom(false));
  addEventListener("keydown", (e) => {
    if (zoomed && (e.key === "Escape" || e.key === "Esc")) setZoom(false);
  });
  layout();
  showRail();
  let deviceData = null,
    accountLinked = false,
    accountMenuOpen = false,
    accountFlow = null;
  function renderIdentity() {
    if (!activeBan() && !username) accountMenuOpen = false;
    $("identity").innerHTML = activeBan()
      ? '<span class="error">Banned from live chat and forums. ' +
        esc(ban.reason || "") +
        (ban.expiresAt
          ? " Until " + esc(new Date(ban.expiresAt).toLocaleString())
          : "") +
        "</span>"
      : username
        ? 'Logged in as <button type="button" class="identity-name" id="identityName" aria-haspopup="true" aria-expanded="' +
          accountMenuOpen +
          '">' +
          esc(username) +
          ' ▾</button><div class="account-menu' +
          (accountMenuOpen ? " is-open" : "") +
          '" id="accountMenu"><div class="account-menu-heading">' +
          esc(username) +
          '</div><a href="#profile/' +
          encodeURIComponent(username.toLowerCase()) +
          '">My profile</a>' +
          (accountLinked
            ? '<button type="button" id="accountSignOut">Sign out</button>'
            : '<a href="#account/link">Link email to account</a>') +
          "</div>"
        : '<a href="#signup">What are you gonna call yourself? Sign up →</a>';
    const nameBtn = $("identityName");
    if (nameBtn)
      nameBtn.onclick = (e) => {
        e.stopPropagation();
        accountMenuOpen = !accountMenuOpen;
        renderIdentity();
      };
    const signOutBtn = $("accountSignOut");
    if (signOutBtn)
      signOutBtn.onclick = (e) => {
        e.stopPropagation();
        act(signOutBtn, async () => {
          signOutBtn.textContent = "Signing out…";
          await signOutAccount();
        });
      };
  }
  document.addEventListener("click", (e) => {
    if (!accountMenuOpen) return;
    if (e.target.closest && e.target.closest("#accountMenu")) return;
    accountMenuOpen = false;
    renderIdentity();
  });
  const supa = window.supabase
    ? window.supabase.createClient(
        "https://ypofuhazhxtzvtywguew.supabase.co",
        "sb_publishable_IJH4--fqVrrTrxG7Ou1JKw_G2WPOiIO",
        { auth: { flowType: "implicit" } },
      )
    : null;
  const PENDING_ACCOUNT_LINK_KEY = "chat_pending_account_link";
  function accountErrorMessage(e, fallback) {
    const code = e && e.code;
    if (code === "not-found") return "No KNOBSOCK username is linked to this email yet.";
    if (code === "already-exists") return e.message || "That account is already linked.";
    if (code === "unauthenticated") return "That sign-in link has expired. Please request another one.";
    return (e && e.message) || fallback;
  }
  async function accountCall(action, payload) {
    if (!supa) throw Error("Email sign-in is unavailable right now.");
    const result = await supa.functions.invoke("chat-account", {
      body: Object.assign({ action }, payload),
    });
    if (!result.error) return result.data;
    let details = null;
    try {
      details = await result.error.context.json();
    } catch {}
    const e = Error(
      (details && details.error) || result.error.message || "Account service unavailable.",
    );
    e.code = details && details.code;
    throw e;
  }
  async function sendAccountEmail(raw, linking) {
    if (!supa) throw Error("Email sign-in is unavailable right now.");
    const email = String(raw || "").trim();
    if (!/^\S+@\S+\.\S+$/.test(email)) throw Error("Enter a valid email address.");
    if (linking) localStorage.setItem(PENDING_ACCOUNT_LINK_KEY, "1");
    const result = await supa.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo:
          location.origin +
          "/livestream-chat-widget.html?" +
          (linking ? "account-link-callback=1" : "account-restore-callback=1") +
          "&return=forums",
        shouldCreateUser: true,
      },
    });
    if (result.error) {
      if (linking) localStorage.removeItem(PENDING_ACCOUNT_LINK_KEY);
      throw result.error;
    }
    return email;
  }
  async function saveDeviceTapInToAccount() {
    const d = deviceData || {};
    if ((!d.lastTapInAt && !d.fightWins) || !username) return;
    const account = db.collection("chat_usernames").doc(username.toLowerCase());
    const snap = await account.get();
    const saved = snap.exists ? snap.data() : {};
    const update = {};
    if (d.lastTapInAt && (Number(saved.lastTapInAt) || 0) < Number(d.lastTapInAt)) {
      update.lastTapInAt = d.lastTapInAt;
      update.streak = d.streak || 0;
      update.streakDay = d.streakDay || null;
    }
    if ((Number(d.fightWins) || 0) > (Number(saved.fightWins) || 0)) update.fightWins = Number(d.fightWins);
    if (Object.keys(update).length) await account.set(update, { merge: true });
  }
  function clearDeviceFields(names) {
    const del = firebase.firestore.FieldValue.delete(),
      update = {};
    names.forEach((n) => (update[n] = del));
    return db.collection("chat_devices").doc(device).update(update);
  }
  const TAP_IN_FIELDS = ["lastTapInAt", "streak", "streakDay", "fightWins"];
  async function signOutAccount() {
    await saveDeviceTapInToAccount();
    await clearDeviceFields(
      ["username", "accountId", "accountLinkedAt", "restoredAt"].concat(TAP_IN_FIELDS),
    );
    if (supa) await supa.auth.signOut().catch(() => {});
    localStorage.removeItem("chat_last_username");
    localStorage.removeItem(PENDING_ACCOUNT_LINK_KEY);
    accountMenuOpen = false;
    goHome();
    notice("Signed out. Sign in with email to switch accounts.");
  }
  let accountNotice = null;
  function notice(text) {
    accountNotice = { text, at: Date.now() };
    status(text);
  }
  async function finishAccountCode(linking, email, raw) {
    const code = String(raw || "").replace(/\s/g, "");
    if (!/^\d{6,10}$/.test(code)) throw Error("Enter the code from the email.");
    const result = await supa.auth.verifyOtp({ email, token: code, type: "email" });
    if (result.error) throw Error("That code is wrong or has expired.");
    if (linking) {
      await accountCall("link", { username, clientId: device });
      localStorage.removeItem(PENDING_ACCOUNT_LINK_KEY);
      accountFlow = null;
      goHome();
      notice("Email linked. You can sign in with it anytime.");
      return;
    }
    if (username && deviceData && (deviceData.lastTapInAt || deviceData.fightWins)) {
      await saveDeviceTapInToAccount();
      await clearDeviceFields(TAP_IN_FIELDS);
    }
    let restored;
    try {
      restored = await accountCall("restore", { clientId: device });
    } catch (e) {
      if (e && e.code === "not-found") {
        await supa.auth.signOut().catch(() => {});
        accountFlow = null;
      }
      throw e;
    }
    if (!restored || !restored.username) throw Error("Could not restore your linked account.");
    localStorage.setItem("chat_last_username", restored.username);
    accountFlow = null;
    goHome();
  }
  function goHome() {
    if (location.hash && location.hash !== "#") location.hash = "";
    else renderRoute();
  }
  const PROFILE_BG = "#000000",
    PROFILE_BORDER = "#00c600",
    PROFILE_CACHE_MS = 60000,
    RANK_CACHE_MS = 300000,
    COUNT_URL =
      "https://firestore.googleapis.com/v1/projects/chat-for-website-efee2/databases/(default)/documents:runAggregationQuery?key=AIzaSyAPOqBlb2ZegRCAbBqIyHqziJywB453pTM",
    REPORT_REASONS = ["Inappropriate photo", "Harassment or hate", "Spam", "Something else"],
    profileCache = {},
    rankCache = {};
  const dayKey = (t) => new Date(t).toISOString().slice(0, 10);
  const safeHex = (v, fallback) => (/^#[0-9a-f]{6}$/i.test(String(v || "")) ? v : fallback);
  const safePhoto = (v) =>
    /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(String(v || "")) ? v : "";
  function inkFor(hex) {
    const n = parseInt(hex.slice(1), 16),
      ch = (v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      };
    return 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255) > 0.4
      ? "#000000"
      : "#ffffff";
  }
  function profileStyle(p) {
    const bg = safeHex(p.cardColor, PROFILE_BG),
      border = safeHex(p.borderColor, PROFILE_BORDER);
    return (
      "--card-bg:" + bg + ";--card-border:" + border + ";--card-ink:" + inkFor(bg) +
      ";--border-ink:" + inkFor(border)
    );
  }
  function normalizeSong(raw) {
    let url;
    try {
      url = new URL(String(raw || "").trim());
    } catch {
      return "";
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    const host = url.hostname.toLowerCase();
    if (host === "m.soundcloud.com" || host === "www.soundcloud.com") url.hostname = "soundcloud.com";
    if (url.hostname !== "soundcloud.com" && url.hostname !== "on.soundcloud.com") return "";
    if (!url.pathname.split("/").filter(Boolean).length) return "";
    url.protocol = "https:";
    url.hash = "";
    if (url.hostname === "soundcloud.com") url.search = "";
    return url.toString();
  }
  function songEmbed(song) {
    return (
      "https://w.soundcloud.com/player/?url=" + encodeURIComponent(song) +
      "&color=%2300c600&auto_play=false&hide_related=true&show_comments=false&show_user=true&show_reposts=false&show_teaser=false&visual=false&show_artwork=false"
    );
  }
  function lastOnline(data, key) {
    if (username && key === username.toLowerCase()) return "Online now";
    const ts = Math.max(Number(data.lastSeenAt) || 0, Number(data.lastTapInAt) || 0);
    if (!ts) return "A while ago";
    const diff = Date.now() - ts;
    if (diff < 300000) return "Online now";
    if (diff < 3600000) return Math.round(diff / 60000) + " min ago";
    if (diff < 86400000) {
      const h = Math.round(diff / 3600000);
      return h + (h === 1 ? " hour ago" : " hours ago");
    }
    if (diff < 604800000) {
      const d = Math.round(diff / 86400000);
      return d + (d === 1 ? " day ago" : " days ago");
    }
    return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
  }
  function profileStats(data) {
    const now = Date.now(),
      fresh = data.streakDay === dayKey(now) || data.streakDay === dayKey(now - 86400000);
    return {
      streak: fresh ? Math.max(0, Number(data.streak) || 0) : 0,
      wins: Math.max(0, Number(data.fightWins) || 0),
    };
  }
  async function loadProfile(key, fresh) {
    const hit = profileCache[key],
      mine = username && key === username.toLowerCase();
    if (!fresh && hit && (mine || Date.now() - hit.at < PROFILE_CACHE_MS)) return hit.data;
    const snap = await db.collection("chat_usernames").doc(key).get(),
      data = snap.exists ? snap.data() : null;
    profileCache[key] = { data, at: Date.now() };
    return data;
  }
  function countUsernames(where) {
    return fetch(COUNT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        structuredAggregationQuery: {
          structuredQuery: { from: [{ collectionId: "chat_usernames" }], where },
          aggregations: [{ alias: "n", count: {} }],
        },
      }),
    })
      .then((r) => r.json())
      .then((rows) => {
        const row = Array.isArray(rows) && rows.find((r) => r && r.result),
          field = row && row.result.aggregateFields && row.result.aggregateFields.n;
        if (!field || field.integerValue == null) throw Error("count unavailable");
        return parseInt(field.integerValue, 10) || 0;
      });
  }
  async function loadRanks(key, stats) {
    const hit = rankCache[key];
    if (hit && Date.now() - hit.at < RANK_CACHE_MS && hit.streak === stats.streak && hit.wins === stats.wins)
      return hit;
    const now = Date.now();
    const [a, b] = await Promise.all([
      stats.streak > 0
        ? countUsernames({
            compositeFilter: {
              op: "AND",
              filters: [
                { fieldFilter: { field: { fieldPath: "streak" }, op: "GREATER_THAN", value: { integerValue: String(stats.streak) } } },
                { fieldFilter: { field: { fieldPath: "streakDay" }, op: "IN", value: { arrayValue: { values: [{ stringValue: dayKey(now) }, { stringValue: dayKey(now - 86400000) }] } } } },
              ],
            },
          }).catch(() => null)
        : null,
      stats.wins > 0
        ? countUsernames({
            fieldFilter: { field: { fieldPath: "fightWins" }, op: "GREATER_THAN", value: { integerValue: String(stats.wins) } },
          }).catch(() => null)
        : null,
    ]);
    const ranks = {
      streak: stats.streak,
      wins: stats.wins,
      streakRank: a == null ? null : a + 1,
      winsRank: b == null ? null : b + 1,
      at: Date.now(),
    };
    rankCache[key] = ranks;
    return ranks;
  }
  function markSeen() {
    if (!username) return;
    const key = username.toLowerCase(),
      storeKey = "knobsock_last_seen_" + key;
    let last = 0;
    try {
      last = Number(localStorage.getItem(storeKey)) || 0;
    } catch {}
    if (Date.now() - last < 1800000) return;
    try {
      localStorage.setItem(storeKey, String(Date.now()));
    } catch {}
    db.collection("chat_usernames").doc(key).set({ lastSeenAt: Date.now() }, { merge: true }).catch(() => {});
  }
  function shrinkPhoto(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file),
        img = new Image();
      img.onload = () => {
        const size = 192,
          side = Math.min(img.naturalWidth, img.naturalHeight),
          canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#000000";
        ctx.fillRect(0, 0, size, size);
        ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
        URL.revokeObjectURL(url);
        let q = 0.82,
          out = canvas.toDataURL("image/jpeg", q);
        while (out.length > 40000 && q > 0.4) {
          q -= 0.1;
          out = canvas.toDataURL("image/jpeg", q);
        }
        resolve(out);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(Error("That image could not be opened."));
      };
      img.src = url;
    });
  }
  const onlineHtml = (label) =>
    label === "Online now"
      ? '<span class="online-now">Online now<span class="online-now-icon"><img src="/IMG_2156.gif?v=1" alt=""></span></span>'
      : esc(label);
  const photoHtml = (photo, name) =>
    photo ? '<img src="' + photo + '" alt="">' : esc(String(name || "?").charAt(0).toUpperCase());
  const reportedKey = (key) => "knobsock_reported_" + key + "_" + device;
  function hasReported(key) {
    try {
      return localStorage.getItem(reportedKey(key)) === "1";
    } catch {
      return false;
    }
  }
  function renderReport(key, name) {
    const box = $("profileReport");
    if (!box) return;
    if (hasReported(key)) {
      box.innerHTML = '<p class="profile-empty">Reported. Thanks for letting us know.</p>';
      return;
    }
    box.innerHTML = '<button type="button" id="profileReportBtn">Report profile</button>';
    $("profileReportBtn").onclick = () => {
      box.innerHTML =
        '<label>Why are you reporting ' + esc(name) + '?<select id="profileReportReason">' +
        REPORT_REASONS.map((r) => "<option>" + esc(r) + "</option>").join("") +
        '</select></label><div class="profile-actions"><button type="button" id="profileReportSend">Send report</button><button type="button" id="profileReportCancel">Cancel</button></div>';
      $("profileReportCancel").onclick = () => renderReport(key, name);
      $("profileReportSend").onclick = () =>
        act($("profileReportSend"), async () => {
          try {
            await db.collection("chat_profile_reports").doc(key + "__" + device).set({
              username: String(name).slice(0, 24),
              usernameKey: key,
              reporterDevice: device,
              reporterUsername: username,
              reason: $("profileReportReason").value.slice(0, 200),
              createdAt: stamp(),
            });
          } catch {
            throw Error("Could not send the report. Try again.");
          }
          try {
            localStorage.setItem(reportedKey(key), "1");
          } catch {}
          renderReport(key, name);
        });
    };
  }
  async function profilePage(view, key, editing, token) {
    view.innerHTML = "Loading profile…";
    const data = await loadProfile(key);
    if (token !== version) return;
    if (!data) {
      view.innerHTML = '<div class="breadcrumbs"><a href="#">Boards</a></div><h1>Member not found</h1>';
      return;
    }
    const name = data.username || key,
      mine = username && key === username.toLowerCase();
    if (editing && mine) return profileEdit(view, key, name, data);
    const p = data.profile || {},
      song = normalizeSong(p.song),
      stats = profileStats(data),
      photo = safePhoto(p.photo),
      mineThreads = ordered(visibleThreads().filter((t) => String(t.username || "").toLowerCase() === key));
    view.innerHTML =
      '<div class="breadcrumbs"><a href="#">Boards</a></div><div class="profile-page" style="' + profileStyle(p) + '">' +
      '<div class="profile-banner"><h1>' + esc(name) + '</h1><span>' + onlineHtml(lastOnline(data, key)) + "</span></div>" +
      '<div class="profile-grid"><aside class="profile-side">' +
      '<div class="profile-photo">' + photoHtml(photo, name) + "</div>" +
      '<table class="profile-facts"><tr><th>Favorite color</th><td>' + (p.favoriteColor ? esc(censorText(p.favoriteColor)) : "—") +
      "</td></tr><tr><th>Last online</th><td>" + onlineHtml(lastOnline(data, key)) +
      "</td></tr><tr><th>Tap-in streak</th><td>" + stats.streak + (stats.streak === 1 ? " day" : " days") +
      ' <span class="profile-rank" id="profileStreakRank"></span></td></tr><tr><th>Knockouts</th><td>' + stats.wins +
      ' <span class="profile-rank" id="profileKoRank"></span></td></tr></table>' +
      (mine
        ? '<div class="profile-actions">' +
          (accountLinked
            ? '<a class="profile-btn" href="#profile/' + encodeURIComponent(key) + '/edit">[ Edit profile ]</a>'
            : '<a class="profile-btn" href="#account/link">[ Link email to edit profile ]</a>') +
          "</div>"
        : username
          ? '<div class="profile-actions" id="profileReport"></div>'
          : "") +
      '</aside><div class="profile-main">' +
      '<section class="profile-box"><h2>About me</h2><div class="profile-box-body">' +
      (p.about ? '<p class="profile-about">' + esc(censorText(p.about)) + "</p>" : '<p class="profile-empty">Nothing here yet.</p>') +
      '</div></section><section class="profile-box"><h2>Song</h2><div class="profile-box-body">' +
      (song
        ? '<div class="profile-song"><iframe title="' + esc(name) + '’s song" allow="autoplay" loading="lazy" src="' + esc(songEmbed(song)) + '"></iframe></div>'
        : '<p class="profile-empty">No song yet.</p>') +
      '</div></section><section class="profile-box"><h2>' + esc(name) + "’s threads (" + mineThreads.length + ')</h2><div class="profile-box-body">' +
      threadTable(mineThreads) +
      "</div></section></div></div></div>";
    if (!mine && username) renderReport(key, name);
    if (stats.streak || stats.wins)
      loadRanks(key, stats).then((r) => {
        if (token !== version) return;
        if (r.streakRank && $("profileStreakRank")) $("profileStreakRank").textContent = "#" + r.streakRank;
        if (r.winsRank && $("profileKoRank")) $("profileKoRank").textContent = "#" + r.winsRank;
      });
  }
  async function profileEdit(view, key, name, data) {
    const signedIn = supa ? (await supa.auth.getSession()).data.session : null;
    if (!accountLinked || !signedIn) {
      view.innerHTML =
        '<div class="breadcrumbs"><a href="#profile/' + encodeURIComponent(key) + '">Back to profile</a></div>' +
        "<h1>Edit profile</h1><p>" +
        (accountLinked
          ? 'Sign in with your email on this browser to edit your profile. <a href="#account/signin">Sign in with email →</a>'
          : 'Link your email to your username to edit your profile. <a href="#account/link">Link email →</a>') +
        "</p>";
      return;
    }
    const p = Object.assign({}, data.profile || {});
    let photo = safePhoto(p.photo);
    const bg = safeHex(p.cardColor, PROFILE_BG),
      border = safeHex(p.borderColor, PROFILE_BORDER);
    view.innerHTML =
      '<div class="breadcrumbs"><a href="#profile/' + encodeURIComponent(key) + '">Back to profile</a></div>' +
      '<div class="profile-page" id="profilePreview" style="' + profileStyle(p) + '">' +
      '<div class="profile-banner"><h1>Edit profile</h1><span>' + esc(name) + "</span></div>" +
      '<form class="profile-edit" id="profileForm">' +
      '<label>Photo</label><div class="profile-photo-row"><div class="profile-photo" id="profilePhotoPreview">' + photoHtml(photo, name) +
      '</div><label class="profile-btn">[ Choose photo ]<input type="file" id="profilePhotoInput" accept="image/*" hidden></label>' +
      '<button type="button" id="profilePhotoRemove">Remove</button></div>' +
      '<label>Favorite color<input id="profileFavColor" maxlength="30" autocomplete="off" value="' + esc(p.favoriteColor || "") + '"></label>' +
      '<label>Song<input id="profileSong" maxlength="300" inputmode="url" autocomplete="off" placeholder="https://soundcloud.com/artist/song" value="' + esc(p.song || "") + '"><small>Paste a link to a track on SoundCloud.</small></label>' +
      '<label>About me<textarea id="profileAbout" maxlength="300">' + esc(p.about || "") + "</textarea></label>" +
      '<div class="profile-colors"><label><input type="color" id="profileBg" value="' + bg + '"> Background color</label>' +
      '<label><input type="color" id="profileBorder" value="' + border + '"> Border color</label></div>' +
      '<div class="profile-actions"><button>Save</button><a class="profile-btn" href="#profile/' + encodeURIComponent(key) + '">[ Cancel ]</a></div>' +
      "</form></div>";
    const preview = $("profilePreview"),
      recolor = () =>
        preview.setAttribute("style", profileStyle({ cardColor: $("profileBg").value, borderColor: $("profileBorder").value }));
    $("profileBg").oninput = recolor;
    $("profileBorder").oninput = recolor;
    $("profilePhotoInput").onchange = async function () {
      const file = this.files && this.files[0];
      if (!file) return;
      status("Loading photo…");
      try {
        photo = await shrinkPhoto(file);
        $("profilePhotoPreview").innerHTML = photoHtml(photo, name);
        status("");
      } catch (e) {
        status(e.message, true);
      }
      this.value = "";
    };
    $("profilePhotoRemove").onclick = () => {
      photo = "";
      $("profilePhotoPreview").innerHTML = photoHtml("", name);
    };
    $("profileForm").onsubmit = (e) => {
      e.preventDefault();
      act($("profileForm").querySelector("button:not([type])"), async () => {
        const rawSong = $("profileSong").value.trim(),
          song = rawSong ? normalizeSong(rawSong) : "";
        if (rawSong && !song) throw Error("That doesn’t look like a SoundCloud link.");
        const next = {
          photo,
          favoriteColor: $("profileFavColor").value.trim().slice(0, 30),
          song,
          about: $("profileAbout").value.trim().slice(0, 300),
          cardColor: safeHex($("profileBg").value, PROFILE_BG),
          borderColor: safeHex($("profileBorder").value, PROFILE_BORDER),
          updatedAt: Date.now(),
        };
        let result;
        try {
          result = await accountCall("saveProfile", { clientId: device, username, profile: next });
        } catch (err) {
          throw Error(
            err && err.code === "unauthenticated"
              ? "Your email sign-in expired. Sign in with email again to save."
              : (err && err.message) || "Could not save your profile.",
          );
        }
        profileCache[key] = {
          data: Object.assign({}, data, { profile: (result && result.profile) || next }),
          at: Date.now(),
        };
        notice("Profile saved.");
        location.hash = "profile/" + encodeURIComponent(key);
      });
    };
  }
  function accountView(view, mode) {
    const linking = mode === "link" && !!username;
    if (!accountFlow || accountFlow.mode !== (linking ? "link" : "signin"))
      accountFlow = { mode: linking ? "link" : "signin", email: "" };
    const heading = linking
      ? "Link your email to your username"
      : "Sign in to your linked username";
    if (accountFlow.email) {
      view.innerHTML =
        '<div class="login-gate"><form class="compose account-form" id="accountForm"><h1>' +
        heading +
        "</h1><p>We sent an email to " +
        esc(accountFlow.email) +
        '. Enter the code from it here, or tap the link in the email.</p><label>Code<span class="prompt-row"><input name="code" maxlength="10" required autocomplete="one-time-code" inputmode="numeric"><span class="cursor-blink" aria-hidden="true">█</span></span></label><div class="account-actions"><button>' +
        (linking ? "Link email" : "Sign in") +
        '</button><button type="button" id="accountBack">Back</button></div></form></div>';
      $("accountForm").onsubmit = (e) => {
        e.preventDefault();
        const button = $("accountForm").querySelector("button");
        act(button, () =>
          finishAccountCode(linking, accountFlow.email, $("accountForm").code.value).catch(
            (err) => {
              if (!accountFlow) renderRoute();
              throw Error(accountErrorMessage(err, "Could not sign in with that code."));
            },
          ),
        );
      };
    } else {
      view.innerHTML =
        '<div class="login-gate"><form class="compose account-form" id="accountForm"><h1>' +
        heading +
        "</h1><p>" +
        (linking
          ? "Link your email so you don’t lose access to your account. You’ll get a one-time sign-in link. You can log in at anytime using your email."
          : "Enter the email linked to your KNOBSOCK username and we’ll send a one-time sign-in link and code." +
            (username && !accountLinked
              ? " <b>" +
                esc(username) +
                "</b> isn’t linked to an email, so you won’t be able to get back to it."
              : "")) +
        '</p><label>Email<span class="prompt-row"><input name="email" type="email" maxlength="254" required autocomplete="email" inputmode="email"><span class="cursor-blink" aria-hidden="true">█</span></span></label><div class="account-actions"><button>Email me a sign-in link</button>' +
        (linking ? '<button type="button" id="accountSwitch">Sign in to another account</button>' : "") +
        '<button type="button" id="accountBack">Back</button></div></form></div>';
      $("accountForm").onsubmit = (e) => {
        e.preventDefault();
        const button = $("accountForm").querySelector("button");
        act(button, async () => {
          try {
            accountFlow.email = await sendAccountEmail($("accountForm").email.value, linking);
          } catch (err) {
            throw Error(accountErrorMessage(err, "Could not send a sign-in link."));
          }
          renderRoute();
        });
      };
      const switchBtn = $("accountSwitch");
      if (switchBtn)
        switchBtn.onclick = () => {
          accountFlow = null;
          location.hash = "account/signin";
        };
    }
    $("accountBack").onclick = () => {
      accountFlow = null;
      goHome();
    };
    const input = $("accountForm").querySelector(".prompt-row input"),
      cursor = $("accountForm").querySelector(".cursor-blink");
    input.oninput = () => {
      cursor.style.display = input.value ? "none" : "";
    };
  }
  async function signup(raw) {
    const name = raw.trim();
    if (!name || name.length > 24 || /[\s/]/.test(name))
      throw Error("Use 1–24 characters, without spaces or slashes.");
    if (activeBan()) throw Error("This browser is banned.");
    if (usernameContainsCensoredWord(name))
      throw Error("Please choose another username.");
    await db.runTransaction(async (tx) => {
      const d = db.collection("chat_devices").doc(device),
        n = db.collection("chat_usernames").doc(name.toLowerCase());
      const ds = await tx.get(d);
      if (ds.exists && ds.data().username) {
        username = ds.data().username;
        return;
      }
      const ns = await tx.get(n);
      if (ns.exists) throw Error("That username is taken. Choose another.");
      tx.set(n, { username: name, createdAt: stamp(), lastDeviceId: device });
      tx.set(d, { username: name, claimedAt: stamp() }, { merge: true });
      username = name;
    });
    localStorage.setItem("chat_last_username", username);
    renderIdentity();
    renderRoute();
  }
  function board(id) {
    return boards.find((b) => b.id === id);
  }
  function visibleThreads() {
    return threads.filter((t) => !t.hidden);
  }
  function ordered(list, sort = "activity") {
    return list
      .slice()
      .sort(
        (a, b) =>
          Number(b.pinned) - Number(a.pinned) ||
          (sort === "title"
            ? a.title.localeCompare(b.title)
            : sort === "replies"
              ? b.postCount - a.postCount
              : time(b[sort === "newest" ? "createdAt" : "updatedAt"]) -
                time(a[sort === "newest" ? "createdAt" : "updatedAt"])),
      );
  }
  function threadTable(list) {
    return (
      '<table class="forum-table"><thead><tr><th class="board-col">Thread / started by</th><th class="count-col">Replies</th><th>Last post</th></tr></thead><tbody>' +
      list
        .map(
          (t) =>
            '<tr><td><a href="#thread/' +
            t.id +
            '">' +
            (t.pinned
              ? '<img class="pinned-icon" src="/forums-pin-transparent.png" alt="Pinned"> '
              : "") +
            (t.locked ? "[LOCKED] " : "") +
            esc(t.title) +
            '</a><small><a href="#profile/' +
            encodeURIComponent(String(t.username || "").toLowerCase()) +
            '">' +
            esc(t.username) +
            "</a>" +
            officialBadge(t.isOfficial) +
            "</small></td><td>" +
            Math.max(0, (t.postCount || 1) - 1) +
            "</td><td><small>" +
            esc(t.lastUsername || t.username) +
            "<br>" +
            date(t.updatedAt) +
            "</small></td></tr>",
        )
        .join("") +
      "</tbody></table>" +
      (list.length ? "" : '<p class="empty">No threads yet.</p>')
    );
  }
  function home() {
    const read = saved("forum_read", {});
    return (
      categories
        .map(
          (c) =>
            '<section class="forum-category"><h2>' +
            esc(c.title) +
            '</h2><table class="forum-table"><thead><tr><th class="board-col">Board</th><th class="count-col">Threads</th><th class="count-col">Posts</th><th class="last-col">Last post</th></tr></thead><tbody>' +
            boards
              .filter((b) => b.categoryId === c.id && !b.archived)
              .map((b) => {
                const ts = ordered(
                    visibleThreads().filter((t) => t.boardId === b.id),
                  ),
                  last = ts
                    .slice()
                    .sort((a, b) => time(b.updatedAt) - time(a.updatedAt))[0],
                  unread = ts.some(
                    (t) => time(t.updatedAt) > (read[t.id] || 0),
                  );
                return (
                  '<tr><td><a class="board-title" href="#board/' +
                  b.id +
                  '">' +
                  (unread
                    ? '<span class="new-dot" aria-label="Unread">■</span>'
                    : "") +
                  esc(b.title) +
                  "</a><small>" +
                  esc(b.description) +
                  '</small></td><td class="count-col">' +
                  ts.length +
                  '</td><td class="count-col">' +
                  ts.reduce((n, t) => n + (t.postCount || 1), 0) +
                  '</td><td class="last-col">' +
                  (last
                    ? '<a href="#thread/' +
                      last.id +
                      '">' +
                      esc(last.title) +
                      "</a><small>" +
                      esc(last.lastUsername || last.username) +
                      "<br>" +
                      date(last.updatedAt) +
                      "</small>"
                    : "—") +
                  "</td></tr>"
                );
              })
              .join("") +
            "</tbody></table></section>",
        )
        .join("") ||
      '<p class="empty">The administrator is setting up the boards. Check back soon.</p>'
    );
  }
  function compose(t, b, body = "", postId = "") {
    if (activeBan() || settings.readOnly)
      return "<p>Posting is unavailable.</p>";
    if (!username)
      return '<p><a href="#signup">Choose a username to join the conversation →</a></p>';
    if (t?.locked || b?.locked || b?.archived)
      return "<p>This " + (t?.locked ? "thread" : "board") + " is locked.</p>";
    return (
      '<form class="compose" id="compose"><h2>' +
      (postId ? "Edit post" : t ? "Reply" : "New thread") +
      "</h2>" +
      (!t
        ? '<label>Subject<input name="title" required maxlength="140"></label>'
        : "") +
      '<label>Message<textarea name="body" required maxlength="12000">' +
      esc(body) +
      '</textarea><span class="char-count" aria-live="polite"></span></label><button type="submit">' +
      (postId ? "Save edit" : "Post") +
      '</button><input type="hidden" name="postId" value="' +
      esc(postId) +
      '"></form>'
    );
  }
  function wireCompose(t, b) {
    const form = $("compose");
    if (!form) return;
    const key = "forum_draft_" + (t ? t.id : b.id);
    if (!form.body.value) form.body.value = localStorage.getItem(key) || "";
    const updateCharacterCount = () => {
      form.querySelector(".char-count").textContent =
        form.body.value.length.toLocaleString() +
        " / " +
        form.body.maxLength.toLocaleString();
    };
    updateCharacterCount();
    form.body.oninput = () => {
      localStorage.setItem(key, form.body.value);
      updateCharacterCount();
    };
    form.onsubmit = (e) => {
      e.preventDefault();
      act(form.querySelector("button"), async () => {
        blocked();
        const body = censorText(form.body.value.trim());
        if (!body) throw Error("Write a message first.");
        if (form.postId.value) {
          await commit((batch) =>
            batch.update(
              ref("threads")
                .doc(t.id)
                .collection("posts")
                .doc(form.postId.value),
              { body, editedAt: stamp() },
            ),
          );
        } else if (t) {
          const tr = ref("threads").doc(t.id),
            pr = tr.collection("posts").doc();
          await db.runTransaction(async (tx) => {
            const snap = await tx.get(tr),
              data = snap.data();
            if (!data || data.locked || data.hidden)
              throw Error("This thread is unavailable for replies.");
            credential(tx);
            tx.set(pr, {
              body,
              authorId: device,
              username,
              createdAt: stamp(),
              editedAt: null,
              hidden: false,
            });
            tx.update(tr, {
              postCount: data.postCount + 1,
              updatedAt: stamp(),
              lastUsername: username,
              lastPostId: pr.id,
            });
          });
          savedCredential();
        } else {
          const title = censorText(form.elements.title.value.trim());
          if (!title) throw Error("Add a subject.");
          const tr = ref("threads").doc(),
            pr = tr.collection("posts").doc();
          await commit((batch) => {
            batch.set(tr, {
              title,
              boardId: b.id,
              authorId: device,
              username,
              createdAt: stamp(),
              updatedAt: stamp(),
              lastUsername: username,
              lastPostId: pr.id,
              postCount: 1,
              pinned: false,
              locked: false,
              hidden: false,
            });
            batch.set(pr, {
              body,
              authorId: device,
              username,
              createdAt: stamp(),
              editedAt: null,
              hidden: false,
            });
          });
          location.hash = "thread/" + tr.id;
        }
        localStorage.removeItem(key);
        form.body.value = "";
        form.postId.value = "";
        status("Posted.");
        if (t) renderRoute();
      });
    };
  }
  function formatted(body) {
    return esc(body)
      .split("\n")
      .map((line) =>
        line.startsWith("&gt;")
          ? "<blockquote>" + line.slice(4) + "</blockquote>"
          : line,
      )
      .join("\n");
  }
  async function threadView(id, page, token) {
    let snap;
    try {
      snap = await ref("threads").doc(id).get();
    } catch (e) {
      if (token !== version) return;
      $("forumView").innerHTML =
        "<p>" +
        (e.code === "permission-denied"
          ? "Thread unavailable."
          : "Could not load this thread: " + esc(e.message)) +
        "</p>";
      return;
    }
    if (token !== version) return;
    if (!snap.exists || snap.data().hidden) {
      $("forumView").innerHTML = "<p>Thread unavailable.</p>";
      return;
    }
    const t = { id, ...snap.data() },
      b = board(t.boardId);
    let query = ref("threads")
      .doc(id)
      .collection("posts")
      .where("hidden", "==", false)
      .orderBy("createdAt")
      .limit(21);
    if (page > 0) {
      const before = await ref("threads")
        .doc(id)
        .collection("posts")
        .where("hidden", "==", false)
        .orderBy("createdAt")
        .limit(page * 20)
        .get();
      if (before.docs.length)
        query = query.startAfter(before.docs[before.docs.length - 1]);
    }
    if (token !== version) return;
    unsubView = query.onSnapshot(
      (s) => {
        if (token !== version) return;
        const oldForm = $('compose');
        const oldDraft = oldForm ? {body:oldForm.elements.body.value, postId:oldForm.elements.postId.value} : null;
        const posts = s.docs
          .slice(0, 20)
          .map((d) => ({ id: d.id, ...d.data() }));
        $("forumView").innerHTML =
          '<div class="breadcrumbs"><a href="#">Boards</a> / <a href="#board/' +
          t.boardId +
          '">' +
          esc(b?.title || "Board") +
          '</a></div><h1 class="thread-title">' +
          esc(t.title) +
          "</h1>" +
          posts
            .map(
              (p) =>
                '<article class="post" id="post-' +
                p.id +
                '"><div class="post-head"><a href="#profile/' +
                encodeURIComponent(String(p.username || "").toLowerCase()) +
                '">' +
                esc(p.username) +
                officialBadge(p.isOfficial) +
                '</a><a href="#thread/' +
                id +
                "/" +
                page +
                "?post=" +
                p.id +
                '">' +
                date(p.createdAt) +
                '</a></div><div class="post-body">' +
                (p.hidden
                  ? "[Post removed by a moderator]"
                  : formatted(p.body)) +
                "</div>" +
                (p.editedAt
                  ? '<small class="edited">Edited ' + date(p.editedAt) + "</small>"
                  : "") +
                (!p.hidden
                  ? '<div class="actions"><button data-quote="' +
                    p.id +
                    '">Quote</button>' +
                    (p.authorId === device
                      ? '<button data-edit="' + p.id + '">Edit</button>'
                      : "") +
                    '<button data-report="' +
                    p.id +
                    '">Report</button></div>'
                  : "") +
                "</article>",
            )
            .join("") +
          '<div class="pager">' +
          (page
            ? '<a href="#thread/' + id + "/" + (page - 1) + '">← Previous</a>'
            : "") +
          "<span>Page " +
          (page + 1) +
          "</span>" +
          (s.size > 20
            ? '<a href="#thread/' + id + "/" + (page + 1) + '">Next →</a>'
            : "") +
          "</div>" +
          compose(t, b);
        wireCompose(t, b);
        if (oldDraft && $('compose')) {
          $('compose').elements.body.value = oldDraft.body;
          $('compose').elements.postId.value = oldDraft.postId;
          if (oldDraft.postId) $('compose').querySelector('button').textContent = 'Save edit';
          $('compose').elements.body.dispatchEvent(new Event("input"));
        }
        document.querySelectorAll("[data-quote]").forEach(
          (btn) =>
            (btn.onclick = () => {
              if (!$("compose")) {
                location.hash = "signup";
                return;
              }
              const p = posts.find((x) => x.id === btn.dataset.quote);
              const own = p.body
                .split("\n")
                .filter((l) => !l.trimStart().startsWith(">"));
              while (own.length && !own[0].trim()) own.shift();
              while (own.length && !own[own.length - 1].trim()) own.pop();
              $("compose").body.value =
                "> " +
                p.username +
                " wrote:\n" +
                own.map((l) => "> " + l).join("\n") +
                "\n\n";
              $("compose").body.dispatchEvent(new Event("input"));
              $("compose").scrollIntoView({ block: "end" });
              $("compose").body.focus();
            }),
        );
        document.querySelectorAll("[data-edit]").forEach(
          (btn) =>
            (btn.onclick = () => {
              const p = posts.find((x) => x.id === btn.dataset.edit),
                form = $("compose");
              if (!form) return;
              form.body.value = p.body;
              form.postId.value = p.id;
              form.querySelector("button").textContent = "Save edit";
              form.scrollIntoView({ block: "end" });
            }),
        );
        document.querySelectorAll("[data-report]").forEach(
          (btn) =>
            (btn.onclick = () => {
              if (!username) {
                location.hash = "signup";
                return;
              }
              const reason = prompt(
                "Why are you reporting this post? (Maximum 500 characters)",
              );
              if (!reason?.trim()) return;
              act(btn, async () => {
                await commit((batch) =>
                  batch.set(ref("reports").doc(), {
                    threadId: id,
                    postId: btn.dataset.report,
                    authorId: device,
                    username,
                    reason: reason.trim().slice(0, 500),
                    createdAt: stamp(),
                    status: "open",
                  }),
                );
                status("Report sent privately to the moderators.");
              });
            }),
        );
        const r = saved("forum_read", {});
        r[id] = Date.now();
        save("forum_read", r);
        syncScroll();
        const postId = location.hash.split("?post=")[1];
        if (postId) $("post-" + postId)?.scrollIntoView({ block: "start" });
      },
      (e) => status(e.message, true),
    );
  }
  async function renderRoute() {
    const token = ++version;
    if (unsubView) {
      unsubView();
      unsubView = null;
    }
    const raw = location.hash.slice(1).split("?")[0],
      parts = raw.split("/"),
      kind = parts[0],
      id = parts[1];
    scroll.scrollTop = 0;
    status("");
    if (accountNotice && Date.now() - accountNotice.at < 8000) status(accountNotice.text);
    if (kind !== "account") accountFlow = null;
    const view = $("forumView");
    try {
      const gated = !username && kind !== "rules" && kind !== "account";
      $("terminal").classList.toggle("is-gated", gated || kind === "account");
      if (kind === "account") {
        accountView(view, id);
      } else if (gated) {
        view.innerHTML =
          '<div class="login-gate"><form class="compose" id="signup"><h1>What are you gonna call yourself?</h1><label>Username<span class="prompt-row"><input name="username" maxlength="24" required autocomplete="nickname"><span class="cursor-blink" aria-hidden="true">█</span></span></label><p class="login-gate-note">This name is shared with live chat and stays signed in on this browser. No password or email is required. Clearing browser storage loses this session.</p><label><input type="checkbox" required style="width:auto"> I agree to the <a href="#rules">forum rules</a> and <a href="/privacy">Privacy &amp; User Agreement</a>.</label><div class="account-actions"><button>Join the forums</button><a class="gate-signin" href="#account/signin">Already have an account? Sign in with email</a></div></form></div>';
        $("signup").onsubmit = (e) => {
          e.preventDefault();
          act($("signup").querySelector("button"), () =>
            signup($("signup").username.value),
          );
        };
        const gateInput = $("signup").username,
          gateCursor = $("signup").querySelector(".cursor-blink");
        gateInput.oninput = () => {
          gateCursor.style.display = gateInput.value ? "none" : "";
        };
      } else if (kind === "thread" && id) {
        view.innerHTML = "Loading thread…";
        await threadView(
          id,
          Math.max(0, Math.min(500, parseInt(parts[2], 10) || 0)),
          token,
        );
      } else if (kind === "new" && id) {
        const b = board(id);
        view.innerHTML = b
          ? "<h1>" + esc(b.title) + "</h1>" + compose(null, b)
          : "Board not found.";
        if (b) wireCompose(null, b);
      } else if (kind === "rules") {
        view.innerHTML =
          "<h1>Forum rules</h1><p>" +
          esc(
            settings.rules ||
              "Be kind. No harassment, hate, threats, spam, impersonation, or sharing private information. Keep posts in the right board. Do not post illegal content. Report problems instead of escalating them. Moderators may remove content, lock discussions, and suspend access to both forums and live chat.",
          ) +
          "</p><p>■ means unread activity. The pin icon means pinned. Drafts stay in this browser. Posts are public. Reports are visible only to moderators.</p><p>For help with your name or moderation, contact the site administrator through the site’s published contact options.</p>";
      } else if (kind === "profile" && id) {
        let key = "";
        try {
          key = decodeURIComponent(id).toLowerCase();
        } catch {}
        await profilePage(view, key, parts[2] === "edit", token);
      } else if (kind === "member" && id) {
        const s = await db.collection("chat_devices").doc(id).get();
        if (token !== version) return;
        const memberName = s.exists ? s.data().username || "" : "";
        if (memberName) await profilePage(view, memberName.toLowerCase(), false, token);
        else view.innerHTML = '<div class="breadcrumbs"><a href="#">Boards</a></div><h1>Member not found</h1>';
      } else if (["board", "recent", "search"].includes(kind)) {
        const b = board(id);
        let query = "";
        try {
          query = decodeURIComponent(id || "");
        } catch {}
        let list = visibleThreads().filter((t) =>
          kind === "board"
            ? t.boardId === id
            : kind === "search"
              ? t.title.toLowerCase().includes(query.toLowerCase())
              : true,
        );
        view.innerHTML =
          '<div class="breadcrumbs"><a href="#">Boards</a></div><h1>' +
          esc(
            kind === "board"
              ? b?.title || "Board"
              : kind === "search"
                ? "Search: " + query
                : "Recent threads",
          ) +
          "</h1>" +
          (b ? "<p>" + esc(b.description) + "</p>" : "") +
          '<div class="actions">' +
          (b && !b.locked
            ? '<a href="#new/' + b.id + '">[ New thread ]</a>'
            : "") +
          '<label>Sort <select id="sort"><option value="activity">Last activity</option><option value="newest">Newest</option><option value="title">Subject</option><option value="replies">Most replies</option></select></label></div><div id="threadList" class="forum-category">' +
          threadTable(ordered(list)) +
          "</div>";
        $("sort").onchange = () => {
          $("threadList").innerHTML = threadTable(
            ordered(list, $("sort").value),
          );
        };
      } else view.innerHTML = home();
      if (kind !== "thread" && threads.length >= threadLimit) {
        view.insertAdjacentHTML(
          "beforeend",
          "<p>Showing the latest " +
            threadLimit +
            ' threads. Counts and search cover loaded threads.</p><button id="loadMoreThreads">Load older threads</button>',
        );
        $("loadMoreThreads").onclick = () => {
          threadLimit += 200;
          listenThreads();
        };
      }
      syncScroll();
    } catch (e) {
      status(e.message, true);
    }
  }
  let unsubThreads;
  function listenThreads() {
    if (unsubThreads) unsubThreads();
    unsubThreads = ref("threads")
      .where("hidden", "==", false)
      .orderBy("updatedAt", "desc")
      .limit(threadLimit)
      .onSnapshot(
        (s) => {
          threads = s.docs.map((d) => ({ id: d.id, ...d.data() }));
          if (
            !location.hash.startsWith("#thread/") &&
            !location.hash.startsWith("#new/") &&
            !location.hash.startsWith("#account") &&
            !location.hash.startsWith("#profile/") &&
            location.hash !== "#signup"
          )
            renderRoute();
        },
        (e) => status("Could not load the forum: " + e.message, true),
      );
  }
  $("searchForm").onsubmit = (e) => {
    e.preventDefault();
    location.hash =
      "search/" + encodeURIComponent($("forumSearch").value.trim());
  };
  addEventListener("hashchange", () => {
    renderRoute();
    if (window.parent !== window)
      window.parent.postMessage(
        { type: "knobsock-shell-update-route", path: "/forums" + (location.hash || "") },
        location.origin,
      );
  });
  try {
    device = localStorage.getItem("chat_client_id");
    if (!device) {
      device = crypto.randomUUID();
      localStorage.setItem("chat_client_id", device);
    }
    secret = localStorage.getItem("forum_write_secret");
    if (!secret) {
      secret = crypto.randomUUID() + crypto.randomUUID();
      localStorage.setItem("forum_write_secret", secret);
    }
  } catch {
    status(
      "Enable browser storage to sign up or post. You can still read the forum.",
      true,
    );
  }
  if (device) {
    db.collection("chat_devices")
      .doc(device)
      .onSnapshot(
        (d) => {
          const wasUsername = username;
          deviceData = d.exists ? d.data() : null;
          username = (deviceData && deviceData.username) || "";
          accountLinked = !!(deviceData && deviceData.accountId);
          if (username) {
            localStorage.setItem("chat_last_username", username);
            markSeen();
          }
          renderIdentity();
          if (!!wasUsername !== !!username && !location.hash.startsWith("#account"))
            renderRoute();
        },
        (e) =>
          status(
            "Could not restore your live-chat username: " + e.message,
            true,
          ),
      );
    db.collection("chat_bans")
      .doc(device)
      .onSnapshot((d) => {
        ban = d.exists ? d.data() : null;
        renderIdentity();
      });
  }
  setInterval(renderIdentity, 30000);
  Promise.all([
    ref("categories").orderBy("order").get(),
    ref("boards").orderBy("order").get(),
    ref("config").doc("main").get(),
  ])
    .then(([c, b, s]) => {
      categories = c.docs.map((d) => ({ id: d.id, ...d.data() }));
      boards = b.docs.map((d) => ({ id: d.id, ...d.data() }));
      settings = s.exists ? s.data() : {};
      listenThreads();
      renderIdentity();
      renderRoute();
    })
    .catch((e) => status("Forum setup is unavailable: " + e.message, true));
})();
