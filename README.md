# Project_for_Ermochenko

Duty scheduling information system for employees and managers.

## Roles

- `manager`
- `employee`

New users register without a role.  
Manager approves them and assigns the `employee` role.

Default manager is created automatically on first run:

- username: `manager`
- password: `12345`

## Implemented Features

- user registration and login;
- manager approval flow for new users;
- duty zone creation;
- duty assignment (date, start time, end time, zone);
- employee duty list;
- duty result submission:
  - observation time,
  - car brand,
  - plate number,
  - speed,
  - overtake flag;
- manager report by zone and date range.

## Report Rules

Fixed time intervals:

- `06:00-10:00`
- `10:00-14:00`
- `14:00-18:00`
- `18:00-22:00`

For each interval:

- **Average speed**: only for vehicles without overtake.
- **Overtake count**: number of vehicles with overtake.

## Tech Stack

- Node.js
- Express
- SQLite
- JWT
- HTML/CSS/JavaScript (vanilla)

## Run

```bash
npm install
npm start
```

After start:

- frontend: `http://localhost:3000`
- backend API: `http://localhost:3000`

## Frontend Files

- `public/index.html`
- `public/styles.css`
- `public/app.js`

## Main API Endpoints

### Auth

- `POST /auth/register`
- `POST /auth/login`

Use this header for protected endpoints:

`Authorization: Bearer <token>`

### Manager

- `GET /manager/pending-users`
- `GET /manager/employees`
- `POST /manager/approve/:userId`
- `POST /manager/zones`
- `POST /manager/duties`
- `GET /manager/reports/zone?zoneId=1&dateFrom=2026-03-01&dateTo=2026-03-31`

### Employee

- `GET /employee/duties`
- `POST /employee/duty-results`

### Shared

- `GET /zones`

## Documentation

SQL schema:

- `docs/schema.sql`

PlantUML diagrams:

- `docs/er-diagram.puml`
- `docs/use-case-diagram.puml`
- `docs/deployment-diagram.puml`
- `docs/idef0.puml`

Mermaid diagrams:

- `docs/diagrams-mermaid.md`

## Google OAuth (6+ integrations - start)

Google OAuth endpoints are implemented, but they require configuration via environment variables:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI` (optional; defaults to `http://localhost:3000/auth/google/callback`)

Login via the "Login with Google" button (frontend on `/`), then Google redirects back to the app.

## 6+ Integrations Implemented (best-effort)

- Google OAuth (JWT session is created after Google login).
- External calendar sync (Google Calendar event created on duty assignment):
  - endpoint: `POST /manager/duties`
  - reminders: 1 day + 1 hour before duty start
- Google Sheets API (results are appended on duty result submission):
  - endpoint: `POST /employee/duty-results`
- Google Docs API (manager can generate a report document):
  - endpoint: `GET /manager/reports/zone/google-doc?zoneId=...&dateFrom=...&dateTo=...`
  - frontend: "Generate Google Doc" button in the manager report form
- Map service for duty zones (interactive polygon draw on manager zone creation):
  - frontend uses Leaflet + OpenStreetMap
  - polygon GeoJSON is sent as `polygon` to `POST /manager/zones`

Note: calendar/sheets/docs sync are "best-effort". If Google credentials are not configured or user hasn't granted required scopes, the app still saves data internally.
