require("dotenv").config();
const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");
const {
  initDatabase, all, one, run, transaction, saveDatabase, DB_PATH
} = require("./database");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === "production";

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  if (isProduction) {
    console.error("SESSION_SECRET wajib diisi dengan minimal 32 karakter saat production.");
    process.exit(1);
  }
  console.warn("PERINGATAN: SESSION_SECRET belum aman. Isi .env sebelum deployment.");
}

app.disable("x-powered-by");
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
      imgSrc: ["'self'", "data:"],
      scriptSrc: ["'self'"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"]
    }
  }
}));
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false, limit: "20kb" }));
app.use(session({
  name: "loewi.sid",
  secret: process.env.SESSION_SECRET || "dev-only-secret-change-this-before-deploy-32",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "strict",
    secure: isProduction,
    maxAge: 1000 * 60 * 60 * 8
  }
}));
app.use(express.static(path.join(__dirname, "public")));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Terlalu banyak percobaan login. Coba lagi dalam 15 menit." }
});

function requireAdmin(req, res, next) {
  if (!req.session.admin) return res.status(401).json({ error: "Login admin diperlukan." });
  next();
}
function requireCsrf(req, res, next) {
  const token = req.get("x-csrf-token");
  if (!token || !req.session.csrfToken || token !== req.session.csrfToken) {
    return res.status(403).json({ error: "Token keamanan tidak valid. Muat ulang halaman lalu coba lagi." });
  }
  next();
}
function audit(adminId, action, details = "") {
  run("INSERT INTO audit_logs (admin_id, action, details) VALUES (?, ?, ?)", [
    adminId || null, action, String(details).slice(0, 2000)
  ]);
}
function validText(value, max = 80) {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= max;
}
function validInteger(value) {
  return Number.isSafeInteger(value) && Math.abs(value) <= 1000000000;
}
function rankingQuery() {
  return `SELECT id, participant_number, name, level, points, created_at, updated_at
          FROM participants ORDER BY points DESC, name COLLATE NOCASE ASC, participant_number ASC`;
}
function csvCell(value) {
  const str = String(value ?? "");
  return '"' + str.replace(/"/g, '""') + '"';
}

app.get("/api/status", (req, res) => {
  res.json({ authenticated: Boolean(req.session.admin), admin: req.session.admin ? req.session.admin.username : null,
    csrfToken: req.session.csrfToken || null });
});

app.post("/api/login", loginLimiter, async (req, res) => {
  const username = typeof req.body.username === "string" ? req.body.username.trim() : "";
  const password = typeof req.body.password === "string" ? req.body.password : "";
  if (!username || !password || username.length > 100 || password.length > 200) {
    return res.status(400).json({ error: "Username dan password wajib diisi." });
  }
  const admin = one("SELECT id, username, password_hash FROM admins WHERE username = ?", [username]);
  const ok = admin ? await bcrypt.compare(password, admin.password_hash) : false;
  if (!ok) return res.status(401).json({ error: "Username atau password salah." });

  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: "Gagal membuat sesi login." });
    req.session.admin = { id: admin.id, username: admin.username };
    req.session.csrfToken = require("crypto").randomBytes(32).toString("hex");
    audit(admin.id, "LOGIN", "Admin login");
    req.session.save(saveErr => {
      if (saveErr) return res.status(500).json({ error: "Gagal menyimpan sesi login." });
      res.json({ ok: true, admin: req.session.admin, csrfToken: req.session.csrfToken });
    });
  });
});

app.post("/api/logout", requireAdmin, requireCsrf, (req, res) => {
  const adminId = req.session.admin.id;
  audit(adminId, "LOGOUT", "Admin logout");
  req.session.destroy(err => {
    if (err) return res.status(500).json({ error: "Gagal logout." });
    res.clearCookie("loewi.sid", { httpOnly: true, sameSite: "strict", secure: isProduction });
    res.json({ ok: true });
  });
});

app.get("/api/participants", (req, res) => {
  const search = typeof req.query.search === "string" ? req.query.search.trim().slice(0, 80) : "";
  const level = typeof req.query.level === "string" ? req.query.level.trim().slice(0, 30) : "";
  const page = Math.max(1, Math.min(100000, parseInt(req.query.page, 10) || 1));
  const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 100));
  let where = [];
  let params = [];
  if (search) {
    where.push("(name LIKE ? OR level LIKE ? OR CAST(participant_number AS TEXT) LIKE ?)");
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (level) { where.push("level = ?"); params.push(level); }
  const clause = where.length ? " WHERE " + where.join(" AND ") : "";
  const total = one("SELECT COUNT(*) AS total FROM participants" + clause, params).total;
  const rows = all(
    "SELECT id, participant_number, name, level, points, created_at, updated_at FROM participants" +
    clause + " ORDER BY points DESC, name COLLATE NOCASE ASC, participant_number ASC LIMIT ? OFFSET ?",
    [...params, limit, (page - 1) * limit]
  );
  res.json({ participants: rows.map((p, i) => ({ ...p, rank: (page - 1) * limit + i + 1 })),
    total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) });
});

app.get("/api/levels", (_req, res) => {
  res.json({ levels: all("SELECT DISTINCT level FROM participants ORDER BY level COLLATE NOCASE").map(x => x.level) });
});

app.get("/api/stats", (_req, res) => {
  const totals = one("SELECT COUNT(*) AS participants, COALESCE(MAX(points), 0) AS topPoints FROM participants");
  const levels = one("SELECT COUNT(DISTINCT level) AS levels FROM participants");
  res.json({ participants: totals.participants, topPoints: totals.topPoints, levels: levels.levels });
});

app.get("/api/history", requireAdmin, (req, res) => {
  const participantId = parseInt(req.query.participantId, 10);
  const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 100));
  const rows = Number.isInteger(participantId)
    ? all(`SELECT h.*, p.name AS participant_name, a.username AS admin_username
           FROM point_history h LEFT JOIN participants p ON p.id=h.participant_id
           LEFT JOIN admins a ON a.id=h.admin_id WHERE h.participant_id=?
           ORDER BY h.id DESC LIMIT ?`, [participantId, limit])
    : all(`SELECT h.*, p.name AS participant_name, a.username AS admin_username
           FROM point_history h LEFT JOIN participants p ON p.id=h.participant_id
           LEFT JOIN admins a ON a.id=h.admin_id ORDER BY h.id DESC LIMIT ?`, [limit]);
  res.json({ history: rows });
});

app.get("/api/audit", requireAdmin, (_req, res) => {
  res.json({ logs: all(`SELECT l.*, a.username FROM audit_logs l LEFT JOIN admins a ON a.id=l.admin_id
                        ORDER BY l.id DESC LIMIT 200`) });
});

app.post("/api/participants", requireAdmin, requireCsrf, (req, res) => {
  const { name, level } = req.body;
  const points = req.body.points === undefined ? 0 : Number(req.body.points);
  if (!validText(name, 80) || !validText(level, 30) || !validInteger(points)) {
    return res.status(400).json({ error: "Nama, level, atau poin tidak valid." });
  }
  const max = one("SELECT MAX(participant_number) AS n FROM participants");
  const number = (max && max.n ? max.n : 0) + 1;
  try {
    const result = transaction(() => {
      const inserted = run("INSERT INTO participants (participant_number, name, level, points) VALUES (?, ?, ?, ?)",
        [number, name.trim(), level.trim().toUpperCase(), points]);
      if (points !== 0) run(`INSERT INTO point_history (participant_id, admin_id, old_points, change_amount, new_points, description)
        VALUES (?, ?, 0, ?, ?, ?)`, [inserted.lastInsertRowid, req.session.admin.id, points, points, "Poin awal peserta"]);
      audit(req.session.admin.id, "CREATE_PARTICIPANT", `Peserta #${number}: ${name.trim()}, level ${level.trim()}, poin ${points}`);
      return { id: inserted.lastInsertRowid, participant_number: number };
    });
    res.status(201).json({ ok: true, participant: result });
  } catch (e) {
    res.status(400).json({ error: "Gagal menambah peserta. Pastikan data valid." });
  }
});

app.put("/api/participants/:id", requireAdmin, requireCsrf, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: "ID peserta tidak valid." });
  const participant = one("SELECT * FROM participants WHERE id=?", [id]);
  if (!participant) return res.status(404).json({ error: "Peserta tidak ditemukan." });
  const name = req.body.name === undefined ? participant.name : req.body.name;
  const level = req.body.level === undefined ? participant.level : req.body.level;
  if (!validText(name, 80) || !validText(level, 30)) return res.status(400).json({ error: "Nama atau level tidak valid." });
  transaction(() => {
    run("UPDATE participants SET name=?, level=?, updated_at=datetime('now') WHERE id=?",
      [name.trim(), level.trim().toUpperCase(), id]);
    audit(req.session.admin.id, "UPDATE_PARTICIPANT", `ID ${id}: nama=${name.trim()}, level=${level.trim().toUpperCase()}`);
  });
  res.json({ ok: true });
});

app.patch("/api/participants/:id/points", requireAdmin, requireCsrf, (req, res) => {
  const id = Number(req.params.id);
  const participant = one("SELECT * FROM participants WHERE id=?", [id]);
  if (!participant) return res.status(404).json({ error: "Peserta tidak ditemukan." });
  const mode = req.body.mode;
  const value = Number(req.body.value);
  const description = typeof req.body.description === "string" ? req.body.description.trim().slice(0, 200) : "";
  if (!validInteger(value) || !["set", "add"].includes(mode)) return res.status(400).json({ error: "Mode atau nilai poin tidak valid." });
  const newPoints = mode === "set" ? value : participant.points + value;
  if (!validInteger(newPoints)) return res.status(400).json({ error: "Total poin di luar batas yang diizinkan." });
  transaction(() => {
    run("UPDATE participants SET points=?, updated_at=datetime('now') WHERE id=?", [newPoints, id]);
    run(`INSERT INTO point_history (participant_id, admin_id, old_points, change_amount, new_points, description)
      VALUES (?, ?, ?, ?, ?, ?)`,
      [id, req.session.admin.id, participant.points, newPoints - participant.points, newPoints,
       description || (mode === "set" ? "Atur total poin" : "Perubahan poin")]);
    audit(req.session.admin.id, "UPDATE_POINTS", `ID ${id}: ${participant.points} -> ${newPoints}; ${description}`);
  });
  res.json({ ok: true, oldPoints: participant.points, newPoints, change: newPoints - participant.points });
});

app.delete("/api/participants/:id", requireAdmin, requireCsrf, (req, res) => {
  const id = Number(req.params.id);
  const participant = one("SELECT * FROM participants WHERE id=?", [id]);
  if (!participant) return res.status(404).json({ error: "Peserta tidak ditemukan." });
  transaction(() => {
    audit(req.session.admin.id, "DELETE_PARTICIPANT", `ID ${id}: ${participant.name} (${participant.level}), poin ${participant.points}`);
    run("DELETE FROM participants WHERE id=?", [id]);
  });
  res.json({ ok: true });
});

app.get("/api/export.csv", requireAdmin, (_req, res) => {
  const rows = all(rankingQuery());
  const lines = [
    ["Ranking", "No Peserta", "Nama", "Level", "Poin"].map(csvCell).join(","),
    ...rows.map((p, i) => [i + 1, p.participant_number, p.name, p.level, p.points].map(csvCell).join(","))
  ];
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="loewi-race7-ranking.csv"');
  res.send("\uFEFF" + lines.join("\r\n"));
});

app.get("/api/export.pdf", requireAdmin, (_req, res) => {
  const rows = all(rankingQuery());
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", 'attachment; filename="loewi-race7-ranking.pdf"');
  const doc = new PDFDocument({ size: "A4", margin: 42 });
  doc.pipe(res);
  doc.rect(0, 0, doc.page.width, 120).fill("#111111");
  doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(25).text("LOEWI ", 42, 34, { continued: true });
  doc.fillColor("#d6f20a").text("RACE 7");
  doc.fillColor("#b8b8b8").font("Helvetica").fontSize(10).text("LEADERBOARD • LAPORAN RANKING", 42, 72);
  doc.fillColor("#222222").font("Helvetica-Bold").fontSize(10);
  let y = 145;
  const xs = [42, 95, 240, 360, 475];
  ["RANK", "NO", "NAMA", "LEVEL", "POIN"].forEach((h, i) => doc.text(h, xs[i], y, { width: i === 2 ? 110 : 65 }));
  y += 24;
  rows.forEach((p, i) => {
    if (y > 760) { doc.addPage(); y = 50; }
    if (i % 2 === 0) doc.rect(40, y - 5, 515, 24).fill("#f2f2f2");
    doc.fillColor("#222222").font("Helvetica").fontSize(10);
    [i + 1, p.participant_number, p.name, p.level, p.points].forEach((v, j) => doc.text(String(v), xs[j], y, { width: j === 2 ? 110 : 65 }));
    y += 24;
  });
  doc.end();
});

app.get("/api/backup", requireAdmin, (_req, res) => {
  saveDatabase();
  res.download(DB_PATH, "loewi-race7-backup.db");
});

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Endpoint tidak ditemukan." });
  res.sendFile(path.join(__dirname, "public", "index.html"), err => err && next(err));
});

(async () => {
  await initDatabase();
  // Seed only if the database is empty or admin has not been configured.
  const { one: dbOne, run: dbRun } = require("./database");
  if (!dbOne("SELECT id FROM admins LIMIT 1")) {
    const username = (process.env.ADMIN_USERNAME || "admin").trim();
    const password = process.env.ADMIN_PASSWORD || "ChangeMe-Immediately-123!";
    const hash = await bcrypt.hash(password, 12);
    dbRun("INSERT INTO admins (username, password_hash) VALUES (?, ?)", [username, hash]);
    saveDatabase();
    console.warn(`Admin awal: ${username}. Ganti password awal di .env sebelum online.`);
  }
  if (!dbOne("SELECT id FROM participants LIMIT 1")) {
    const seed = require("./seed-data");
    transaction(() => seed.forEach(p => dbRun(
      "INSERT INTO participants (participant_number, name, level, points) VALUES (?, ?, ?, ?)", p
    )));
  }
  app.listen(PORT, "0.0.0.0", () => console.log(`LOEWI RACE 7 berjalan di http://localhost:${PORT}`));
})().catch(err => { console.error("Gagal memulai aplikasi:", err); process.exit(1); });
