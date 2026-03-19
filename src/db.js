const sqlite3 = require("sqlite3").verbose();
const bcrypt = require("bcryptjs");

const db = new sqlite3.Database("database.sqlite");

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) {
        reject(err);
        return;
      }
      resolve(this);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(rows);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(row);
    });
  });
}

async function initDb() {
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT,
      is_approved INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS zones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      polygon_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS duties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL,
      zone_id INTEGER NOT NULL,
      duty_date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(employee_id) REFERENCES users(id),
      FOREIGN KEY(zone_id) REFERENCES zones(id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS duty_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      duty_id INTEGER NOT NULL,
      employee_id INTEGER NOT NULL,
      observed_at TEXT NOT NULL,
      car_brand TEXT NOT NULL,
      plate_number TEXT NOT NULL,
      speed REAL NOT NULL,
      is_overtake INTEGER NOT NULL CHECK(is_overtake IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(duty_id) REFERENCES duties(id),
      FOREIGN KEY(employee_id) REFERENCES users(id)
    )
  `);

  const manager = await get("SELECT id FROM users WHERE username = ?", ["manager"]);
  if (!manager) {
    const passwordHash = await bcrypt.hash("12345", 10);
    await run(
      "INSERT INTO users (username, password_hash, role, is_approved) VALUES (?, ?, ?, ?)",
      ["manager", passwordHash, "manager", 1]
    );
  }
}

module.exports = {
  db,
  run,
  all,
  get,
  initDb
};
