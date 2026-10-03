#!/usr/bin/env python3
import json
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.request

RPC_URL = "https://ypofuhazhxtzvtywguew.supabase.co/rest/v1/rpc/set_stream_uplink_lag"
API_KEY = "sb_publishable_IJH4--fqVrrTrxG7Ou1JKw_G2WPOiIO"
TOKEN_FILE = os.environ.get("KNOBSOCK_UPLINK_TOKEN_FILE", "/etc/knobsock-uplink-token")
MIN_CHANGE_MS = 500
HEARTBEAT_S = 15


def read_token():
    token = os.environ.get("KNOBSOCK_UPLINK_TOKEN", "").strip()
    if token:
        return token
    try:
        with open(TOKEN_FILE) as handle:
            return handle.read().strip()
    except OSError:
        return ""


TOKEN = read_token()
SOURCE = sys.argv[1] if len(sys.argv) > 1 else "rtmp://127.0.0.1:1935/" + os.environ.get("MTX_PATH", "live")
state = {"lag": None, "running": True}


def log(message):
    print(time.strftime("%H:%M:%S"), message, flush=True)


def report(lag_ms):
    body = json.dumps({"writer_token": TOKEN, "new_lag_ms": lag_ms}).encode()
    request = urllib.request.Request(RPC_URL, data=body, method="POST", headers={"apikey": API_KEY, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            accepted = response.read().decode().strip() == "true"
        if not accepted:
            log("Supabase rejected the report; check the key in " + TOKEN_FILE)
        return accepted
    except Exception as error:
        log("report failed: %s" % error)
        return False


def reporter():
    last_sent = None
    last_time = 0.0
    while state["running"]:
        lag = state["lag"]
        now = time.time()
        if lag is not None and (last_sent is None or abs(lag - last_sent) >= MIN_CHANGE_MS or now - last_time >= HEARTBEAT_S):
            if report(lag):
                last_sent = lag
                last_time = now
        time.sleep(0.5)


def stop(*_):
    state["running"] = False


def find_tool(name):
    found = shutil.which(name)
    if found:
        return found
    for folder in ("/usr/local/bin", "/usr/bin", "/snap/bin", "/root", "/root/bin", "/opt/ffmpeg", "/opt/ffmpeg/bin"):
        candidate = os.path.join(folder, name)
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


def timestamp_reader():
    ffprobe = find_tool("ffprobe")
    if ffprobe:
        command = [ffprobe, "-v", "error", "-fflags", "nobuffer", "-select_streams", "v:0", "-show_entries", "packet=pts_time", "-of", "csv=p=0", SOURCE]
        return command, "ffprobe"
    ffmpeg = find_tool("ffmpeg")
    if ffmpeg:
        command = [ffmpeg, "-hide_banner", "-loglevel", "error", "-fflags", "nobuffer", "-i", SOURCE, "-map", "0:v:0", "-c", "copy", "-flush_packets", "1", "-f", "framecrc", "-"]
        return command, "ffmpeg"
    return None, None


def packet_seconds(line, mode, timebase):
    if mode == "ffprobe":
        field = line.strip().split(",")[0]
        return float(field) if field and field != "N/A" else None
    if line.startswith("#"):
        return None
    parts = [part.strip() for part in line.split(",")]
    if len(parts) < 3 or timebase is None:
        return None
    return int(parts[2]) * timebase


def main():
    if not TOKEN:
        log("No uplink key found. Put it in " + TOKEN_FILE)
        return 1
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    command, mode = timestamp_reader()
    if not command:
        log("Neither ffprobe nor ffmpeg was found on this server.")
        report(None)
        return 1
    if shutil.which("stdbuf"):
        command = ["stdbuf", "-oL"] + command
    log("watching " + SOURCE + " with " + mode)
    sync_lock = None
    sync_script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sync-lock.py")
    if os.path.isfile(sync_script):
        sync_lock = subprocess.Popen([sys.executable, sync_script])
    probe = subprocess.Popen(command, stdout=subprocess.PIPE, text=True, bufsize=1)
    threading.Thread(target=reporter, daemon=True).start()
    baseline = None
    last_pts = None
    timebase = None
    try:
        for line in probe.stdout:
            if not state["running"]:
                break
            if line.startswith("#tb 0:"):
                num, _, den = line.split(":", 1)[1].strip().partition("/")
                try:
                    timebase = float(num) / float(den)
                except (ValueError, ZeroDivisionError):
                    timebase = None
                continue
            try:
                pts = packet_seconds(line, mode, timebase)
            except ValueError:
                continue
            if pts is None:
                continue
            arrived = time.monotonic()
            if last_pts is not None and pts < last_pts - 5:
                baseline = None
            last_pts = pts
            offset = arrived - pts
            if baseline is None or offset < baseline:
                baseline = offset
            state["lag"] = int(round((offset - baseline) * 1000))
    finally:
        state["running"] = False
        if probe.poll() is None:
            probe.terminate()
        if sync_lock is not None and sync_lock.poll() is None:
            sync_lock.terminate()
        report(None)
        log("stream ended")
    return 0


if __name__ == "__main__":
    sys.exit(main())
