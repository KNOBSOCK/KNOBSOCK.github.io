(function () {
  var HOST = 'live.knobsock.net';
  var EVENTS_URL = 'https://live.knobsock.net/api/events';
  var listeners = [];
  var source = null;
  var latest = null;
  var retryTimer = null;
  var failures = 0;

  function handles(url) {
    try {
      return new URL(url, location.href).host === HOST;
    } catch (e) {
      return false;
    }
  }

  function emit() {
    listeners.slice().forEach(function (fn) {
      try { fn(latest); } catch (e) {}
    });
  }

  function connect() {
    if (source || retryTimer || !window.EventSource || !listeners.length) return;
    source = new EventSource(EVENTS_URL);
    source.onmessage = function (event) {
      var data;
      try { data = JSON.parse(event.data); } catch (e) { return; }
      failures = 0;
      latest = { live: !!data.live, since: data.since || null, viewers: Math.max(0, Number(data.viewers) || 0) };
      emit();
    };
    source.onerror = function () {
      if (!source || source.readyState !== 2) return;
      source = null;
      failures += 1;
      retryTimer = setTimeout(function () {
        retryTimer = null;
        connect();
      }, Math.min(30000, 2000 * failures));
    };
  }

  function disconnectIfUnused() {
    if (listeners.length) return;
    if (source) source.close();
    source = null;
    clearTimeout(retryTimer);
    retryTimer = null;
  }

  function subscribe(fn) {
    listeners.push(fn);
    connect();
    if (latest) {
      try { fn(latest); } catch (e) {}
    }
    return function () {
      listeners = listeners.filter(function (other) { return other !== fn; });
      disconnectIfUnused();
    };
  }

  window.KnobsockStreamStatus = {
    handles: handles,
    subscribe: subscribe,
    supported: !!window.EventSource
  };
})();
