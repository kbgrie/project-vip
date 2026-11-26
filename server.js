const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 10 * 1024 * 1024, // 10MB cho frame ảnh base64
  cors: { origin: "*" }
});

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "ztrongz_secret_key_2026";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const ALERT_COOLDOWN_MS = 60 * 1000; // Chống spam Discord: 60s/lần cảnh báo

let lastAlertTime = 0;
let latestTelemetry = {
  online: false,
  deviceName: "Unknown Device",
  cpu: 0,
  ram: 0,
  ramUsedMB: 0,
  ramTotalMB: 0,
  uptime: "0m",
  fps: 0,
  screenBase64: null,
  updatedAt: null
};

app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_, res) => res.status(200).json({ status: "ok" }));

async function sendDiscordAlert({ reason, cpu, ram, deviceName, screenBase64 }) {
  if (!DISCORD_WEBHOOK_URL) return;
  const now = Date.now();
  if (now - lastAlertTime < ALERT_COOLDOWN_MS) return;
  lastAlertTime = now;

  try {
    const form = new FormData();
    const payload = {
      content: `@everyone 🚨 **CẢNH BÁO THIẾT BỊ [${deviceName}]**`,
      embeds: [
        {
          title: reason,
          color: cpu > 90 || ram > 90 ? 15548997 : 16776960,
          fields: [
            { name: "CPU Usage", value: `**${cpu.toFixed(1)}%**`, inline: true },
            { name: "RAM Usage", value: `**${ram.toFixed(1)}%**`, inline: true },
            { name: "Thời gian", value: new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }), inline: false }
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

io.on("connection", (socket) => {
  const role = socket.handshake.auth?.role || "viewer";

  if (role === "agent") {
    const token = socket.handshake.auth?.token;
    if (token !== API_KEY) {
      socket.disconnect(true);
      return;
    }

    console.log(`[Agent Connected] ${socket.id}`);

    socket.on("telemetry", async (data) => {
      latestTelemetry = {
        ...latestTelemetry,
        ...data,
        online: true,
        updatedAt: Date.now()
      };

      // Broadcast real-time tới toàn bộ trình duyệt đang xem
      io.to("viewers").emit("telemetry_update", latestTelemetry);

      // Kiểm tra điều kiện cảnh báo: dưới 50% hoặc trên 90%
      const reasons = [];
      if (data.cpu < 50) reasons.push(`CPU giảm xuống dưới 50% (${data.cpu.toFixed(1)}%)`);
      if (data.cpu > 90) reasons.push(`CPU vượt ngưỡng 90% (${data.cpu.toFixed(1)}%)`);
      if (data.ram < 50) reasons.push(`RAM giảm xuống dưới 50% (${data.ram.toFixed(1)}%)`);
      if (data.ram > 90) reasons.push(`RAM vượt ngưỡng 90% (${data.ram.toFixed(1)}%)`);

      if (reasons.length > 0) {
        sendDiscordAlert({
          reason: reasons.join(" | "),
          cpu: data.cpu,
          ram: data.ram,
          deviceName: data.deviceName || "Termux Device",
          screenBase64: data.screenBase64
        });
      }
    });

    socket.on("disconnect", () => {
      console.log(`[Agent Disconnected] ${socket.id}`);
      latestTelemetry.online = false;
      io.to("viewers").emit("telemetry_update", latestTelemetry);
    });
  } else {
    socket.join("viewers");
    socket.emit("telemetry_update", latestTelemetry);
  }
});

server.listen(PORT, () => {
  console.log(`Telemetry server listening on port ${PORT}`);
});
