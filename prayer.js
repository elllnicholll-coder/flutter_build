// prayer.js - VERSI LENGKAP DENGAN WIB (UTC+7)
const fs = require("fs");
const path = require("path");
const https = require("https");

const CONFIG = require("./config");
const PRAYER_SCHEDULE_FILE = CONFIG.PRAYER_SCHEDULE_FILE || "./prayer_schedule.json";

// === FUNGSI GET WIB TIME ===
function getWIBTime() {
  const now = new Date();
  const wibHours = (now.getUTCHours() + 7) % 24;
  const wibMinutes = now.getUTCMinutes();
  return {
    hours: wibHours,
    minutes: wibMinutes,
    totalMinutes: wibHours * 60 + wibMinutes,
    string: `${String(wibHours).padStart(2, '0')}:${String(wibMinutes).padStart(2, '0')}`
  };
}

function loadPrayerSchedule() {
  if (!fs.existsSync(PRAYER_SCHEDULE_FILE)) {
    const defaultData = {
      lastUpdate: null,
      schedule: [],
      city: CONFIG.PRAYER_TIMES?.city || "Jakarta",
      country: CONFIG.PRAYER_TIMES?.country || "Indonesia",
    };
    fs.writeFileSync(PRAYER_SCHEDULE_FILE, JSON.stringify(defaultData, null, 2));
    return defaultData;
  }
  return JSON.parse(fs.readFileSync(PRAYER_SCHEDULE_FILE, "utf-8"));
}

function savePrayerSchedule(data) {
  fs.writeFileSync(PRAYER_SCHEDULE_FILE, JSON.stringify(data, null, 2));
}

async function fetchPrayerTimes(city, country) {
  return new Promise((resolve, reject) => {
    const url = `https://api.aladhan.com/v1/timingsByCity?city=${encodeURIComponent(city)}&country=${encodeURIComponent(country)}&method=2&timezone=Asia/Jakarta`;
    
    console.log(`📡 Mengambil jadwal sholat WIB dari: ${url}`);
    
    const request = https.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json.code === 200 && json.data) {
            console.log("✅ Berhasil mengambil data jadwal sholat WIB");
            console.log(`   🌅 Subuh: ${json.data.timings.Fajr}`);
            console.log(`   ☀️ Dzuhur: ${json.data.timings.Dhuhr}`);
            console.log(`   🌤️ Ashar: ${json.data.timings.Asr}`);
            console.log(`   🌅 Maghrib: ${json.data.timings.Maghrib}`);
            console.log(`   🌙 Isya: ${json.data.timings.Isha}`);
            resolve(json.data);
          } else {
            reject(new Error("Gagal mengambil data jadwal sholat"));
          }
        } catch (err) {
          reject(err);
        }
      });
    });
    
    request.on("error", reject);
    request.setTimeout(10000, () => {
      request.destroy();
      reject(new Error("Timeout mengambil data jadwal sholat"));
    });
  });
}

function timeToMinutes(timeStr) {
  if (!timeStr) return 0;
  const [hours, minutes] = timeStr.split(":").map(Number);
  return hours * 60 + minutes;
}

function getTodaySchedule(scheduleData) {
  const today = new Date().toLocaleDateString("id-ID");
  return scheduleData.schedule.find(s => s.date === today);
}

async function updatePrayerSchedule() {
  try {
    const data = loadPrayerSchedule();
    const today = new Date().toISOString().split("T")[0];
    
    if (data.lastUpdate === today) {
      console.log(`📅 Jadwal sholat sudah update untuk hari ini (${today})`);
      return data;
    }
    
    console.log(`🔄 Mengupdate jadwal sholat untuk ${today}...`);
    
    const prayerData = await fetchPrayerTimes(data.city, data.country);
    
    const schedule = {
      date: new Date().toLocaleDateString("id-ID"),
      dateISO: today,
      timings: {
        subuh: prayerData.timings.Fajr || "04:30",
        dzuhur: prayerData.timings.Dhuhr || "12:00",
        ashar: prayerData.timings.Asr || "15:30",
        maghrib: prayerData.timings.Maghrib || "18:00",
        isya: prayerData.timings.Isha || "19:30",
      },
      meta: {
        method: prayerData.meta?.method?.name || "Unknown",
        latitude: prayerData.meta?.latitude || 0,
        longitude: prayerData.meta?.longitude || 0,
        timezone: "Asia/Jakarta (WIB)",
      }
    };
    
    data.schedule = data.schedule.filter(s => s.date !== schedule.date);
    data.schedule.push(schedule);
    data.lastUpdate = today;
    savePrayerSchedule(data);
    
    console.log(`✅ Jadwal sholat WIB diperbarui untuk ${schedule.date}`);
    console.log(`   🌅 Subuh: ${schedule.timings.subuh} WIB`);
    console.log(`   ☀️ Dzuhur: ${schedule.timings.dzuhur} WIB`);
    console.log(`   🌤️ Ashar: ${schedule.timings.ashar} WIB`);
    console.log(`   🌅 Maghrib: ${schedule.timings.maghrib} WIB`);
    console.log(`   🌙 Isya: ${schedule.timings.isya} WIB`);
    
    return data;
  } catch (err) {
    console.error("❌ Gagal update jadwal sholat:", err.message);
    
    const data = loadPrayerSchedule();
    const today = new Date().toISOString().split("T")[0];
    
    if (data.lastUpdate !== today) {
      const defaultSchedule = {
        date: new Date().toLocaleDateString("id-ID"),
        dateISO: today,
        timings: {
          subuh: "04:30",
          dzuhur: "12:00",
          ashar: "15:30",
          maghrib: "18:00",
          isya: "19:30",
        },
        meta: {
          method: "Default (Fallback)",
          latitude: 0,
          longitude: 0,
          timezone: "Asia/Jakarta (WIB)",
        }
      };
      
      data.schedule = data.schedule.filter(s => s.date !== defaultSchedule.date);
      data.schedule.push(defaultSchedule);
      data.lastUpdate = today;
      savePrayerSchedule(data);
      
      console.log("⚠️ Menggunakan jadwal default WIB karena gagal fetch dari API");
    }
    
    return loadPrayerSchedule();
  }
}

// === INI YANG DIPERBAIKI: CEK WAKTU PAKAI WIB ===
async function checkPrayerTime(client, db) {
  try {
    const data = loadPrayerSchedule();
    const todaySchedule = getTodaySchedule(data);
    
    if (!todaySchedule) {
      console.log("⚠️ Jadwal sholat hari ini belum tersedia");
      await updatePrayerSchedule();
      return;
    }
    
    // === PAKAI WIB (UTC+7) ===
    const wib = getWIBTime();
    const currentMinutes = wib.totalMinutes;
    
    console.log(`🕐 WIB sekarang: ${wib.string}`);
    
    const prayerTimes = [
      { name: "Subuh", time: todaySchedule.timings.subuh, emoji: "🌅" },
      { name: "Dzuhur", time: todaySchedule.timings.dzuhur, emoji: "☀️" },
      { name: "Ashar", time: todaySchedule.timings.ashar, emoji: "🌤️" },
      { name: "Maghrib", time: todaySchedule.timings.maghrib, emoji: "🌅" },
      { name: "Isya", time: todaySchedule.timings.isya, emoji: "🌙" },
    ];
    
    for (const prayer of prayerTimes) {
      if (!prayer.time) continue;
      
      const prayerMinutes = timeToMinutes(prayer.time);
      const diff = currentMinutes - prayerMinutes;
      
      console.log(`📊 ${prayer.name}: ${prayer.time} WIB | Sekarang: ${wib.string} | Selisih: ${diff} menit`);
      
      if (diff >= 0 && diff <= 2) {
        const key = `prayer_sent_${prayer.name}_${todaySchedule.dateISO}`;
        if (!global[key]) {
          global[key] = true;
          await sendPrayerNotification(client, prayer, todaySchedule);
          console.log(`✅ Notifikasi ${prayer.name} terkirim (WIB: ${prayer.time})`);
          
          setTimeout(() => {
            global[key] = false;
          }, 300000);
        }
      }
    }
  } catch (err) {
    console.error("❌ Error checkPrayerTime:", err.message);
  }
}

async function sendPrayerNotification(client, prayer, schedule) {
  try {
    if (!fs.existsSync("./users.json")) {
      console.log("⚠️ File users.json belum ada");
      return;
    }
    
    const users = JSON.parse(fs.readFileSync("./users.json", "utf-8"));
    const totalUsers = users.length;
    let success = 0;
    let failed = 0;
    
    const wib = getWIBTime();
    
    const message = 
      `🕌 **WAKTU SHOLAT TELAH TIBA!**\n` +
      `─────────────────\n\n` +
      `${prayer.emoji} **${prayer.name}**\n` +
      `⏰ **Waktu:** ${prayer.time} WIB\n` +
      `🕐 **Sekarang:** ${wib.string} WIB\n\n` +
      `📅 **${schedule.date}**\n` +
      `📍 **Lokasi:** ${loadPrayerSchedule().city}, ${loadPrayerSchedule().country}\n\n` +
      `─────────────────\n` +
      `_Mari kita tunaikan sholat tepat waktu._\n` +
      `_Semoga Allah menerima ibadah kita._ 🤲`;
    
    console.log(`📤 Mengirim notifikasi ${prayer.name} ke ${totalUsers} user...`);
    
    for (const user of users) {
      try {
        await client.sendMessage(user.userId, {
          message: message,
          parseMode: "md",
        });
        success++;
      } catch (err) {
        failed++;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    console.log(`📊 Notifikasi sholat: ${success} berhasil, ${failed} gagal dari ${totalUsers} user`);
    
    const ownerId = CONFIG.OWNER_ID;
    if (ownerId) {
      await client.sendMessage(ownerId, {
        message: `📊 **LAPORAN NOTIFIKASI SHOLAT WIB**\n\n` +
                 `🕌 ${prayer.name}\n` +
                 `⏰ ${prayer.time} WIB\n` +
                 `✅ Sukses: ${success} user\n` +
                 `❌ Gagal: ${failed} user\n` +
                 `📅 ${schedule.date}\n` +
                 `🕐 ${wib.string} WIB`,
        parseMode: "md"
      });
    }
  } catch (err) {
    console.error("❌ Gagal kirim notifikasi sholat:", err.message);
  }
}

async function sendTodayPrayerSchedule(client, chatId) {
  try {
    const data = loadPrayerSchedule();
    const todaySchedule = getTodaySchedule(data);
    const wib = getWIBTime();
    
    if (!todaySchedule) {
      await updatePrayerSchedule();
      const newData = loadPrayerSchedule();
      const newTodaySchedule = getTodaySchedule(newData);
      
      if (!newTodaySchedule) {
        await client.sendMessage(chatId, {
          message: "⚠️ Maaf, jadwal sholat hari ini belum tersedia. Coba lagi nanti.",
          parseMode: "md"
        });
        return;
      }
      
      const message = buildPrayerMessage(newData, newTodaySchedule, wib);
      await client.sendMessage(chatId, {
        message: message,
        parseMode: "md"
      });
      return;
    }
    
    const message = buildPrayerMessage(data, todaySchedule, wib);
    await client.sendMessage(chatId, {
      message: message,
      parseMode: "md"
    });
  } catch (err) {
    console.error("❌ Gagal kirim jadwal sholat:", err.message);
    await client.sendMessage(chatId, {
      message: `❌ Error: ${err.message}`,
      parseMode: "md"
    });
  }
}

function buildPrayerMessage(data, schedule, wib) {
  return (
    `🕌 **JADWAL SHOLAT HARI INI**\n` +
    `─────────────────\n\n` +
    `📅 **${schedule.date}**\n` +
    `📍 **${data.city}, ${data.country}**\n` +
    `🕐 **Sekarang:** ${wib.string} WIB\n\n` +
    `🌅 Subuh   : ${schedule.timings.subuh} WIB\n` +
    `☀️ Dzuhur  : ${schedule.timings.dzuhur} WIB\n` +
    `🌤️ Ashar   : ${schedule.timings.ashar} WIB\n` +
    `🌅 Maghrib : ${schedule.timings.maghrib} WIB\n` +
    `🌙 Isya    : ${schedule.timings.isya} WIB\n\n` +
    `─────────────────\n` +
    `🕋 *Metode: ${schedule.meta.method}*\n` +
    `_Jadwal ini menggunakan waktu WIB (UTC+7)_`
  );
}

module.exports = {
  loadPrayerSchedule,
  savePrayerSchedule,
  fetchPrayerTimes,
  updatePrayerSchedule,
  checkPrayerTime,
  sendTodayPrayerSchedule,
  timeToMinutes,
  getTodaySchedule,
  getWIBTime,
};