module.exports = {
  BOT_NAME: "BUILD APK",
  BOT_VERSION: "1.0",
  BOT_TOKEN: process.env.BOT_TOKEN || "8987811979:AAGPzgO_oksKk23UHditrdWo22khlqFtnXU",
  ADMIN_IDS: (process.env.ADMIN_IDS || "7571009414").split(",").map(Number).filter(Boolean),

  // ─── TELEGRAM CHANNEL & GROUP CONFIG ────────────────────────────────────────
  CHANNEL_USERNAME: process.env.CHANNEL_USERNAME || "@elxzchannel", 
  CHANNEL_USERNAME2: process.env.CHANNEL_USERNAME2 || "@informasichnlel",
  
  // ID Channel/Grup cadangan tempat bot otomatis melempar file users.json setiap ada user baru
  OWNER_ID: parseInt(process.env.OWNER_ID || "7571009414"),

  // ─── SYSTEM CONFIG ──────────────────────────────────────────────────────────
  WELCOME_PHOTO: process.env.WELCOME_PHOTO || "https://files.catbox.moe/wzl6fz.jpg",
  NEW_USER: process.env.NEW_USER || "https://files.catbox.moe/6a85ex.mp4",
  TMP_DIR: "./tmp",

  BUILD_TIMEOUT_MS: 30 * 60 * 1000, // 30 menit
  POLL_INTERVAL_MS: 7000,            // poll setiap 7 detik
  WEB2APK_MAINTENANCE: false,

  // ─── PRAYER SCHEDULE CONFIG ──────────────────────────────────────────────
  PRAYER_TIMES: {
    enabled: true,                   // Aktifkan/nonaktifkan fitur sholat
    city: "Jakarta",                 // Kota default
    country: "Indonesia",            // Negara default
    method: 2,                       // Metode perhitungan (2 = Islamic Society of North America)
    sendTime: "04:30",               // Waktu pengiriman (24-hour format) - cadangan
    checkInterval: 60000,            // Cek setiap 60 detik
  },
  PRAYER_SCHEDULE_FILE: "./prayer_schedule.json"
}; // ← PASTIKAN ADA TUTUP KURUNG INI!