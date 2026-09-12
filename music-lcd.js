/* LCD library: consumes the same two read-only Firestore documents as admin.html. */
(() => {
  'use strict';
  const body = document.getElementById('lcdBody');
  const title = document.getElementById('lcdTitle');
  const footer = document.getElementById('lcdFooter');
  const indicator = document.getElementById('lcdState');
  const audio = new Audio();
  audio.preload = 'metadata';
  let config = {}, saved = [], cloud = [], library = [], queue = [];
  let page = { kind: 'home', label: 'KNOBSOCK' }, history = [], cursor = 0;
  let current = null, playing = false, wantsPlay = false, shuffle = false, elapsed = 0, duration = 0;
  let message = 'Loading library...', widget = null, scFrame = null, scUrl = '', generation = 0;
  let loadTimer, hls, profileVersion = 0;
  const metadata = new Map();
  const scripts = new Map();
  function script(url) {
    if (!scripts.has(url)) scripts.set(url, new Promise((resolve, reject) => {
      const el = document.createElement('script'); el.src = url;
      el.onload = resolve; el.onerror = () => reject(new Error('Player could not load'));
      document.head.append(el);
    }));
    return scripts.get(url);
  }
  function node(tag, text, className) {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    if (className) el.className = className;
    return el;
  }
  function safeUrl(value) {
    if (/^[a-zA-Z0-9_-]{11}$/.test(value || '')) return 'https://www.youtube.com/watch?v=' + value;
    try { const url = new URL(value); return /^https?:$/.test(url.protocol) ? url.href : ''; } catch (_) { return ''; }
  }
  function source(url) {
    const host = new URL(url).hostname;
    if (/(^|\.)(youtube\.com|youtu\.be)$/.test(host)) return 'YouTube';
    if (/(^|\.)soundcloud\.com$/.test(host)) return 'SoundCloud';
    return /\.(mp3|m4a|aac|ogg|wav|flac|mp4|webm|m3u8)(\?|$)/i.test(url) ? 'Audio' : 'Link';
  }
  function rebuild() {
    const seen = new Set();
    library = [...saved, ...cloud].filter(track => {
      if (seen.has(track.url)) return false;
      seen.add(track.url);
      return !(config.hiddenCreators || []).includes(track.rawArtist);
    }).map(track => ({ ...track, artist: (config.creatorAliases || {})[track.rawArtist] || track.rawArtist || 'Unknown artist' }));
    if (current && !library.some(t => t.url === current.url)) { stop(); current = null; }
    cursor = Math.min(cursor, Math.max(0, rows().length - 1));
    render();
  }
  function orderedGroups(key, order) {
    return [...new Set(library.map(t => t[key]))].sort((a, b) => {
      const ai = order.indexOf(a), bi = order.indexOf(b);
      return (ai < 0 ? 9999 : ai) - (bi < 0 ? 9999 : bi) || a.localeCompare(b);
    });
  }
  function rows() {
    if (page.kind === 'home') return [
      { label: 'Songs', kind: 'songs' }, { label: 'Artists', kind: 'artists' },
      { label: 'Albums', kind: 'albums' }, { label: 'Now Playing', kind: 'now' }
    ];
    if (page.kind === 'artists' || page.kind === 'albums') {
      const key = page.kind === 'artists' ? 'artist' : 'album';
      return orderedGroups(key, config[key === 'artist' ? 'creatorOrder' : 'albumOrder'] || [])
        .map(label => ({ label, kind: 'songs', filter: key, value: label }));
    }
    if (page.kind === 'songs') return library.filter(t => !page.filter || t[page.filter] === page.value)
      .map(track => ({ label: track.title, track }));
    return [];
  }
  function visit(next) { history.push({ page, cursor }); page = next; cursor = 0; message = ''; render(); }
  function back() {
    const previous = history.pop(); page = previous ? previous.page : { kind: 'home', label: 'KNOBSOCK' };
    cursor = previous ? previous.cursor : 0; message = ''; render();
  }
  function clock(seconds) {
    seconds = Math.max(0, Math.floor(Number(seconds) || 0));
    return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
  }
  function render() {
    title.textContent = page.label;
    indicator.textContent = (shuffle ? 'S ' : '') + (playing ? '▶' : 'Ⅱ');
    body.replaceChildren();
    if (page.kind === 'now') {
      const box = node('div', undefined, 'lcd-now');
      if (!current) box.append(node('div', 'Choose a song'), node('div', 'ARTIST / ALBUM to browse', 'lcd-detail'));
      else {
        box.append(node('div', current.title, 'lcd-track-name'), node('div', current.artist + ' / ' + current.album, 'lcd-detail'));
        const progress = node('button', undefined, 'lcd-progress');
        progress.type = 'button'; progress.setAttribute('aria-label', 'Seek within this track');
        const fill = node('span', undefined, 'lcd-progress-fill');
        fill.style.width = (duration ? Math.min(100, elapsed / duration * 100) : 0) + '%';
        progress.append(fill);
        let scrubbing = false;
        const scrub = event => {
          if (!duration || !current || !/Audio|SoundCloud/.test(current.provider)) return;
          const rect = progress.getBoundingClientRect();
          const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
          elapsed = duration * fraction;
          if (current.provider === 'SoundCloud') widget?.seekTo(elapsed * 1000);
          else audio.currentTime = elapsed;
          fill.style.width = (fraction * 100) + '%';
          render();
        };
        progress.addEventListener('pointerdown', event => { event.preventDefault(); scrubbing = true; progress.setPointerCapture(event.pointerId); scrub(event); });
        progress.addEventListener('pointermove', event => { if (scrubbing) scrub(event); });
        progress.addEventListener('pointerup', event => { scrubbing = false; if (progress.hasPointerCapture(event.pointerId)) progress.releasePointerCapture(event.pointerId); });
        progress.addEventListener('pointercancel', () => { scrubbing = false; });
        const times = node('div', undefined, 'lcd-times');
        times.append(node('span', clock(elapsed)), node('span', current.provider), node('span', '-' + clock(duration - elapsed)));
        box.append(progress, times);
      }
      body.append(box);
    } else {
      const entries = rows(), start = Math.max(0, cursor - 3);
      if (!entries.length) body.append(node('div', 'No songs yet', 'lcd-detail'));
      entries.slice(start, start + 4).forEach((entry, offset) => {
        const index = start + offset;
        const button = node('button', undefined, 'lcd-row' + (cursor === index ? ' is-selected' : ''));
        button.type = 'button'; button.title = entry.label;
        button.setAttribute('aria-label', entry.label);
        if (cursor === index) button.setAttribute('aria-current', 'true');
        button.append(node('span', entry.label), node('span', entry.track ? (entry.track.provider === 'YouTube' ? 'YT' : '♪') : '>'));
        button.onclick = () => { cursor = index; select(); }; body.append(button);
      });
    }
    footer.textContent = message || (page.kind === 'now' ? (playing ? 'PLAYING' : 'PAUSED') :
      (rows().length ? `${cursor + 1}/${rows().length} · SCROLL + SELECT` : 'Add music in Admin'));
  }
  function scroll(step) {
    if (page.kind === 'now') { page = { kind: 'songs', label: 'Songs' }; cursor = Math.max(0, library.findIndex(t => t.url === current?.url)); }
    const length = rows().length;
    if (length) cursor = ((cursor + step) % length + length) % length;
    message = ''; render();
  }
  function select() {
    const entry = rows()[cursor];
    if (!entry) return;
    if (entry.track) { queue = rows().map(row => row.track); play(entry.track, true); }
    else visit({ ...entry, label: entry.label });
  }
  function state(value) {
    playing = value;
    if (value) { message = ''; clearTimeout(loadTimer); }
    document.dispatchEvent(new CustomEvent('music-playback-state', { detail: value ? 'play' : 'pause' })); render();
  }
  function stop() {
    wantsPlay = false; generation++; clearTimeout(loadTimer); audio.pause(); widget?.pause();
    if (hls) { hls.destroy(); hls = null; }
    state(false);
  }
  function failed(text) { wantsPlay = false; clearTimeout(loadTimer); audio.pause(); widget?.pause(); state(false); message = text; render(); }
  async function play(track, autoplay = true) {
    if (!track) return;
    stop(); const token = generation;
    current = track; elapsed = 0; duration = track.duration || 0;
    if (page.kind !== 'now') { history.push({ page, cursor }); page = { kind: 'now', label: 'Now Playing' }; }
    if (track.provider === 'YouTube' || track.provider === 'Link') {
      message = 'Audio version coming soon'; render(); return;
    }
    wantsPlay = autoplay;
    if (wantsPlay) document.dispatchEvent(new CustomEvent('music-playback-state', { detail: 'play' }));
    message = 'Loading audio...'; render();
    loadTimer = setTimeout(() => { if (token === generation) failed('Press PLAY to retry · source may be unavailable'); }, 15000);
    try {
      if (track.provider === 'SoundCloud') {
        await soundcloud(track.url); if (token !== generation) return;
        scUrl = track.url;
        widget.load(track.url, { auto_play: wantsPlay, show_artwork: false, callback: () => {
          if (token !== generation) return;
          widget.getDuration(ms => { if (token === generation) duration = ms / 1000; });
          if (wantsPlay) widget.play();
          else { clearTimeout(loadTimer); message = ''; render(); }
        } });
      } else {
        if (/\.m3u8(\?|$)/i.test(track.url) && !audio.canPlayType('application/vnd.apple.mpegurl')) {
          await script('https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.6.15/hls.min.js');
          if (token !== generation) return;
          if (!window.Hls?.isSupported()) throw new Error('Stream unsupported');
          hls = new Hls(); hls.loadSource(track.url); hls.attachMedia(audio);
          hls.on(Hls.Events.ERROR, (_, data) => { if (data.fatal && token === generation) failed('Stream unavailable · try another song'); });
        } else audio.src = track.url;
        if (wantsPlay) await audio.play();
        else { clearTimeout(loadTimer); message = ''; render(); }
      }
    } catch (_) { if (token === generation) failed('Playback unavailable · press PLAY to retry'); }
  }
  function resume() {
    wantsPlay = true;
    if (!current) { const entry = rows()[cursor]; queue = library.slice(); play(entry?.track || library.find(t => /Audio|SoundCloud/.test(t.provider))); return; }
    if (!/Audio|SoundCloud/.test(current.provider)) { message = 'Audio version coming soon'; render(); return; }
    if (message || (current.provider === 'SoundCloud' && scUrl !== current.url)) { play(current); return; }
    if (current.provider === 'SoundCloud') widget?.play();
    else audio.play().catch(() => failed('Press PLAY to retry'));
  }
  function navigate(direction, continuePlaying = playing) {
    if (direction < 0 && elapsed > 3 && current) {
      if (current.provider === 'SoundCloud') widget.seekTo(0); else audio.currentTime = 0;
      elapsed = 0; render(); return;
    }
    const candidates = (queue.length ? queue : library).filter(t => /Audio|SoundCloud/.test(t.provider) && library.some(l => l.url === t.url));
    if (!candidates.length) { message = 'No audio sources yet'; render(); return; }
    let index = candidates.findIndex(t => t.url === current?.url);
    if (shuffle && candidates.length > 1) index = (Math.max(0, index) + 1 + Math.floor(Math.random() * (candidates.length - 1))) % candidates.length;
    else index = (index + direction + candidates.length) % candidates.length;
    play(candidates[index], !current || continuePlaying);
  }
  let scPromise;
  function soundcloud(initialUrl) {
    if (!scPromise) scPromise = script('https://w.soundcloud.com/player/api.js').then(() => new Promise((resolve, reject) => {
      scFrame = node('iframe'); scFrame.className = 'music-engine'; scFrame.title = 'SoundCloud audio engine';
      scFrame.allow = 'autoplay'; scFrame.tabIndex = -1; scFrame.setAttribute('aria-hidden', 'true');
      scFrame.src = 'https://w.soundcloud.com/player/?url=' + encodeURIComponent(initialUrl) + '&auto_play=false&show_artwork=false';
      document.body.append(scFrame); widget = SC.Widget(scFrame);
      const timer = setTimeout(() => reject(new Error('SoundCloud timed out')), 20000);
      widget.bind(SC.Widget.Events.READY, () => { clearTimeout(timer); resolve(widget); });
      widget.bind(SC.Widget.Events.PLAY, () => { if (current?.provider === 'SoundCloud' && wantsPlay) state(true); else widget.pause(); });
      widget.bind(SC.Widget.Events.PAUSE, () => { if (current?.provider === 'SoundCloud') state(false); });
      widget.bind(SC.Widget.Events.PLAY_PROGRESS, data => { if (current?.provider === 'SoundCloud') { elapsed = data.currentPosition / 1000; if (page.kind === 'now') render(); } });
      widget.bind(SC.Widget.Events.FINISH, () => { if (current?.provider === 'SoundCloud') navigate(1, true); });
      widget.bind(SC.Widget.Events.ERROR, () => { if (current?.provider === 'SoundCloud') failed('SoundCloud track unavailable'); });
    }));
    return scPromise;
  }
  audio.addEventListener('playing', () => { if (current?.provider === 'Audio') state(true); });
  audio.addEventListener('pause', () => { if (current?.provider === 'Audio') state(false); });
  audio.addEventListener('error', () => { if (current?.provider === 'Audio') failed('Audio unavailable · try another song'); });
  audio.addEventListener('ended', () => navigate(1, true));
  audio.addEventListener('timeupdate', () => {
    if (current?.provider !== 'Audio') return;
    elapsed = audio.currentTime; duration = Number.isFinite(audio.duration) ? audio.duration : 0;
    if (page.kind === 'now') render();
  });
  document.getElementById('lcdBack').onclick = back;
  document.addEventListener('music-wheel-step', event => scroll(event.detail));
  document.getElementById('musicSelectButton').addEventListener('click', select);
  document.querySelectorAll('[data-control]').forEach(button => button.addEventListener('click', () => {
    const kind = button.dataset.control;
    if (kind === 'shuffle') { shuffle = button.getAttribute('aria-pressed') === 'true'; render(); }
    else { history = []; visit({ kind: kind === 'artist' ? 'artists' : 'albums', label: kind === 'artist' ? 'Artists' : 'Albums' }); }
  }));
  document.addEventListener('music-transport', event => {
    if (event.detail === 'play') resume();
    else if (event.detail === 'pause') { wantsPlay = false; clearTimeout(loadTimer); audio.pause(); widget?.pause(); message = ''; state(false); }
    else navigate(event.detail === 'forward' ? 1 : -1);
  });
  document.addEventListener('keydown', event => {
    if (!document.getElementById('musicZoom').classList.contains('is-open') || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); scroll(event.key === 'ArrowDown' ? 1 : -1); }
    if (event.key === 'ArrowLeft' || event.key === 'Backspace') { event.preventDefault(); back(); }
    if (event.key === 'ArrowRight') { event.preventDefault(); select(); }
    if (event.key === 'Enter' && (event.target === document.body || event.target.id === 'musicTracksWheel')) { event.preventDefault(); select(); }
  });
  async function enrich(track) {
    if (!/YouTube|SoundCloud/.test(track.provider)) return;
    if (!metadata.has(track.url)) metadata.set(track.url, fetch('https://noembed.com/embed?url=' + encodeURIComponent(track.url), { signal: AbortSignal.timeout(8000) })
      .then(response => response.json()).catch(() => ({})));
    const data = await metadata.get(track.url);
    track.rawArtist = data.author_name || track.rawArtist;
    if (!track.title) track.title = data.title || 'Untitled';
    rebuild();
  }
  window.knobsockMusic = { connect(db) {
    db.collection('playlist').doc('music').onSnapshot(doc => {
      config = doc.data() || {};
      saved = (Array.isArray(config.videos) ? config.videos : []).map(item => {
        const url = safeUrl(item.url); if (!url) return null;
        return { url, title: item.title || 'Untitled', album: item.album || 'Singles', rawArtist: item.artist || item.author || 'Unknown artist', provider: source(url) };
      }).filter(Boolean);
      message = ''; rebuild(); saved.forEach(enrich);
    }, () => { message = 'Library unavailable · reload to retry'; render(); });
    db.collection('chat_config').doc('soundcloud').onSnapshot(async doc => {
      const version = ++profileVersion;
      const url = safeUrl(doc.data()?.profileUrl);
      cloud = []; rebuild(); if (!url || source(url) !== 'SoundCloud') return;
      try {
        await soundcloud(url); if (version !== profileVersion) return;
        if (current?.provider === 'SoundCloud') stop();
        widget.load(url, { auto_play: false, show_artwork: false, callback: () => widget.getSounds(sounds => {
          if (version !== profileVersion) return;
          cloud = (sounds || []).filter(s => safeUrl(s.permalink_url)).map(s => ({ url: s.permalink_url, title: s.title || 'Untitled', rawArtist: s.user?.username || 'SoundCloud', album: 'SoundCloud', provider: 'SoundCloud', duration: s.duration / 1000 }));
          rebuild();
        }) });
      } catch (_) { message = 'SoundCloud unavailable · reload to retry'; render(); }
    }, () => { message = 'SoundCloud unavailable'; render(); });
  } };
  render();
})();
