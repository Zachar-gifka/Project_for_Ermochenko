const express = require("express");
const bcrypt = require("bcryptjs");
const path = require("path");
const { all, get, run, initDb } = require("./db");
const { authMiddleware, generateToken, requireRole } = require("./auth");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

function toIsoDate(dateString) {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.post("/auth/register", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      res.status(400).json({ error: "username and password are required" });
      return;
    }

    const existing = await get("SELECT id FROM users WHERE username = ?", [username]);
    if (existing) {
      res.status(409).json({ error: "User already exists" });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 10);
    await run(
      "INSERT INTO users (username, password_hash, role, is_approved) VALUES (?, ?, ?, ?)",
      [username, passwordHash, null, 0]
    );

    res.status(201).json({
      message: "User registered. Waiting for manager approval."
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/auth/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      res.status(400).json({ error: "username and password are required" });
      return;
    }

    const user = await get(
      "SELECT id, username, password_hash, role, is_approved FROM users WHERE username = ?",
      [username]
    );
    if (!user) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }

    if (!user.is_approved && user.role !== "manager") {
      res.status(403).json({ error: "User is not approved by manager yet" });
      return;
    }

    const token = generateToken(user);
    res.json({
      token,
      user: { id: user.id, username: user.username, role: user.role }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/manager/pending-users", authMiddleware, requireRole("manager"), async (req, res) => {
  try {
    const users = await all(
      "SELECT id, username, created_at FROM users WHERE is_approved = 0 ORDER BY created_at ASC"
    );
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/manager/employees", authMiddleware, requireRole("manager"), async (req, res) => {
  try {
    const employees = await all(
      `
      SELECT id, username, created_at
      FROM users
      WHERE role = 'employee' AND is_approved = 1
      ORDER BY username ASC
    `
    );
    res.json(employees);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post(
  "/manager/approve/:userId",
  authMiddleware,
  requireRole("manager"),
  async (req, res) => {
    try {
      const userId = Number(req.params.userId);
      if (!Number.isInteger(userId)) {
        res.status(400).json({ error: "Invalid user id" });
        return;
      }

      const user = await get("SELECT id, role FROM users WHERE id = ?", [userId]);
      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }

      await run("UPDATE users SET is_approved = 1, role = ? WHERE id = ?", ["employee", userId]);
      res.json({ message: "User approved and role employee assigned" });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

app.post("/manager/zones", authMiddleware, requireRole("manager"), async (req, res) => {
  try {
    const { name, description, polygon } = req.body;
    if (!name) {
      res.status(400).json({ error: "name is required" });
      return;
    }

    const polygonJson = polygon ? JSON.stringify(polygon) : null;
    const result = await run(
      "INSERT INTO zones (name, description, polygon_json) VALUES (?, ?, ?)",
      [name, description || null, polygonJson]
    );

    res.status(201).json({ id: result.lastID, message: "Zone created" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/zones", authMiddleware, async (req, res) => {
  try {
    const zones = await all("SELECT id, name, description, polygon_json FROM zones ORDER BY id DESC");
    res.json(
      zones.map((zone) => ({
        ...zone,
        polygon: zone.polygon_json ? JSON.parse(zone.polygon_json) : null
      }))
    );
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/manager/duties", authMiddleware, requireRole("manager"), async (req, res) => {
  try {
    const { employeeId, zoneId, dutyDate, startTime, endTime } = req.body;
    if (!employeeId || !zoneId || !dutyDate || !startTime || !endTime) {
      res.status(400).json({ error: "employeeId, zoneId, dutyDate, startTime, endTime are required" });
      return;
    }

    const employee = await get(
      "SELECT id FROM users WHERE id = ? AND role = ? AND is_approved = 1",
      [employeeId, "employee"]
    );
    if (!employee) {
      res.status(404).json({ error: "Employee not found or not approved" });
      return;
    }

    const zone = await get("SELECT id FROM zones WHERE id = ?", [zoneId]);
    if (!zone) {
      res.status(404).json({ error: "Zone not found" });
      return;
    }

    const isoDate = toIsoDate(dutyDate);
    if (!isoDate) {
      res.status(400).json({ error: "Invalid dutyDate format" });
      return;
    }

    const created = await run(
      "INSERT INTO duties (employee_id, zone_id, duty_date, start_time, end_time) VALUES (?, ?, ?, ?, ?)",
      [employeeId, zoneId, isoDate, startTime, endTime]
    );

    res.status(201).json({ id: created.lastID, message: "Duty assigned" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/employee/duties", authMiddleware, requireRole("employee"), async (req, res) => {
  try {
    const duties = await all(
      `
      SELECT d.id, d.duty_date, d.start_time, d.end_time, z.id AS zone_id, z.name AS zone_name
      FROM duties d
      JOIN zones z ON z.id = d.zone_id
      WHERE d.employee_id = ?
      ORDER BY d.duty_date DESC, d.start_time ASC
    `,
      [req.user.userId]
    );
    res.json(duties);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/employee/duty-results", authMiddleware, requireRole("employee"), async (req, res) => {
  try {
    const { dutyId, observedAt, carBrand, plateNumber, speed, isOvertake } = req.body;

    if (
      !dutyId ||
      !observedAt ||
      !carBrand ||
      !plateNumber ||
      typeof speed !== "number" ||
      typeof isOvertake !== "boolean"
    ) {
      res.status(400).json({
        error: "dutyId, observedAt, carBrand, plateNumber, speed(number), isOvertake(boolean) are required"
      });
      return;
    }

    const duty = await get("SELECT id FROM duties WHERE id = ? AND employee_id = ?", [
      dutyId,
      req.user.userId
    ]);
    if (!duty) {
      res.status(404).json({ error: "Duty not found for current employee" });
      return;
    }

    const observedDate = new Date(observedAt);
    if (Number.isNaN(observedDate.getTime())) {
      res.status(400).json({ error: "Invalid observedAt" });
      return;
    }

    const created = await run(
      `
      INSERT INTO duty_results (duty_id, employee_id, observed_at, car_brand, plate_number, speed, is_overtake)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      [
        dutyId,
        req.user.userId,
        observedDate.toISOString(),
        carBrand,
        plateNumber,
        speed,
        isOvertake ? 1 : 0
      ]
    );

    res.status(201).json({ id: created.lastID, message: "Duty result saved" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get(
  "/manager/reports/zone",
  authMiddleware,
  requireRole("manager"),
  async (req, res) => {
    try {
      const { zoneId, dateFrom, dateTo } = req.query;
      if (!zoneId || !dateFrom || !dateTo) {
        res.status(400).json({ error: "zoneId, dateFrom, dateTo are required" });
        return;
      }

      const from = toIsoDate(dateFrom);
      const to = toIsoDate(dateTo);
      if (!from || !to) {
        res.status(400).json({ error: "Invalid date format" });
        return;
      }

      const rows = await all(
        `
        SELECT
          date(dr.observed_at) AS report_date,
          CASE
            WHEN time(dr.observed_at) >= '06:00:00' AND time(dr.observed_at) < '10:00:00' THEN '06:00-10:00'
            WHEN time(dr.observed_at) >= '10:00:00' AND time(dr.observed_at) < '14:00:00' THEN '10:00-14:00'
            WHEN time(dr.observed_at) >= '14:00:00' AND time(dr.observed_at) < '18:00:00' THEN '14:00-18:00'
            WHEN time(dr.observed_at) >= '18:00:00' AND time(dr.observed_at) < '22:00:00' THEN '18:00-22:00'
            ELSE NULL
          END AS interval_name,
          AVG(CASE WHEN dr.is_overtake = 0 THEN dr.speed END) AS avg_speed_without_overtake,
          SUM(CASE WHEN dr.is_overtake = 1 THEN 1 ELSE 0 END) AS overtake_count
        FROM duty_results dr
        JOIN duties d ON d.id = dr.duty_id
        WHERE d.zone_id = ?
          AND date(dr.observed_at) BETWEEN ? AND ?
        GROUP BY report_date, interval_name
        HAVING interval_name IS NOT NULL
        ORDER BY report_date ASC
      `,
        [zoneId, from, to]
      );

      const grouped = {};
      for (const row of rows) {
        if (!grouped[row.report_date]) {
          grouped[row.report_date] = {
            date: row.report_date,
            "06:00-10:00": { averageSpeed: null, overtakeCount: 0 },
            "10:00-14:00": { averageSpeed: null, overtakeCount: 0 },
            "14:00-18:00": { averageSpeed: null, overtakeCount: 0 },
            "18:00-22:00": { averageSpeed: null, overtakeCount: 0 }
          };
        }

        grouped[row.report_date][row.interval_name] = {
          averageSpeed:
            row.avg_speed_without_overtake === null
              ? null
              : Number(Number(row.avg_speed_without_overtake).toFixed(2)),
          overtakeCount: row.overtake_count || 0
        };
      }

      res.json({
        zoneId: Number(zoneId),
        dateFrom: from,
        dateTo: to,
        rows: Object.values(grouped)
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server is running on http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Failed to initialize database:", error);
    process.exit(1);
  });
