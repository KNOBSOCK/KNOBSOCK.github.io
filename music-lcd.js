/* LCD library and player: populated from the linked SoundCloud profiles. */
(() => {
  'use strict';
  const body = document.getElementById('lcdBody'), title = document.getElementById('lcdTitle');
  const footer = document.getElementById('lcdFooter'), indicator = document.getElementById('lcdState');
  let cloud = [], library = [], queue = [];
  let page = { kind: 'home', label: 'KNOBSOCK' }, history = [], cursor = 0;
  let current = null, playing = false, wantsPlay = false, shuffle = false, elapsed = 0, duration = 0;
  let message = 'Loading SoundCloud...', widget = null, scUrl = '', generation = 0, loadTimer, profileVersion = 0, scPromise;
  let lastCompletedUrl = '', autoplayLockUntil = 0, pendingExternalUrl = '';
  const mediaSession = 'mediaSession' in navigator && typeof MediaMetadata === 'function' ? navigator.mediaSession : null;
  const scripts = new Map();
  const node = (tag, text, className) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; };
  function script(url) {
    if (!scripts.has(url)) scripts.set(url, new Promise((resolve, reject) => {
      const el = document.createElement('script'); el.src = url; el.onload = resolve; el.onerror = () => reject(new Error('Player could not load')); document.head.append(el);
    })); return scripts.get(url);
  }
  function soundCloudUrl(value) { try { const url = new URL(value); return /^https?:$/.test(url.protocol) && /(^|\.)soundcloud\.com$/i.test(url.hostname) ? url.href : ''; } catch (_) { return ''; } }
  function notifyParent(message) {
    if (window.parent === window) return;
    try { window.parent.postMessage(message, window.location.origin); } catch (_) {}
  }
  function alphabetical(items, field) {
    return items.slice().sort((a, b) => String(field ? a[field] : a).localeCompare(String(field ? b[field] : b), undefined, { sensitivity: 'base', numeric: true }));
  }
  function groups(key) { return alphabetical([...new Set(library.map(track => track[key]))]); }
  function syncMediaSession(track, isPlaying) {
    if (!track) return;
    const metadata = {
      title: String(track.title || 'Untitled'),
      artist: String(track.artist || track.rawArtist || 'SoundCloud'),
      album: String(track.album || 'SoundCloud')
    };
    notifyParent({ type: 'knobsock-music-track', title: metadata.title, artist: metadata.artist, artwork: track.artwork_url || '', url: track.url || '', duration: track.duration || 0 });
    if (!mediaSession) return;
    if (track.artwork_url) metadata.artwork = [{ src: track.artwork_url, sizes: '500x500', type: 'image/jpeg' }];
    try {
      mediaSession.metadata = new MediaMetadata(metadata);
      mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
    } catch (_) {}
  }
  function clearMediaSession() {
    if (!mediaSession) return;
    try { mediaSession.metadata = null; mediaSession.playbackState = 'none'; } catch (_) {}
  }
  function refreshMediaSession() { syncMediaSession(current, playing); }
  function rows() {
    if (page.kind === 'home') return [{ label: 'Songs', kind: 'songs' }, { label: 'Artists', kind: 'artists' }, { label: 'Albums', kind: 'albums' }, { label: 'Now Playing', kind: 'now' }];
    if (page.kind === 'artists' || page.kind === 'albums') { const key = page.kind === 'artists' ? 'artist' : 'album'; return groups(key).map(label => ({ label, kind: 'songs', filter: key, value: label })); }
    return page.kind === 'songs' ? alphabetical(library.filter(track => !page.filter || track[page.filter] === page.value), 'title').map(track => ({ label: track.artist + ' - ' + track.title, track })) : [];
  }
  function rebuild() {
    const seen = new Set(); library = cloud.filter(track => !seen.has(track.url) && seen.add(track.url)).map(track => ({ ...track, artist: track.rawArtist || 'SoundCloud' }));
    if (current && !library.some(track => track.url === current.url)) { stop(); current = null; clearMediaSession(); }
    cursor = Math.min(cursor, Math.max(0, rows().length - 1)); render();
    if (pendingExternalUrl && playTrackByUrl(pendingExternalUrl)) pendingExternalUrl = '';
  }
  function visit(next) { history.push({ page, cursor }); page = next; cursor = 0; message = ''; render(); }
  function back() { const previous = history.pop(); page = previous ? previous.page : { kind: 'home', label: 'KNOBSOCK' }; cursor = previous ? previous.cursor : 0; message = ''; render(); }
  function clock(value) { const seconds = Math.max(0, Math.floor(Number(value) || 0)); return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0'); }
  /* The footer is gone, leaving room for three portrait rows and at least four-and-a-half desktop rows. */
  function visibleRows() { return window.matchMedia('(max-width: 860px) and (orientation: portrait)').matches ? 3 : 5; }
  function render() {
    title.textContent = page.label; indicator.textContent = (shuffle ? 'S ' : '') + (playing ? '▶' : 'Ⅱ'); footer.classList.toggle('lcd-footer--now', page.kind === 'now'); body.replaceChildren();
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
      const entries = rows(), rowCount = visibleRows();
      const start = Math.min(Math.max(0, cursor - rowCount + 1), Math.max(0, entries.length - rowCount));
      if (!entries.length) body.append(node('div', 'No SoundCloud tracks yet', 'lcd-detail'));
      entries.slice(start, start + rowCount).forEach((entry, offset) => {
        const index = start + offset, button = node('button', undefined, 'lcd-row' + (cursor === index ? ' is-selected' : ''));
        button.type = 'button'; button.title = entry.label; button.setAttribute('aria-label', entry.label); if (cursor === index) button.setAttribute('aria-current', 'true');
        button.append(node('span', entry.label), node('span', entry.track ? '♪' : '>')); button.onclick = () => { cursor = index; select(); }; body.append(button);
      });
    }
    footer.textContent = message || (page.kind === 'now' ? (playing ? 'PLAYING' : 'PAUSED') : (rows().length ? `${cursor + 1}/${rows().length} · SCROLL + SELECT` : 'Link SoundCloud in Admin'));
  }
  function scroll(step) {
    const beforePage = page.kind, beforeCursor = cursor;
    if (page.kind === 'now') { page = { kind: 'songs', label: 'Songs' }; cursor = Math.max(0, library.findIndex(track => track.url === current?.url)); }
    const length = rows().length; if (length) cursor = Math.max(0, Math.min(length - 1, cursor + step)); message = ''; render();
    const moved = beforePage === page.kind ? Math.abs(cursor - beforeCursor) : Math.abs(step);
    if (moved) document.dispatchEvent(new CustomEvent('music-wheel-selection', { detail: moved }));
  }
  function select() { const entry = rows()[cursor]; if (!entry) return; if (entry.track) { queue = rows().map(row => row.track); document.dispatchEvent(new CustomEvent('music-select-play')); play(entry.track, true); } else visit({ ...entry, label: entry.label }); }
  function state(value) { playing = value; syncMediaSession(current, value); if (value) { message = ''; clearTimeout(loadTimer); } document.dispatchEvent(new CustomEvent('music-playback-state', { detail: value ? 'play' : 'pause' })); render(); }
  function stop() { wantsPlay = false; generation++; clearTimeout(loadTimer); widget?.pause(); state(false); }
  function failed(text) { wantsPlay = false; clearTimeout(loadTimer); widget?.pause(); state(false); message = text; render(); }
  async function play(track, autoplay = true) {
    if (!track) return; stop(); const token = generation; current = track; elapsed = 0; duration = track.duration || 0;
    lastCompletedUrl = '';
    syncMediaSession(current, autoplay);
    notifyParent({ type: 'knobsock-music-progress', elapsed: 0, duration, fraction: 0 });
    if (page.kind !== 'now') { history.push({ page, cursor }); page = { kind: 'now', label: 'Now Playing' }; }
    wantsPlay = autoplay; if (wantsPlay) document.dispatchEvent(new CustomEvent('music-playback-state', { detail: 'play' })); message = 'Loading SoundCloud...'; render();
    loadTimer = setTimeout(() => { if (token === generation) failed('Press PLAY to retry'); }, 15000);
    try { await soundcloud(track.url); if (token !== generation) return; scUrl = track.url; widget.load(track.url, { auto_play: wantsPlay, show_artwork: false, callback: () => { if (token !== generation) return; widget.getDuration(ms => { if (token === generation) duration = ms / 1000; }); if (wantsPlay) widget.play(); else { clearTimeout(loadTimer); message = ''; render(); } } }); }
    catch (_) { if (token === generation) failed('SoundCloud unavailable · press PLAY to retry'); }
  }
  function playTrackByUrl(value) {
    const url = soundCloudUrl(value);
    if (!url) return true;
    const track = library.find(item => item.url === url);
    if (!track) return false;
    queue = library.slice();
    play(track, true);
    return true;
  }
  function resume() { wantsPlay = true; if (!current) { const entry = rows()[cursor]; queue = library.slice(); play(entry?.track || library[0]); return; } if (message || scUrl !== current.url) { play(current); return; } widget?.play(); }
  function handleShellCommand(command) {
    const action = String(command.action || '');
    if (action === 'play-track') {
      const url = soundCloudUrl(command.url);
      if (!url) return;
      if (!playTrackByUrl(url)) pendingExternalUrl = url;
      return;
    }
    if (action === 'play') { resume(); return; }
    if (action === 'pause') { wantsPlay = false; clearTimeout(loadTimer); widget?.pause(); message = ''; state(false); return; }
    if (action === 'toggle') { if (playing) { wantsPlay = false; clearTimeout(loadTimer); widget?.pause(); message = ''; state(false); } else resume(); return; }
    if (action === 'seek') {
      const fraction = Math.min(1, Math.max(0, Number(command.fraction)));
      if (!Number.isFinite(fraction) || !duration || !widget) return;
      elapsed = duration * fraction;
      widget.seekTo(elapsed * 1000);
      render();
    }
  }
  function navigate(direction, continuePlaying = playing) {
    if (direction < 0 && elapsed > 3 && current) { widget?.seekTo(0); elapsed = 0; render(); return; }
    const candidates = (queue.length ? queue : library).filter(track => library.some(item => item.url === track.url)); if (!candidates.length) { message = 'No SoundCloud tracks yet'; render(); return; }
    let index = candidates.findIndex(track => track.url === current?.url); if (shuffle && candidates.length > 1) index = Math.max(0, index) + 1 + Math.floor(Math.random() * (candidates.length - 1)); else index += direction;
    if (index < 0 || index >= candidates.length) { render(); return; } play(candidates[index], !current || continuePlaying);
  }
  function autoplayNext() {
    const available = library.filter(track => soundCloudUrl(track.url));
    const candidates = (queue.length ? queue : available).filter(track => available.some(item => item.url === track.url));
    let index = candidates.findIndex(track => track.url === current?.url);
    let next = index >= 0 ? candidates[index + 1] : null;
    /* A one-track artist/album view should still continue through the profile library. */
    if (!next) {
      index = available.findIndex(track => track.url === current?.url);
      next = index >= 0 ? available[index + 1] : null;
    }
    if (!next) { wantsPlay = false; state(false); return; }
    wantsPlay = true;
    play(next, true);
  }
  function completeTrack() {
    const endedUrl = current?.url;
    if (!endedUrl || endedUrl === lastCompletedUrl || Date.now() < autoplayLockUntil) return;
    lastCompletedUrl = endedUrl;
    /* Ignore the old widget's trailing events while the next source is loading. */
    autoplayLockUntil = Date.now() + 1500;
    setTimeout(() => { if (current?.url === endedUrl) autoplayNext(); }, 40);
  }
  function soundcloud(initialUrl) {
    if (!scPromise) scPromise = script('https://w.soundcloud.com/player/api.js').then(() => new Promise((resolve, reject) => {
      const frame = node('iframe'); frame.className = 'music-engine'; frame.title = 'SoundCloud audio engine'; frame.allow = 'autoplay'; frame.tabIndex = -1; frame.setAttribute('aria-hidden', 'true'); frame.src = 'https://w.soundcloud.com/player/?url=' + encodeURIComponent(initialUrl) + '&auto_play=false&show_artwork=false'; document.body.append(frame); widget = SC.Widget(frame);
      const timer = setTimeout(() => reject(new Error('SoundCloud timed out')), 20000);
      widget.bind(SC.Widget.Events.READY, () => { clearTimeout(timer); resolve(widget); });
      widget.bind(SC.Widget.Events.PLAY, () => { if (current && wantsPlay) state(true); else widget.pause(); });
      widget.bind(SC.Widget.Events.PAUSE, () => {
        if (!current) return;
        if (wantsPlay && duration && elapsed >= duration - 2) completeTrack();
        else state(false);
      });
      widget.bind(SC.Widget.Events.PLAY_PROGRESS, data => { if (current) { elapsed = data.currentPosition / 1000; notifyParent({ type: 'knobsock-music-progress', elapsed, duration, fraction: data.relativePosition }); if (page.kind === 'now') render(); } });
      widget.bind(SC.Widget.Events.FINISH, completeTrack);
      widget.bind(SC.Widget.Events.ERROR, () => { if (current) failed('SoundCloud track unavailable'); });
    })); return scPromise;
  }
  function soundCloudProfiles(data) {
    const values = [], artists = data && Array.isArray(data.profileArtists) ? data.profileArtists : [];
    if (data && Array.isArray(data.profileUrls)) {
      data.profileUrls.forEach((url, index) => values.push({ url, artist: artists[index] || '' }));
    } else if (data && typeof data.profileUrls === 'string') {
      values.push({ url: data.profileUrls, artist: artists[0] || '' });
    }
    if (data && data.profileUrl) values.push({ url: data.profileUrl, artist: data.profileArtist || artists[values.length] || '' });
    const seen = new Set();
    return values.map(profile => ({ url: soundCloudUrl(profile.url), artist: String(profile.artist || '').trim() })).filter(profile => {
      if (!profile.url || seen.has(profile.url)) return false;
      seen.add(profile.url);
      return true;
    });
  }
  function configuredAlbums(data) {
    const seen = new Set();
    return (data && Array.isArray(data.albums) ? data.albums : []).map(album => {
      const name = String(album && album.name || '').trim();
      const tracks = Array.isArray(album && album.tracks) ? album.tracks.map(soundCloudUrl).filter(Boolean) : [];
      return { name, tracks };
    }).filter(album => album.name && !seen.has(album.name.toLocaleLowerCase()) && seen.add(album.name.toLocaleLowerCase()));
  }
  function albumForTrack(url, albums) {
    const match = albums.find(album => album.tracks.includes(url));
    return match ? match.name : 'SoundCloud';
  }
  function loadSoundCloudProfile(url) {
    return new Promise(resolve => {
      if (!widget) { resolve([]); return; }
      let settled = false;
      const finish = sounds => { if (settled) return; settled = true; resolve(sounds || []); };
      const timer = setTimeout(() => finish([]), 20000);
      try {
        widget.load(url, {
          auto_play: false,
          show_artwork: false,
          callback: () => widget.getSounds(sounds => { clearTimeout(timer); finish(sounds); })
        });
      } catch (_) { clearTimeout(timer); finish([]); }
    });
  }
  document.getElementById('lcdBack').onclick = back; document.addEventListener('music-wheel-step', event => scroll(event.detail)); document.getElementById('musicSelectButton').addEventListener('click', select);
  document.querySelectorAll('[data-control]').forEach(button => button.addEventListener('click', () => { const kind = button.dataset.control; if (kind === 'back') back(); else if (kind === 'shuffle') { shuffle = button.getAttribute('aria-pressed') === 'true'; render(); } else { history = []; visit({ kind: kind === 'artist' ? 'artists' : 'albums', label: kind === 'artist' ? 'Artists' : 'Albums' }); } }));
  document.addEventListener('music-transport', event => { if (event.detail === 'play') resume(); else if (event.detail === 'pause') { wantsPlay = false; clearTimeout(loadTimer); widget?.pause(); message = ''; state(false); } else navigate(event.detail === 'forward' ? 1 : -1); });
  window.addEventListener('message', event => {
    if (
      window.parent === window ||
      event.source !== window.parent ||
      event.origin !== window.location.origin ||
      !event.data ||
      event.data.type !== 'knobsock-shell-music-command'
    ) return;
    handleShellCommand(event.data);
  });
  function keyboardTransport(action) {
    document.dispatchEvent(new CustomEvent('music-key-transport', { detail: action }));
    document.dispatchEvent(new CustomEvent('music-transport', { detail: action }));
  }
  document.addEventListener('keydown', event => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const key = event.key || '', code = event.code || '';
    const isKey = (...values) => values.includes(key) || values.includes(code);
    if (isKey('MediaTrackNext', 'AudioTrackNext', 'MediaNextTrack', 'NextTrack', 'F9')) { event.preventDefault(); keyboardTransport('forward'); }
    else if (isKey('MediaTrackPrevious', 'AudioTrackPrevious', 'MediaPreviousTrack', 'PreviousTrack', 'F7')) { event.preventDefault(); keyboardTransport('previous'); }
    else if (isKey('MediaPlayPause', 'AudioPlayPause', 'PlayPause', 'F8')) { event.preventDefault(); keyboardTransport(playing ? 'pause' : 'play'); }
    else if (isKey('MediaPlay', 'AudioPlay', 'Play')) { event.preventDefault(); keyboardTransport('play'); }
    else if (isKey('MediaPause', 'AudioPause', 'Pause')) { event.preventDefault(); keyboardTransport('pause'); }
  });
  if (navigator.mediaSession?.setActionHandler) {
    try { navigator.mediaSession.setActionHandler('nexttrack', () => keyboardTransport('forward')); } catch (_) {}
    try { navigator.mediaSession.setActionHandler('previoustrack', () => keyboardTransport('previous')); } catch (_) {}
    try { navigator.mediaSession.setActionHandler('play', () => keyboardTransport('play')); } catch (_) {}
    try { navigator.mediaSession.setActionHandler('pause', () => keyboardTransport('pause')); } catch (_) {}
  }
  document.addEventListener('visibilitychange', refreshMediaSession);
  window.addEventListener('pageshow', refreshMediaSession);
  document.addEventListener('keydown', event => { if (!document.getElementById('musicZoom').classList.contains('is-open') || event.altKey || event.ctrlKey || event.metaKey) return; if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); scroll(event.key === 'ArrowDown' ? 1 : -1); } if (event.key === 'ArrowLeft' || event.key === 'Backspace') { event.preventDefault(); back(); } if (event.key === 'ArrowRight') { event.preventDefault(); select(); } if (event.key === 'Enter' && (event.target === document.body || event.target.id === 'musicTracksWheel')) { event.preventDefault(); select(); } });
  window.knobsockMusic = { connect(db) { db.collection('chat_config').doc('soundcloud').onSnapshot(async doc => {
    const config = doc.data(), version = ++profileVersion, profiles = soundCloudProfiles(config), albums = configuredAlbums(config);
    cloud = []; message = profiles.length ? 'Loading SoundCloud...' : ''; rebuild();
    if (!profiles.length) return;
    try {
      await soundcloud(profiles[0].url);
      if (version !== profileVersion) return;
      if (current) stop();
      const tracks = [];
      for (const profile of profiles) {
        if (version !== profileVersion) return;
        const sounds = await loadSoundCloudProfile(profile.url);
        sounds.filter(sound => soundCloudUrl(sound.permalink_url)).forEach(sound => {
          const url = soundCloudUrl(sound.permalink_url);
          tracks.push({ url, title: sound.title || 'Untitled', rawArtist: profile.artist || sound.user?.username || 'SoundCloud', album: albumForTrack(url, albums), artwork_url: sound.artwork_url || '', provider: 'SoundCloud', duration: sound.duration / 1000 });
        });
      }
      if (version !== profileVersion) return;
      cloud = tracks; message = ''; rebuild();
    } catch (_) { message = 'SoundCloud unavailable · reload to retry'; render(); }
  }, () => { message = 'SoundCloud unavailable'; render(); }); } };
  render();
})();
