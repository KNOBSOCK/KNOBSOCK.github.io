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
    ZOOM_FONT_PX = 18,
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
  function renderIdentity() {
    $("identity").innerHTML = activeBan()
      ? '<span class="error">Banned from live chat and forums. ' +
        esc(ban.reason || "") +
        (ban.expiresAt
          ? " Until " + esc(new Date(ban.expiresAt).toLocaleString())
          : "") +
        "</span>"
      : username
        ? 'Logged in as <a href="#member/' +
          encodeURIComponent(device) +
          '">' +
          esc(username) +
          "</a>"
        : '<a href="#signup">What are you gonna call yourself? Sign up →</a>';
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
            (t.pinned ? "↑ " : "") +
            (t.locked ? "[LOCKED] " : "") +
            esc(t.title) +
            "</a><small>" +
            esc(t.username) +
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
      '</textarea></label><button type="submit">' +
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
    form.body.oninput = () => localStorage.setItem(key, form.body.value);
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
                '"><div class="post-head"><a href="#member/' +
                encodeURIComponent(p.authorId) +
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
    const view = $("forumView");
    try {
      const gated = !username && kind !== "rules";
      $("terminal").classList.toggle("is-gated", gated);
      if (gated) {
        view.innerHTML =
          '<div class="login-gate"><form class="compose" id="signup"><h1>What are you gonna call yourself?</h1><label>Username<span class="prompt-row"><input name="username" maxlength="24" required autocomplete="nickname"><span class="cursor-blink" aria-hidden="true">█</span></span></label><p class="login-gate-note">This name is shared with live chat and stays signed in on this browser. No password or email is required. Clearing browser storage loses this session.</p><label><input type="checkbox" required style="width:auto"> I agree to the <a href="#rules">forum rules</a> and <a href="/privacy">Privacy &amp; User Agreement</a>.</label><button>Join the forums</button></form></div>';
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
          "</p><p>■ means unread activity. ↑ means pinned. Drafts stay in this browser. Posts are public. Reports are visible only to moderators.</p><p>For help with your name or moderation, contact the site administrator through the site’s published contact options.</p>";
      } else if (kind === "member" && id) {
        const s = await db.collection("chat_devices").doc(id).get();
        if (token !== version) return;
        view.innerHTML =
          "<h1>" +
          esc(s.exists ? s.data().username || "Member" : "Member") +
          '</h1><h2>Threads</h2><div class="forum-category">' +
          threadTable(
            ordered(visibleThreads().filter((t) => t.authorId === id)),
          ) +
          "</div>";
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
          username = d.exists ? d.data().username || "" : "";
          if (username) localStorage.setItem("chat_last_username", username);
          renderIdentity();
          if (!!wasUsername !== !!username) renderRoute();
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
