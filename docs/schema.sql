-- Internal database schema for duty scheduling information system

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT,
  is_approved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE zones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  polygon_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE duties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL,
  zone_id INTEGER NOT NULL,
  duty_date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (employee_id) REFERENCES users(id),
  FOREIGN KEY (zone_id) REFERENCES zones(id)
);

CREATE TABLE duty_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  duty_id INTEGER NOT NULL,
  employee_id INTEGER NOT NULL,
  observed_at TEXT NOT NULL,
  car_brand TEXT NOT NULL,
  plate_number TEXT NOT NULL,
  speed REAL NOT NULL,
  is_overtake INTEGER NOT NULL CHECK (is_overtake IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (duty_id) REFERENCES duties(id),
  FOREIGN KEY (employee_id) REFERENCES users(id)
);

-- Recommended indexes for report and lookup speed
CREATE INDEX idx_users_role_approved ON users(role, is_approved);
CREATE INDEX idx_duties_employee_date ON duties(employee_id, duty_date);
CREATE INDEX idx_duties_zone_date ON duties(zone_id, duty_date);
CREATE INDEX idx_results_duty_observed ON duty_results(duty_id, observed_at);
