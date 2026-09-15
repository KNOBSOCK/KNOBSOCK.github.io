(function () {
  "use strict";
  let db,
    auth,
    stops = [],
    data = {
      categories: [],
      boards: [],
      threads: [],
      reports: [],
      audit: [],
      bans: [],
    },
    config = {},
    structureBound = false;
  const esc = (v) =>
    String(v ?? "").replace(
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
  const $ = (id) => document.getElementById(id),
    ref = (n) => db.collection("forum_" + n),
    stamp = () => firebase.firestore.FieldValue.serverTimestamp();
  function stop() {
    stops.forEach((f) => f());
    stops = [];
    structureBound = false;
    if ($("forumsAdmin"))
      $("forumsAdmin").textContent = "Sign in to load forum moderation.";
  }
  async function run(fn) {
    try {
      $("faStatus").textContent = "Saving…";
      await fn();
      $("faStatus").textContent = "Saved.";
    } catch (e) {
      $("faStatus").textContent = "Failed: " + e.message;
    }
  }
  async function write(action, target, fn) {
    const batch = db.batch();
    fn(batch);
    batch.set(ref("audit").doc(), {
      action,
      target,
      adminUid: auth.currentUser.uid,
      at: stamp(),
    });
    await batch.commit();
  }
  function options(list, current) {
    return list
      .map(
        (x) =>
          '<option value="' +
          esc(x.id) +
          '" ' +
          (x.id === current ? "selected" : "") +
          ">" +
          esc(x.title) +
          "</option>",
      )
      .join("");
  }
  function sortable(container, onReorder) {
    let dragEl = null,
      pointerId = null;
    container.addEventListener("pointerdown", (e) => {
      const handle = e.target.closest(".grip");
      if (!handle) return;
      const row = handle.closest("[data-draggable]");
      if (!row || row.parentNode !== container) return;
      e.preventDefault();
      dragEl = row;
      pointerId = e.pointerId;
      try {
        row.setPointerCapture(pointerId);
      } catch (err) {}
      row.classList.add("dragging");
    });
    container.addEventListener("pointermove", (e) => {
      if (!dragEl || e.pointerId !== pointerId) return;
      e.preventDefault();
      const under = document.elementFromPoint(e.clientX, e.clientY);
      const row = under && under.closest ? under.closest("[data-draggable]") : null;
      if (!row || row === dragEl || row.parentNode !== container) return;
      const rect = row.getBoundingClientRect();
      const before = e.clientY - rect.top < rect.height / 2;
      container.insertBefore(dragEl, before ? row : row.nextSibling);
    });
    function end(e) {
      if (!dragEl || e.pointerId !== pointerId) return;
      dragEl.classList.remove("dragging");
      try {
        dragEl.releasePointerCapture(pointerId);
      } catch (err) {}
      const rows = Array.prototype.slice.call(
        container.querySelectorAll(":scope > [data-draggable]"),
      );
      onReorder(rows.map((r) => r.dataset.id));
      dragEl = null;
      pointerId = null;
    }
    container.addEventListener("pointerup", end);
    container.addEventListener("pointercancel", end);
  }
  function reorderCategories(ids) {
    run(() =>
      write("reorder categories", "all", (batch) =>
        ids.forEach((id, i) => batch.update(ref("categories").doc(id), { order: i })),
      ),
    );
  }
  function reorderBoards(categoryId, ids) {
    run(() =>
      write("reorder boards", categoryId, (batch) =>
        ids.forEach((id, i) => batch.update(ref("boards").doc(id), { order: i })),
      ),
    );
  }
  function renderStructure() {
    $("faStructure").innerHTML =
      data.categories
        .map(
          (c) =>
            '<div class="card" data-draggable data-id="' +
            c.id +
            '" style="margin-bottom:12px"><div class="card-head"><h2><span class="grip" title="Drag to reorder">&#10303;</span> ' +
            esc(c.title) +
            '</h2><button class="btn-link" data-category="' +
            c.id +
            '">Edit category</button> <button class="btn-link" data-delete-category="' +
            c.id +
            '">Delete</button></div><div data-board-list data-list-category="' +
            c.id +
            '" style="display:flex;flex-direction:column;gap:6px">' +
            (data.boards.filter((b) => b.categoryId === c.id).length
              ? data.boards
                  .filter((b) => b.categoryId === c.id)
                  .map(
                    (b) =>
                      '<div class="row" data-draggable data-id="' +
                      b.id +
                      '"><span class="grip" title="Drag to reorder">&#10303;</span><span style="flex:1">' +
                      esc(b.title) +
                      (b.locked ? " · read-only" : "") +
                      (b.archived ? " · archived" : "") +
                      '</span><button class="btn-link" data-board="' +
                      b.id +
                      '">Edit</button> <button class="btn-link" data-delete-board="' +
                      b.id +
                      '">Delete</button></div>',
                  )
                  .join("")
              : '<p class="empty-state">No boards in this category yet.</p>') +
            '</div><button class="btn-link" data-add-board="' +
            c.id +
            '" style="margin-top:10px">+ Add board here</button></div>',
        )
        .join("") ||
      '<p class="empty-state">No categories yet. Start with "New category" above.</p>';
    $("faStructure")
      .querySelectorAll("[data-category]")
      .forEach((b) => (b.onclick = () => editCategory(b.dataset.category)));
    $("faStructure")
      .querySelectorAll("[data-board]")
      .forEach((b) => (b.onclick = () => editBoard(b.dataset.board)));
    $("faStructure")
      .querySelectorAll("[data-add-board]")
      .forEach(
        (b) => (b.onclick = () => editBoard(null, b.dataset.addBoard)),
      );
    $("faStructure")
      .querySelectorAll("[data-delete-board]")
      .forEach(
        (b) =>
          (b.onclick = () => {
            const board = data.boards.find((x) => x.id === b.dataset.deleteBoard);
            if (
              !confirm(
                'Delete "' +
                  board.title +
                  '"? Existing threads in it stay in the database but won\'t be reachable anywhere in the forum. This cannot be undone.',
              )
            )
              return;
            run(() =>
              write("delete board", board.id, (batch) =>
                batch.delete(ref("boards").doc(board.id)),
              ),
            );
          }),
      );
    $("faStructure")
      .querySelectorAll("[data-delete-category]")
      .forEach(
        (b) =>
          (b.onclick = () => {
            const category = data.categories.find(
              (x) => x.id === b.dataset.deleteCategory,
            );
            const boardCount = data.boards.filter(
              (x) => x.categoryId === category.id,
            ).length;
            const warning = boardCount
              ? 'Delete the "' +
                category.title +
                '" category? It has ' +
                boardCount +
                " board(s) still in it - they'll stop showing up anywhere on the forum index, though their threads and posts stay in the database. This cannot be undone."
              : 'Delete the "' + category.title + '" category? This cannot be undone.';
            if (!confirm(warning)) return;
            run(() =>
              write("delete category", category.id, (batch) =>
                batch.delete(ref("categories").doc(category.id)),
              ),
            );
          }),
      );
    if (!structureBound) {
      structureBound = true;
      sortable($("faStructure"), reorderCategories);
    }
    $("faStructure")
      .querySelectorAll("[data-board-list]")
      .forEach((list) =>
        sortable(list, (ids) => reorderBoards(list.dataset.listCategory, ids)),
      );
  }
  function editCategory(id) {
    const c = data.categories.find((x) => x.id === id) || {
      title: "",
      order: data.categories.length,
    };
    $("faEditor").innerHTML =
      '<form id="faCategoryForm" class="card" style="padding:16px;margin-bottom:16px"><h2>' +
      (id ? "Edit" : "New") +
      ' category</h2><label>Name<input name="name" value="' +
      esc(c.title) +
      '" required maxlength="80"></label><div class="actions" style="display:flex;gap:10px;margin-top:10px"><button class="btn">Save category</button><button type="button" class="btn-link" id="faCancelCategory">Cancel</button></div></form>';
    $("faCategoryForm").onsubmit = (e) => {
      e.preventDefault();
      const f = e.currentTarget;
      run(() =>
        write("save category", id || "new", (b) =>
          b.set(ref("categories").doc(id || ref("categories").doc().id), {
            title: f.elements.name.value.trim(),
            order: c.order,
          }),
        ),
      ).then(() => ($("faEditor").innerHTML = ""));
    };
    $("faCancelCategory").onclick = () => ($("faEditor").innerHTML = "");
    $("faEditor").scrollIntoView({ block: "start" });
  }
  function editBoard(id, presetCategoryId) {
    const defaultCategory =
      presetCategoryId || (data.categories[0] && data.categories[0].id) || "";
    const v = data.boards.find((x) => x.id === id) || {
      title: "",
      description: "",
      categoryId: defaultCategory,
      order: data.boards.length,
    };
    if (!data.categories.length) {
      $("faEditor").innerHTML =
        '<p class="empty-state">Add a category first, then add boards inside it.</p>';
      $("faEditor").scrollIntoView({ block: "start" });
      return;
    }
    $("faEditor").innerHTML =
      '<form id="faBoardForm" class="card" style="padding:16px;margin-bottom:16px"><h2>' +
      (id ? "Edit" : "New") +
      ' board</h2><label>Name<input name="name" value="' +
      esc(v.title) +
      '" required maxlength="100"></label><label>Description<input name="description" value="' +
      esc(v.description) +
      '" maxlength="300"></label><label>Category<select name="category">' +
      options(data.categories, v.categoryId) +
      '</select></label><label class="check-label"><input name="locked" type="checkbox" ' +
      (v.locked ? "checked" : "") +
      '> Read-only board (no new threads or replies)</label><label class="check-label"><input name="archived" type="checkbox" ' +
      (v.archived ? "checked" : "") +
      '> Archive board (remove from index and stop new posts)</label><div class="actions" style="display:flex;gap:10px;margin-top:10px"><button class="btn">Save board</button><button type="button" class="btn-link" id="faCancelBoard">Cancel</button></div></form>';
    $("faBoardForm").onsubmit = (e) => {
      e.preventDefault();
      const f = e.currentTarget;
      if (!f.elements.category.value) {
        $("faStatus").textContent = "Choose a category first.";
        return;
      }
      run(() =>
        write("save board", id || "new", (b) =>
          b.set(ref("boards").doc(id || ref("boards").doc().id), {
            title: f.elements.name.value.trim(),
            description: f.elements.description.value,
            categoryId: f.elements.category.value,
            order: v.order,
            locked: f.elements.locked.checked,
            archived: f.elements.archived.checked,
          }),
        ),
      ).then(() => ($("faEditor").innerHTML = ""));
    };
    $("faCancelBoard").onclick = () => ($("faEditor").innerHTML = "");
    $("faEditor").scrollIntoView({ block: "start" });
  }
  function renderThreads() {
    const q = $("faFilter").value.toLowerCase();
    $("faThreads").innerHTML =
      data.threads
        .filter((t) => (t.title + " " + t.username).toLowerCase().includes(q))
        .map(
          (t) =>
            '<div class="card" style="padding:12px;margin:8px 0"><b>' +
            esc(t.title) +
            "</b> · " +
            esc(t.username) +
            " " +
            (t.hidden ? "[hidden]" : "") +
            " " +
            (t.locked ? "[locked]" : "") +
            " " +
            (t.pinned ? "[pinned]" : "") +
            '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px"><button class="btn" data-thread="' +
            t.id +
            '">Moderate posts</button><button class="btn" data-toggle="locked" data-id="' +
            t.id +
            '">' +
            (t.locked ? "Unlock" : "Lock") +
            '</button><button class="btn" data-toggle="pinned" data-id="' +
            t.id +
            '">' +
            (t.pinned ? "Unpin" : "Pin") +
            '</button><button class="btn" data-toggle="hidden" data-id="' +
            t.id +
            '">' +
            (t.hidden ? "Restore" : "Hide") +
            '</button><button class="btn" data-rename="' +
            t.id +
            '">Rename</button><label style="display:inline-flex;align-items:center;gap:4px;margin:0">Move to <select class="inline-field" data-move="' +
            t.id +
            '">' +
            options(data.boards, t.boardId) +
            "</select></label></div></div>",
        )
        .join("") || '<p class="empty-state">No matching threads.</p>';
    $("faThreads")
      .querySelectorAll("[data-toggle]")
      .forEach(
        (b) =>
          (b.onclick = () => {
            const t = data.threads.find((x) => x.id === b.dataset.id),
              k = b.dataset.toggle;
            run(() =>
              write((t[k] ? "unset " : "set ") + k, t.id, (batch) =>
                batch.update(ref("threads").doc(t.id), { [k]: !t[k] }),
              ),
            );
          }),
      );
    $("faThreads")
      .querySelectorAll("[data-move]")
      .forEach(
        (s) =>
          (s.onchange = () =>
            run(() =>
              write("move thread", s.dataset.move, (b) =>
                b.update(ref("threads").doc(s.dataset.move), {
                  boardId: s.value,
                }),
              ),
            )),
      );
    $("faThreads")
      .querySelectorAll("[data-rename]")
      .forEach(
        (b) =>
          (b.onclick = () => {
            const t = data.threads.find((t) => t.id === b.dataset.rename),
              title = prompt("Thread title", t.title);
            if (title?.trim())
              run(() =>
                write("rename thread", t.id, (b) =>
                  b.update(ref("threads").doc(t.id), {
                    title: title.trim().slice(0, 140),
                  }),
                ),
              );
          }),
      );
    $("faThreads")
      .querySelectorAll("[data-thread]")
      .forEach((b) => (b.onclick = () => loadPosts(b.dataset.thread)));
  }
  async function loadPosts(id) {
    try {
      const s = await ref("threads")
        .doc(id)
        .collection("posts")
        .orderBy("createdAt", "desc")
        .limit(100)
        .get();
      $("faPosts").innerHTML =
        "<h2>Moderate posts</h2><p>Latest 100 posts. Hidden content stays available here for review and restoration.</p>" +
        s.docs
          .map((d) => {
            const p = d.data();
            return (
              '<article class="card" style="padding:12px;margin:8px 0"><b>' +
              esc(p.username) +
              "</b> " +
              (p.hidden ? "[hidden]" : "") +
              '<pre style="white-space:pre-wrap;overflow-wrap:anywhere;font-family:inherit">' +
              esc(p.body) +
              '</pre><button class="btn" data-hidepost="' +
              d.id +
              '" data-hidden="' +
              p.hidden +
              '">' +
              (p.hidden ? "Restore post" : "Hide post") +
              '</button> <button class="btn" data-editpost="' + d.id + '">Edit post</button> <button class="btn" data-ban="' +
              esc(p.authorId) +
              '" data-name="' +
              esc(p.username) +
              '" data-post-thread="' +
              id +
              '" data-post-id="' +
              d.id +
              '">Ban / timeout</button> <button class="btn" data-history="' +
              esc(p.authorId) +
              '">User history &amp; tools</button></article>'
            );
          })
          .join("");
      $("faPosts")
        .querySelectorAll("[data-hidepost]")
        .forEach(
          (b) =>
            (b.onclick = () =>
              run(async () => {
                await write(
                  b.dataset.hidden === "true" ? "restore post" : "hide post",
                  id + "/" + b.dataset.hidepost,
                  (batch) =>
                    batch.update(
                      ref("threads")
                        .doc(id)
                        .collection("posts")
                        .doc(b.dataset.hidepost),
                      { hidden: b.dataset.hidden !== "true" },
                    ),
                );
                await loadPosts(id);
              })),
        );
      $("faPosts").querySelectorAll('[data-editpost]').forEach(button => {
        button.onclick = () => {
          const post = s.docs.find(d => d.id === button.dataset.editpost);
          const body = prompt('Edit post text. This action is recorded in the moderation log.', post.data().body);
          if (body?.trim()) run(async () => {
            await write('edit post', id + '/' + post.id, batch => batch.update(post.ref, {body: body.trim().slice(0,12000), editedAt: stamp()}));
            await loadPosts(id);
          });
        };
      });
      wireBans($("faPosts"));
      $("faPosts")
        .querySelectorAll("[data-history]")
        .forEach(
          (b) =>
            (b.onclick = () => loadHistory(b.dataset.history, b.parentElement.querySelector('b').textContent)),
        );
      $("faPosts").scrollIntoView({ block: "start" });
    } catch (e) {
      $("faStatus").textContent = e.message;
    }
  }
  function wireBans(root) {
    root
      .querySelectorAll("[data-ban]")
      .forEach(
        (b) =>
          (b.onclick = () =>
            banForm(
              b.dataset.ban,
              b.dataset.name,
              b.dataset.postThread,
              b.dataset.postId,
            )),
      );
  }
  async function all(query) {
    const docs = []; let cursor;
    for (;;) {
      const page = await (cursor ? query.startAfter(cursor) : query).limit(300).get();
      docs.push(...page.docs);
      if (page.size < 300) return docs;
      cursor = page.docs[page.docs.length - 1];
    }
  }
  async function backup() {
    const out = {exportedAt: new Date().toISOString(), config};
    for (const key of ['categories','boards','threads','reports','audit']) {
      const docs = await all(ref(key).orderBy(firebase.firestore.FieldPath.documentId()));
      out[key] = docs.map(d => ({id:d.id, ...d.data()}));
      if (key === 'threads') for (const thread of out.threads) {
        $('faStatus').textContent = 'Exporting posts: ' + thread.title;
        const posts = await all(ref('threads').doc(thread.id).collection('posts').orderBy('createdAt'));
        thread.posts = posts.map(d => ({id:d.id, ...d.data()}));
      }
    }
    out.bans = data.bans;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(out,null,2)], {type:'application/json'}));
    a.download = 'knobsock-forums-backup.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  async function loadHistory(id, name) {
    try {
      const s = await db.collectionGroup('posts').where('authorId','==',id).orderBy('createdAt','desc').limit(100).get();
      $('faPosts').innerHTML = '<h2>' + esc(name) + ' — recent posts</h2><p>Latest 100 posts, including replies and hidden posts.</p><div class="actions"><button class="btn" id="faHideUser">Hide these ' + s.size + ' posts</button> <button class="btn" id="faForceOut">Sign out of live chat &amp; forums</button> <button class="btn" id="faResetSession">Reset forum write credential</button></div>' + s.docs.map(d => '<article class="card" style="padding:12px;margin:8px 0"><p>' + esc(d.data().body) + '</p><button class="btn" data-review="' + d.ref.parent.parent.id + '">Open thread moderation</button></article>').join('');
      $('faHideUser').onclick = () => run(() => write('bulk hide posts by '+name,id,batch=>s.docs.forEach(d=>batch.update(d.ref,{hidden:true}))));
      $('faForceOut').onclick = () => run(() => write('shared sign-out '+name,id,batch=>batch.update(db.collection('chat_devices').doc(id),{username:firebase.firestore.FieldValue.delete()})));
      $('faResetSession').onclick = () => run(() => write('reset forum credential '+name,id,batch=>batch.delete(ref('sessions').doc(id))));
      $('faPosts').querySelectorAll('[data-review]').forEach(b=>b.onclick=()=>loadPosts(b.dataset.review));
    } catch (e) { $('faStatus').textContent = e.message; }
  }
  function banForm(id, name, postThread, postId) {
    $("faEditor").innerHTML =
      '<form id="faBanForm" class="card" style="padding:16px;margin-bottom:16px"><h2>Ban ' +
      esc(name) +
      '</h2><p>Applies to both live chat and forums on this browser. Other devices are not blocked.' +
      (postThread && postId
        ? " The post you opened this from is hidden automatically."
        : "") +
      '</p><label>Duration<select name="duration"><option value="3600000">1 hour</option><option value="86400000">24 hours</option><option value="604800000">7 days</option><option value="0">Permanent</option></select></label><label>Reason<input name="reason" maxlength="500" required></label><div class="actions" style="display:flex;gap:10px;margin-top:10px"><button class="btn">Apply shared ban</button><button type="button" class="btn-link" id="faCancelBan">Cancel</button></div></form>';
    $("faBanForm").onsubmit = (e) => {
      e.preventDefault();
      const f = e.currentTarget,
        duration = Number(f.elements.duration.value);
      run(() =>
        write("ban " + name, id, (b) => {
          b.set(
            db.collection("chat_bans").doc(id),
            {
              bannedAt: Date.now(),
              bannedBy: auth.currentUser.email || auth.currentUser.uid,
              expiresAt: duration ? Date.now() + duration : null,
              reason: f.elements.reason.value,
              enforced: true,
              usernames: firebase.firestore.FieldValue.arrayUnion(name),
            },
            { merge: true },
          );
          if (postThread && postId)
            b.update(
              ref("threads").doc(postThread).collection("posts").doc(postId),
              { hidden: true },
            );
        }),
      ).then(() => {
        $("faEditor").innerHTML = "";
        if (postThread) loadPosts(postThread);
      });
    };
    $("faCancelBan").onclick = () => ($("faEditor").innerHTML = "");
    $("faEditor").scrollIntoView({ block: "start" });
  }
  function renderReports() {
    $("faReports").innerHTML =
      data.reports
        .map(
          (r) =>
            '<div class="card" style="padding:12px;margin:8px 0"><b>' +
            esc(r.status) +
            "</b> · " +
            esc(r.username) +
            "<p>" +
            esc(r.reason) +
            '</p><button class="btn" data-review="' +
            r.threadId +
            '">Review thread</button> <button class="btn" data-resolve="' +
            r.id +
            '">' +
            (r.status === "open" ? "Resolve" : "Reopen") +
            "</button></div>",
        )
        .join("") || '<p class="empty-state">No reports right now.</p>';
    $("faReports")
      .querySelectorAll("[data-review]")
      .forEach((b) => (b.onclick = () => loadPosts(b.dataset.review)));
    $("faReports")
      .querySelectorAll("[data-resolve]")
      .forEach(
        (b) =>
          (b.onclick = () => {
            const r = data.reports.find((x) => x.id === b.dataset.resolve);
            run(() =>
              write(
                "report " + (r.status === "open" ? "resolved" : "reopened"),
                r.id,
                (batch) =>
                  batch.update(ref("reports").doc(r.id), {
                    status: r.status === "open" ? "resolved" : "open",
                    resolvedAt: stamp(),
                  }),
              ),
            );
          }),
      );
  }
  function renderBans() {
    $("faBans").innerHTML =
      data.bans
        .filter((b) => !b.expiresAt || b.expiresAt > Date.now())
        .map(
          (b) =>
            "<p>" +
            esc((b.usernames || []).join(", ")) +
            " — " +
            esc(b.reason) +
            " " +
            (b.expiresAt
              ? "until " + esc(new Date(b.expiresAt).toLocaleString())
              : "(permanent)") +
            ' <button class="btn-link" data-unban="' +
            b.id +
            '">Unban everywhere</button></p>',
        )
        .join("") || '<p class="empty-state">No active bans.</p>';
    $("faBans")
      .querySelectorAll("[data-unban]")
      .forEach(
        (b) =>
          (b.onclick = () =>
            run(() =>
              write("unban", b.dataset.unban, (batch) =>
                batch.delete(db.collection("chat_bans").doc(b.dataset.unban)),
              ),
            )),
      );
  }
  function init(database, authentication) {
    stop();
    db = database;
    auth = authentication;
    $("forumsAdmin").innerHTML =
      '<style>#forumsAdmin label{display:block;margin:10px 0 4px}#forumsAdmin label.check-label{display:flex;align-items:center;gap:6px;margin:10px 0}#forumsAdmin label input:not([type=checkbox]):not(.inline-field),#forumsAdmin label select:not(.inline-field),#forumsAdmin label textarea:not(.inline-field){display:block;width:100%;box-sizing:border-box;margin-top:4px}</style>' +
      '<div id="faStatus" role="status" style="margin-bottom:12px"></div>' +
      '<div class="actions" style="display:flex;gap:10px;margin-bottom:20px"><button class="btn" id="faExport">Export full forum backup</button></div>' +
      '<div class="card" style="padding:16px;margin-bottom:20px"><h2>Community rules &amp; posting</h2><p class="panel-sub">This text is what visitors see on the forum\'s Rules page. Pausing posting stops new threads and replies everywhere but keeps the forum readable.</p><form id="faSettings"><label class="check-label"><input type="checkbox" name="readOnly"> Pause all public posting</label><label>Rules text<textarea name="rules" rows="8" maxlength="5000"></textarea></label><button class="btn" style="margin-top:10px">Save rules &amp; settings</button></form></div>' +
      '<div class="card" style="padding:16px;margin-bottom:20px"><div class="card-head"><h2>Categories &amp; boards</h2><button class="btn" id="faAddCategory">New category</button></div><p class="panel-sub">Drag the grip (&#10303;) to reorder categories, or the boards inside one. "New board" inside a category starts it there already.</p><div id="faEditor"></div><div id="faStructure"></div></div>' +
      '<div class="card" style="padding:16px;margin-bottom:20px"><h2>Post as KNOBSOCK</h2><p class="panel-sub">Starts a new thread under the official KNOBSOCK account. Its posts carry a badge marking them official, and it can skip straight to pinned.</p><form id="faOfficialPost"><label>Board<select name="board" id="faOfficialBoard"></select></label><label>Subject<input name="title" required maxlength="140"></label><label>Message<textarea name="body" rows="6" required maxlength="12000"></textarea></label><label class="check-label"><input type="checkbox" name="pinned"> Pin this thread</label><button class="btn" style="margin-top:10px">Post as KNOBSOCK</button></form></div>' +
      '<div class="card" style="padding:16px;margin-bottom:20px"><h2>Reports</h2><p class="panel-sub">Members flag posts here privately. Review the thread, act if needed, then resolve.</p><div id="faReports"></div></div>' +
      '<div class="card" style="padding:16px;margin-bottom:20px"><h2>Threads</h2><p class="panel-sub">Latest 500 threads. Open "Moderate posts" on one to hide, edit, or ban from within it.</p><label>Search loaded threads or author<input id="faFilter" type="search"></label><div id="faThreads"></div></div>' +
      '<div id="faPosts" class="card" style="padding:16px;margin-bottom:20px"><p class="empty-state">Open "Moderate posts" on a thread above to review its posts.</p></div>' +
      '<details style="margin-bottom:12px"><summary>Shared bans &amp; timeouts</summary><div id="faBans" style="margin-top:10px"></div></details>' +
      '<details><summary>Moderation log (latest 100)</summary><div id="faAudit" style="margin-top:10px"></div></details>';
    $("faAddCategory").onclick = () => editCategory();
    $("faFilter").oninput = renderThreads;
    $("faOfficialPost").onsubmit = (e) => {
      e.preventDefault();
      const f = e.currentTarget;
      if (!f.elements.board.value) {
        $("faStatus").textContent = "Add a board first.";
        return;
      }
      const title = f.elements.title.value.trim(),
        body = f.elements.body.value.trim();
      if (!title || !body) return;
      const tr = ref("threads").doc(),
        pr = tr.collection("posts").doc();
      run(() =>
        write("post as KNOBSOCK", tr.id, (batch) => {
          batch.set(tr, {
            title,
            boardId: f.elements.board.value,
            authorId: "official",
            username: "KNOBSOCK",
            createdAt: stamp(),
            updatedAt: stamp(),
            lastUsername: "KNOBSOCK",
            lastPostId: pr.id,
            postCount: 1,
            pinned: f.elements.pinned.checked,
            locked: false,
            hidden: false,
            isOfficial: true,
          });
          batch.set(pr, {
            body,
            authorId: "official",
            username: "KNOBSOCK",
            createdAt: stamp(),
            editedAt: null,
            hidden: false,
            isOfficial: true,
          });
        }),
      ).then(() => f.reset());
    };
    $("faSettings").onsubmit = (e) => {
      e.preventDefault();
      const f = e.currentTarget;
      run(() =>
        write("settings", "main", (b) =>
          b.set(ref("config").doc("main"), {
            rules: f.elements.rules.value,
            readOnly: f.elements.readOnly.checked,
          }),
        ),
      );
    };
    $("faExport").onclick = () => run(backup);
    const queries = {
      categories: ref("categories").orderBy("order"),
      boards: ref("boards").orderBy("order"),
      threads: ref("threads").orderBy("updatedAt", "desc").limit(500),
      reports: ref("reports").orderBy("createdAt", "desc").limit(200),
      audit: ref("audit").orderBy("at", "desc").limit(100),
      bans: db.collection("chat_bans"),
    };
    Object.entries(queries).forEach(([key, q]) =>
      stops.push(
        q.onSnapshot(
          (s) => {
            data[key] = s.docs.map((d) => ({ id: d.id, ...d.data() }));
            if (key === "categories" || key === "boards") renderStructure();
            if (key === "boards" && $("faOfficialBoard"))
              $("faOfficialBoard").innerHTML = options(
                data.boards,
                $("faOfficialBoard").value,
              );
            if (key === "threads") renderThreads();
            if (key === "reports") renderReports();
            if (key === "bans") renderBans();
            if (key === "audit")
              $("faAudit").innerHTML = data.audit
                .map(
                  (a) =>
                    "<p>" +
                    esc(a.at?.toDate().toLocaleString() || "Now") +
                    " · " +
                    esc(a.action) +
                    " · " +
                    esc(a.target) +
                    "</p>",
                )
                .join("");
          },
          (e) => {
            $("faStatus").textContent = e.message;
          },
        ),
      ),
    );
    stops.push(
      ref("config")
        .doc("main")
        .onSnapshot((s) => {
          config = s.exists ? s.data() : {};
          const f = $("faSettings");
          f.elements.rules.value = config.rules || "";
          f.elements.readOnly.checked = !!config.readOnly;
        }),
    );
  }
  window.KnobsockForumsAdmin = { init, stop };
})();
