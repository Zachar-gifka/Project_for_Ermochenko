const express = require("express");
const bcrypt = require("bcryptjs");
const path = require("path");
const dotenv = require("dotenv");
const { google } = require("googleapis");
const { DateTime } = require("luxon");
const { all, get, run, initDb } = require("./db");
const { authMiddleware, generateToken, requireRole } = require("./auth");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

function toIsoDate(dateString) {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function getGoogleOAuthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/auth/google/callback`;
  if (!clientId || !clientSecret) return null;
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

function getGoogleScopes() {
  // Minimal default set for: Google OAuth + Calendar + Sheets + Docs.
  // Can be overridden via GOOGLE_SCOPES (comma-separated).
  if (process.env.GOOGLE_SCOPES) {
    return process.env.GOOGLE_SCOPES.split(",").map((s) => s.trim()).filter(Boolean);
  }

  return [
    "openid",
    "email",
    "profile",
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/documents"
  ];
}

function getDefaultTimezone() {
  return process.env.DEFAULT_TIMEZONE || "Europe/Moscow";
}

function getOAuthClientForUser(userRow) {
  const oauth2Client = getGoogleOAuthClient();
  if (!oauth2Client) return null;
  if (!userRow?.google_refresh_token) return null;
  oauth2Client.setCredentials({ refresh_token: userRow.google_refresh_token });
  return oauth2Client;
}

async function ensureGoogleSheetsForUser(userRow) {
  if (userRow.sheets_spreadsheet_id && userRow.sheets_sheet_name) {
    return { spreadsheetId: userRow.sheets_spreadsheet_id, sheetName: userRow.sheets_sheet_name };
  }

  const oauth2Client = getOAuthClientForUser(userRow);
  if (!oauth2Client) return null;

  const sheets = google.sheets({ version: "v4", auth: oauth2Client });
  const sheetName = userRow.sheets_sheet_name || "results";
  const title = `Duty Results - ${userRow.username}`;

  // Create spreadsheet with a single sheet (sheetName)
  const created = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title },
      sheets: [
        {
          properties: { title: sheetName }
        }
      ]
    }
  });

  const spreadsheetId = created.data.spreadsheetId;

  // Write header row.
  const header = [
    "duty_id",
    "zone_id",
    "observed_at",
    "car_brand",
    "plate_number",
    "speed",
    "is_overtake",
    "created_at"
  ];
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetName}!A1:H1`,
    valueInputOption: "RAW",
    requestBody: { values: [header] }
  });

  await run(
    "UPDATE users SET sheets_spreadsheet_id = ?, sheets_sheet_name = ? WHERE id = ?",
    [spreadsheetId, sheetName, userRow.id]
  );

  return { spreadsheetId, sheetName };
}

async function appendDutyResultToSheets(userRow, dutyResultRow, dutyInfoRow) {
  const prepared = await ensureGoogleSheetsForUser(userRow);
  if (!prepared) return null;

  const oauth2Client = getOAuthClientForUser(userRow);
  if (!oauth2Client) return null;

  const sheets = google.sheets({ version: "v4", auth: oauth2Client });
  const range = `${prepared.sheetName}!A:H`;

  const values = [
    [
      String(dutyResultRow.duty_id),
      String(dutyInfoRow.zone_id),
      dutyResultRow.observed_at,
      dutyResultRow.car_brand,
      dutyResultRow.plate_number,
      Number(dutyResultRow.speed),
      dutyResultRow.is_overtake === 1 ? "1" : "0",
      dutyResultRow.created_at || ""
    ]
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId: prepared.spreadsheetId,
    range,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values }
  });

  await run("UPDATE duty_results SET sheets_written = 1 WHERE id = ?", [dutyResultRow.id]);
  return true;
}

async function createCalendarEventForDuty(userRow, dutyRow) {
  const oauth2Client = getOAuthClientForUser(userRow);
  if (!oauth2Client) return null;

  const calendar = google.calendar({ version: "v3", auth: oauth2Client });
  const calendarId = userRow.calendar_id || "primary";
  const tz = userRow.calendar_timezone || getDefaultTimezone();

  // Combine duty date + times to local timezone ISO strings
  const start = DateTime.fromFormat(`${dutyRow.duty_date} ${dutyRow.start_time}`, "yyyy-MM-dd HH:mm", {
    zone: tz
  });
  const end = DateTime.fromFormat(`${dutyRow.duty_date} ${dutyRow.end_time}`, "yyyy-MM-dd HH:mm", { zone: tz });
  if (!start.isValid || !end.isValid) return null;

  const event = {
    summary: `Duty #${dutyRow.id}`,
    description: `Zone: ${dutyRow.zone_name || dutyRow.zone_id}`,
    start: {
      dateTime: start.toISO(),
      timeZone: tz
    },
    end: {
      dateTime: end.toISO(),
      timeZone: tz
    },
    reminders: {
      useDefault: false,
      overrides: [
        { method: "popup", minutes: 1440 }, // 1 day before
        { method: "popup", minutes: 60 } // 1 hour before
      ]
    }
  };

  const created = await calendar.events.insert({
    calendarId,
    requestBody: event
  });

  const eventId = created.data?.id || null;
  if (eventId) {
    await run("UPDATE duties SET calendar_event_id = ? WHERE id = ?", [eventId, dutyRow.id]);
  }
  return eventId;
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

// ---- Google OAuth (for employee registration/authentication) ----
app.get("/auth/google/login", async (req, res) => {
  try {
    const oauth2Client = getGoogleOAuthClient();
    if (!oauth2Client) {
      res.status(500).json({
        error:
          "Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in environment."
      });
      return;
    }

    const url = oauth2Client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: getGoogleScopes()
    });

    res.redirect(url);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/auth/google/callback", async (req, res) => {
  try {
    const code = req.query.code;
    if (!code || typeof code !== "string") {
      res.status(400).json({ error: "Missing code in callback" });
      return;
    }

    const oauth2Client = getGoogleOAuthClient();
    if (!oauth2Client) {
      res.status(500).json({
        error:
          "Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in environment."
      });
      return;
    }

    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Fetch basic profile information.
    const userinfo = await google.oauth2({ version: "v2", auth: oauth2Client }).userinfo.get();
    const googleSub = userinfo.data.id;
    const googleEmail = userinfo.data.email;
    if (!googleSub) {
      res.status(500).json({ error: "Failed to read google user id" });
      return;
    }

    let user = await get(
      "SELECT id, username, role, is_approved FROM users WHERE google_sub = ?",
      [googleSub]
    );

    if (!user) {
      const randomPassword = `google-${googleSub}-${Date.now()}`;
      const passwordHash = await bcrypt.hash(randomPassword, 10);
      const baseUsername = googleEmail ? googleEmail.split("@")[0] : `user_${googleSub.slice(0, 6)}`;
      const created = await run(
        "INSERT INTO users (username, password_hash, role, is_approved, google_sub, google_email, google_refresh_token) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
          baseUsername,
          passwordHash,
          null,
          0,
          googleSub,
          googleEmail || null,
          tokens.refresh_token || null
        ]
      );
      user = await get("SELECT id, username, role, is_approved FROM users WHERE id = ?", [
        created.lastID
      ]);
    } else {
      await run(
        "UPDATE users SET google_email = ?, google_refresh_token = COALESCE(?, google_refresh_token) WHERE google_sub = ?",
        [googleEmail || null, tokens.refresh_token || null, googleSub]
      );
    }

    // Set defaults for external integrations (if empty).
    await run(
      `
      UPDATE users
      SET
        calendar_id = COALESCE(calendar_id, 'primary'),
        calendar_timezone = COALESCE(calendar_timezone, ?),
        sheets_sheet_name = COALESCE(sheets_sheet_name, 'results')
      WHERE id = ?
    `,
      [getDefaultTimezone(), user.id]
    );

    const jwtToken = generateToken({
      id: user.id,
      username: user.username,
      role: user.role
    });

    const redirectUser = {
      id: user.id,
      username: user.username,
      role: user.role
    };

    const redirectUrl = `/?token=${encodeURIComponent(jwtToken)}&user=${encodeURIComponent(
      JSON.stringify(redirectUser)
    )}`;

    res.redirect(redirectUrl);
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

    const dutyId = created.lastID;
    // Try to sync planned duty to employee's Google Calendar (best-effort).
    let calendarEventId = null;
    try {
      const dutyRow = await get(
        `
          SELECT
            d.id,
            d.employee_id,
            d.zone_id,
            d.duty_date,
            d.start_time,
            d.end_time,
            z.name AS zone_name,
            u.google_refresh_token,
            u.calendar_id,
            u.calendar_timezone
          FROM duties d
          JOIN zones z ON z.id = d.zone_id
          JOIN users u ON u.id = d.employee_id
          WHERE d.id = ?
        `,
        [dutyId]
      );

      if (dutyRow?.google_refresh_token) {
        calendarEventId = await createCalendarEventForDuty(
          {
            google_refresh_token: dutyRow.google_refresh_token,
            calendar_id: dutyRow.calendar_id,
            calendar_timezone: dutyRow.calendar_timezone
          },
          dutyRow
        );
      }
    } catch (e) {
      // ignore calendar sync failures; internal duty assignment should still succeed
    }

    res.status(201).json({ id: dutyId, message: "Duty assigned", calendarEventId });
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

    const dutyResultId = created.lastID;

    // Sync result to Google Sheets (best-effort).
    let sheetsWritten = false;
    try {
      const dutyResultRow = await get("SELECT * FROM duty_results WHERE id = ?", [dutyResultId]);
      const dutyInfoRow = await get(
        `
          SELECT
            d.id AS duty_id,
            d.zone_id
          FROM duties d
          WHERE d.id = ?
        `,
        [dutyId]
      );
      const userRow = await get(
        `
          SELECT
            id,
            username,
            google_refresh_token,
            sheets_spreadsheet_id,
            sheets_sheet_name
          FROM users
          WHERE id = ?
        `,
        [req.user.userId]
      );

      if (userRow?.google_refresh_token && dutyResultRow && dutyInfoRow) {
        sheetsWritten = (await appendDutyResultToSheets(userRow, dutyResultRow, dutyInfoRow)) === true;
      }
    } catch (e) {
      // ignore sheets sync failures
    }

    res.status(201).json({ id: dutyResultId, message: "Duty result saved", sheetsWritten });
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

// Generate Google Docs report (6+ integration - best-effort).
app.get(
  "/manager/reports/zone/google-doc",
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

      // Reuse the internal aggregation logic (data source).
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

      const reportRows = Object.values(grouped);
      const intervals = ["06:00-10:00", "10:00-14:00", "14:00-18:00", "18:00-22:00"];

      let text = `Duty report\nZone ID: ${zoneId}\nPeriod: ${from}..${to}\n\n`;
      if (!reportRows.length) {
        text += "No data.\n";
      } else {
        for (const r of reportRows) {
          text += `Date: ${r.date}\n`;
          for (const it of intervals) {
            const item = r[it];
            text += `  ${it} | avg speed (no overtake): ${item.averageSpeed ?? "-"} | overtake count: ${
              item.overtakeCount
            }\n`;
          }
          text += "\n";
        }
      }

      // Create doc on behalf of the authenticated manager via Google Docs API.
      const manager = await get(
        "SELECT id, username, google_refresh_token FROM users WHERE id = ?",
        [req.user.userId]
      );
      const oauth2Client = getOAuthClientForUser(manager);
      if (!oauth2Client) {
        res.status(400).json({
          error:
            "Google Docs integration requires manager to login via Google OAuth (refresh token not found)."
        });
        return;
      }

      const docs = google.docs({ version: "v1", auth: oauth2Client });
      const created = await docs.documents.create({
        requestBody: {
          title: `Duty report zone ${zoneId} (${from}..${to})`
        }
      });

      const documentId = created.data.documentId;
      await docs.documents.batchUpdate({
        documentId,
        requestBody: {
          requests: [
            {
              insertText: {
                location: { index: 1 },
                text
              }
            }
          ]
        }
      });

      const docUrl = `https://docs.google.com/document/d/${documentId}/edit`;
      res.json({ docUrl });
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
