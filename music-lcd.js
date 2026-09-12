/* LCD library and player: populated only from the linked SoundCloud profile. */
(() => {
  'use strict';
  const body = document.getElementById('lcdBody'), title = document.getElementById('lcdTitle');
  const footer = document.getElementById('lcdFooter'), indicator = document.getElementById('lcdState');
  let cloud = [], library = [], queue = [];
  let page = { kind: 'home', label: 'KNOBSOCK' }, history = [], cursor = 0;
  let current = null, playing = false, wantsPlay = false, shuffle = false, elapsed = 0, duration = 0;
  let message = 'Loading SoundCloud...', widget = null, scUrl = '', generation = 0, loadTimer, profileVersion = 0, scPromise;
  const scripts = new Map();
  const node = (tag, text, className) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; };
  function script(url) {
    if (!scripts.has(url)) scripts.set(url, new Promise((resolve, reject) => {
      const el = document.createElement('script'); el.src = url; el.onload = resolve; el.onerror = () => reject(new Error('Player could not load')); document.head.append(el);
    })); return scripts.get(url);
  }
  function soundCloudUrl(value) { try { const url = new URL(value); return /^https?:$/.test(url.protocol) && /(^|\.)soundcloud\.com$/i.test(url.hostname) ? url.href : ''; } catch (_) { return ''; } }
  function groups(key) { return [...new Set(library.map(track => track[key]))].sort((a, b) => a.localeCompare(b)); }
  function rows() {
    if (page.kind === 'home') return [{ label: 'Songs', kind: 'songs' }, { label: 'Artists', kind: 'artists' }, { label: 'Albums', kind: 'albums' }, { label: 'Now Playing', kind: 'now' }];
    if (page.kind === 'artists' || page.kind === 'albums') { const key = page.kind === 'artists' ? 'artist' : 'album'; return groups(key).map(label => ({ label, kind: 'songs', filter: key, value: label })); }
    return page.kind === 'songs' ? library.filter(track => !page.filter || track[page.filter] === page.value).map(track => ({ label: track.title, track })) : [];
  }
  function rebuild() {
    const seen = new Set(); library = cloud.filter(track => !seen.has(track.url) && seen.add(track.url)).map(track => ({ ...track, artist: track.rawArtist || 'SoundCloud' }));
    if (current && !library.some(track => track.url === current.url)) { stop(); current = null; }
    cursor = Math.min(cursor, Math.max(0, rows().length - 1)); render();
  }
  function visit(next) { history.push({ page, cursor }); page = next; cursor = 0; message = ''; render(); }
  function back() { const previous = history.pop(); page = previous ? previous.page : { kind: 'home', label: 'KNOBSOCK' }; cursor = previous ? previous.cursor : 0; message = ''; render(); }
  function clock(value) { const seconds = Math.max(0, Math.floor(Number(value) || 0)); return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0'); }
  function render() {
    title.textContent = page.label; indicator.textContent = (shuffle ? 'S ' : '') + (playing ? '▶' : 'Ⅱ'); body.replaceChildren();
    if (page.kind === 'now') {
      const box = node('div', undefined, 'lcd-now');
      if (!current) box.append(node('div', 'Choose a song'), node('div', 'ARTIST / ALBUM to browse', 'lcd-detail'));
      else {
        box.append(node('div', current.title, 'lcd-track-name'), node('div', current.artist + ' / SoundCloud', 'lcd-detail'));
        const progress = node('button', undefined, 'lcd-progress'), fill = node('span', undefined, 'lcd-progress-fill');
        progress.type = 'button'; progress.setAttribute('aria-label', 'Seek within this track'); fill.style.width = (duration ? Math.min(100, elapsed / duration * 100) : 0) + '%'; progress.append(fill);
        let scrubbing = false;
        const scrub = event => { if (!duration || !current || !widget) return; const rect = progress.getBoundingClientRect(); const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)); elapsed = duration * fraction; widget.seekTo(elapsed * 1000); fill.style.width = (fraction * 100) + '%'; render(); };
        progress.addEventListener('pointerdown', event => { event.preventDefault(); scrubbing = true; progress.setPointerCapture(event.pointerId); scrub(event); });
        progress.addEventListener('pointermove', event => { if (scrubbing) scrub(event); });
        progress.addEventListener('pointerup', event => { scrubbing = false; if (progress.hasPointerCapture(event.pointerId)) progress.releasePointerCapture(event.pointerId); });
        progress.addEventListener('pointercancel', () => { scrubbing = false; });
        const times = node('div', undefined, 'lcd-times'); times.append(node('span', clock(elapsed)), node('span', 'SC'), node('span', '-' + clock(duration - elapsed))); box.append(progress, times);
      } body.append(box);
    } else {
      const entries = rows(), start = Math.max(0, cursor - 3);
      if (!entries.length) body.append(node('div', 'No SoundCloud tracks yet', 'lcd-detail'));
      entries.slice(start, start + 4).forEach((entry, offset) => {
        const index = start + offset, button = node('button', undefined, 'lcd-row' + (cursor === index ? ' is-selected' : ''));
        button.type = 'button'; button.title = entry.label; button.setAttribute('aria-label', entry.label); if (cursor === index) button.setAttribute('aria-current', 'true');
        button.append(node('span', entry.label), node('span', entry.track ? '♪' : '>')); button.onclick = () => { cursor = index; select(); }; body.append(button);
      });
    }
    footer.textContent = message || (page.kind === 'now' ? (playing ? 'PLAYING' : 'PAUSED') : (rows().length ? `${cursor + 1}/${rows().length} · SCROLL + SELECT` : 'Link SoundCloud in Admin'));
  }
  function scroll(step) {
    if (page.kind === 'now') { page = { kind: 'songs', label: 'Songs' }; cursor = Math.max(0, library.findIndex(track => track.url === current?.url)); }
    const length = rows().length; if (length) cursor = Math.max(0, Math.min(length - 1, cursor + step)); message = ''; render();
  }
  function select() { const entry = rows()[cursor]; if (!entry) return; if (entry.track) { queue = rows().map(row => row.track); play(entry.track, true); } else visit({ ...entry, label: entry.label }); }
  function state(value) { playing = value; if (value) { message = ''; clearTimeout(loadTimer); } document.dispatchEvent(new CustomEvent('music-playback-state', { detail: value ? 'play' : 'pause' })); render(); }
  function stop() { wantsPlay = false; generation++; clearTimeout(loadTimer); widget?.pause(); state(false); }
  function failed(text) { wantsPlay = false; clearTimeout(loadTimer); widget?.pause(); state(false); message = text; render(); }
  async function play(track, autoplay = true) {
    if (!track) return; stop(); const token = generation; current = track; elapsed = 0; duration = track.duration || 0;
    if (page.kind !== 'now') { history.push({ page, cursor }); page = { kind: 'now', label: 'Now Playing' }; }
    wantsPlay = autoplay; if (wantsPlay) document.dispatchEvent(new CustomEvent('music-playback-state', { detail: 'play' })); message = 'Loading SoundCloud...'; render();
    loadTimer = setTimeout(() => { if (token === generation) failed('Press PLAY to retry'); }, 15000);
    try { await soundcloud(track.url); if (token !== generation) return; scUrl = track.url; widget.load(track.url, { auto_play: wantsPlay, show_artwork: false, callback: () => { if (token !== generation) return; widget.getDuration(ms => { if (token === generation) duration = ms / 1000; }); if (wantsPlay) widget.play(); else { clearTimeout(loadTimer); message = ''; render(); } } }); }
    catch (_) { if (token === generation) failed('SoundCloud unavailable · press PLAY to retry'); }
  }
  function resume() { wantsPlay = true; if (!current) { const entry = rows()[cursor]; queue = library.slice(); play(entry?.track || library[0]); return; } if (message || scUrl !== current.url) { play(current); return; } widget?.play(); }
  function navigate(direction, continuePlaying = playing) {
    if (direction < 0 && elapsed > 3 && current) { widget?.seekTo(0); elapsed = 0; render(); return; }
    const candidates = (queue.length ? queue : library).filter(track => library.some(item => item.url === track.url)); if (!candidates.length) { message = 'No SoundCloud tracks yet'; render(); return; }
    let index = candidates.findIndex(track => track.url === current?.url); if (shuffle && candidates.length > 1) index = Math.max(0, index) + 1 + Math.floor(Math.random() * (candidates.length - 1)); else index += direction;
    if (index < 0 || index >= candidates.length) { render(); return; } play(candidates[index], !current || continuePlaying);
  }
  function soundcloud(initialUrl) {
    if (!scPromise) scPromise = script('https://w.soundcloud.com/player/api.js').then(() => new Promise((resolve, reject) => {
      const frame = node('iframe'); frame.className = 'music-engine'; frame.title = 'SoundCloud audio engine'; frame.allow = 'autoplay'; frame.tabIndex = -1; frame.setAttribute('aria-hidden', 'true'); frame.src = 'https://w.soundcloud.com/player/?url=' + encodeURIComponent(initialUrl) + '&auto_play=false&show_artwork=false'; document.body.append(frame); widget = SC.Widget(frame);
      const timer = setTimeout(() => reject(new Error('SoundCloud timed out')), 20000);
      widget.bind(SC.Widget.Events.READY, () => { clearTimeout(timer); resolve(widget); });
      widget.bind(SC.Widget.Events.PLAY, () => { if (current && wantsPlay) state(true); else widget.pause(); });
      widget.bind(SC.Widget.Events.PAUSE, () => { if (current) state(false); });
      widget.bind(SC.Widget.Events.PLAY_PROGRESS, data => { if (current) { elapsed = data.currentPosition / 1000; if (page.kind === 'now') render(); } });
      widget.bind(SC.Widget.Events.FINISH, () => { if (current) { wantsPlay = false; state(false); } });
      widget.bind(SC.Widget.Events.ERROR, () => { if (current) failed('SoundCloud track unavailable'); });
    })); return scPromise;
  }
  document.getElementById('lcdBack').onclick = back; document.addEventListener('music-wheel-step', event => scroll(event.detail)); document.getElementById('musicSelectButton').addEventListener('click', select);
  document.querySelectorAll('[data-control]').forEach(button => button.addEventListener('click', () => { const kind = button.dataset.control; if (kind === 'shuffle') { shuffle = button.getAttribute('aria-pressed') === 'true'; render(); } else { history = []; visit({ kind: kind === 'artist' ? 'artists' : 'albums', label: kind === 'artist' ? 'Artists' : 'Albums' }); } }));
  document.addEventListener('music-transport', event => { if (event.detail === 'play') resume(); else if (event.detail === 'pause') { wantsPlay = false; clearTimeout(loadTimer); widget?.pause(); message = ''; state(false); } else navigate(event.detail === 'forward' ? 1 : -1); });
  document.addEventListener('keydown', event => { if (!document.getElementById('musicZoom').classList.contains('is-open') || event.altKey || event.ctrlKey || event.metaKey) return; if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); scroll(event.key === 'ArrowDown' ? 1 : -1); } if (event.key === 'ArrowLeft' || event.key === 'Backspace') { event.preventDefault(); back(); } if (event.key === 'ArrowRight') { event.preventDefault(); select(); } if (event.key === 'Enter' && (event.target === document.body || event.target.id === 'musicTracksWheel')) { event.preventDefault(); select(); } });
  window.knobsockMusic = { connect(db) { db.collection('chat_config').doc('soundcloud').onSnapshot(async doc => { const version = ++profileVersion, url = soundCloudUrl(doc.data()?.profileUrl); cloud = []; rebuild(); if (!url) return; try { await soundcloud(url); if (version !== profileVersion) return; if (current) stop(); widget.load(url, { auto_play: false, show_artwork: false, callback: () => widget.getSounds(sounds => { if (version !== profileVersion) return; cloud = (sounds || []).filter(sound => soundCloudUrl(sound.permalink_url)).map(sound => ({ url: sound.permalink_url, title: sound.title || 'Untitled', rawArtist: sound.user?.username || 'SoundCloud', album: 'SoundCloud', provider: 'SoundCloud', duration: sound.duration / 1000 })); message = ''; rebuild(); }) }); } catch (_) { message = 'SoundCloud unavailable · reload to retry'; render(); } }, () => { message = 'SoundCloud unavailable'; render(); }); } };
  render();
})();
