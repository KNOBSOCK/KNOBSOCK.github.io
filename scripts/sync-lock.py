#!/usr/bin/env python3
import json
import math
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request

SUPABASE = "https://ypofuhazhxtzvtywguew.supabase.co"
API_KEY = "sb_publishable_IJH4--fqVrrTrxG7Ou1JKw_G2WPOiIO"
LIVE_DOC = "https://firestore.googleapis.com/v1/projects/chat-for-website-efee2/databases/(default)/documents/chat_config/liveVideo"
REFERER = "https://knobsock.net/"
TOKEN_FILE = os.environ.get("KNOBSOCK_UPLINK_TOKEN_FILE", "/etc/knobsock-uplink-token")
FPS = 10
WIDTH, HEIGHT = 160, 90
BAND_TOP, BAND_BOTTOM = 25, 65
MAX_SHIFT = 24
WINDOW_S = 90
WINDOW_CHOICES = (20, 30, 45, 60, 90)
SHORT_WINDOW_S = 30
SHORT_WINDOW_CORRELATION = 0.88
LAG_FACTOR = 0.6
LAG_SHIFT_S = 2.0
NEARBY_S = 10.0
FULL_SEARCH_EVERY_S = 30
KEEP_S = 240
LAG_MIN, LAG_MAX, LAG_STEP = -60.0, 15.0, 0.1
MIN_CORRELATION = 0.8
SMOOTH_WITHIN_MS = 1500
EVALUATE_EVERY_S = 5


def log(message):
    print(time.strftime("%H:%M:%S"), "sync-lock:", message, flush=True)


def http_text(url, headers=None, data=None, timeout=10):
    request = urllib.request.Request(url, data=data, headers=headers or {}, method="POST" if data else "GET")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def bunny(url):
    return http_text(url, {"Referer": REFERER})


def read_token():
    token = os.environ.get("KNOBSOCK_UPLINK_TOKEN", "").strip()
    if token:
        return token
    try:
        with open(TOKEN_FILE) as handle:
            return handle.read().strip()
    except OSError:
        return ""


def live_config():
    doc = json.loads(http_text(LIVE_DOC))
    fields = doc.get("fields", {})
    url = fields.get("directUrl", {}).get("stringValue")
    seed = fields.get("liveSeed", {})
    seed = int(seed.get("integerValue") or seed.get("doubleValue") or 0)
    return url, seed


def history_between(start_ms, end_ms):
    url = "%s/functions/v1/stream-location?from=%d&to=%d" % (SUPABASE, start_ms, end_ms)
    data = json.loads(http_text(url, {"apikey": API_KEY}, timeout=15))
    headings = [(h["t"] / 1000.0, h["h"]) for h in data.get("headings", [])]
    lags = sorted((l["t"] / 1000.0, (l["ms"] or 0) / 1000.0) for l in data.get("lags", []))
    return headings, lags


def lag_at(lags, t):
    found = None
    for when, seconds in lags:
        if when <= t:
            found = (when, seconds)
        else:
            break
    if found is None or t - found[0] > 60:
        return 0.0
    return found[1]


def lag_corrected(window, lags, offset_guess_s):
    if not lags:
        return window
    return [(t - LAG_FACTOR * lag_at(lags, t - offset_guess_s + LAG_SHIFT_S), p) for t, p in window]


def publish(token, chunk_at_ms, offset_ms, quality):
    body = json.dumps({"writer_token": token, "chunk_at_ms": int(chunk_at_ms), "new_offset_ms": int(offset_ms), "quality": round(quality, 3)}).encode()
    try:
        result = http_text(SUPABASE + "/rest/v1/rpc/set_stream_sync_offset", {"apikey": API_KEY, "Content-Type": "application/json"}, body)
        if result.decode().strip() != "true":
            log("Supabase rejected the offset; check the key in " + TOKEN_FILE)
    except Exception as error:
        log("publish failed: %s" % error)


def decode_segment(init_bytes, segment_bytes):
    result = subprocess.run(
        ["ffmpeg", "-v", "error", "-f", "mp4", "-i", "pipe:0", "-vf", "fps=%d,scale=%d:%d,format=gray" % (FPS, WIDTH, HEIGHT), "-f", "rawvideo", "-"],
        input=init_bytes + segment_bytes, capture_output=True)
    raw = result.stdout
    size = WIDTH * HEIGHT
    return [raw[i:i + size] for i in range(0, len(raw) - size + 1, size)]


def column_profile(frame):
    profile = [0.0] * WIDTH
    for y in range(BAND_TOP, BAND_BOTTOM):
        row = frame[y * WIDTH:(y + 1) * WIDTH]
        for x in range(WIDTH):
            profile[x] += row[x]
    mean = sum(profile) / WIDTH
    return [(value - mean) for value in profile]


def frame_shift(previous, current):
    best, best_error = 0, float("inf")
    for shift in range(-MAX_SHIFT, MAX_SHIFT + 1):
        error = 0.0
        for x in range(MAX_SHIFT + 6, WIDTH - MAX_SHIFT - 6):
            difference = current[x] - previous[x + shift]
            error += difference * difference
        if error < best_error:
            best_error, best = error, shift
    return best


def smooth(values, width=5):
    half = width // 2
    out = []
    for i in range(len(values)):
        lo, hi = max(0, i - half), min(len(values), i + half + 1)
        out.append(sum(values[lo:hi]) / (hi - lo))
    return out


def heading_rate_series(samples, start, end):
    points = [(t, h) for t, h in samples if h is not None]
    if len(points) < 6:
        return None
    points.sort()
    unwrapped, total, previous = [], 0.0, None
    for t, h in points:
        if previous is not None:
            step = (h - previous + 540) % 360 - 180
            total += step
        else:
            total = h
        unwrapped.append((t, total))
        previous = h
    grid_start = start - 1
    count = int((end - grid_start) * FPS) + 2
    times = [grid_start + i / FPS for i in range(count)]
    values, j = [], 0
    for t in times:
        while j < len(unwrapped) - 2 and unwrapped[j + 1][0] < t:
            j += 1
        t0, v0 = unwrapped[j]
        t1, v1 = unwrapped[min(j + 1, len(unwrapped) - 1)]
        if t <= t0:
            values.append(v0)
        elif t >= t1:
            values.append(v1)
        else:
            values.append(v0 + (v1 - v0) * (t - t0) / (t1 - t0))
    rates = [0.0] + [(values[i] - values[i - 1]) * FPS for i in range(1, len(values))]
    return grid_start, smooth(rates)


def std(values):
    if not values:
        return 0.0
    mean = sum(values) / len(values)
    return math.sqrt(sum((v - mean) ** 2 for v in values) / len(values))


def best_offset(pan_samples, rate_series, lag_min=LAG_MIN, lag_max=LAG_MAX, min_correlation=MIN_CORRELATION):
    if not pan_samples or rate_series is None:
        return None
    grid_start, rates = rate_series
    times = [t for t, _ in pan_samples]
    pans = smooth([p for _, p in pan_samples])
    if std(pans) < 0.15:
        return None
    pan_mean = sum(pans) / len(pans)
    centered = [p - pan_mean for p in pans]
    pan_norm = math.sqrt(sum(c * c for c in centered))
    best = None
    lag_min, lag_max = max(LAG_MIN, lag_min), min(LAG_MAX, lag_max)
    steps = int(round((lag_max - lag_min) / LAG_STEP))
    for s in range(steps + 1):
        lag = lag_min + s * LAG_STEP
        picked = []
        for t in times:
            index = int(round((t - lag - grid_start) * FPS))
            if index < 0 or index >= len(rates):
                break
            picked.append(rates[index])
        if len(picked) != len(times):
            continue
        rate_mean = sum(picked) / len(picked)
        rate_centered = [r - rate_mean for r in picked]
        rate_norm = math.sqrt(sum(r * r for r in rate_centered))
        if rate_norm < 1e-6 or std(picked) < 3.0:
            continue
        r = sum(a * b for a, b in zip(centered, rate_centered)) / (pan_norm * rate_norm)
        if best is None or r > best[0]:
            best = (r, lag)
    if best is None or best[0] < min_correlation:
        return None
    return best[1] * 1000.0, best[0]


class Locker:
    def __init__(self):
        self.current = None
        self.pending = None
        self.last_published = None

    def update(self, offset_ms):
        if self.current is None:
            self.current = offset_ms
            self.pending = None
            return True
        if abs(offset_ms - self.current) <= SMOOTH_WITHIN_MS:
            self.current = 0.7 * self.current + 0.3 * offset_ms
            self.pending = None
            return True
        if self.pending is not None and abs(offset_ms - self.pending) <= SMOOTH_WITHIN_MS:
            self.current = (self.pending + offset_ms) / 2
            self.pending = None
            return True
        self.pending = offset_ms
        return False

    def should_publish(self):
        if self.current is None:
            return False
        if self.last_published is None or abs(self.current - self.last_published) >= 300:
            self.last_published = self.current
            return True
        return False


class PanTracker:
    def __init__(self):
        self.samples = []
        self.previous = None

    def add_segment(self, chunk_wall, frames):
        for index, frame in enumerate(frames):
            profile = column_profile(frame)
            if self.previous is not None:
                shift = frame_shift(self.previous, profile)
                if abs(shift) < MAX_SHIFT:
                    self.samples.append((chunk_wall + index / FPS, float(shift)))
            self.previous = profile
        if self.samples:
            newest = self.samples[-1][0]
            self.samples = [s for s in self.samples if s[0] >= newest - KEEP_S]

    def window(self, seconds=WINDOW_S):
        if not self.samples:
            return []
        newest = self.samples[-1][0]
        return [s for s in self.samples if s[0] >= newest - seconds]


def strongest_offset(tracker, heading_samples, lags=None, offset_guess_ms=None, full_search=True):
    best = None
    if full_search or offset_guess_ms is None:
        lag_min, lag_max = LAG_MIN, LAG_MAX
    else:
        lag_min, lag_max = offset_guess_ms / 1000.0 - NEARBY_S, offset_guess_ms / 1000.0 + NEARBY_S
    for seconds in WINDOW_CHOICES:
        window = tracker.window(seconds)
        if len(window) < seconds * FPS * 0.6:
            continue
        threshold = SHORT_WINDOW_CORRELATION if seconds <= SHORT_WINDOW_S else MIN_CORRELATION
        start, end = window[0][0], window[-1][0]
        rates = heading_rate_series(heading_samples, start + LAG_MIN - 10, end - LAG_MIN + 10)
        guess = offset_guess_ms
        if guess is None:
            raw = best_offset(window, rates, lag_min, lag_max, threshold)
            guess = raw[0] if raw else None
        if lags and guess is not None:
            found = best_offset(lag_corrected(window, lags, guess / 1000.0), rates, lag_min, lag_max, threshold)
        else:
            found = best_offset(window, rates, lag_min, lag_max, threshold)
        if found and (best is None or found[1] > best[1]):
            best = found
    return best


def parse_variant(text, base_url):
    init_uri, segments, duration = None, [], 0.0
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("#EXT-X-MAP:"):
            match = re.search(r'URI="([^"]+)"', line)
            if match:
                init_uri = urllib.parse.urljoin(base_url, match.group(1))
        elif line.startswith("#EXTINF:"):
            duration = float(line[8:].split(",")[0] or 0)
        elif line and not line.startswith("#"):
            match = re.search(r"-(\d{10})\.(?:m4s|ts)", line)
            if match:
                segments.append((int(match.group(1)), urllib.parse.urljoin(base_url, line), duration))
    return init_uri, segments


def lowest_variant(master_url):
    text = bunny(master_url).decode()
    if "#EXTINF" in text:
        return master_url
    for line in text.splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            return urllib.parse.urljoin(master_url, line)
    return None


def run_live():
    token = read_token()
    if not token:
        log("No key found. Put it in " + TOKEN_FILE)
        return 1
    locker, tracker = Locker(), PanTracker()
    stream_url, seed, variant_url, init_bytes = None, 0, None, None
    seen, last_config, last_evaluate, last_full = set(), 0.0, time.time(), 0.0
    parent = os.getppid()
    while True:
        if os.getppid() != parent:
            log("parent stopped, exiting")
            return 0
        now = time.time()
        try:
            if now - last_config > 30 or not stream_url:
                url, live_seed = live_config()
                last_config = now
                if url != stream_url:
                    stream_url, seed, variant_url, init_bytes = url, live_seed, None, None
                    seen, tracker = set(), PanTracker()
                    log("following " + str(url))
                elif live_seed:
                    seed = live_seed
            if not stream_url:
                time.sleep(10)
                continue
            if variant_url is None:
                variant_url = lowest_variant(stream_url)
            init_uri, segments = parse_variant(bunny(variant_url).decode(), variant_url)
            if not segments:
                time.sleep(2)
                continue
            if not seed:
                seed = segments[0][0]
            if init_bytes is None and init_uri:
                init_bytes = bunny(init_uri)
            fresh = [s for s in segments if s[0] not in seen][-4:]
            for number, uri, _ in fresh:
                seen.add(number)
                frames = decode_segment(init_bytes or b"", bunny(uri))
                tracker.add_segment(seed + 2 * (number - seed), frames)
            if time.time() - last_evaluate >= EVALUATE_EVERY_S:
                last_evaluate = time.time()
                window = tracker.window()
                if len(window) > min(WINDOW_CHOICES) * FPS * 0.6:
                    start, end = window[0][0], window[-1][0]
                    samples, lags = history_between(int((start + LAG_MIN - 30) * 1000), int((end - LAG_MIN + 30) * 1000))
                    full = locker.current is None or time.time() - last_full >= FULL_SEARCH_EVERY_S
                    if full:
                        last_full = time.time()
                    found = strongest_offset(tracker, samples, lags, locker.current, full)
                    if found:
                        offset_ms, quality = found
                        accepted = locker.update(offset_ms)
                        log("match %.1fs (strength %.2f)%s" % (offset_ms / 1000, quality, "" if accepted else " waiting for confirmation"))
                        if locker.should_publish():
                            publish(token, end * 1000, locker.current, quality)
                            log("published offset %.1fs" % (locker.current / 1000))
            time.sleep(1.5)
        except urllib.error.HTTPError as error:
            if error.code == 404:
                time.sleep(5)
                last_config = 0
            else:
                log("http %s" % error.code)
                time.sleep(5)
        except Exception as error:
            log("error: %s" % error)
            time.sleep(5)


def run_replay(guid, token=None):
    base = "https://vz-168e0ecf-c9d.b-cdn.net/live/%s/playlist.m3u8" % guid
    variant_url = lowest_variant(base)
    init_uri, segments = parse_variant(bunny(variant_url).decode(), variant_url)
    seed = segments[0][0]
    init_bytes = bunny(init_uri) if init_uri else b""
    tracker, locker = PanTracker(), Locker()
    all_headings, all_lags = history_between((seed - 120) * 1000, (seed + 2 * len(segments) + 120) * 1000)
    last_evaluate = None
    for number, uri, _ in segments:
        tracker.add_segment(seed + 2 * (number - seed), decode_segment(init_bytes, bunny(uri)))
        newest = tracker.samples[-1][0] if tracker.samples else None
        if newest is None:
            continue
        if last_evaluate is None:
            last_evaluate = newest
        if newest - last_evaluate >= EVALUATE_EVERY_S:
            last_evaluate = newest
            window = tracker.window()
            if len(window) > min(WINDOW_CHOICES) * FPS * 0.6:
                end = window[-1][0]
                found = strongest_offset(tracker, all_headings, all_lags, locker.current)
                stamp = int(end - seed)
                if found:
                    accepted = locker.update(found[0])
                    if token and accepted and locker.should_publish():
                        publish(token, end * 1000, locker.current, found[1])
                    print("video %4ds  match %6.1fs  strength %.2f  %s  -> locked %s" % (stamp, found[0] / 1000, found[1], "ok" if accepted else "unconfirmed", "%.1fs" % (locker.current / 1000) if locker.current is not None else "-"), flush=True)
                else:
                    print("video %4ds  no confident match (not enough turning)  -> locked %s" % (stamp, "%.1fs" % (locker.current / 1000) if locker.current is not None else "-"), flush=True)
    return 0


if __name__ == "__main__":
    if len(sys.argv) > 2 and sys.argv[1] == "--replay":
        sys.exit(run_replay(sys.argv[2]))
    if len(sys.argv) > 2 and sys.argv[1] == "--backfill":
        key = read_token()
        if not key:
            sys.exit("No key found. Set KNOBSOCK_UPLINK_TOKEN or put it in " + TOKEN_FILE)
        sys.exit(run_replay(sys.argv[2], key))
    sys.exit(run_live() or 0)
