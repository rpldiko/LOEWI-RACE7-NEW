```js
require("dotenv").config();

const express = require("express");
const session = require("express-session");
const SQLiteStoreFactory = require("connect-sqlite3");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const PDFDocument = require("pdfkit");
const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === "production";

app.set("trust proxy", 1);
app.disable("x-powered-by");

if (
  isProduction &&
  (!process.env.SESSION_SECRET ||
    process.env.SESSION_SECRET.length < 32)
) {
  console.error("SESSION_SECRET minimal 32 karakter.");
  process.exit(1);
}

const sessionSecret =
  process.env.SESSION_SECRET ||
  "local-development-secret-change-before-deploy-32";

const DB_PATH = process.env.DB_PATH || "./data/loewi.db";

fs.mkdirSync(path.dirname(path.resolve(DB_PATH)), {
  recursive: true
});

const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS participants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  participant_number INTEGER NOT NULL UNIQUE,
  name TEXT NOT NULL,
  level TEXT NOT NULL,
  points INTEGER NOT NULL DEFAULT 0 CHECK(points >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS point_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  participant_id INTEGER,
  admin_id INTEGER,
  old_points INTEGER NOT NULL,
  change_amount INTEGER NOT NULL,
  new_points INTEGER NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(participant_id)
    REFERENCES participants(id) ON DELETE SET NULL,
  FOREIGN KEY(admin_id)
    REFERENCES admins(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER,
  action TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(admin_id)
    REFERENCES admins(id) ON DELETE SET NULL
);
`);

const all = (sql, params = []) =>
  db.prepare(sql).all(params);

const one = (sql, params = []) =>
  db.prepare(sql).get(params);

const run = (sql, params = []) =>
  db.prepare(sql).run(params);

function transaction(fn) {
  return db.transaction(fn)();
}

function audit(adminId, action, details = "") {
  run(
    `INSERT INTO audit_logs (admin_id, action, details)
     VALUES (?, ?, ?)`,
    [adminId || null, action, String(details).slice(0, 2000)]
  );
}

function requireAdmin(req, res, next) {
  if (!req.session.admin) {
    return res.status(401).json({
      error: "Login admin diperlukan."
    });
  }

  next();
}

function requireCsrf(req, res, next) {
  const token = req.get("x-csrf-token");

  if (
    !token ||
    !req.session.csrfToken ||
    token !== req.session.csrfToken
  ) {
    return res.status(403).json({
      error: "Token keamanan tidak valid. Login kembali."
    });
  }

  next();
}

function validText(value, max = 80) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= max
  );
}

function validInteger(value) {
  return (
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 1000000000
  );
}

function rankingQuery() {
  return `
    SELECT id, participant_number, name, level,
           points, created_at, updated_at
    FROM participants
    ORDER BY points DESC,
             name COLLATE NOCASE ASC,
             participant_number ASC
  `;
}

function csvCell(value) {
  return '"' + String(value ?? "").replace(/"/g, '""') + '"';
}

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      fontSrc: ["'self'", "data:"],
      imgSrc: ["'self'", "data:"],
      scriptSrc: ["'self'"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"]
    }
  }
}));

app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({
  extended: false,
  limit: "20kb"
}));

const SQLiteStore = SQLiteStoreFactory(session);

app.use(session({
  name: "loewi.sid",
  secret: sessionSecret,
  store: new SQLiteStore({
    db: "sessions.sqlite",
    dir: path.dirname(path.resolve(DB_PATH))
  }),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction,
    maxAge: 8 * 60 * 60 * 1000
  }
}));

app.use(express.static(path.join(__dirname, "public")));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Terlalu banyak percobaan login. Coba lagi dalam 15 menit."
  }
});
```
```js
// STATUS LOGIN
app.get("/api/status", (req, res) => {
  res.json({
    authenticated: Boolean(req.session.admin),
    admin: req.session.admin?.username || null,
    csrfToken: req.session.csrfToken || null
  });
});

// LOGIN ADMIN
app.post("/api/login", loginLimiter, async (req, res) => {
  const username =
    typeof req.body.username === "string"
      ? req.body.username.trim()
      : "";

  const password =
    typeof req.body.password === "string"
      ? req.body.password
      : "";

  if (!username || !password) {
    return res.status(400).json({
      error: "Username dan password wajib diisi."
    });
  }

  const admin = one(
    "SELECT id, username, password_hash FROM admins WHERE username = ?",
    [username]
  );

  if (!admin || !(await bcrypt.compare(password, admin.password_hash))) {
    return res.status(401).json({
      error: "Username atau password salah."
    });
  }

  req.session.regenerate((err) => {
    if (err) {
      return res.status(500).json({
        error: "Gagal membuat sesi login."
      });
    }

    req.session.admin = {
      id: admin.id,
      username: admin.username
    };

    req.session.csrfToken = crypto
      .randomBytes(32)
      .toString("hex");

    audit(admin.id, "LOGIN", "Admin login");

    req.session.save((saveErr) => {
      if (saveErr) {
        return res.status(500).json({
          error: "Gagal menyimpan sesi login."
        });
      }

      res.json({
        ok: true,
        admin: req.session.admin,
        csrfToken: req.session.csrfToken
      });
    });
  });
});

// LOGOUT ADMIN
app.post("/api/logout", requireAdmin, requireCsrf, (req, res) => {
  const adminId = req.session.admin.id;

  audit(adminId, "LOGOUT", "Admin logout");

  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({
        error: "Gagal logout."
      });
    }

    res.clearCookie("loewi.sid", {
      httpOnly: true,
      sameSite: "lax",
      secure: isProduction
    });

    res.json({ ok: true });
  });
});

// DAFTAR PESERTA DAN PENCARIAN
app.get("/api/participants", (req, res) => {
  const search =
    typeof req.query.search === "string"
      ? req.query.search.trim().slice(0, 80)
      : "";

  const level =
    typeof req.query.level === "string"
      ? req.query.level.trim().slice(0, 30)
      : "";

  const page = Math.max(
    1,
    parseInt(req.query.page, 10) || 1
  );

  const limit = Math.max(
    1,
    Math.min(100, parseInt(req.query.limit, 10) || 100)
  );

  const where = [];
  const params = [];

  if (search) {
    where.push(
      "(name LIKE ? OR level LIKE ? OR CAST(participant_number AS TEXT) LIKE ?)"
    );

    params.push(
      `%${search}%`,
      `%${search}%`,
      `%${search}%`
    );
  }

  if (level) {
    where.push("level = ?");
    params.push(level);
  }

  const clause = where.length
    ? " WHERE " + where.join(" AND ")
    : "";

  const total = one(
    "SELECT COUNT(*) AS total FROM participants" + clause,
    params
  ).total;

  const participants = all(
    `SELECT id, participant_number, name, level, points,
            created_at, updated_at
     FROM participants
     ${clause}
     ORDER BY points DESC, name COLLATE NOCASE ASC,
              participant_number ASC
     LIMIT ? OFFSET ?`,
    [...params, limit, (page - 1) * limit]
  );

  res.json({
    participants: participants.map((p, i) => ({
      ...p,
      rank: (page - 1) * limit + i + 1
    })),
    total,
    page,
    limit,
    pages: Math.max(1, Math.ceil(total / limit))
  });
});

// LEVEL PESERTA
app.get("/api/levels", (_req, res) => {
  const levels = all(
    "SELECT DISTINCT level FROM participants ORDER BY level COLLATE NOCASE"
  );

  res.json({
    levels: levels.map(item => item.level)
  });
});

// STATISTIK RANKING
app.get("/api/stats", (_req, res) => {
  const totals = one(`
    SELECT COUNT(*) AS participants,
           COALESCE(MAX(points), 0) AS topPoints
    FROM participants
  `);

  const levels = one(`
    SELECT COUNT(DISTINCT level) AS levels
    FROM participants
  `);

  res.json({
    participants: totals.participants,
    topPoints: totals.topPoints,
    levels: levels.levels
  });
});

// RIWAYAT PERUBAHAN POIN
app.get("/api/history", requireAdmin, (req, res) => {
  const participantId = parseInt(req.query.participantId, 10);
  const limit = Math.max(
    1,
    Math.min(200, parseInt(req.query.limit, 10) || 100)
  );

  let sql = `
    SELECT h.*, p.name AS participant_name,
           a.username AS admin_username
    FROM point_history h
    LEFT JOIN participants p ON p.id = h.participant_id
    LEFT JOIN admins a ON a.id = h.admin_id
  `;

  let params = [];

  if (Number.isInteger(participantId)) {
    sql += " WHERE h.participant_id = ?";
    params.push(participantId);
  }

  sql += " ORDER BY h.id DESC LIMIT ?";
  params.push(limit);

  res.json({
    history: all(sql, params)
  });
});

// AUDIT LOG ADMIN
app.get("/api/audit", requireAdmin, (_req, res) => {
  res.json({
    logs: all(`
      SELECT l.*, a.username
      FROM audit_logs l
      LEFT JOIN admins a ON a.id = l.admin_id
      ORDER BY l.id DESC
      LIMIT 200
    `)
  });
});
```
```js
// TAMBAH PESERTA
app.post(
  "/api/participants",
  requireAdmin,
  requireCsrf,
  (req, res) => {
    const { name, level } = req.body;
    const points =
      req.body.points === undefined ? 0 : Number(req.body.points);

    if (
      !validText(name, 80) ||
      !validText(level, 30) ||
      !validInteger(points)
    ) {
      return res.status(400).json({
        error: "Nama, level, atau poin tidak valid."
      });
    }

    const max = one(
      "SELECT MAX(participant_number) AS n FROM participants"
    );

    const number = (max?.n || 0) + 1;

    try {
      const result = transaction(() => {
        const inserted = run(
          `INSERT INTO participants
           (participant_number, name, level, points)
           VALUES (?, ?, ?, ?)`,
          [number, name.trim(), level.trim().toUpperCase(), points]
        );

        if (points !== 0) {
          run(
            `INSERT INTO point_history
             (participant_id, admin_id, old_points,
              change_amount, new_points, description)
             VALUES (?, ?, 0, ?, ?, ?)`,
            [
              inserted.lastInsertRowid,
              req.session.admin.id,
              points,
              points,
              "Poin awal peserta"
            ]
          );
        }

        audit(
          req.session.admin.id,
          "CREATE_PARTICIPANT",
          `Peserta #${number}: ${name.trim()}`
        );

        return {
          id: inserted.lastInsertRowid,
          participant_number: number
        };
      });

      res.status(201).json({
        ok: true,
        participant: result
      });
    } catch (err) {
      console.error(err);
      res.status(400).json({
        error: "Gagal menambah peserta."
      });
    }
  }
);

// EDIT NAMA DAN LEVEL PESERTA
app.put(
  "/api/participants/:id",
  requireAdmin,
  requireCsrf,
  (req, res) => {
    const id = Number(req.params.id);

    if (!Number.isSafeInteger(id) || id < 1) {
      return res.status(400).json({
        error: "ID peserta tidak valid."
      });
    }

    const participant = one(
      "SELECT * FROM participants WHERE id = ?",
      [id]
    );

    if (!participant) {
      return res.status(404).json({
        error: "Peserta tidak ditemukan."
      });
    }

    const name =
      req.body.name === undefined
        ? participant.name
        : req.body.name;

    const level =
      req.body.level === undefined
        ? participant.level
        : req.body.level;

    if (!validText(name, 80) || !validText(level, 30)) {
      return res.status(400).json({
        error: "Nama atau level tidak valid."
      });
    }

    transaction(() => {
      run(
        `UPDATE participants
         SET name = ?, level = ?, updated_at = datetime('now')
         WHERE id = ?`,
        [name.trim(), level.trim().toUpperCase(), id]
      );

      audit(
        req.session.admin.id,
        "UPDATE_PARTICIPANT",
        `ID ${id}: ${name.trim()}, ${level.trim()}`
      );
    });

    res.json({ ok: true });
  }
);

// TAMBAH ATAU ATUR TOTAL POIN
app.patch(
  "/api/participants/:id/points",
  requireAdmin,
  requireCsrf,
  (req, res) => {
    const id = Number(req.params.id);

    const participant = one(
      "SELECT * FROM participants WHERE id = ?",
      [id]
    );

    if (!participant) {
      return res.status(404).json({
        error: "Peserta tidak ditemukan."
      });
    }

    const { mode } = req.body;
    const value = Number(req.body.value);
    const description =
      typeof req.body.description === "string"
        ? req.body.description.trim().slice(0, 200)
        : "";

    if (
      !Number.isSafeInteger(value) ||
      Math.abs(value) > 1000000000 ||
      !["set", "add"].includes(mode)
    ) {
      return res.status(400).json({
        error: "Mode atau nilai poin tidak valid."
      });
    }

    const newPoints =
      mode === "set"
        ? value
        : participant.points + value;

    if (!validInteger(newPoints)) {
      return res.status(400).json({
        error: "Total poin harus antara 0 sampai 1 miliar."
      });
    }

    transaction(() => {
      run(
        `UPDATE participants
         SET points = ?, updated_at = datetime('now')
         WHERE id = ?`,
        [newPoints, id]
      );

      run(
        `INSERT INTO point_history
         (participant_id, admin_id, old_points,
          change_amount, new_points, description)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          id,
          req.session.admin.id,
          participant.points,
          newPoints - participant.points,
          newPoints,
          description || "Perubahan poin"
        ]
      );

      audit(
        req.session.admin.id,
        "UPDATE_POINTS",
        `ID ${id}: ${participant.points} -> ${newPoints}`
      );
    });

    res.json({
      ok: true,
      oldPoints: participant.points,
      newPoints,
      change: newPoints - participant.points
    });
  }
);

// HAPUS PESERTA
app.delete(
  "/api/participants/:id",
  requireAdmin,
  requireCsrf,
  (req, res) => {
    const id = Number(req.params.id);

    const participant = one(
      "SELECT * FROM participants WHERE id = ?",
      [id]
    );

    if (!participant) {
      return res.status(404).json({
        error: "Peserta tidak ditemukan."
      });
    }

    transaction(() => {
      audit(
        req.session.admin.id,
        "DELETE_PARTICIPANT",
        `ID ${id}: ${participant.name}`
      );

      run(
        "DELETE FROM participants WHERE id = ?",
        [id]
      );
    });

    res.json({ ok: true });
  }
);

// EXPORT CSV
app.get("/api/export.csv", requireAdmin, (_req, res) => {
  const rows = all(rankingQuery());

  const lines = [
    ["Ranking", "No Peserta", "Nama", "Level", "Poin"]
      .map(csvCell)
      .join(","),
    ...rows.map((p, i) =>
      [
        i + 1,
        p.participant_number,
        p.name,
        p.level,
        p.points
      ].map(csvCell).join(",")
    )
  ];

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="loewi-race7-ranking.csv"'
  );

  res.send("\uFEFF" + lines.join("\r\n"));
});

// EXPORT PDF
app.get("/api/export.pdf", requireAdmin, (_req, res) => {
  const rows = all(rankingQuery());

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="loewi-race7-ranking.pdf"'
  );

  const doc = new PDFDocument({
    size: "A4",
    margin: 42
  });

  doc.pipe(res);

  doc.rect(0, 0, doc.page.width, 120).fill("#111111");

  doc.fillColor("#ffffff")
    .font("Helvetica-Bold")
    .fontSize(25)
    .text("LOEWI RACE 7", 42, 34);

  doc.fillColor("#bbbbbb")
    .font("Helvetica")
    .fontSize(10)
    .text("LEADERBOARD - LAPORAN RANKING", 42, 72);

  let y = 145;
  const xs = [42, 95, 240, 360, 475];
  const headers = ["RANK", "NO", "NAMA", "LEVEL", "POIN"];

  doc.fillColor("#222222")
    .font("Helvetica-Bold")
    .fontSize(10);

  headers.forEach((h, i) => {
    doc.text(h, xs[i], y, {
      width: i === 2 ? 110 : 65
    });
  });

  y += 24;

  rows.forEach((p, i) => {
    if (y > 760) {
      doc.addPage();
      y = 50;
    }

    if (i % 2 === 0) {
      doc.rect(40, y - 5, 515, 24).fill("#f2f2f2");
    }

    doc.fillColor("#222222")
      .font("Helvetica")
      .fontSize(10);

    [
      i + 1,
      p.participant_number,
      p.name,
      p.level,
      p.points
    ].forEach((value, j) => {
      doc.text(String(value), xs[j], y, {
        width: j === 2 ? 110 : 65
      });
    });

    y += 24;
  });

  doc.end();
});

// BACKUP DATABASE
app.get("/api/backup", requireAdmin, (_req, res) => {
  db.pragma("wal_checkpoint(FULL)");

  res.download(
    DB_PATH,
    "loewi-race7-backup.db"
  );
});

// HALAMAN WEBSITE
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({
      error: "Endpoint tidak ditemukan."
    });
  }

  res.sendFile(
    path.join(__dirname, "public", "index.html"),
    err => {
      if (err) next(err);
    }
  );
});

// BUAT ADMIN DAN JALANKAN SERVER
(async () => {
  const existingAdmin = one(
    "SELECT id FROM admins LIMIT 1"
  );

  if (!existingAdmin) {
    const username = (
      process.env.ADMIN_USERNAME || "admin"
    ).trim();

    const password = process.env.ADMIN_PASSWORD;

    if (!password) {
      throw new Error(
        "Isi ADMIN_USERNAME dan ADMIN_PASSWORD di Railway Variables."
      );
    }

    run(
      "INSERT INTO admins (username, password_hash) VALUES (?, ?)",
      [username, await bcrypt.hash(password, 12)]
    );

    console.log("Admin awal berhasil dibuat.");
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`LOEWI RACE 7 berjalan pada port ${PORT}`);
  });
})().catch(err => {
  console.error("Gagal memulai aplikasi:", err);
  process.exit(1);
});
```
