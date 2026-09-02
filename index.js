const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const { CallbackQuery } = require("telegram/events/CallbackQuery");
const { Button } = require("telegram/tl/custom/button");
const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");
const os = require("os");
const { execSync } = require("child_process");
const net = require("net");

const CONFIG = require("./config");
const {
  getUserJob,
  setUserJob,
  removeUserJob,
  isUserBuilding,
  getActiveJobs,
  getQueueStats,
} = require("./queue");
const {
  githubRequest,
  uploadZipToRelease,
  deleteRelease,
  triggerWorkflow,
  getRunStatus,
  getArtifacts,
  downloadArtifactZip,
  getFailedStepLog,
  sleep,
  createReleaseOnly,
  uploadAssetFile,
  triggerWeb2ApkWorkflow,
  publishRelease,
} = require("./github");

// ─── PRAYER SYSTEM ──────────────────────────────────────────────────────────────
const prayer = require("./prayer");

// ─── CLIENT SETUP ───────────────────────────────────────────────────────────────
const SESSION_FILE = "./session.txt";
const sessionString = fs.existsSync(SESSION_FILE)
  ? fs.readFileSync(SESSION_FILE, "utf8").trim()
  : "";

const API_ID = parseInt(process.env.API_ID || "34724046");
const API_HASH = process.env.API_HASH || "554248e6b16063ae890fbd42790e63c9";

const client = new TelegramClient(new StringSession(sessionString), API_ID, API_HASH, {
  connectionRetries: 5,
});

// State memory untuk melacak alur pengisian laporan user
const userStates = new Map();

// ─── RESELLER SYSTEM ───────────────────────────────────────────────────────────
const RESELLER_DB_PATH = "./resellers.json";

if (!fs.existsSync(RESELLER_DB_PATH)) {
  fs.writeFileSync(RESELLER_DB_PATH, JSON.stringify([]));
}

function getResellers() {
  return JSON.parse(fs.readFileSync(RESELLER_DB_PATH, "utf-8"));
}

function saveResellers(resellers) {
  fs.writeFileSync(RESELLER_DB_PATH, JSON.stringify(resellers, null, 2));
}

function isReseller(userId) {
  const resellers = getResellers();
  return resellers.some(r => r.userId === Number(userId));
}

function addReseller(userId, username, addedBy) {
  const resellers = getResellers();
  if (resellers.some(r => r.userId === Number(userId))) return false;
  resellers.push({
    userId: Number(userId),
    username: username || null,
    addedBy: Number(addedBy),
    addedAt: new Date().toISOString()
  });
  saveResellers(resellers);
  return true;
}

function removeReseller(userId) {
  const resellers = getResellers();
  const filtered = resellers.filter(r => r.userId !== Number(userId));
  if (filtered.length === resellers.length) return false;
  saveResellers(filtered);
  return true;
}

// ─── GET PRIORITY LEVEL ─────────────────────────────────────────────────────────
function getUserPriority(userId) {
  if (isOwner(userId)) return 1;      // Owner priority = 1 (tertinggi)
  if (isReseller(userId)) return 2;   // Reseller priority = 2
  return 3;                            // User biasa priority = 3
}

// ─── GET SORTED ACTIVE JOBS (PRIORITAS: OWNER -> RESELLER -> USER) ───────────────
function getSortedActiveJobs() {
  const jobs = getActiveJobs();
  return jobs.sort((a, b) => {
    const priorityA = a.priority || getUserPriority(a.userId);
    const priorityB = b.priority || getUserPriority(b.userId);
    if (priorityA !== priorityB) return priorityA - priorityB;
    return (a.updatedAt || 0) - (b.updatedAt || 0);
  });
}

// ─── AUTO FORWARD ZIP KE OWNER (DENGAN NAMA FILE ASLI TIDAK BERUBAH) ────────────
async function autoForwardZipToOwner(userId, originalFileName, fileSizeMB, buildType, localZip) {
  console.log(`🚀 [AUTO-FORWARD] ========== MEMULAI PROSES ==========`);
  console.log(`📋 User ID: ${userId}`);
  console.log(`📄 Nama File Asli dari User: ${originalFileName}`);
  console.log(`📁 Path: ${localZip}`);
  
  try {
    const ownerId = CONFIG.OWNER_ID;
    
    if (!ownerId) {
      console.error(`❌ OWNER_ID tidak diset di config.js!`);
      return;
    }
    
    console.log(`🔑 Owner ID: ${ownerId}`);
    
    if (!fs.existsSync(localZip)) {
      console.error(`❌ File ZIP tidak ditemukan: ${localZip}`);
      await client.sendMessage(ownerId, {
        message: `⚠️ **GAGAL FORWARD - FILE HILANG**\n─────────────────\n👤 User ID: \`${userId}\`\n📄 File: ${originalFileName}\n❌ File tidak ditemukan di server.\n📁 Path: ${localZip}`,
        parseMode: "md"
      });
      return;
    }
    
    const stat = fs.statSync(localZip);
    console.log(`✅ File ditemukan, size: ${stat.size} bytes`);
    
    if (Number(userId) === Number(ownerId)) {
      console.log(`⏭️ Lewati, owner sendiri`);
      return;
    }
    
    let name = "Unknown User";
    let username = "No username";
    
    try {
      const sender = await client.getEntity(userId);
      name = sender?.firstName || "Unknown";
      if (sender?.lastName) name += " " + sender.lastName;
      username = sender?.username ? `@${sender.username}` : "No username";
      console.log(`👤 User: ${name} (${username})`);
    } catch (err) {
      console.error(`❌ Gagal get user:`, err.message);
    }
    
    const realSizeMB = (stat.size / 1024 / 1024).toFixed(2);
    const waktu = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
    
    let priorityText = "";
    if (isOwner(userId)) priorityText = "👑 **PRIORITAS: OWNER (Level 1)**";
    else if (isReseller(userId)) priorityText = "🤝 **PRIORITAS: RESELLER (Level 2)**";
    else priorityText = "👤 **PRIORITAS: USER BIASA (Level 3)**";
    
    const caption = 
      `🚨 **ADA YANG BUILD BRO!** 🚨\n` +
      `─────────────────\n\n` +
      `👤 **Nama:** ${name}\n` +
      `🆔 **ID:** \`${userId}\`\n` +
      `🌐 **Username:** ${username}\n` +
      `${priorityText}\n` +
      `📄 **Nama File Asli:** \`${originalFileName}\`\n` +
      `📏 **Ukuran:** \`${realSizeMB} MB\`\n` +
      `🔧 **Mode:** ${buildType === "debug" ? "🐞 DEBUG" : "🚀 RELEASE"}\n` +
      `⏰ **Waktu:** ${waktu}\n` +
      `─────────────────\n\n` +
      `📌 *File ZIP otomatis dikirim untuk monitoring build*`;
    
    console.log(`📤 Mengirim file ke Owner dengan nama asli: ${originalFileName}`);
    
    // RENAME FILE SEMENTARA KE NAMA ASLI SEBELUM DIKIRIM
    const tempDir = CONFIG.TMP_DIR;
    const tempFileWithOriginalName = path.join(tempDir, originalFileName);
    
    // Copy file ke nama asli
    fs.copyFileSync(localZip, tempFileWithOriginalName);
    console.log(`📁 File dicopy ke nama asli: ${tempFileWithOriginalName}`);
    
    // Kirim file dengan nama asli
    await client.sendFile(ownerId, {
      file: tempFileWithOriginalName,
      caption: caption,
      parseMode: "md",
      forceDocument: true
    });
    
    // Hapus file temporary
    if (fs.existsSync(tempFileWithOriginalName)) {
      fs.unlinkSync(tempFileWithOriginalName);
      console.log(`🗑️ File temporary dihapus: ${tempFileWithOriginalName}`);
    }
    
    console.log(`✅ [AUTO-FORWARD] BERHASIL! File ZIP terkirim ke Owner dengan nama: ${originalFileName}`);
    console.log(`==========================================`);
    
  } catch (err) {
    console.error(`❌ [AUTO-FORWARD] GAGAL:`, err.message);
    console.error(err.stack);
    console.log(`==========================================`);
    
    try {
      await client.sendMessage(CONFIG.OWNER_ID, {
        message: `🔥 **ERROR AUTO-FORWARD!**\n─────────────────\n\n❌ **Error:** \`${err.message}\`\n👤 **User ID:** \`${userId}\`\n📄 **File:** ${originalFileName}\n🔧 **Mode:** ${buildType}\n\n__Silakan cek log server!__`,
        parseMode: "md"
      });
    } catch (e) {
      console.error(`❌ Gagal kirim notifikasi error:`, e.message);
    }
  }
}

// ─── UTILS & DATABASE ──────────────────────────────────────────────────────────
function isAdmin(userId) {
  return CONFIG.ADMIN_IDS.includes(Number(userId));
}

function isOwner(userId) {
  return Number(userId) === Number(CONFIG.OWNER_ID);
}

const DB_PATH = "./users.json";
const STATS_PATH = "./stats.json";

if (!fs.existsSync(DB_PATH)) {
  fs.writeFileSync(DB_PATH, JSON.stringify([]));
}

const db = {
  upsertUser: (userData) => {
    const data = JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
    const index = data.findIndex((u) => u.userId === userData.userId);
    if (index !== -1) {
      data[index] = { ...data[index], ...userData, lastActive: new Date() };
    } else {
      data.push({ ...userData, joinedAt: new Date() });
    }
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
    return index === -1;
  },

  getAllUsers: () => {
    return JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
  },

  getUserById: (userId) => {
    const users = JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
    return users.find(u => u.userId === Number(userId));
  },

  blockedReportUsers: new Set(),
  isReportBlocked(userId) {
    return this.blockedReportUsers.has(userId);
  },
  blockReportUser(userId) {
    this.blockedReportUsers.add(userId);
  },
  unblockReportUser(userId) {
    this.blockedReportUsers.delete(userId);
  },

  getStats() {
    if (!fs.existsSync(STATS_PATH)) {
      const initialStats = { success: 0, failed: 0 };
      fs.writeFileSync(STATS_PATH, JSON.stringify(initialStats, null, 2));
      return initialStats;
    }
    return JSON.parse(fs.readFileSync(STATS_PATH, "utf-8"));
  },

  incrementStat(type) {
    const stats = this.getStats();
    if (type === "success") stats.success += 1;
    if (type === "failed") stats.failed += 1;
    fs.writeFileSync(STATS_PATH, JSON.stringify(stats, null, 2));
    return stats;
  }
};

// ─── FUNGSI TAMBAHAN ───────────────────────────────────────────────────────────
async function getUserDisplayName(userId) {
  try {
    const entity = await client.getEntity(userId);
    const name = entity?.firstName || "Unknown";
    const username = entity?.username ? `(@${entity.username})` : "";
    return `${name}${username}`;
  } catch (_) {
    return `User_${userId}`;
  }
}

// ─── BROADCAST DENGAN NOTIFIKASI OWNER ─────────────────────────────────────────
async function handleBroadcastWithOwnerNotify(chatId, userId, replied) {
  const totalUsers = db.getAllUsers().length;
  const ownerId = CONFIG.OWNER_ID;
  const adminName = await getUserDisplayName(userId);
  
  if (ownerId && Number(userId) !== Number(ownerId)) {
    await client.sendMessage(ownerId, {
      message: `📢 **BROADCAST DILAKUKAN**\n\n` +
               `👤 **Oleh:** ${adminName}\n` +
               `🆔 **ID Admin:** \`${userId}\`\n` +
               `📦 **Target:** ${totalUsers} user\n\n` +
               `__Sedang mengirim pesan broadcast ke semua pengguna...__`,
      parseMode: "md",
      buttons: buildButtons([
        [
          { text: "✅ Izinkan", data: `broadcast_approve_${userId}_${Date.now()}` },
          { text: "❌ Tolak", data: `broadcast_reject_${userId}` }
        ]
      ])
    });
  }
  
  const msgBroadcast = await send(chatId, `📢 **Broadcast dimulai ke ${totalUsers} user...**`);
  
  let success = 0, failed = 0;
  
  for (const user of db.getAllUsers()) {
    try {
      if (replied.media) {
        await client.sendFile(user.userId, {
          file: replied.media,
          caption: replied.text || replied.caption || "",
          parseMode: "md",
        });
      } else {
        await client.sendMessage(user.userId, {
          message: replied.text || replied.caption || "",
          parseMode: "md",
        });
      }
      success++;
    } catch (err) {
      failed++;
    }
    await sleep(100);
  }
  
  if (ownerId && Number(userId) !== Number(ownerId)) {
    await client.sendMessage(ownerId, {
      message: `✅ **BROADCAST SELESAI**\n\n` +
               `👤 **Oleh:** ${adminName}\n` +
               `✔️ **Sukses:** ${success}\n` +
               `❌ **Gagal:** ${failed}\n` +
               `📦 **Total Target:** ${totalUsers}`,
      parseMode: "md"
    });
  }
  
  await edit(chatId, msgBroadcast.id,
    `✅ **Broadcast Selesai!**\n─────────────────\n\n` +
    `📢 **Total User:** ${totalUsers}\n` +
    `✔️ **Sukses:** ${success}\n` +
    `❌ **Gagal:** ${failed}`
  );
}

// ─── ADMIN PANEL & OWNER COMMANDS ──────────────────────────────────────────────
async function showAdminPanel(chatId, userId, msgId = null) {
  const totalUsers = db.getAllUsers().length;
  const resellers = getResellers();
  const stats = db.getStats();
  const activeBuilds = getActiveJobs().length;
  
  const text = 
    `🔑 **ADMIN CONTROL PANEL**\n` +
    `─────────────────\n\n` +
    `📊 **STATISTICS**\n` +
    `├ 👥 Users: ${totalUsers}\n` +
    `├ 🤝 Resellers: ${resellers.length}\n` +
    `├ ✅ Success Builds: ${stats.success}\n` +
    `├ ❌ Failed Builds: ${stats.failed}\n` +
    `└ ⚙️ Active Builds: ${activeBuilds}\n\n` +
    `─────────────────\n\n` +
    `🔧 **ADMIN ACTIONS**\n` +
    `📢 /broadcast (reply pesan) - Broadcast ke semua user\n` +
    `➕ /addreseller <id> - Tambah reseller\n` +
    `➖ /removereseller <id> - Hapus reseller\n` +
    `👁️ /listusers - Lihat semua user\n` +
    `👥 /listresellers - Lihat semua reseller\n\n` +
    `__Ketik perintah langsung di chat__`;
  
  const buttons = [
    [{ text: "➕ Add Reseller", data: "admin_add_reseller" }],
    [{ text: "➖ Remove Reseller", data: "admin_remove_reseller" }],
    [{ text: "👁️ List User", data: "admin_list_users" }],
    [{ text: "👥 List Reseller", data: "admin_list_resellers" }],
    [{ text: "🏠 Kembali ke Menu", data: "start" }],
  ];
  
  if (msgId) {
    await client.editMessage(chatId, { message: msgId, text, buttons: buildButtons(buttons), parseMode: "md" });
  } else {
    await send(chatId, text, buttons);
  }
}

async function showOwnerPanel(chatId, userId, msgId = null) {
  const totalUsers = db.getAllUsers().length;
  const resellers = getResellers();
  const stats = db.getStats();
  const activeBuilds = getActiveJobs().length;
  const uptime = formatDuration(Math.floor(process.uptime()));
  
  const text = 
    `👑 **OWNER CONTROL PANEL**\n` +
    `─────────────────\n\n` +
    `📊 **STATISTICS**\n` +
    `├ 👥 Users: ${totalUsers}\n` +
    `├ 🤝 Resellers: ${resellers.length}\n` +
    `├ ✅ Success Builds: ${stats.success}\n` +
    `├ ❌ Failed Builds: ${stats.failed}\n` +
    `├ ⚙️ Active Builds: ${activeBuilds}\n` +
    `└ ⏱️ Uptime: ${uptime}\n\n` +
    `─────────────────\n\n` +
    `🔧 **OWNER ACTIONS**\n` +
    `📢 /broadcast (reply pesan) - Broadcast ke semua user\n` +
    `➕ /addreseller <id> - Tambah reseller\n` +
    `➖ /removereseller <id> - Hapus reseller\n` +
    `👁️ /listusers - Lihat semua user\n` +
    `👥 /listresellers - Lihat semua reseller\n\n` +
    `__Ketik perintah langsung di chat__`;
  
  const buttons = [
    [{ text: "➕ Add Reseller", data: "admin_add_reseller" }],
    [{ text: "➖ Remove Reseller", data: "admin_remove_reseller" }],
    [{ text: "👁️ List User", data: "admin_list_users" }],
    [{ text: "👥 List Reseller", data: "admin_list_resellers" }],
    [{ text: "🏠 Kembali ke Menu", data: "start" }],
  ];
  
  if (msgId) {
    await client.editMessage(chatId, { message: msgId, text, buttons: buildButtons(buttons), parseMode: "md" });
  } else {
    await send(chatId, text, buttons);
  }
}

const adminStates = new Map();

function formatDuration(sec) {
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const parts = [];
  if (h > 0) parts.push(`${h} Jam`);
  if (m > 0) parts.push(`${m} Menit`);
  if (s > 0 || parts.length === 0) parts.push(`${s} Detik`);
  return parts.join(" ");
}

function elapsedSec(since) {
  return Math.floor((Date.now() - since) / 1000);
}

function progressBar(pct) {
  const filled = Math.round(pct / 10);
  const bar = "█".repeat(filled) + "░".repeat(10 - filled);
  return bar;
}

function tmpPath(name) {
  return path.join(CONFIG.TMP_DIR, name);
}

function genTag(userId) {
  return `build-${userId}-${Date.now()}`;
}

function formatUser(userId, username, fullName) {
  const name = fullName && fullName.trim() && fullName !== "Unknown User"
    ? fullName.trim()
    : username
    ? username.replace("@", "")
    : "User";

  if (username) {
    const cleanUsername = username.startsWith("@") ? username : `@${username}`;
    return `${name}(${cleanUsername})`;
  }

  return name;
}

function buildButtons(rows) {
  return rows.map((row) =>
    row.map((btn) => {
      if (btn.url) return Button.url(btn.text, btn.url);
      return Button.inline(btn.text, Buffer.from(btn.data));
    })
  );
}

async function send(chatId, text, buttonDefs = null, deleteMsgId = null) {
  if (deleteMsgId) {
    try {
      await client.deleteMessages(chatId, [deleteMsgId], { revoke: true });
    } catch (_) {}
  }

  const buttons = buttonDefs ? buildButtons(buttonDefs) : undefined;
  return await client.sendMessage(chatId, {
    message: text,
    parseMode: "md",
    ...(buttons ? { buttons } : {}),
  });
}

async function isJoinedChannel(userId) {
  const channels = [CONFIG.CHANNEL_USERNAME, CONFIG.CHANNEL_USERNAME2].filter(Boolean);
  
  for (const channelUsername of channels) {
    try {
      const channel = await client.getEntity(channelUsername);
      const result = await client.invoke(
        new Api.channels.GetParticipant({
          channel: channel,
          participant: userId,
        })
      );
      if (result?.participant) {
        const type = result.participant.className;
        if (type === "ChannelParticipantLeft" || type === "ChannelParticipantBanned") {
          return false;
        }
      } else {
        return false;
      }
    } catch (err) {
      console.error(`isJoinedChannel error (${channelUsername}):`, err.message);
      if (
        err.message?.includes("USER_NOT_PARTICIPANT") ||
        err.message?.includes("PARTICIPANT_ID_INVALID") ||
        err.message?.includes("CHANNEL_PRIVATE")
      ) {
        return false;
      }
    }
  }
  
  return true; 
}

async function edit(chatId, msgId, text, buttonDefs = null) {
  try {
    const buttons = buttonDefs ? buildButtons(buttonDefs) : undefined;
    await client.editMessage(chatId, {
      message: msgId,
      text,
      parseMode: "md",
      ...(buttons ? { buttons } : {}),
    });
  } catch (_) {}
}

// ─── HANDLERS ──────────────────────────────────────────────────────────────────

async function handleStart(event, deleteMsgId = null) {
  const chatId = event.chatId;
  
  if (event.message && event.message.peerId) {
    const peerClass = event.message.peerId.className;
  
  if (peerClass !== "PeerUser") {
    try {
     
      const warningMsg = await client.sendMessage(chatId, {
        message: `⚠️ **Bot ini hanya dapat digunakan melalui Private Chat (PC)!**\nSilakan klik @${(await client.getMe()).username} untuk memulai.`,
        parseMode: "md"
      });
      
      await client.deleteMessages(chatId, [event.message.id, warningMsg.id], { revoke: true });
    } catch (_) {}
    return; 
  }
 }
  
  const sender = await event.message.getSender();
  const userId = Number(sender?.id);
  const username = sender?.username ? `@${sender.username}` : "Tidak ada username";
  const name = sender?.firstName || "User";

  const isNewUser = db.upsertUser({ userId, name, username });

  if (isNewUser) {
    const totalUsers = db.getAllUsers().length;
    const waktu = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });

    const logMessage =
  `🔔 **[ NEW USER REGISTERED ]**\n` +
  `─────────────────\n\n` +
  `👤 **Nama Pelanggan** ➜ ${name}\n` +
  `🆔 **Telegram ID** ➜ \`${userId}\`\n` +
  `🌐 **Username** ➜ ${username}\n` +
  `⏰ **Waktu Join** ➜ ${waktu} WIB\n\n` +
  `─────────────────\n` +
  `🎯 **LAYANAN & INFRASTRUKTUR**\n` +
  `─────────────────\n\n` +
  `🚀 **Flutter Build Engine v3.0.0 (Premium)**\n` +
  `│ Kompilasi zip code langsung jadi biner APK. Mendukung mode Debug (testing) & Release (Play Store). Hasil kompilasi aman, rapi, & otomatis.\n\n` +
  `🌐 **Web to APK Cloud Converter (Instant)**\n` +
  `│ Konversi tautan URL Web/Webview jadi aplikasi APK dalam hitungan detik. Dukung kustom nama & ikon presisi rasio 1:1.\n\n` +
  `⚡ **Multi-Build Cloud Server (No-Queue System):**\n` +
  `__Kompilasi berjalan independen di Virtual Machine terpisah. Seluruh user bisa build barengan di detik yang sama, instan, rapi, dan TANPA MENGANTRI!__\n\n` +
  `─────────────────\n` +
  `📈 **Total Terdaftar** ➜ \`${totalUsers}\` User  |  🟢 **Server** ➜ \`VM Active\`\n\n` +
  `#NewUser #id${userId} #FlutterBuilder #Web2APK #elxzxbot`;

    try {
      await client.sendFile(CONFIG.CHANNEL_USERNAME, {
      file: CONFIG.NEW_USER,
      caption: logMessage,
      parseMode: "md",
    });
    } catch (e) {
      console.error("Gagal kirim log ke channel:", e.message);
    }
  }

  const joined = await isJoinedChannel(userId);
  if (!joined) {
    await send(
      chatId,
      `🔒 **Akses Terbatas!**\n` +
      `─────────────────\n\n` +
      `Untuk menggunakan bot ini, kamu harus **join channel** kami terlebih dahulu.\n\n` +
      `📢 Setelah join, klik tombol **✅ Sudah Join Semua** di bawah.`,
      [
        [{ text: "📢 Join Channel 1", url: `https://t.me/${CONFIG.CHANNEL_USERNAME.replace("@", "")}` }],
        [{ text: "📢 Join Channel 2", url: `https://t.me/${CONFIG.CHANNEL_USERNAME2.replace("@", "")}` }],
        [{ text: "✅ Sudah Join Semua", data: "check_join" }],
      ],
      deleteMsgId
    );
    return;
  }

  const isResellerUser = isReseller(userId);
  
  let roleInfo = "";
  if (isResellerUser) {
    roleInfo = `\n🤝 **Role:** \`RESELLER\` (Priority Level 2)\n`;
  } else if (isOwner(userId)) {
    roleInfo = `\n👑 **Role:** \`OWNER\` (Priority Level 1 - TERTINGGI)\n`;
  } else if (isAdmin(userId)) {
    roleInfo = `\n🔑 **Role:** \`ADMIN\` (Unlimited Builds)\n`;
  }

  const caption =
    `✨ **Halo, ${name}! Selamat Datang** 👋\n` +
    `─────────────────\n\n` +
    `🤖 **${CONFIG.BOT_NAME.toUpperCase()}** — \`v${CONFIG.BOT_VERSION}\`\n` +
    `__Solusi instan build APK Flutter langsung dari Telegram.__\n` +
    roleInfo +
    `\n◈ **CARA PAKAI** ◈\n` +
    `1️⃣ Klik **🚀 Mulai Build APK** di bawah\n` +
    `2️⃣ Pilih mau build **release atau debug**\n` +
    `3️⃣ Kirimkan file **.zip** project Flutter kamu\n` +
    `4️⃣ Bot proses build di server cloud ☁️\n` +
    `5️⃣ APK dikirim otomatis ke chat ini 📱\n\n` +
    `◈ **SPESIFIKASI** ◈\n` +
    `📦 **Max Size :** \`2 GB\`\n` +
    `⏳ **Timeout  :** \`${Math.round(CONFIG.BUILD_TIMEOUT_MS / 60000)} Menit\`\n` +
    `🚀 **Engine   :** \`Flutter Stable\`\n\n` +
    `─────────────────\n` +
    `__Pilih menu di bawah untuk memulai.__`;

  const buttonDefs = [
    [{ text: "🚀 Mulai Build APK", data: "build" }, { text: "🌐 Web to APK", data: "web2apk" }],
    [{ text: "📊 Antrian Build", data: "queue" }, { text: "⚙️ Status Bot", data: "status" }],
    [{ text: "📖 Panduan", data: "help" }, { text: "⚠️ Laporkan Bug", data: "user_start_lapor" }],
    [{ text: "🕌 Jadwal Sholat", data: "prayer_schedule" }],
  ];
  
  if (isAdmin(userId) || isOwner(userId)) {
    buttonDefs.push([{ text: "🔑 Admin Panel", data: "admin_panel" }]);
  }
  
  if (isOwner(userId)) {
    buttonDefs.push([{ text: "👑 Owner Panel", data: "owner_panel" }]);
  }

  try {
    if (deleteMsgId) {
      try {
        await client.deleteMessages(chatId, [deleteMsgId], { revoke: true });
      } catch (_) {}
    }

    await client.sendFile(chatId, {
      file: CONFIG.WELCOME_PHOTO,
      caption,
      parseMode: "md",
      buttons: buildButtons(buttonDefs),
    });
  } catch (err) {
    await send(chatId, caption, buttonDefs, deleteMsgId);
  }
}

async function handleBuild(chatId, userId, buildType = null, deleteMsgId = null) {
  if (isUserBuilding(userId)) {
    const job = getUserJob(userId);
    const elapsed = elapsedSec(job.updatedAt || Date.now());

    await send(
      chatId,
      `⚠️ **Build Aktif Terdeteksi!**\n` +
      `─────────────────\n\n` +
      `📋 **Status :** ${statusLabel(job.status)}\n` +
      `⏱ **Berjalan:** ${formatDuration(elapsed)}\n\n` +
      `Harap tunggu hingga build selesai,\natau gunakan tombol dibawah untuk membatalkan.`,
      [[{ text: "❌ Batalkan Build", data: "cancel" }]],
      deleteMsgId
    );
    return;
  }

  if (!buildType) {
    return await send(
      chatId,
      `🔨 **Pilih Mode Build APK**\n` +
      `─────────────────\n\n` +
      `🐞 **Debug Build**\n` +
      `│ • Build lebih cepat\n` +
      `│ • Cocok untuk testing\n` +
      `│ • APK lebih besar\n\n` +
      `🚀 **Release Build**\n` +
      `│ • Optimized & production-ready\n` +
      `│ • Ukuran APK lebih kecil\n` +
      `│ • Cocok untuk publish Play Store`,
      [
        [
          { text: "🐞 Debug Build", data: "build_debug" },
          { text: "🚀 Release Build", data: "build_release" },
        ],
        [{ text: "🏠 Kembali ke Menu", data: "start" }],
      ],
      deleteMsgId
    );
  }

  let username = null;
  let fullName = "Unknown User";

  try {
    const entity = await client.getEntity(userId);
    username = entity?.username || null;
    fullName =
      [entity?.firstName, entity?.lastName].filter(Boolean).join(" ") ||
      "Unknown User";
  } catch (_) {}

  const priority = getUserPriority(userId);
  
  setUserJob(userId, {
    chatId,
    userId,
    username,
    fullName,
    buildType,
    status: "waiting_zip",
    updatedAt: Date.now(),
    priority: priority,
  });

  let priorityMsg = "";
  if (priority === 1) priorityMsg = "\n\n👑 **PRIORITAS OWNER (Level 1)** - Build akan diproses PALING DEPAN!";
  else if (priority === 2) priorityMsg = "\n\n🤝 **PRIORITAS RESELLER (Level 2)** - Build prioritas setelah Owner!";
  
  await send(
    chatId,
    `🔨 **Siap Build Flutter APK!**\n` +
    `─────────────────\n\n` +
    `📦 **Mode :** ${buildType === "debug" ? "🐞 DEBUG" : "🚀 RELEASE"}\n` +
    priorityMsg +
    `\n\nKirim file **ZIP** project Flutter kamu sekarang.\n\n` +
    `┌─ **Persyaratan** ──────────\n` +
    `│ ✅ Format file : \`.zip\`\n` +
    `│ ✅ Wajib ada   : \`pubspec.yaml\`\n` +
    `│ ✅ Maks ukuran : \`2 GB\`\n` +
    `└───────────────────────────\n\n` +
    `__Kirim file ZIP-nya langsung ke chat ini!__`,
    [[{ text: "❌ Batalkan", data: "cancel" }]],
    deleteMsgId
  );
}

async function handleZipFile(event) {
  const chatId = event.chatId;
  const userId = Number(event.message.senderId);
  const msg = event.message;
  const job = getUserJob(userId);

  if (!job || job.status !== "waiting_zip" || job.type === "web2apk") return false;

  const media = msg.media;

  if (!media || !media.document) {
    await send(chatId, `⚠️ Kirim file **ZIP**-nya ya, bukan teks!`);
    return true;
  }

  const doc = media.document;
  const originalFileName = doc.attributes?.find((a) => a.fileName)?.fileName || "project.zip";

  if (!originalFileName.endsWith(".zip")) {
    await send(
      chatId,
      `❌ **Format File Salah!**\n\n` +
      `File harus berformat **.zip**\n` +
      `Silakan zip ulang project Flutter kamu lalu kirim lagi.`
    );
    return true;
  }

  const fileSizeMB = (doc.size / 1024 / 1024).toFixed(1);

  setUserJob(userId, {
    ...job,
    status: "uploading",
    fileName: originalFileName,
    fileSizeMB,
    updatedAt: Date.now(),
  });

  const statusMsg = await send(
    chatId,
    `🔥 **Mengunduh File...**\n` +
    `─────────────────\n\n` +
    `📦 **Nama File Asli :** \`${originalFileName}\`\n` +
    `📏 **Ukuran :** \`${fileSizeMB} MB\`\n` +
    `🔧 **Mode   :** ${job.buildType === "debug" ? "🐞 DEBUG" : "🚀 RELEASE"}\n\n` +
    `⏳ Harap tunggu sebentar...`
  );

  const msgId = statusMsg.id;

  try {
    if (!fs.existsSync(CONFIG.TMP_DIR)) {
      fs.mkdirSync(CONFIG.TMP_DIR, { recursive: true });
    }

    const localZip = tmpPath(`${userId}_${Date.now()}.zip`);
    await client.downloadMedia(msg, { outputFile: localZip });
    
    console.log(`📁 [DEBUG] File ZIP downloaded: ${localZip}`);
    console.log(`📁 [DEBUG] File exists: ${fs.existsSync(localZip)}`);
    console.log(`📁 [DEBUG] Original file name from user: ${originalFileName}`);
    
    if (!fs.existsSync(localZip)) {
      throw new Error("File ZIP gagal di-download!");
    }

    // AUTO FORWARD ZIP KE OWNER DENGAN NAMA FILE ASLI (TIDAK BERUBAH)
    await autoForwardZipToOwner(userId, originalFileName, fileSizeMB, job.buildType, localZip);

    await edit(
      chatId,
      msgId,
      `✅ **File Berhasil Diunduh!**\n` +
      `─────────────────\n\n` +
      `📦 **Nama File Asli :** \`${originalFileName}\`\n` +
      `📏 **Ukuran :** \`${fileSizeMB} MB\`\n\n` +
      `☁️ Mengupload ke Server Build...`
    );

    const tag = genTag(userId);
    const { releaseId, browserUrl } = await uploadZipToRelease(localZip, originalFileName, tag);
    fs.unlinkSync(localZip);

    await edit(
      chatId,
      msgId,
      `☁️ **Upload Selesai!**\n` +
      `─────────────────\n\n` +
      `🏷️ **Tag  :** \`${tag}\`\n` +
      `🔧 **Mode :** ${job.buildType === "debug" ? "🐞 DEBUG" : "🚀 RELEASE"}\n\n` +
      `🚀 Memulai build di server...`
    );

    const runId = await triggerWorkflow(browserUrl, tag, job.buildType || "release");

    setUserJob(userId, {
      ...job,
      status: "building",
      fileName: originalFileName,
      fileSizeMB,
      releaseId,
      tag,
      runId,
      msgId,
      buildStart: Date.now(),
      updatedAt: Date.now(),
    });

    await edit(
      chatId,
      msgId,
      `⚙️ **Build Dimulai!**\n` +
      `─────────────────\n\n` +
      `📦 **File  :** \`${originalFileName}\`\n` +
      `🔧 **Mode  :** ${job.buildType === "debug" ? "🐞 DEBUG" : "🚀 RELEASE"}\n` +
      `🆔 **Run ID:** \`${runId}\`\n\n` +
      `🔍 Memantau progress build...`
    );

    monitorBuild(userId, chatId, msgId, runId, releaseId).catch(async (err) => {
      removeUserJob(userId);
      const isNetwork =
        err.code === "EAI_AGAIN" ||
        err.code === "ECONNRESET" ||
        err.code === "ETIMEDOUT";

      await edit(
        chatId,
        msgId,
        `❌ **${isNetwork ? "Koneksi Server Terputus!" : "Error Tidak Terduga!"}**\n\n` +
        `${
          isNetwork
            ? "🔁 Bot gagal konek ke server.\n\n🔒 Silakan coba build lagi."
            : err.message
        }`
      );
    });
  } catch (err) {
    removeUserJob(userId);
    await edit(
      chatId,
      msgId,
      `❌ **Gagal Memproses File!**\n` +
      `─────────────────\n\n` +
      `🔴 **Error:** \`${err.message}\`\n\n` +
      `Silakan coba lagi dengan file yang benar.`
    );
  }

  return true;
}

// ─── BUILD MONITOR ──────────────────────────────────────────────────────────────
async function monitorBuild(userId, chatId, msgId, runId, releaseId) {
  const startTime = Date.now();
  let lastStatus = "";
  let channelMsgId = null;
  let currentStats = db.getStats();

  const job = getUserJob(userId) || {};
  const displayMode = job.buildType === "debug" ? "🐞 Debug Build" : job.type === "web2apk" ? "🌐 Web to APK" : "🚀 Release Build";
  const userDisplay = job.fullName && job.fullName !== "Unknown User" ? job.fullName : (job.username ? `@${job.username}` : `User_${userId}`);
  const projectDisplay = job.type === "web2apk" ? (job.appName || "Web App") : (job.fileName || "Flutter Project");
  
  let priorityText = "";
  if (isOwner(userId)) priorityText = "👑 OWNER PRIORITY";
  else if (isReseller(userId)) priorityText = "🤝 RESELLER PRIORITY";
  else priorityText = "👤 NORMAL USER";

  async function updateStatusEmbed(userText, statusEmoji, statusTitle, statusDesc, showQueueButton = false) {
    const buttonDefs = showQueueButton ? [[{ text: "🚀 Mau Build Juga?, Gas!", url: `https://t.me/${(await client.getMe()).username}?start` }]] : null;
    
    await edit(chatId, msgId, userText);

    try {
      const channelCaption = 
        `${statusEmoji} **LIVE BUILD MONITOR** ${statusEmoji}\n` +
        `─────────────────\n\n` +
        `👤 **Developer :** ${userDisplay}\n` +
        `🆔 **User ID   :** \`${userId}\`\n` +
        `🎯 **Priority  :** ${priorityText}\n` +
        `📦 **Project   :** \`${projectDisplay}\`\n` +
        `🔧 **Mode      :** \`${displayMode}\`\n\n` +
        `📊 **PROGRES AKTIF:**\n` +
        ` STATUS ➜ **${statusTitle}**\n` +
        ` DETAIL ➜ __${statusDesc}__\n\n` +
        `─────────────────\n` +
        `⏱ **Waktu Berjalan:** \`${formatDuration(Math.floor((Date.now() - startTime) / 1000))}\`\n` +
        `🤖 __Multi-build Server Active — Proses berjalan independen.__`;

      if (!channelMsgId) {
        const sentChan = await client.sendFile(CONFIG.CHANNEL_USERNAME, {
          file: CONFIG.WELCOME_PHOTO,
          caption: channelCaption,
          parseMode: "md",
          buttons: buttonDefs ? buildButtons(buttonDefs) : undefined
        });
        channelMsgId = sentChan.id;
      } else {
        await client.editMessage(CONFIG.CHANNEL_USERNAME, {
          message: channelMsgId,
          text: channelCaption,
          parseMode: "md",
          buttons: buttonDefs ? buildButtons(buttonDefs) : undefined
        });
      }
    } catch (e) {
      console.error("Gagal update log kustom ke channel:", e.message);
    }
  }

  while (true) {
    if (Date.now() - startTime > CONFIG.BUILD_TIMEOUT_MS) {
      if (releaseId) await deleteRelease(releaseId).catch(() => {});
      
      const currentJob = getUserJob(userId);
      if (currentJob?.iconReleaseId) {
        await deleteRelease(currentJob.iconReleaseId).catch(() => {});
      }
      
      removeUserJob(userId);
      
      const timeoutText = 
        `🛑 **[ ENGINE CRASH ]**\n` +
        `─────────────────\n` +
        `📡 **Server :** \`🔴 TIMEOUT\`\n` +
        `🔧 **Mode   :** \`${displayMode}\`\n` +
        `📦 **App    :** \`${projectDisplay}\`\n` +
        `─────────────────\n\n` +
        `─────────────────\n` +
        `📊 **DASHBOARD LOG**\n` +
        `├ **Eror** ➜ \`Timeout Expired\`\n` +
        `└ **Limit** ➜ \`${Math.round(CONFIG.BUILD_TIMEOUT_MS / 60000)} Menit\`\n` +
        `─────────────────\n\n` +
        `⚠️ __Waktu habis! Server otomatis cut proses karena stuck. Cek dependensi kodingan lu terus coba lagi.__`;
        
      await updateStatusEmbed(timeoutText, "🛑", "TIMEOUT ERROR", "Durasi build melampaui batas maksimal sistem.", false);
      return;
    }

    const run = await getRunStatus(runId);
    const elapsed = Math.floor((Date.now() - startTime) / 1000);

    if (run.status === "queued" && lastStatus !== "queued") {
      lastStatus = "queued";
      
      const userText = 
        `⏳ **[ ENGINE SATELLITE ]**\n` +
        `─────────────────\n` +
        `📡 **Server :** \`🟢 ONLINE\`\n` +
        `🎯 **Priority :** ${priorityText}\n` +
        `🔧 **Mode   :** \`${displayMode}\`\n` +
        `📦 **App    :** \`${projectDisplay}\`\n` +
        `─────────────────\n\n` +
        `─────────────────\n` +
        `📊 **DASHBOARD LOG**\n` +
        `├ **Status** ➜ \`Menunggu Antrean...\`\n` +
        `└ **Waktu** ➜ \`${formatDuration(elapsed)}\`\n` +
        `─────────────────\n\n` +
        `☕ __Sabar Kan! VM Server lagi disiapin khusus buat ngerakit proyek lu. Jangan dicancel ya!__`;
        
      await updateStatusEmbed(
        userText, 
        "⏳", 
        "MENUNGGU RUNNER", 
        "Mempersiapkan mesin Virtual Environment di cloud server...", 
        true
      );

    } else if (run.status === "in_progress") {
      lastStatus = "in_progress";
      const pct = Math.min(Math.round((elapsed / 300) * 100), 95);
      
      const userText = 
        `⚡ **[ ENGINE COMPILING ]**\n` +
        `─────────────────\n` +
        `📡 **Server :** \`🟡 PROCESSING\`\n` +
        `🎯 **Priority :** ${priorityText}\n` +
        `🔧 **Mode   :** \`${displayMode}\`\n` +
        `📦 **App    :** \`${projectDisplay}\`\n` +
        `─────────────────\n\n` +
        `─────────────────\n` +
        `📊 **DASHBOARD LOG**\n` +
        `├ **Live** ➜ \`${progressBar(pct)}\` **${pct}%**\n` +
        `├ **Kerja** ➜ \`Kompilasi Source...\`\n` +
        `└ **Waktu** ➜ \`${formatDuration(elapsed)}\`\n` +
        `─────────────────\n\n` +
        `🚀 __Kodingan lu lagi dibakar engine cloud biar jadi APK. Stay tune di sini, jangan dicancel!__`;
        
      await updateStatusEmbed(
        userText, 
        "🔍", 
        `COMPILING (${pct}%)`, 
        "Flutter SDK sedang melakukan kompilasi dependensi ke format binari APK.", 
        true
      );

    } else if (run.status === "completed") {
      if (run.conclusion === "success") {
      currentStats = db.incrementStat("success");
        
        const userText = 
          `📦 **[ ENGINE EXTRACT ]**\n` +
          `─────────────────\n` +
          `📡 **Server :** \`🟢 SUCCESS\`\n` +
          `🎯 **Priority :** ${priorityText}\n` +
          `🔧 **Mode   :** \`${displayMode}\`\n` +
          `📦 **App    :** \`${projectDisplay}\`\n` +
          `─────────────────\n\n` +
          `─────────────────\n` +
          `📊 **DASHBOARD LOG**\n` +
          `├ **Hasil** ➜ \`100% Sukses\`\n` +
          `├ **Durasi** ➜ \`${formatDuration(run.durationSec)}\`\n` +
          `└ **Aksi** ➜ \`Menjemput APK...\`\n` +
          `─────────────────\n\n` +
          `🎉 __Gokil tembus tanpa error! File APK lagi ditarik dari cloud storage dan langsung diupload ke sini!__`;
          
        await updateStatusEmbed(userText, "📦", "UPLOADING ARTIFACT", "Proses kompilasi sukses, sedang memindahkan berkas APK ke Telegram.");

        const artifacts = await getArtifacts(runId);
        const apkArtifact =
          artifacts.find(
            (a) =>
              a.name.toLowerCase().includes("apk") ||
              a.name.toLowerCase().includes("build")
          ) || artifacts[0];

        if (!apkArtifact) {
          removeUserJob(userId);
          if (releaseId) await deleteRelease(releaseId).catch(() => {});
          
          const noArtifactText = 
            `⚠️ **[ EXTRACT ERROR ]**\n` +
            `─────────────────\n` +
            `❌ **File APK Hilang!**\n` +
            `Kompilasi sukses, tapi letak output file \`.apk\` gagal dideteksi server.\n\n` +
            `📞 __Hubungi admin @elnicholl buat cek jalur ekspor reponya.__`;
            
          await updateStatusEmbed(noArtifactText, "⚠️", "MISSING ARTIFACT", "Gagal mendeteksi output kompilasi aplikasi di server cloud.");
          return;
        }

        const zipDest = tmpPath(`flutter_${Date.now()}.zip`);
        await downloadArtifactZip(apkArtifact.id, zipDest);

        const zip = new AdmZip(zipDest);
        const apkEntry = zip
          .getEntries()
          .find((e) => e.entryName.endsWith(".apk"));

        if (!apkEntry) {
          removeUserJob(userId);
          fs.unlinkSync(zipDest);
          if (releaseId) await deleteRelease(releaseId).catch(() => {});
          
          const noApkInZipText = 
            `⚠️ **[ UNZIP ERROR ]**\n` +
            `─────────────────\n` +
            `❌ **Berkas APK Kosong!**\n` +
            `File arsip berhasil ditarik tapi isi di dalamnya terindikasi korup.\n\n` +
            `📞 __Hubungi admin @elnicholl buat cek konfigurasi gradlenya.__`;
            
          await updateStatusEmbed(noApkInZipText, "⚠️", "BAD ZIP CONTENT", "Ekstensi berkas keluaran tidak valid atau file korup.");
          return;
        }

        const apkDest = tmpPath(`flutter_${Date.now()}.apk`);
        fs.writeFileSync(apkDest, apkEntry.getData());
        fs.unlinkSync(zipDest);

        const apkSizeMB = (fs.statSync(apkDest).size / 1024 / 1024).toFixed(2);

        await edit(chatId, msgId, `🚀 **MENGUNGGAH FILE...**\n\nProses kompresi lokal sukses! Berkas APK berukuran \`${apkSizeMB} MB\` sedang dikirim ke chat lu... 🎉`);

        await client.sendFile(chatId, {
          file: apkDest,
          caption:
            `📱 **APK Siap Digunakan!** 🎉\n` +
            `─────────────────\n\n` +
            `⏱ **Durasi build :** ${formatDuration(run.durationSec)}\n` +
            `📦 **Ukuran APK  :** ${apkSizeMB} MB\n` +
            `🔧 **Mode        :** ${displayMode}\n` +
            `🎯 **Priority    :** ${priorityText}\n\n` +
            `__Terima kasih sudah menggunakan layanan ${CONFIG.BOT_NAME}!__`,
          parseMode: "md",
        });

        try {
          const finalSuccessChannelText = 
            `🎉 **BUILD SUCCESS COMPLETED** 🎉\n` +
            `─────────────────\n\n` +
            `👤 **Developer :** ${userDisplay}\n` +
            `🎯 **Priority  :** ${priorityText}\n` +
            `📦 **Project   :** \`${projectDisplay}\`\n` +
            `🔧 **Mode      :** \`${displayMode}\`\n\n` +
            `📊 **HASIL AKHIR:**\n` +
            ` 🟢 **STATUS** ➜ **SUKSES TERKIRIM**\n` +
            ` ⏱ **DURASI** ➜ \`${formatDuration(run.durationSec)}\`\n` +
            ` 💾 **UKURAN** ➜ \`${apkSizeMB} MB\`\n\n` +
            `─────────────────\n` +
            `🏁 __Berkas aplikasi telah mendarat dengan aman di DM pribadi pengguna.__`;
            
          await client.editMessage(CONFIG.CHANNEL_USERNAME, {
            message: channelMsgId,
            text: finalSuccessChannelText,
            parseMode: "md"
          });
        } catch (_) {}

        fs.unlinkSync(apkDest);
        if (releaseId) await deleteRelease(releaseId).catch(() => {});

        const currentJob = getUserJob(userId);
        if (currentJob?.iconReleaseId) {
          await deleteRelease(currentJob.iconReleaseId).catch(() => {});
        }

        removeUserJob(userId);
        return;
      } else {
      currentStats = db.incrementStat("failed");
   
        const userFailNotifyText = 
          `❌ **[ ENGINE FAILED ]**\n` +
          `─────────────────\n` +
          `📡 **Server :** \`🔴 FAILED\`\n` +
          `🎯 **Priority :** ${priorityText}\n` +
          `⚙️ **Mode Build   :** \`${displayMode}\`\n` +
          `📦 **Nama App     :** \`${projectDisplay}\`\n\n` +
          `🔍 __Aduh rontok Kan! Ada error di kodingan lu. Bot lagi narik log kesalahan dari server biar lu tau typonya...__`;
          
        await updateStatusEmbed(userFailNotifyText, "❌", "BUILD FAILED", "Terjadi kesalahan penulisan kode sintaks/eror manifes pada proyek.");

        if (releaseId) await deleteRelease(releaseId).catch(() => {});
        await sleep(3000);

        const errDetail = await Promise.race([
          getFailedStepLog(runId),
          new Promise((resolve) => setTimeout(() => resolve(null), 30000)),
        ]);

        let errText =
          `❌ **BUILD FAILED (EROR MANIFEST)**\n` +
          `─────────────────\n` +
          `🔴 **Gagal** ➜ \`${errDetail?.stepName || "Kompilasi Utama"}\`\n` +
          `⏱ **Waktu** ➜ \`${formatDuration(run.durationSec)}\`\n\n` +
          `📋 **Rincian Potongan Kode Error:**\n`;

        if (errDetail && errDetail.errorLines?.length) {
          errText += `\`\`\`\n${errDetail.errorLines.join("\n").slice(0, 1500)}\n\`\`\``;
          
          await updateStatusEmbed(errText, "❌", "FAILED ERROR", `Eror terdeteksi pada baris kodingan tahap: [${errDetail.stepName}].`);

          const fullLog =
            `BUILD FAILED\n` +
            `=============================\n` +
            `Step Failed : ${errDetail.stepName}\n` +
            `=============================\n` +
            errDetail.errorLines.join("\n");

          const logFile = tmpPath(`build_error_${userId}_${Date.now()}.txt`);
          fs.writeFileSync(logFile, fullLog);

          await client.sendFile(chatId, {
            file: logFile,
            caption: `📄 **Full Build Error Log.txt**\n\n⚠️ __Gunakan berkas log teks ini buat nyari baris kode lu yang typo secara detail.__`,
            parseMode: "md",
          });

          if (fs.existsSync(logFile)) fs.unlinkSync(logFile);
        } else {
          errText += `\`\`\`\nGagal mengambil log error otomatis dari server cloud.\n\`\`\``;
          await updateStatusEmbed(errText, "❌", "FAILED UNKNOWN", "Gagal menarik detail manifes kegagalan.");
        }

        const currentJob = getUserJob(userId);
        if (currentJob?.iconReleaseId) {
          await deleteRelease(currentJob.iconReleaseId).catch(() => {});
        }

        removeUserJob(userId);
        return;
      }
    }

    await sleep(CONFIG.POLL_INTERVAL_MS);
  }
}

// ─── QUEUE ─────────────────────────────────────────────────────────────────────
const queueMessages = new Map();

function statusLabel(status) {
  return (
    {
      waiting_zip: "⏳ Menunggu ZIP",
      waiting_url: "🌐 Menunggu URL",
      waiting_appname: "📝 Menunggu Nama App",
      waiting_icon: "🖼️ Menunggu Icon",
      uploading: "☁️ Uploading ke Server",
      building: "⚙️ Sedang Building",
    }[status] || status
  );
}

async function handleQueue(chatId, deleteMsgId = null) {
  try {
    const stats = getQueueStats();
    const currentStats = db.getStats();
    const jobs = getSortedActiveJobs();

    let text =
      `╭─【 📊 **STATUS BUILD** 】─╮\n\n` +
      `⏳ **Menunggu :** ${stats.waiting}\n` +
      `☁️ **Upload   :** ${stats.uploading}\n` +
      `⚙️ **Building :** ${stats.building}\n\n` +
      `╰─────────────────────────╯\n\n`;

    if (jobs.length === 0) {
      text += `__🚫 Tidak ada build aktif saat ini.__\n\n`;
    } else {
      text += `🔥 **Build Aktif (${jobs.length})**\n\n`;

      jobs.forEach((j, i) => {
        const icon =
          j.status === "building"
            ? "⚙️"
            : j.status === "uploading"
            ? "☁️"
            : "⏳";
            
        let priorityIcon = "";
        let priorityLevel = getUserPriority(j.userId);
        if (priorityLevel === 1) priorityIcon = "👑 ";
        else if (priorityLevel === 2) priorityIcon = "🤝 ";
        else priorityIcon = "👤 ";

        const elapsed = formatDuration(elapsedSec(j.updatedAt));
        const userDisplay = formatUser(j.userId, j.username, j.fullName);

        text +=
          `${i + 1}\\. ${priorityIcon}${icon} ${userDisplay}\n` +
          `   ├ **Status :** ${statusLabel(j.status)}\n` +
          `   ├ **Mode   :** ${j.buildType === "debug" ? "🐞 Debug" : j.type === "web2apk" ? "🌐 Web2APK" : "🚀 Release"}\n` +
          `   └ **Aktif  :** ${elapsed}\n\n`;
      });
    }

    text +=
  `─────────────────\n` +
  `🟢 **Sukses (Aplikasi Berhasil Dibuat) :** \`${currentStats.success} Build\`\n` +
  `🔴 **Gagal (Karena Error Code) :** \`${currentStats.failed} Build\`\n` +
  `─────────────────\n` +
  `🕒 \`${new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit", second: "2-digit" })} WIB\``;

    const buttons = [
      [{ text: "🔄 Refresh", data: "queue" }, { text: "🏠 Menu Utama", data: "start" }],
    ];

    if (deleteMsgId) {
      try {
        await client.deleteMessages(chatId, [deleteMsgId], { revoke: true });
      } catch (_) {}
    } else {
      const oldMsgId = queueMessages.get(chatId);
      if (oldMsgId) {
        try {
          await client.deleteMessages(chatId, [oldMsgId]);
        } catch (_) {}
      }
    }

    const msg = await client.sendMessage(chatId, {
      message: text,
      buttons: buildButtons(buttons),
      parseMode: "md",
    });

    queueMessages.set(chatId, msg.id);
  } catch (err) {
    console.error("Handle Queue Error:", err);
    try {
      await client.sendMessage(chatId, {
        message:
          `❌ **Gagal mengambil status antrian.**\n\n` +
          `📝 Error: \`${err.message}\``,
        parseMode: "md",
      });
    } catch (_) {}
  }
}

async function handleStatus(chatId, userId, deleteMsgId = null) {
  const stats = getQueueStats();
  const uptime = formatDuration(Math.floor(process.uptime()));
  const totalUsers = db.getAllUsers().length;

  const totalRam = (os.totalmem() / (1024 * 1024 * 1024)).toFixed(2);
  const freeRam = (os.freemem() / (1024 * 1024 * 1024)).toFixed(2);
  const usedRam = (totalRam - freeRam).toFixed(2);
  const ramPercentage = ((usedRam / totalRam) * 100).toFixed(1);

  const cpus = os.cpus();
  const cpuModel = cpus.length > 0 ? cpus[0].model.trim() : "Unknown CPU";
  const cpuCores = cpus.length;
  const cpuLoad = (os.loadavg()[0] * 100 / cpuCores).toFixed(1);
  const cpuSpeed = cpus.length > 0 ? `${cpus[0].speed} MHz` : "N/A";

  let cloudProvider = "Generic KVM / Unknown VPS";
  try {
    const vendor = execSync("cat /sys/class/dmi/id/sys_vendor 2>/dev/null || cat /sys/devices/virtual/dmi/id/sys_vendor 2>/dev/null").toString().trim().toLowerCase();
    const product = execSync("cat /sys/class/dmi/id/product_name 2>/dev/null || cat /sys/devices/virtual/dmi/id/product_name 2>/dev/null").toString().trim().toLowerCase();
    
    if (vendor.includes("digitalocean") || product.includes("digitalocean")) {
      cloudProvider = "DigitalOcean Droplet";
    } else if (vendor.includes("amazon") || product.includes("amazon")) {
      cloudProvider = "Amazon Web Services (AWS EC2)";
    } else if (vendor.includes("google") || product.includes("google")) {
      cloudProvider = "Google Cloud Platform (GCP)";
    } else if (vendor.includes("linode") || product.includes("linode")) {
      cloudProvider = "Linode VPS";
    } else if (vendor.includes("vultr") || product.includes("vultr")) {
      cloudProvider = "Vultr VPS";
    } else if (vendor.includes("qemu") || product.includes("kvm")) {
      cloudProvider = "KVM Virtual Server (QEMU)";
    } else if (vendor.length > 0) {
      cloudProvider = `${vendor.toUpperCase()} (${product.toUpperCase()})`;
    }
  } catch (_) {}

  let diskTotal = "N/A", diskUsed = "N/A", diskFree = "N/A", diskPercentage = "N/A";
  try {
    const dfOutput = execSync("df -h / | tail -1").toString().trim().split(/\s+/);
    if (dfOutput.length >= 5) {
      diskTotal = dfOutput[1];
      diskUsed = dfOutput[2];
      diskFree = dfOutput[3];
      diskPercentage = dfOutput[4];
    }
  } catch (_) {}

  let localIp = "127.0.0.1";
  const interfaces = os.networkInterfaces();
  for (const name in interfaces) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        localIp = iface.address;
        break;
      }
    }
  }

  const measurePing = () => {
    return new Promise((resolve) => {
      const start = Date.now();
      const socket = new net.Socket();
      
      socket.setTimeout(2000);

      socket.connect(443, "api.github.com", () => {
        const latency = Date.now() - start;
        socket.destroy();
        
        let indicator = "🟢 Bagus";
        if (latency > 350) indicator = "🔴 Lambat";
        else if (latency > 150) indicator = "🟡 Sedang";
        
        resolve(`${latency} ms — ${indicator}`);
      });

      socket.on("error", () => {
        socket.destroy();
        resolve("❌ Gagal Terhubung");
      });

      socket.on("timeout", () => {
        socket.destroy();
        resolve("❌ Timeout (2s)");
      });
    });
  };

  const githubPing = await measurePing();

  await send(
    chatId,
    `⚙️ **Spesifikasi Lengkap Infrastruktur Bot**\n` +
    `─────────────────\n\n` +
    `🤖 **BOT METRICS**\n` +
    `│ 📦 **Nama Aplikasi :** ${CONFIG.BOT_NAME} \`v${CONFIG.BOT_VERSION}\`\n` +
    `│ 🟢 **Status Bot    :** Online / Active\n` +
    `│ ⏱ **Uptime Kerja   :** ${uptime}\n` +
    `│ 👥 **Total Database:** ${totalUsers} pengguna terdaftar\n\n` +
    `📊 **ANTRIAN ENGINE**\n` +
    `│ ⏳ Menunggu ZIP : ${stats.waiting}\n` +
    `│ ☁️ Uploading    : ${stats.uploading}\n` +
    `│ ⚙️ Building     : ${stats.building}\n\n` +
    `☁️ **VIRTUAL ENVIRONMENT**\n` +
    `│ 🌐 **Cloud Host    :** \`${cloudProvider}\`\n` +
    `│ ⚡ **Ping ke Server Build :** \`${githubPing}\`\n` +
    `│ 📍 **Internal IP   :** \`${localIp}\`\n` +
    `│ 🐧 **Kernel OS     :** ${os.type()} ${os.release()} (${os.arch()})\n\n` +
    `🧠 **HARDWARE PROCESSOR**\n` +
    `│ 🎛️ **Model CPU     :** ${cpuModel}\n` +
    `│ ⚙️ **Total Core    :** ${cpuCores}x Virtual Cores\n` +
    `│ 🚀 **Kecepatan CPU :** ${cpuSpeed}\n` +
    `│ ⚡ **Rata-rata Load:** \`${cpuLoad}%\` Terpakai\n\n` +
    `💾 **MEMORY & STORAGE**\n` +
    `│ 🧠 **RAM Terpakai  :** ${usedRam} GB / ${totalRam} GB (\`${ramPercentage}%\` Used)\n` +
    `│ 📉 **RAM Tersisa   :** ${freeRam} GB Bebas\n` +
    `│ 💽 **SSD Penyimpanan:** ${diskUsed} / ${diskTotal} (\`${diskPercentage}\` Terpakai)\n` +
    `│ 📀 **SSD Sisa Free :** ${diskFree} Tersedia\n\n` +
    `─────────────────\n` +
    `🕒 ${new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })} WIB`,
    [[{ text: "🏠 Menu Utama", data: "start" }]],
    deleteMsgId
  );
}

async function handleHelp(chatId, deleteMsgId = null) {
  await send(
    chatId,
    `📖 **Panduan — ${CONFIG.BOT_NAME}**\n` +
    `─────────────────\n\n` +
    `**Perintah Tersedia:**\n` +
    `🔹 /start  — Menu utama\n` +
    `🔹 /help   — Tampilkan bantuan ini\n` +
    `🔹 /jadwalsholat — Lihat jadwal sholat hari ini\n` +
    `🔹 /broadcast (reply pesan) — Broadcast ke semua user (Admin/Owner)\n` +
    `🔹 /addreseller <id> — Tambah reseller (Admin/Owner)\n` +
    `🔹 /removereseller <id> — Hapus reseller (Admin/Owner)\n` +
    `🔹 /listusers — Lihat semua user (Admin/Owner)\n` +
    `🔹 /listresellers — Lihat semua reseller (Admin/Owner)\n\n` +
    `**Alur Build APK:**\n` +
    `1️⃣ Klik tombol **🚀 Mulai Build APK**\n` +
    `2️⃣ Pilih mode Debug / Release\n` +
    `3️⃣ Kirim file ZIP project Flutter\n` +
    `4️⃣ Bot build & APK dikirim otomatis!\n\n` +
    `**Alur Web to APK:**\n` +
    `1️⃣ Klik tombol **🌐 Web to APK**\n` +
    `2️⃣ Kirim URL website\n` +
    `3️⃣ Kirim nama aplikasi\n` +
    `4️⃣ Kirim logo/icon\n` +
    `5️⃣ APK dikirim otomatis!\n\n` +
    `**Ketentuan:**\n` +
    `│ • Maks **1 build aktif** per user\n` +
    `│ • Maks ukuran file: **2 GB**\n` +
    `└ • Timeout build: **${Math.round(CONFIG.BUILD_TIMEOUT_MS / 60000)} menit**`,
    [
      [{ text: "🚀 Mulai Build APK", data: "build" }, { text: "🌐 Web to APK", data: "web2apk" }],
      [{ text: "🕌 Jadwal Sholat", data: "prayer_schedule" }],
      [{ text: "🏠 Menu Utama", data: "start" }],
    ],
    deleteMsgId
  );
}

// ─── WEB2APK ───────────────────────────────────────────────────────────────────
async function handleWeb2Apk(chatId, userId, deleteMsgId = null) {
  if (CONFIG.WEB2APK_MAINTENANCE) {
    await send(
      chatId,
      `🛠️ **FITUR DALAM MAINTENANCE**\n` +
      `─────────────────\n\n` +
      `Mohon maaf, fitur **Web to APK** saat ini sedang ditutup sementara untuk peningkatan sistem / perbaikan server.\n\n` +
      `📢 Kami akan menginfokan kembali jika fitur ini sudah dibuka normal melalui channel resmi.\n\n` +
      `__Silakan gunakan fitur Build APK biasa untuk sementara waktu.__`,
      [[{ text: "🏠 Menu Utama", data: "start" }]],
      deleteMsgId
    );
    return;
  }

  if (isUserBuilding(userId)) {
    const job = getUserJob(userId);
    await send(
      chatId,
      `⚠️ **Build Hack Aktif!**\n\n` +
      `📋 **Status :** ${statusLabel(job.status)}\n\n` +
      `Harap tunggu hingga selesai, atau batalkan dulu.`,
      [[{ text: "❌ Batalkan Build", data: "cancel" }]],
      deleteMsgId
    );
    return;
  }

  let username = null;
  let fullName = "Unknown User";
  try {
    const entity = await client.getEntity(userId);
    username = entity?.username || null;
    fullName =
      [entity?.firstName, entity?.lastName].filter(Boolean).join(" ") ||
      "Unknown User";
  } catch (_) {}

  const priority = getUserPriority(userId);

  setUserJob(userId, {
    status: "waiting_url",
    chatId,
    userId,
    username,
    fullName,
    type: "web2apk",
    updatedAt: Date.now(),
    priority: priority,
  });

  let priorityMsg = "";
  if (priority === 1) priorityMsg = "\n\n👑 **PRIORITAS OWNER (Level 1)**";
  else if (priority === 2) priorityMsg = "\n\n🤝 **PRIORITAS RESELLER (Level 2)**";

  await send(
    chatId,
    `🌐 **Web to APK — Langkah 1/3**\n` +
    `─────────────────\n\n` +
    `Kirim **URL website** yang ingin dijadikan APK.${priorityMsg}\n\n` +
    `📌 Contoh:\n` +
    `\`https://example.com\``,
    [[{ text: "❌ Batalkan", data: "cancel" }]],
    deleteMsgId
  );
}

async function handleWeb2ApkUrl(event) {
  const chatId = event.chatId;
  const userId = Number(event.message.senderId);
  const text = event.message.text?.trim();
  const job = getUserJob(userId);

  if (!job || job.status !== "waiting_url" || job.type !== "web2apk") return;

  try {
    new URL(text);
  } catch {
    await send(chatId, `❌ **URL tidak valid!**\n\nContoh: \`https://example.com\``);
    return;
  }

  setUserJob(userId, { ...job, status: "waiting_appname", webUrl: text, updatedAt: Date.now() });

  await send(
    chatId,
    `✅ **URL Tersimpan!**\n\n` +
    `🌐 **Web to APK — Langkah 2/3**\n` +
    `─────────────────\n\n` +
    `Kirim **nama aplikasi** yang diinginkan.\n\n` +
    `📌 Contoh:\n` +
    `\`Toko Online Saya\``,
    [[{ text: "❌ Batalkan", data: "cancel" }]]
  );
}

async function handleWeb2ApkName(event) {
  const chatId = event.chatId;
  const userId = Number(event.message.senderId);
  const text = event.message.text?.trim();
  const job = getUserJob(userId);

  if (!job || job.status !== "waiting_appname" || job.type !== "web2apk") return;

  setUserJob(userId, { ...job, status: "waiting_icon", appName: text, updatedAt: Date.now() });

  await send(
    chatId,
    `✅ **Nama App Tersimpan!**\n\n` +
    `🌐 **Web to APK — Langkah 3/3**\n` +
    `─────────────────\n\n` +
    `Kirim **foto/logo** untuk icon APK.\n\n` +
    `📌 Tips:\n` +
    `• Kirim sebagai **foto** atau **file gambar**\n` +
    `• Disarankan ukuran **1:1** (persegi)\n` +
    `• Format: PNG, JPG`,
    [[{ text: "❌ Batalkan", data: "cancel" }]]
  );
}

async function handleWeb2ApkIcon(event) {
  const chatId = event.chatId;
  const userId = Number(event.message.senderId);
  const msg = event.message;
  const job = getUserJob(userId);

  if (!job || job.status !== "waiting_icon" || job.type !== "web2apk") return false;

  const media = msg.media;
  if (!media) return false;

  const isPhoto = media.photo;
  const isDocument = media.document;
  
  if (!isPhoto && !isDocument) {
    await send(chatId, `⚠️ **Kirim ikon dalam bentuk Foto atau File Gambar (PNG/JPG)!**`);
    return true;
  }

  const statusMsg = await send(
    chatId,
    `⚙️ **Memproses Web to APK...**\n` +
    `─────────────────\n\n` +
    `🌐 **URL  :** \`${job.webUrl}\`\n` +
    `📱 **Nama :** \`${job.appName}\`\n\n` +
    `🔥 Mengunduh dan memproses icon...`
  );

  const msgId = statusMsg.id;

  try {
    if (!fs.existsSync(CONFIG.TMP_DIR)) fs.mkdirSync(CONFIG.TMP_DIR, { recursive: true });

    const iconPath = tmpPath(`icon_${userId}_${Date.now()}.png`);
    await client.downloadMedia(msg, { outputFile: iconPath });

    await edit(
      chatId,
      msgId,
      `⚙️ **Memproses Web to APK...**\n` +
      `─────────────────\n\n` +
      `🌐 **URL  :** \`${job.webUrl}\`\n` +
      `📱 **Nama :** \`${job.appName}\`\n\n` +
      `☁️ Menyiapkan aset di GitHub Release...`
    );

    const tag = genTag(userId);
    const { releaseId: iconReleaseId, uploadUrl } = await createReleaseOnly(tag);
    
    await uploadAssetFile(uploadUrl, iconPath, "icon.png", "image/png");
    if (fs.existsSync(iconPath)) fs.unlinkSync(iconPath);

    const iconUrl = await publishRelease(iconReleaseId);
    console.log("✅ Berhasil Publish! Icon URL:", iconUrl);

    if (!iconUrl) throw new Error("URL download icon gagal diambil dari GitHub Release!");

    const runId = await triggerWeb2ApkWorkflow(job.webUrl, job.appName, iconUrl);

    await edit(
      chatId,
      msgId,
      `⚙️ **Memproses Web to APK...**\n` +
      `─────────────────\n\n` +
      `🌐 **URL  :** \`${job.webUrl}\`\n` +
      `📱 **Nama :** \`${job.appName}\`\n\n` +
      `🚀 Memicu workflow server build...`
    );

    setUserJob(userId, {
      ...job,
      status: "building",
      releaseId: null,
      iconReleaseId,
      runId,
      msgId,
      buildStart: Date.now(),
      updatedAt: Date.now(),
    });

    await edit(
      chatId,
      msgId,
      `⚙️ **Build Web to APK Dimulai!**\n` +
      `─────────────────\n\n` +
      `🌐 **URL  :** \`${job.webUrl}\`\n` +
      `📱 **Nama :** \`${job.appName}\`\n` +
      `🆔 **Run  :** \`${runId}\`\n\n` +
      `🔍 Memantau progress build...`
    );

    monitorBuild(userId, chatId, msgId, runId, null).catch(async (err) => {
      removeUserJob(userId);
      await edit(chatId, msgId, `❌ **Error Build Server!**\n\n🔴 Detail: \`${err.message}\``);
    });
  } catch (err) {
    removeUserJob(userId);
    await edit(chatId, msgId, `❌ **Gagal Memproses Asset!**\n\n🔴 Error: \`${err.message}\``);
  }

  return true;
}

// ─── REPORT HANDLING (SISI USER & ADMIN) ───────────────────────────────────────
async function handleUserReportMessages(event) {
  const sender = await event.message.getSender();
  const userId = Number(sender?.id);
  const chatId = event.chatId;
  const messageText = event.message.text;

  const currentState = userStates.get(userId);
  if (!currentState) return false; 

  if (currentState.step === 'WAITING_FOR_REASON') {
    if (!messageText || messageText.length < 10) {
      await client.sendMessage(chatId, { 
        message: "⚠️ **Mohon berikan alasan yang lebih detail (minimal 10 karakter agar admin paham penjelasannya).**",
        buttons: buildButtons([[{ text: "❌ Batalkan Laporan", data: "user_cancel_lapor" }]]),
        parseMode: "md"
      });
      return true;
    }
    
    userStates.set(userId, { step: 'WAITING_FOR_SCREENSHOT', reason: messageText });
    await client.sendMessage(chatId, {
      message: `📸 **BUKTI SCREENSHOT**\n\n` +
               `Sekarang, silakan kirimkan **1 Foto/Screenshot** bukti pendukung kendala tersebut untuk mempermudah perbaikan.`,
      parseMode: "md",
      buttons: buildButtons([[{ text: "❌ Batalkan Laporan", data: "user_cancel_lapor" }]])
    });
    return true;
  }

  if (currentState.step === 'WAITING_FOR_SCREENSHOT') {
    if (!event.message.media || !(event.message.media instanceof Api.MessageMediaPhoto)) {
      await client.sendMessage(chatId, { 
        message: "⚠️ **Format salah! Silakan kirimkan bukti file berupa Gambar/Foto.**",
        buttons: buildButtons([[{ text: "❌ Batalkan Laporan", data: "user_cancel_lapor" }]]),
        parseMode: "md"
      });
      return true;
    }

    const username = sender?.username ? `@${sender.username}` : "Tidak ada username";
    const name = sender?.firstName || "User";
    
    const adminReportLog = 
      `🚨 **LAPORAN MASUK**\n\n` +
      `👤 **Pengirim:** ${name}\n` +
      `🆔 **User ID:** \`${userId}\`\n` +
      `🌐 **Username:** ${username}\n\n` +
      `📝 **Detail Alasan:**\n` +
      `"${currentState.reason}"\n\n` +
      `📌 **Tindakan Admin:**`;

    try {
      const reportIconPath = tmpPath(`report_${userId}_${Date.now()}.jpg`);
      await client.downloadMedia(event.message, { outputFile: reportIconPath });

      await client.sendMessage(CONFIG.CHANNEL_USERNAME, {
        message: adminReportLog,
        file: reportIconPath, 
        parseMode: "md",
        buttons: buildButtons([
          [{ text: "✅ Masalah Selesai", data: `adm_fix_${userId}` }],
          [
            { text: "🔒 Blokir", data: `adm_blk_${userId}` },
            { text: "🔓 Unblokir", data: `adm_unblk_${userId}` }
          ]
        ])
      });

      if (fs.existsSync(reportIconPath)) fs.unlinkSync(reportIconPath);

      await client.sendMessage(chatId, {
        message: `✅ **Laporan Sukses Dikirim**\n\nTerima kasih, laporan lengkap dan bukti screenshot kamu sudah berhasil masuk ke sistem penanganan admin. Kami akan segera mengeceknya.`,
        parseMode: "md"
      });

    } catch (e) {
      console.error("Gagal mengirim laporan:", e.message);
      await client.sendMessage(chatId, { message: "❌ Terjadi gangguan internal sistem, gagal mengirim laporan." });
    }

    userStates.delete(userId);
    return true;
  }
  return false;
}

// ─── ADMIN COMMAND HANDLERS ────────────────────────────────────────────────────
async function handleAddReseller(chatId, userId, targetUserId = null) {
  if (!isAdmin(userId) && !isOwner(userId)) {
    await send(chatId, "❌ Anda tidak memiliki akses admin!");
    return;
  }
  
  if (targetUserId) {
    const targetNum = Number(targetUserId);
    if (isNaN(targetNum)) {
      await send(chatId, "❌ Format salah! Gunakan: `/addreseller 123456789`");
      return;
    }
    
    const userInfo = db.getUserById(targetNum);
    const username = userInfo?.username || null;
    
    if (addReseller(targetNum, username, userId)) {
      await send(chatId, `✅ **Berhasil menambahkan reseller!**\n\n🆔 ID: \`${targetNum}\`\n👤 Username: ${username || "Tidak ada"}\n🎯 **Priority Level 2** - Build prioritas setelah Owner!`);
      
      try {
        await client.sendMessage(targetNum, {
          message: `🎉 **SELAMAT!**\n\nAnda sekarang telah menjadi **RESELLER** dari ${CONFIG.BOT_NAME}.\n\n✨ **Akses yang Anda dapatkan:**\n• Unlimited Build APK\n• Unlimited Web to APK\n• **PRIORITAS LEVEL 2** (Build anda diprioritaskan setelah Owner)\n• Prioritas support\n\nTerima kasih telah bergabung! 🚀`,
          parseMode: "md"
        });
      } catch (err) {
        console.log("Gagal kirim notifikasi ke reseller:", err.message);
      }
    } else {
      await send(chatId, `❌ **Gagal menambahkan reseller!**\nUser ID \`${targetNum}\` sudah menjadi reseller.`);
    }
    return;
  }
  
  await send(chatId, `➕ **Tambah Reseller**\n\nGunakan format: \`/addreseller 123456789\``);
}

async function handleRemoveReseller(chatId, userId, targetUserId = null) {
  if (!isAdmin(userId) && !isOwner(userId)) {
    await send(chatId, "❌ Anda tidak memiliki akses admin!");
    return;
  }
  
  if (targetUserId) {
    const targetNum = Number(targetUserId);
    if (isNaN(targetNum)) {
      await send(chatId, "❌ Format salah! Gunakan: `/removereseller 123456789`");
      return;
    }
    
    if (removeReseller(targetNum)) {
      await send(chatId, `✅ **Berhasil menghapus reseller!**\n\n🆔 ID: \`${targetNum}\``);
      
      try {
        await client.sendMessage(targetNum, {
          message: `⚠️ **PEMBERITAHUAN**\n\nStatus reseller Anda telah dicabut oleh admin.\n\nTerima kasih atas kerjasamanya.`,
          parseMode: "md"
        });
      } catch (err) {}
    } else {
      await send(chatId, `❌ **Gagal menghapus reseller!**\nUser ID \`${targetNum}\` bukan reseller.`);
    }
    return;
  }
  
  await send(chatId, `➖ **Hapus Reseller**\n\nGunakan format: \`/removereseller 123456789\``);
}

async function handleListUsers(chatId, userId, page = 1) {
  if (!isAdmin(userId) && !isOwner(userId)) {
    await send(chatId, "❌ Anda tidak memiliki akses admin!");
    return;
  }
  
  const allUsers = db.getAllUsers();
  const resellers = getResellers();
  const perPage = 10;
  const totalPages = Math.ceil(allUsers.length / perPage);
  const start = (page - 1) * perPage;
  const end = start + perPage;
  const usersPage = allUsers.slice(start, end);
  
  let text = `👥 **DAFTAR USER (${allUsers.length})**\n─────────────────\n\n`;
  
  for (const user of usersPage) {
    const isRes = resellers.some(r => r.userId === user.userId);
    const isOwn = isOwner(user.userId);
    let roleIcon = "";
    if (isOwn) roleIcon = "👑 ";
    else if (isRes) roleIcon = "🤝 ";
    else roleIcon = "👤 ";
    
    text += `${roleIcon}🆔 **ID:** \`${user.userId}\`\n`;
    text += `👤 **Nama:** ${user.name || "Unknown"}\n`;
    text += `🤝 **Reseller:** ${isRes ? "✅ Ya" : "❌ Tidak"}\n`;
    text += `─────────────────\n`;
  }
  
  text += `\n📄 **Halaman ${page} dari ${totalPages}**\n\nGunakan /listusers ${page + 1} untuk halaman berikutnya`;
  
  await send(chatId, text);
}

async function handleListResellers(chatId, userId, page = 1) {
  if (!isAdmin(userId) && !isOwner(userId)) {
    await send(chatId, "❌ Anda tidak memiliki akses admin!");
    return;
  }
  
  const resellers = getResellers();
  const perPage = 10;
  const totalPages = Math.ceil(resellers.length / perPage);
  const start = (page - 1) * perPage;
  const end = start + perPage;
  const resellersPage = resellers.slice(start, end);
  
  let text = `🤝 **DAFTAR RESELLER (${resellers.length})**\n─────────────────\n\n`;
  
  for (const reseller of resellersPage) {
    text += `🤝🆔 **ID:** \`${reseller.userId}\`\n`;
    text += `👤 **Username:** ${reseller.username || "Tidak ada"}\n`;
    text += `📅 **Ditambahkan:** ${new Date(reseller.addedAt).toLocaleDateString("id-ID")}\n`;
    text += `🎯 **Priority Level 2 (Reseller)**\n`;
    text += `─────────────────\n`;
  }
  
  text += `\n📄 **Halaman ${page} dari ${totalPages}**\n\nGunakan /listresellers ${page + 1} untuk halaman berikutnya`;
  
  await send(chatId, text);
}

// ─── CALLBACK PROCESSING ───────────────────────────────────────────────────────
async function handleCallback(event) {
  try {
    const data = event.data.toString();
    const chatId = event.chatId;
    const userId = Number(event.senderId);
    const msgId = event.messageId;

    if (data.startsWith("broadcast_approve_")) {
      if (!isOwner(userId)) {
        return await event.answer({ message: "❌ Hanya Owner yang bisa approve!", alert: true });
      }
      const parts = data.split("_");
      const targetUserId = parseInt(parts[2]);
      
      await client.sendMessage(targetUserId, {
        message: `✅ **Broadcast Disetujui Owner!**\n\nPesan broadcast kamu telah disetujui dan akan segera dikirim ke semua pengguna.`,
        parseMode: "md"
      });
      
      await event.answer({ message: "✅ Broadcast disetujui!", alert: false });
      return;
    }
    
    if (data.startsWith("broadcast_reject_")) {
      if (!isOwner(userId)) {
        return await event.answer({ message: "❌ Hanya Owner yang bisa reject!", alert: true });
      }
      const targetUserId = parseInt(data.replace("broadcast_reject_", ""));
      
      await client.sendMessage(targetUserId, {
        message: `❌ **Broadcast Ditolak Owner!**\n\nPesan broadcast kamu ditolak oleh owner. Pastikan pesan yang akan di-broadcast sesuai dengan ketentuan.`,
        parseMode: "md"
      });
      
      await event.answer({ message: "❌ Broadcast ditolak!", alert: false });
      return;
    }

    if (data === "user_start_lapor") {
      if (db.isReportBlocked(userId)) {
        return event.answer({
          message: "❌ Akses Ditolak! Kamu telah diblokir dari fitur laporan karena terindikasi mengirimkan laporan palsu.",
          alert: true
        });
      }

      userStates.set(userId, { step: 'WAITING_FOR_REASON' });
      await client.editMessage(chatId, {
        message: msgId,
        text: `📝 **MENU LAPORAN**\n\n` +
              `Silakan ketik **Alasan & Detail Laporan** kamu dengan jelas, lalu kirimkan lewat chat di bawah ini.\n\n` +
              `⚠️ __Laporan asal-asalan/palsu akan mengakibatkan akun kamu diblokir dari fitur bot.__`,
        parseMode: "md",
        buttons: buildButtons([[{ text: "❌ Batalkan Laporan", data: "user_cancel_lapor" }]])
      });
      return await event.answer();
    }

    if (data === "user_cancel_lapor") {
      userStates.delete(userId);
      await client.editMessage(chatId, {
        message: msgId,
        text: `❌ **Laporan Dibatalkan**\n\nProses pengisian laporan telah dihentikan secara aman. Silakan buka kembali menu utama jika diperlukan.`,
        parseMode: "md",
        buttons: []
      });
      return await event.answer({ message: "Laporan dibatalkan" });
    }

    if (data === "prayer_schedule") {
      await prayer.sendTodayPrayerSchedule(client, chatId);
      await event.answer({ message: "📋 Mengirim jadwal sholat..." });
      return;
    }

    if (data === "admin_panel") {
      if (!isAdmin(userId) && !isOwner(userId)) {
        return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      }
      await showAdminPanel(chatId, userId, msgId);
      return await event.answer();
    }
    
    if (data === "owner_panel") {
      if (!isOwner(userId)) {
        return await event.answer({ message: "❌ Hanya Owner yang bisa mengakses!", alert: true });
      }
      await showOwnerPanel(chatId, userId, msgId);
      return await event.answer();
    }
    
    if (data === "admin_add_reseller") {
      if (!isAdmin(userId) && !isOwner(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      await send(chatId, `➕ **Tambah Reseller**\n\nGunakan format: \`/addreseller 123456789\``);
      return await event.answer();
    }
    
    if (data === "admin_remove_reseller") {
      if (!isAdmin(userId) && !isOwner(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      await send(chatId, `➖ **Hapus Reseller**\n\nGunakan format: \`/removereseller 123456789\``);
      return await event.answer();
    }
    
    if (data === "admin_list_users") {
      if (!isAdmin(userId) && !isOwner(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      await handleListUsers(chatId, userId, 1);
      return await event.answer();
    }
    
    if (data === "admin_list_resellers") {
      if (!isAdmin(userId) && !isOwner(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      await handleListResellers(chatId, userId, 1);
      return await event.answer();
    }

    const isAdminAction = data.startsWith("adm_fix_") || data.startsWith("adm_blk_") || data.startsWith("adm_unblk_");
    if (isAdminAction) {
      if (chatId !== CONFIG.ADMIN_GROUP_ID && !isAdmin(userId)) {
        return await event.answer({ message: "❌ Kamu tidak memiliki akses admin!", alert: true });
      }

      let originalMsgText = "Laporan User";
      try {
        const fullMsg = await client.getMessages(chatId, { ids: [msgId] });
        originalMsgText = fullMsg[0]?.message || fullMsg[0]?.caption || "Laporan User";
      } catch (err) {
        console.error("Gagal get original message:", err);
      }

      if (data.startsWith("adm_fix_")) {
        const targetUserId = Number(data.replace("adm_fix_", ""));
        try {
          await client.sendMessage(targetUserId, {
            message: `🎉 **LAPORAN SELESAI DIPROSES**\n\n` +
                     `Halo, kendala/bug yang kamu laporkan sebelumnya **telah berhasil diperbaiki** oleh tim admin.\n\n` +
                     `Terima kasih banyak atas kontribusi dan laporan kamu! Silakan dicoba kembali fiturnya.`,
            parseMode: "md"
          });
          await event.answer({ message: "✅ Berhasil memberi tahu user!", alert: false });
        } catch (err) {
          await event.answer({ message: "⚠️ Gagal kirim DM (User memblokir bot)", alert: true });
        }

        await client.editMessage(chatId, {
          message: msgId,
          text: originalMsgText + `\n\n` + `🟢 **STATUS:** Selesai diperbaiki & user telah diberitahu.`,
          parseMode: "md",
          buttons: buildButtons([[{ text: "🔒 Blokir User", data: `adm_blk_${targetUserId}` }]])
        });
        return;
      }

      if (data.startsWith("adm_blk_")) {
        const targetUserId = Number(data.replace("adm_blk_", ""));
        if (db.isReportBlocked(targetUserId)) {
          return await event.answer({ message: "ℹ️ User ini sudah berstatus diblokir.", alert: true });
        }
        db.blockReportUser(targetUserId);
        await event.answer({ message: `🔒 ID ${targetUserId} Berhasil Diblokir`, alert: false });

        const cleanedMessage = originalMsgText.replace(`\n\n🟢 **STATUS:** Selesai diperbaiki & user telah diberitahu.`, "");
        await client.editMessage(chatId, {
          message: msgId,
          text: cleanedMessage + `\n\n` + `🔴 **STATUS:** User telah diblokir oleh admin karena laporan palsu.`,
          parseMode: "md",
          buttons: buildButtons([[{ text: "🔓 Unblokir User", data: `adm_unblk_${targetUserId}` }]])
        });

        try {
          await client.sendMessage(targetUserId, {
            message: `⚠️ **AKSES DIBLOKIR**\n\nFitur laporan kamu telah dinonaktifkan oleh tim admin karena terindikasi mengirimkan laporan palsu/spam.`,
            parseMode: "md"
          });
        } catch (err) {}
        return;
      }

      if (data.startsWith("adm_unblk_")) {
        const targetUserId = Number(data.replace("adm_unblk_", ""));
        if (!db.isReportBlocked(targetUserId)) {
          return await event.answer({ message: "ℹ️ User tidak sedang dalam pemblokiran.", alert: true });
        }
        db.unblockReportUser(targetUserId);
        await event.answer({ message: `🔓 Blokir ID ${targetUserId} Telah Dibuka`, alert: false });

        const cleanedMessage = originalMsgText.replace(`\n\n🔴 **STATUS:** User telah diblokir oleh admin karena laporan palsu.`, "");
        await client.editMessage(chatId, {
          message: msgId,
          text: cleanedMessage + `\n\n` + `⚪ **STATUS:** Akses laporan dikembangkan normal.`,
          parseMode: "md",
          buttons: buildButtons([
            [{ text: "✅ Masalah Selesai", data: `adm_fix_${targetUserId}` }],
            [
              { text: "🔒 Blokir", data: `adm_blk_${targetUserId}` },
              { text: "🔓 Unblokir", data: `adm_unblk_${targetUserId}` }
            ]
          ])
        });

        try {
          await client.sendMessage(targetUserId, {
            message: `✅ **AKSES DIKEMBALIKAN**\n\nFitur laporan kamu telah diaktifkan kembali. Mohon gunakan fasilitas ini dengan bijak.`,
            parseMode: "md"
          });
        } catch (err) {}
        return;
      }
    }

    if (data === "check_join") {
      const joined = await isJoinedChannel(userId);

      if (!joined) {
        return event.answer({
          message: "❌ Kamu belum join semua channel!",
          alert: true,
        });
      }

      await event.answer({ message: "✅ Verifikasi berhasil!" });

      let firstName = "User";
      try {
        const entity = await client.getEntity(userId);
        firstName = entity?.firstName || "User";
      } catch (_) {}

      return handleStart(
        {
          chatId,
          message: {
            getSender: async () => ({
              id: userId,
              firstName,
              username: null,
            }),
          },
        },
        msgId
      );
    }

    await event.answer();

    if (data === "start") {
      return await handleStart(
        {
          chatId,
          message: {
            getSender: async () => {
              try {
                const entity = await client.getEntity(userId);
                return {
                  id: userId,
                  firstName: entity?.firstName || "User",
                  username: entity?.username || null,
                };
              } catch (_) {
                return { id: userId, firstName: "User" };
              }
            },
          },
        },
        msgId
      );
    }

    if (data === "build") return await handleBuild(chatId, userId, null, msgId);
    if (data === "build_debug") return await handleBuild(chatId, userId, "debug", msgId);
    if (data === "build_release") return await handleBuild(chatId, userId, "release", msgId);
    if (data === "web2apk") return await handleWeb2Apk(chatId, userId, msgId);
    if (data === "queue") return await handleQueue(chatId, msgId);
    if (data === "help") return await handleHelp(chatId, msgId);
    if (data === "status") return await handleStatus(chatId, userId, msgId);

    if (data === "cancel") {
      removeUserJob(userId);
      return await send(
        chatId,
        `✅ **Dibatalkan.**\n\n` +
        `__Ketik /start atau klik tombol di bawah untuk kembali ke menu utama.__`,
        [[{ text: "🏠 Menu Utama", data: "start" }]],
        msgId
      );
    }
  } catch (err) {
    console.error("handleCallback error:", err);
  }
}

// ─── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`🚀 Starting ${CONFIG.BOT_NAME}...`);
  console.log(`👑 OWNER_ID: ${CONFIG.OWNER_ID}`);
  console.log(`🎯 PRIORITY SYSTEM: Owner (Level 1) > Reseller (Level 2) > User (Level 3)`);

  if (!fs.existsSync(CONFIG.TMP_DIR)) fs.mkdirSync(CONFIG.TMP_DIR, { recursive: true });

  await client.start({
    botAuthToken: CONFIG.BOT_TOKEN,
    onError: (err) => console.error("Client error:", err),
  });

  fs.writeFileSync(SESSION_FILE, client.session.save());
  console.log("✅ Bot connected & session saved!");

  // ─── PRAYER SCHEDULE SYSTEM ──────────────────────────────────────────────────
  if (CONFIG.PRAYER_TIMES?.enabled !== false) {
    console.log("🕌 Menyiapkan sistem jadwal sholat...");
    
    // Update jadwal sholat pertama kali
    try {
      await prayer.updatePrayerSchedule();
      console.log("✅ Jadwal sholat berhasil di-load pertama kali");
    } catch (err) {
      console.error("❌ Gagal load jadwal sholat awal:", err.message);
    }
    
    // Update jadwal setiap hari jam 00:05
    setInterval(async () => {
      const now = new Date();
      if (now.getHours() === 0 && now.getMinutes() === 5) {
        try {
          await prayer.updatePrayerSchedule();
          console.log("✅ Jadwal sholat berhasil diupdate otomatis");
        } catch (err) {
          console.error("❌ Gagal update jadwal sholat:", err.message);
        }
      }
    }, 60000);
    
    // Cek waktu sholat setiap 30 detik
    setInterval(async () => {
      try {
        await prayer.checkPrayerTime(client, db);
      } catch (err) {
        console.error("❌ Error check prayer time:", err.message);
      }
    }, 30000);
    
    console.log("✅ Sistem jadwal sholat aktif!");
  }

  client.addEventHandler(async (event) => {
    try {
      const msg = event.message;
      const text = msg?.text?.trim();
      const chatId = event.chatId;
      const userId = Number(msg.senderId);

      if (text === "/start") return handleStart(event);
      if (text === "/help") return handleHelp(chatId);
      
      if (text === "/jadwalsholat") {
        await prayer.sendTodayPrayerSchedule(client, chatId);
        return;
      }

      if (text === "/broadcast" && (isAdmin(userId) || isOwner(userId))) {
        const replied = await event.message.getReplyMessage();
        if (!replied) {
          return send(chatId, `⚠️ **Cara Broadcast:**\nReply pesan yang ingin di-broadcast, lalu ketik /broadcast\n\nContoh: reply pesan lalu ketik /broadcast`);
        }
        
        if (!isOwner(userId)) {
          await handleBroadcastWithOwnerNotify(chatId, userId, replied);
        } else {
          const totalUsers = db.getAllUsers().length;
          const msgBroadcast = await send(chatId, `📢 **Broadcast dimulai ke ${totalUsers} user...**`);
          
          let success = 0, failed = 0;
          
          for (const user of db.getAllUsers()) {
            try {
              if (replied.media) {
                await client.sendFile(user.userId, {
                  file: replied.media,
                  caption: replied.text || replied.caption || "",
                  parseMode: "md",
                });
              } else {
                await client.sendMessage(user.userId, {
                  message: replied.text || replied.caption || "",
                  parseMode: "md",
                });
              }
              success++;
            } catch (err) {
              failed++;
            }
            await sleep(100);
          }
          
          await edit(chatId, msgBroadcast.id,
            `✅ **Broadcast Selesai!**\n─────────────────\n\n` +
            `📢 **Total User:** ${totalUsers}\n` +
            `✔️ **Sukses:** ${success}\n` +
            `❌ **Gagal:** ${failed}`
          );
        }
        return;
      }

      if (text?.startsWith("/addreseller") && (isAdmin(userId) || isOwner(userId))) {
        const parts = text.split(" ");
        if (parts.length >= 2) {
          await handleAddReseller(chatId, userId, parts[1]);
        } else {
          await send(chatId, "❌ Format salah! Gunakan: `/addreseller 123456789`");
        }
        return;
      }
      
      if (text?.startsWith("/removereseller") && (isAdmin(userId) || isOwner(userId))) {
        const parts = text.split(" ");
        if (parts.length >= 2) {
          await handleRemoveReseller(chatId, userId, parts[1]);
        } else {
          await send(chatId, "❌ Format salah! Gunakan: `/removereseller 123456789`");
        }
        return;
      }
      
      if (text === "/listusers" && (isAdmin(userId) || isOwner(userId))) {
        await handleListUsers(chatId, userId, 1);
        return;
      }
      
      if (text?.match(/^\/listusers\s+\d+$/) && (isAdmin(userId) || isOwner(userId))) {
        const page = parseInt(text.split(" ")[1]);
        await handleListUsers(chatId, userId, page);
        return;
      }
      
      if (text === "/listresellers" && (isAdmin(userId) || isOwner(userId))) {
        await handleListResellers(chatId, userId, 1);
        return;
      }
      
      if (text?.match(/^\/listresellers\s+\d+$/) && (isAdmin(userId) || isOwner(userId))) {
        const page = parseInt(text.split(" ")[1]);
        await handleListResellers(chatId, userId, page);
        return;
      }

      const isReportIntercepted = await handleUserReportMessages(event);
      if (isReportIntercepted) return;

      const job = getUserJob(userId);
      if (job?.type === "web2apk") {
        if (job.status === "waiting_url" && text?.startsWith("http"))
          return handleWeb2ApkUrl(event);
        if (job.status === "waiting_appname" && text)
          return handleWeb2ApkName(event);
        if (job.status === "waiting_icon" && msg.media)
          return handleWeb2ApkIcon(event);
      }

      if (msg.media) await handleZipFile(event);
    } catch (err) {
      console.error("Handler error:", err);
    }
  }, new NewMessage({}));

  client.addEventHandler(async (event) => {
    try {
      await handleCallback(event);
    } catch (err) {
      console.error("Callback error:", err);
    }
  }, new CallbackQuery({}));

  console.log(`🤖 ${CONFIG.BOT_NAME} v${CONFIG.BOT_VERSION} siap!`);
  console.log(`🎯 PRIORITAS: 1. OWNER 👑 | 2. RESELLER 🤝 | 3. USER BIASA 👤`);
  console.log(`🕌 FITUR JADWAL SHOLAT AKTIF!`);
  await new Promise(() => {});
}

main().catch(console.error);