import os
import io
import re
import time
import uuid
import base64
import socket
import subprocess
import socketio
from PIL import Image

# ================= CONFIG =================
SERVER_URL = "https://check-real-time.onrender.com/"
API_KEY = "ztrongz_secret_key_2026"
DEVICE_NAME = socket.gethostname() or "Farm got"  # Tên hiển thị trên ô, sửa tự do
DEVICE_ID_FILE = "1"                           # Giữ ID cố định dù đổi DEVICE_NAME
SEND_INTERVAL = 0.8
JPEG_QUALITY = 55
MAX_WIDTH = 540
# ==========================================

def get_or_create_device_id() -> str:
    if os.path.exists(DEVICE_ID_FILE):
        with open(DEVICE_ID_FILE, "r", encoding="utf-8") as f:
            saved = f.read().strip()
            if saved:
                return saved
    host = re.sub(r"[^a-zA-Z0-9_-]", "-", socket.gethostname() or "termux").strip("-") or "termux"
    new_id = f"{host}-{uuid.uuid4().hex[:6]}"
    with open(DEVICE_ID_FILE, "w", encoding="utf-8") as f:
        f.write(new_id)
    return new_id

DEVICE_ID = get_or_create_device_id()
sio = socketio.Client(reconnection=True, reconnection_delay=2)

def get_cpu_usage(interval=0.25):
    def read_stat():
        with open("/proc/stat", "r") as f:
            line = f.readline()
        parts = [float(x) for x in line.split()[1:8]]
        idle = parts[3] + parts[4]
        total = sum(parts)
        return idle, total

    try:
        idle1, total1 = read_stat()
        time.sleep(interval)
        idle2, total2 = read_stat()
        total_delta = total2 - total1
        idle_delta = idle2 - idle1
        if total_delta <= 0:
            return 0.0
        return round((1.0 - (idle_delta / total_delta)) * 100.0, 1)
    except Exception:
        return 0.0

def get_ram_usage():
    try:
        mem = {}
        with open("/proc/meminfo", "r") as f:
            for line in f:
                parts = line.split()
                if len(parts) >= 2:
                    mem[parts[0].rstrip(":")] = int(parts[1])
        total_kb = mem.get("MemTotal", 1)
        avail_kb = mem.get("MemAvailable", mem.get("MemFree", 0))
        used_kb = max(0, total_kb - avail_kb)
        pct = round((used_kb / total_kb) * 100.0, 1)
        return pct, round(used_kb / 1024), round(total_kb / 1024)
    except Exception:
        return 0.0, 0, 0

def get_uptime():
    try:
        with open("/proc/uptime", "r") as f:
            secs = int(float(f.readline().split()[0]))
        h, rem = divmod(secs, 3600)
        m, _ = divmod(rem, 60)
        return f"{h}h {m}m"
    except Exception:
        return "0m"

def capture_screen_base64():
    raw_png = None
    for cmd in [["screencap", "-p"], ["su", "-c", "screencap -p"]]:
        try:
            proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=3)
            if proc.returncode == 0 and len(proc.stdout) > 100:
                raw_png = proc.stdout
                break
        except Exception:
            continue

    if not raw_png:
        return None

    try:
        img = Image.open(io.BytesIO(raw_png)).convert("RGB")
        w, h = img.size
        if w > MAX_WIDTH:
            new_h = int(h * (MAX_WIDTH / w))
            img = img.resize((MAX_WIDTH, new_h), Image.Resampling.LANCZOS)

        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=JPEG_QUALITY, optimize=True)
        return base64.b64encode(buf.getvalue()).decode("ascii")
    except Exception:
        return None

@sio.event
def connect():
    print(f"[+] Connected to {SERVER_URL} as [{DEVICE_ID}]")

@sio.event
def disconnect():
    print("[-] Disconnected from server, retrying...")

def main():
    while True:
        try:
            sio.connect(
                SERVER_URL,
                auth={"role": "agent", "token": API_KEY},
                transports=["websocket"]
            )
            break
        except Exception as e:
            print(f"[!] Connect failed: {e} — retry in 3s")
            time.sleep(3)

    last_tick = time.time()
    while True:
        try:
            now = time.time()
            dt = max(0.001, now - last_tick)
            last_tick = now
            fps = round(1.0 / dt, 1)

            cpu = get_cpu_usage(0.25)
            ram, ram_used, ram_total = get_ram_usage()
            screen_b64 = capture_screen_base64()

            payload = {
                "deviceId": DEVICE_ID,
                "deviceName": DEVICE_NAME,
                "cpu": cpu,
                "ram": ram,
                "ramUsedMB": ram_used,
                "ramTotalMB": ram_total,
                "uptime": get_uptime(),
                "fps": fps,
                "screenBase64": screen_b64
            }

            if sio.connected:
                sio.emit("telemetry", payload)
                print(f"[STREAM:{DEVICE_ID}] CPU: {cpu}% | RAM: {ram}% | Screen: {'OK' if screen_b64 else 'NO_PERM'} | {fps} FPS")

            sleep_time = max(0.05, SEND_INTERVAL - (time.time() - now))
            time.sleep(sleep_time)
        except KeyboardInterrupt:
            sio.disconnect()
            break
        except Exception as e:
            print(f"[ERR] {e}")
            time.sleep(1)

if __name__ == "__main__":
    main()
