(() => {
  'use strict';

  const routeFrame = document.getElementById('siteRouteFrame');
  const musicFrame = document.getElementById('siteMusicFrame');
  const miniPlayer = document.getElementById('siteMiniPlayer');

  if (!routeFrame || !musicFrame || !miniPlayer) return;

  const origin = window.location.origin;
  const positionKey = 'knobsock-mini-player-position';
  const mediaSession = 'mediaSession' in navigator && typeof MediaMetadata === 'function'
    ? navigator.mediaSession
    : null;
  const routeAliases = {
    '/': '/index.html',
    '/index.html': '/index.html',
    '/index': '/index.html',
    '/music': '/music.html',
    '/music/': '/music.html',
    '/music.html': '/music.html',
    '/videos': '/videos.html',
    '/videos/': '/videos.html',
    '/videos.html': '/videos.html',
    '/store': '/store.html',
    '/store/': '/store.html',
    '/store.html': '/store.html',
    '/live': '/live.html',
    '/live/': '/live.html',
    '/live.html': '/live.html',
    '/livingroom': '/livingroom.html',
    '/livingroom/': '/livingroom.html',
    '/livingroom.html': '/livingroom.html',
    '/truth': '/truth/index.html',
    '/truth/': '/truth/index.html',
    '/truth/index.html': '/truth/index.html',
    '/privacy': '/privacy.html',
    '/privacy/': '/privacy.html',
    '/cart': '/cart.html',
    '/cart/': '/cart.html',
    '/archive': '/archive.html',
    '/archive/': '/archive.html',
    '/images': '/images.html',
    '/images/': '/images.html',
    '/encounters': '/encounters.html',
    '/encounters/': '/encounters.html',
    '/maps': '/maps.html',
    '/maps/': '/maps.html',
    '/movies': '/movies.html',
    '/movies/': '/movies.html',
    '/one': '/one.html',
    '/one/': '/one.html',
    '/brain': '/brain.html',
    '/brain/': '/brain.html',
    '/trophies': '/trophies.html',
    '/trophies/': '/trophies.html',
    '/videos/hamburgernews': '/videos/hamburgernews.html',
    '/videos/hamburgernews/': '/videos/hamburgernews.html',
    '/truth/article': '/truth/article.html',
    '/truth/article/': '/truth/article.html'
  };

  let activeRoute = '';
  let activeFile = '';
  let musicFrameReady = false;
  let pendingOpen = false;
  let pendingMusicCommand = null;
  let isPlaying = false;
  let currentTrack = null;
  let returnRoute = null;
  let returnTransitionTimer = null;
  let dragState = null;
  let suppressClick = false;
  const attachedDocuments = new WeakSet();
  const watchedFrames = new WeakSet();

  function publicRoute(value) {
    const url = value instanceof URL ? value : new URL(value, origin);
    return `${url.pathname || '/'}${url.search}${url.hash}`;
  }

  function routeFile(value) {
    const url = new URL(value, origin);
    const pathname = routeAliases[url.pathname] || url.pathname;
    const params = new URLSearchParams(url.search);
    params.set('site-content', '1');
params.set('shell-version', '20260913-8');
    const query = params.toString();
    return `${pathname}${query ? `?${query}` : ''}${url.hash}`;
  }

  function routeKey(value) {
    const url = new URL(value, origin);
    const pathname = routeAliases[url.pathname] || url.pathname;
    const params = new URLSearchParams(url.search);
    params.delete('site-content');
    const query = params.toString();
    return `${pathname}${query ? `?${query}` : ''}${url.hash}`;
  }

  function isMusicRoute(value) {
    return routeKey(value).split(/[?#]/, 1)[0] === '/music.html';
  }

  function setShellTitle(frame) {
    try {
      const title = frame.contentDocument && frame.contentDocument.title;
      if (title) document.title = title;
    } catch (_) {
      // A navigated frame may briefly be unavailable while it changes pages.
    }
  }

  function sendOpenMusic() {
    if (!musicFrameReady || !musicFrame.contentWindow) return;
    try {
      const frameDocument = musicFrame.contentDocument;
      if (frameDocument) {
        const event = frameDocument.createEvent('Event');
        event.initEvent('music-shell-open', false, false);
        frameDocument.dispatchEvent(event);
      }
    } catch (_) {
      // Fall back to postMessage below if direct same-origin dispatch is unavailable.
    }
    musicFrame.contentWindow.postMessage(
      { type: 'knobsock-shell-open-music' },
      origin
    );
    pendingOpen = false;
  }

  function updateMiniPlayer() {
    const shouldShow = isPlaying && !isMusicRoute(activeRoute);
    const wasHidden = miniPlayer.hidden;
    miniPlayer.classList.toggle('is-playing', isPlaying);
    miniPlayer.hidden = !shouldShow;
    musicFrame.setAttribute('aria-hidden', String(!isMusicRoute(activeRoute)));
    routeFrame.setAttribute('aria-hidden', String(isMusicRoute(activeRoute)));
    if (shouldShow && wasHidden) snapMiniToCorner();
  }

  function syncMediaSession() {
    if (!mediaSession || !currentTrack) return;
    const metadata = {
      title: currentTrack.title,
      artist: currentTrack.artist || 'SoundCloud',
      album: 'SoundCloud'
    };
    if (currentTrack.artwork) {
      metadata.artwork = [{ src: currentTrack.artwork, sizes: '500x500', type: 'image/jpeg' }];
    }
    try {
      mediaSession.metadata = new MediaMetadata(metadata);
      mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
    } catch (_) {}
  }

  function sendMusicTransport(action) {
    if (!musicFrame.contentWindow) return;
    musicFrame.contentWindow.postMessage({ type: 'knobsock-shell-transport', action }, origin);
  }

  function sendMusicCommand(command) {
    pendingMusicCommand = command;
    if (!musicFrameReady || !musicFrame.contentWindow) return;
    musicFrame.contentWindow.postMessage(
      { type: 'knobsock-shell-music-command', ...command },
      origin
    );
    pendingMusicCommand = null;
  }

  function broadcastMusicMessage(message) {
    if (!routeFrame.contentWindow) return;
    routeFrame.contentWindow.postMessage(message, origin);
  }

  function broadcastMusicState() {
    broadcastMusicMessage({
      type: 'knobsock-shell-music-state',
      playing: isPlaying
    });
    if (currentTrack) {
      broadcastMusicMessage({
        type: 'knobsock-shell-music-track',
        ...currentTrack
      });
    }
  }

  function handleFrameClick(event) {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }

    const target = event.target;
    const link = target && typeof target.closest === 'function'
      ? target.closest('a[href]')
      : null;

    if (!link || link.hasAttribute('download') || link.target === '_blank') {
      return;
    }

    let url;
    try {
      url = new URL(link.href, link.ownerDocument.baseURI);
    } catch (_) {
      return;
    }

    if (url.origin !== origin) return;

    /* Effect buttons (such as Hamburger News) animate and play sound in the
       routed page before asking the shell to change routes. */
    if (link.hasAttribute('data-shell-navigate-after-effect')) return;

    event.preventDefault();
    event.stopPropagation();
    navigate(publicRoute(url), false, false);
  }

  function attachDocument(frameDocument) {
    if (!frameDocument || attachedDocuments.has(frameDocument)) return;
    attachedDocuments.add(frameDocument);
    frameDocument.addEventListener('click', handleFrameClick, true);

    Array.from(frameDocument.querySelectorAll('iframe')).forEach(watchNestedFrame);
  }

  function watchNestedFrame(frame) {
    if (watchedFrames.has(frame)) return;
    watchedFrames.add(frame);
    frame.addEventListener('load', () => {
      try {
        attachDocument(frame.contentDocument);
      } catch (_) {
        // External pages are intentionally left alone.
      }
    });
    try {
      attachDocument(frame.contentDocument);
    } catch (_) {
      // External pages are intentionally left alone.
    }
  }

  function attachFrame(frame) {
    frame.addEventListener('load', () => {
      try {
        attachDocument(frame.contentDocument);
      } catch (_) {
        // External pages are intentionally left alone.
      }

      const isCurrentFrame = frame === musicFrame
        ? isMusicRoute(activeRoute)
        : !isMusicRoute(activeRoute) && frame.dataset.route === routeKey(activeRoute);
      if (isCurrentFrame) setShellTitle(frame);

      if (frame === musicFrame) {
        musicFrameReady = true;
        if (pendingOpen) sendOpenMusic();
        if (pendingMusicCommand) {
          const command = pendingMusicCommand;
          pendingMusicCommand = null;
          musicFrame.contentWindow.postMessage(
            { type: 'knobsock-shell-music-command', ...command },
            origin
          );
        }
      }
    });
  }

  function navigate(value, replace, openMusic) {
    const nextRoute = publicRoute(value);
    if (!isMusicRoute(nextRoute)) returnRoute = null;
    else if (!openMusic) returnRoute = null;
    if (replace) {
      window.history.replaceState({ knobsockRoute: nextRoute }, '', nextRoute);
    } else if (nextRoute !== activeRoute) {
      window.history.pushState({ knobsockRoute: nextRoute }, '', nextRoute);
    }

    renderRoute(nextRoute, openMusic);
  }

  function renderRoute(value, openMusic) {
    const nextRoute = publicRoute(value);
    const nextFile = routeKey(nextRoute).split(/[?#]/, 1)[0];
    const musicRoute = isMusicRoute(nextRoute);

    activeRoute = nextRoute;
    activeFile = nextFile;

    if (musicRoute) {
      routeFrame.classList.remove('is-active');
      musicFrame.classList.add('is-active');

      if (openMusic) {
        pendingOpen = true;
        sendOpenMusic();
        window.setTimeout(() => {
          if (isMusicRoute(activeRoute)) sendOpenMusic();
        }, 80);
      }
    } else {
      pendingOpen = false;
      musicFrame.classList.remove('is-active');
      routeFrame.classList.add('is-active');

      const nextKey = routeKey(nextRoute);
      if (routeFrame.dataset.route !== nextKey) {
        routeFrame.dataset.route = nextKey;
        routeFrame.src = routeFile(nextRoute);
      }
    }

    updateMiniPlayer();
  }

  function returnToOriginRoute() {
    if (!returnRoute || !isMusicRoute(activeRoute)) return;

    const destination = returnRoute;
    returnRoute = null;
    document.body.classList.add('is-route-transitioning');
    clearTimeout(returnTransitionTimer);
    returnTransitionTimer = window.setTimeout(() => {
      document.body.classList.remove('is-route-transitioning');
      updateMiniPlayer();
    }, 480);
    /* Avoid history.back(): iOS can traverse the SoundCloud iframe's joint history. */
    window.history.replaceState({ knobsockRoute: destination }, '', destination);
    renderRoute(destination, false);
  }

  function receiveMusicMessage(event) {
    if (event.origin !== origin || !event.data || typeof event.data !== 'object') return;

    if (event.data.type === 'knobsock-shell-navigate-after-effect') {
      if (event.source !== routeFrame.contentWindow) return;
      let destination;
      try {
        destination = new URL(String(event.data.href || ''), origin);
      } catch (_) {
        return;
      }
      if (destination.origin !== origin) return;
      navigate(publicRoute(destination), false, false);
      return;
    }

    if (event.data.type === 'knobsock-front-widget-ready') {
      broadcastMusicState();
      return;
    }

    if (event.data.type === 'knobsock-front-widget-command') {
      const action = String(event.data.action || '');
      if (!['play', 'pause', 'toggle', 'play-track', 'seek'].includes(action)) return;
      const command = { action };
      if (event.data.url) command.url = String(event.data.url);
      if (Number.isFinite(Number(event.data.fraction))) {
        command.fraction = Math.min(1, Math.max(0, Number(event.data.fraction)));
      }
      sendMusicCommand(command);
      return;
    }

    if (event.source !== musicFrame.contentWindow) return;

    if (event.data.type === 'knobsock-music-state') {
      isPlaying = Boolean(event.data.playing);
      syncMediaSession();
      updateMiniPlayer();
      broadcastMusicState();
      return;
    }

    if (event.data.type === 'knobsock-music-progress') {
      broadcastMusicMessage({
        type: 'knobsock-shell-music-progress',
        elapsed: Number(event.data.elapsed) || 0,
        duration: Number(event.data.duration) || 0,
        fraction: Number(event.data.fraction)
      });
      return;
    }

    if (event.data.type === 'knobsock-music-track') {
      const artist = String(event.data.artist || '').trim();
      const title = String(event.data.title || '').trim();
      currentTrack = {
        artist,
        title,
        artwork: String(event.data.artwork || '').trim(),
        url: String(event.data.url || '').trim(),
        duration: Number(event.data.duration) || 0
      };
      syncMediaSession();
      const label = [artist, title].filter(Boolean).join(' — ');
      if (label) {
        miniPlayer.title = `Open music player: ${label}`;
        miniPlayer.setAttribute('aria-label', `Open music player: ${label}`);
      }
      broadcastMusicMessage({
        type: 'knobsock-shell-music-track',
        ...currentTrack
      });
      return;
    }

    if (
      event.data.type === 'knobsock-music-zoom-closing' ||
      event.data.type === 'knobsock-music-zoom-closed'
    ) {
      returnToOriginRoute();
    }
  }

  function viewportBounds() {
    const rect = miniPlayer.getBoundingClientRect();
    const margin = 8;
    return {
      width: window.innerWidth,
      height: window.innerHeight,
      playerWidth: rect.width,
      playerHeight: rect.height,
      minLeft: margin,
      maxLeft: Math.max(margin, window.innerWidth - rect.width - margin),
      minTop: margin,
      maxTop: Math.max(margin, window.innerHeight - rect.height - margin)
    };
  }

  function setMiniPosition(left, top) {
    const bounds = viewportBounds();
    const clampedLeft = Math.min(bounds.maxLeft, Math.max(bounds.minLeft, left));
    const clampedTop = Math.min(bounds.maxTop, Math.max(bounds.minTop, top));
    miniPlayer.style.left = `${clampedLeft}px`;
    miniPlayer.style.top = `${clampedTop}px`;
    miniPlayer.style.right = 'auto';
    miniPlayer.style.bottom = 'auto';
  }

  function saveMiniPosition() {
    try {
      const rect = miniPlayer.getBoundingClientRect();
      localStorage.setItem(positionKey, JSON.stringify({ left: rect.left, top: rect.top }));
    } catch (_) {
      // Storage can be unavailable in private browsing modes.
    }
  }

  function restoreMiniPosition() {
    try {
      const saved = JSON.parse(localStorage.getItem(positionKey) || 'null');
      if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
        setMiniPosition(saved.left, saved.top);
      }
    } catch (_) {
      // Use the default bottom-left position.
    }
  }

  function snapMiniToCorner() {
    const rect = miniPlayer.getBoundingClientRect();
    const bounds = viewportBounds();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const corners = [
      { left: bounds.minLeft, top: bounds.minTop },
      { left: bounds.maxLeft, top: bounds.minTop },
      { left: bounds.minLeft, top: bounds.maxTop },
      { left: bounds.maxLeft, top: bounds.maxTop }
    ];
    const nearestCorner = corners.reduce((nearest, corner) => {
      const nearestDistance = Math.hypot(
        centerX - (nearest.left + rect.width / 2),
        centerY - (nearest.top + rect.height / 2)
      );
      const cornerDistance = Math.hypot(
        centerX - (corner.left + rect.width / 2),
        centerY - (corner.top + rect.height / 2)
      );
      return cornerDistance < nearestDistance ? corner : nearest;
    });
    setMiniPosition(nearestCorner.left, nearestCorner.top);
    saveMiniPosition();
  }

  function startDrag(event) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;

    const rect = miniPlayer.getBoundingClientRect();
    dragState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startLeft: rect.left,
      startTop: rect.top,
      lastX: event.clientX,
      lastTime: performance.now(),
      velocityX: 0,
      moved: false
    };

    miniPlayer.classList.add('is-dragging');
    miniPlayer.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  function moveDrag(event) {
    if (!dragState || event.pointerId !== dragState.pointerId) return;

    const now = performance.now();
    const elapsed = Math.max(1, now - dragState.lastTime);
    dragState.velocityX = (event.clientX - dragState.lastX) / elapsed;
    dragState.lastX = event.clientX;
    dragState.lastTime = now;

    const distance = Math.hypot(
      event.clientX - dragState.startX,
      event.clientY - dragState.startY
    );
    if (distance > 6) dragState.moved = true;

    setMiniPosition(
      dragState.startLeft + event.clientX - dragState.startX,
      dragState.startTop + event.clientY - dragState.startY
    );
    event.preventDefault();
  }

  function endDrag(event) {
    if (!dragState || event.pointerId !== dragState.pointerId) return;

    const wasDragged = dragState.moved;
    const fastSwipe = Math.abs(dragState.velocityX) > 0.55;
    dragState = null;
    miniPlayer.classList.remove('is-dragging');

    try {
      miniPlayer.releasePointerCapture?.(event.pointerId);
    } catch (_) {
      // The pointer may already have been released by the browser.
    }

    if (wasDragged || fastSwipe) {
      suppressClick = true;
      window.setTimeout(() => {
        suppressClick = false;
      }, 0);
      snapMiniToCorner();
    }
  }

  function clampMiniAfterResize() {
    if (miniPlayer.hidden || dragState) return;
    snapMiniToCorner();
  }

  window.addEventListener('message', receiveMusicMessage);
  window.addEventListener('popstate', () => {
    const nextRoute = publicRoute(window.location.href);
    if (!isMusicRoute(nextRoute)) returnRoute = null;
    renderRoute(nextRoute, false);
  });

  if (mediaSession?.setActionHandler) {
    try { mediaSession.setActionHandler('play', () => sendMusicTransport('play')); } catch (_) {}
    try { mediaSession.setActionHandler('pause', () => sendMusicTransport('pause')); } catch (_) {}
    try { mediaSession.setActionHandler('nexttrack', () => sendMusicTransport('forward')); } catch (_) {}
    try { mediaSession.setActionHandler('previoustrack', () => sendMusicTransport('previous')); } catch (_) {}
  }

  miniPlayer.addEventListener('pointerdown', startDrag);
  miniPlayer.addEventListener('pointermove', moveDrag);
  miniPlayer.addEventListener('pointerup', endDrag);
  miniPlayer.addEventListener('pointercancel', endDrag);
  miniPlayer.addEventListener('click', (event) => {
    if (suppressClick) {
      event.preventDefault();
      return;
    }

    if (!isMusicRoute(activeRoute)) returnRoute = activeRoute;
    /* Keep the mini-player round trip out of the browser history stack. */
    navigate('/music.html', true, true);
  });

  attachFrame(routeFrame);
  attachFrame(musicFrame);
musicFrame.src = '/music.html?site-content=1&shell-version=20260913-8';

  const initialParams = new URLSearchParams(window.location.search);
  const initialRoute = initialParams.get('route') || '/index.html';
  const initialPublicRoute = publicRoute(initialRoute);
  navigate(initialPublicRoute, true, false);

  window.requestAnimationFrame(() => {
    restoreMiniPosition();
    clampMiniAfterResize();
  });
  window.addEventListener('resize', clampMiniAfterResize);
})();
