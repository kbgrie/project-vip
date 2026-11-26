const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 10 * 1024 * 1024,
  cors: { origin: "*" }
});

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "ztrongz_secret_key_2026";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const ALERT_COOLDOWN_MS = 60 * 1000;
const OFFLINE_TIMEOUT_MS = 8000;

// Map<deviceId, telemetryObject>
const devices = new Map();
// Map<socketId, deviceId>
const socketToDevice = new Map();
// Map<deviceId, number>
const lastAlertByDevice = new Map();

app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_, res) => res.status(200).json({ status: "ok", devices: devices.size }));

function getDeviceListSnapshot() {
  const now = Date.now();
  return Array.from(devices.values()).map((d) => ({
    ...d,
    online: d.online && now - (d.updatedAt || 0) <= OFFLINE_TIMEOUT_MS
  }));
}

async function sendDiscordAlert({ deviceId, reason, cpu, ram, deviceName, screenBase64 }) {
  if (!DISCORD_WEBHOOK_URL) return;
  const now = Date.now();
  const prev = lastAlertByDevice.get(deviceId) || 0;
  if (now - prev < ALERT_COOLDOWN_MS) return;
  lastAlertByDevice.set(deviceId, now);

  try {
    const form = new FormData();
    const payload = {
      content: `@everyone 🚨 **CẢNH BÁO THIẾT BỊ [${deviceName || deviceId}]**`,
      embeds: [
        {
          title: reason,
          color: cpu > 90 || ram > 90 ? 15548997 : 16776960,
          fields: [
            { name: "Device ID", value: `\`${deviceId}\``, inline: true },
            { name: "CPU Usage", value: `**${cpu.toFixed(1)}%**`, inline: true },
            { name: "RAM Usage", value: `**${ram.toFixed(1)}%**`, inline: true },
            {
              name: "Thời gian",
              value: new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }),
              inline: false
            }
          ],
          image: screenBase64 ? { url: "attachment://screen.jpg" } : undefined
        }
      ]
    };

    form.append("payload_json", JSON.stringify(payload));

    if (screenBase64) {
      const cleanB64 = screenBase64.replace(/^data:image\/\w+;base64,/, "");
      const imgBuffer = Buffer.from(cleanB64, "base64");
      const blob = new Blob([imgBuffer], { type: "image/jpeg" });
      form.append("files[0]", blob, "screen.jpg");
    }

    const res = await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      body: form
    });

    if (!res.ok) {
      console.error("[Discord Webhook Error]", res.status, await res.text());
    }
  } catch (err) {
    console.error("[Discord Alert Exception]", err.message);
  }
}

// Quét máy bị rớt mạng / treo agent mà không kịp gửi disconnect
setInterval(() => {
  let changed = false;
  const now = Date.now();
  for (const [id, d] of devices.entries()) {
    const shouldBeOnline = now - (d.updatedAt || 0) <= OFFLINE_TIMEOUT_MS;
    if (d.online !== shouldBeOnline) {
      d.online = shouldBeOnline;
      changed = true;
    }
  }
  if (changed) {
    io.to("viewers").emit("devices_snapshot", getDeviceListSnapshot());
  }
}, 2000);

io.on("connection", (socket) => {
  const role = socket.handshake.auth?.role || "viewer";

  if (role === "agent") {
    const token = socket.handshake.auth?.token;
    if (token !== API_KEY) {
      socket.disconnect(true);
      return;
    }

    console.log(`[Agent Connected] ${socket.id}`);

    socket.on("telemetry", (data = {}) => {
      const deviceId = String(data.deviceId || data.deviceName || socket.id).trim();
      const deviceName = String(data.deviceName || deviceId).trim();
      const cpu = Number(data.cpu || 0);
      const ram = Number(data.ram || 0);

      socketToDevice.set(socket.id, deviceId);

      const prev = devices.get(deviceId) || {};
      const record = {
        ...prev,
        ...data,
        deviceId,
        deviceName,
        cpu,
        ram,
        online: true,
        updatedAt: Date.now()
      };

      devices.set(deviceId, record);

      // Gửi cập nhật riêng cho 1 máy + đồng bộ danh sách máy
      io.to("viewers").emit("device_update", record);
      io.to("viewers").emit("devices_snapshot", getDeviceListSnapshot());

      const reasons = [];
      if (cpu < 50) reasons.push(`CPU giảm xuống dưới 50% (${cpu.toFixed(1)}%)`);
      if (cpu > 90) reasons.push(`CPU vượt ngưỡng 90% (${cpu.toFixed(1)}%)`);
      if (ram < 50) reasons.push(`RAM giảm xuống dưới 50% (${ram.toFixed(1)}%)`);
      if (ram > 90) reasons.push(`RAM vượt ngưỡng 90% (${ram.toFixed(1)}%)`);

      if (reasons.length > 0) {
        sendDiscordAlert({
          deviceId,
          reason: reasons.join(" | "),
          cpu,
          ram,
          deviceName,
          screenBase64: data.screenBase64
        });
      }
    });

    socket.on("disconnect", () => {
      const deviceId = socketToDevice.get(socket.id);
      socketToDevice.delete(socket.id);
      if (deviceId && devices.has(deviceId)) {
        const d = devices.get(deviceId);
        d.online = false;
        d.updatedAt = Date.now();
        io.to("viewers").emit("device_update", d);
        io.to("viewers").emit("devices_snapshot", getDeviceListSnapshot());
      }
      console.log(`[Agent Disconnected] ${socket.id} (${deviceId || "unknown"})`);
    });
  } else {
    socket.join("viewers");
    socket.emit("devices_snapshot", getDeviceListSnapshot());
  }
});

server.listen(PORT, () => {
  console.log(`Multi-device telemetry server listening on port ${PORT}`);
});
