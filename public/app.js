const state = {
  token: localStorage.getItem("token"),
  user: JSON.parse(localStorage.getItem("user") || "null"),
  duties: []
};

const authSection = document.getElementById("auth-section");
const sessionSection = document.getElementById("session-section");
const managerSection = document.getElementById("manager-section");
const employeeSection = document.getElementById("employee-section");
const sessionTitle = document.getElementById("session-title");
const sessionSubtitle = document.getElementById("session-subtitle");
const logNode = document.getElementById("log");

function log(message, payload) {
  const line = `[${new Date().toLocaleTimeString()}] ${message}`;
  const body = payload ? `${line}\n${JSON.stringify(payload, null, 2)}\n` : `${line}\n`;
  logNode.textContent = body + logNode.textContent;
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (!headers["Content-Type"] && options.body) headers["Content-Type"] = "application/json";
  if (state.token) headers.Authorization = `Bearer ${state.token}`;

  const response = await fetch(path, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

function setSession(token, user) {
  state.token = token;
  state.user = user;
  localStorage.setItem("token", token);
  localStorage.setItem("user", JSON.stringify(user));
  render();
}

function clearSession() {
  state.token = null;
  state.user = null;
  state.duties = [];
  localStorage.removeItem("token");
  localStorage.removeItem("user");
  render();
}

function render() {
  const isAuth = Boolean(state.token && state.user);
  authSection.classList.toggle("hidden", isAuth);
  sessionSection.classList.toggle("hidden", !isAuth);
  managerSection.classList.toggle("hidden", !isAuth || state.user.role !== "manager");
  employeeSection.classList.toggle("hidden", !isAuth || state.user.role !== "employee");

  if (isAuth) {
    sessionTitle.textContent = `Пользователь: ${state.user.username}`;
    sessionSubtitle.textContent = `Роль: ${state.user.role}`;
  }
}

function fillSelect(select, items, mapLabel, mapValue, placeholder) {
  select.innerHTML = "";
  const option = document.createElement("option");
  option.value = "";
  option.textContent = placeholder;
  select.appendChild(option);
  items.forEach((item) => {
    const opt = document.createElement("option");
    opt.value = mapValue(item);
    opt.textContent = mapLabel(item);
    select.appendChild(opt);
  });
}

async function refreshManagerData() {
  const [pendingUsers, employees, zones] = await Promise.all([
    api("/manager/pending-users"),
    api("/manager/employees"),
    api("/zones")
  ]);

  const list = document.getElementById("pending-users-list");
  list.innerHTML = "";
  pendingUsers.forEach((user) => {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.textContent = `Подтвердить ${user.username} (id=${user.id})`;
    btn.addEventListener("click", async () => {
      try {
        await api(`/manager/approve/${user.id}`, { method: "POST" });
        log("Пользователь подтвержден", user);
        await refreshManagerData();
      } catch (error) {
        log(`Ошибка подтверждения: ${error.message}`);
      }
    });
    li.appendChild(btn);
    list.appendChild(li);
  });

  fillSelect(
    document.getElementById("duty-employee"),
    employees,
    (e) => `${e.username} (id=${e.id})`,
    (e) => e.id,
    "Выберите сотрудника"
  );
  fillSelect(
    document.getElementById("duty-zone"),
    zones,
    (z) => `${z.name} (id=${z.id})`,
    (z) => z.id,
    "Выберите зону"
  );
  fillSelect(
    document.getElementById("report-zone"),
    zones,
    (z) => `${z.name} (id=${z.id})`,
    (z) => z.id,
    "Выберите зону"
  );
}

async function refreshEmployeeData() {
  state.duties = await api("/employee/duties");
  const list = document.getElementById("duties-list");
  list.innerHTML = "";
  state.duties.forEach((duty) => {
    const li = document.createElement("li");
    li.textContent = `#${duty.id} | ${duty.duty_date} ${duty.start_time}-${duty.end_time} | ${duty.zone_name}`;
    list.appendChild(li);
  });

  fillSelect(
    document.getElementById("result-duty"),
    state.duties,
    (d) => `#${d.id} ${d.duty_date} ${d.start_time}-${d.end_time} ${d.zone_name}`,
    (d) => d.id,
    "Выберите дежурство"
  );
}

function renderReportTable(rows) {
  const wrap = document.getElementById("report-table-wrap");
  if (!rows.length) {
    wrap.innerHTML = "<p>Нет данных за выбранный период.</p>";
    return;
  }

  const intervals = ["06:00-10:00", "10:00-14:00", "14:00-18:00", "18:00-22:00"];
  const head1 = intervals
    .map((it) => `<th colspan="2">${it}</th>`)
    .join("");
  const head2 = intervals.map(() => "<th>Средняя скорость</th><th>К-во обгонов</th>").join("");
  const body = rows
    .map((row) => {
      const cols = intervals
        .map((it) => {
          const item = row[it] || { averageSpeed: null, overtakeCount: 0 };
          return `<td>${item.averageSpeed ?? "-"}</td><td>${item.overtakeCount ?? 0}</td>`;
        })
        .join("");
      return `<tr><td>${row.date}</td>${cols}</tr>`;
    })
    .join("");

  wrap.innerHTML = `
    <table>
      <thead>
        <tr><th rowspan="2">Дата</th>${head1}</tr>
        <tr>${head2}</tr>
      </thead>
      <tbody>${body}</tbody>
    </table>
  `;
}

document.getElementById("register-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const username = document.getElementById("reg-username").value.trim();
    const password = document.getElementById("reg-password").value;
    const result = await api("/auth/register", {
      method: "POST",
      body: JSON.stringify({ username, password })
    });
    log("Регистрация выполнена", result);
    event.target.reset();
  } catch (error) {
    log(`Ошибка регистрации: ${error.message}`);
  }
});

document.getElementById("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const username = document.getElementById("login-username").value.trim();
    const password = document.getElementById("login-password").value;
    const result = await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password })
    });
    setSession(result.token, result.user);
    log("Успешный вход", result.user);
    if (result.user.role === "manager") await refreshManagerData();
    if (result.user.role === "employee") await refreshEmployeeData();
  } catch (error) {
    log(`Ошибка входа: ${error.message}`);
  }
});

document.getElementById("logout-btn").addEventListener("click", () => {
  clearSession();
  log("Выход из системы");
});

document.getElementById("refresh-pending-btn").addEventListener("click", async () => {
  try {
    await refreshManagerData();
    log("Данные менеджера обновлены");
  } catch (error) {
    log(`Ошибка обновления: ${error.message}`);
  }
});

document.getElementById("zone-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const name = document.getElementById("zone-name").value.trim();
    const description = document.getElementById("zone-description").value.trim();
    const polygonText = document.getElementById("zone-polygon").value.trim();
    let polygon = null;
    if (polygonText) polygon = JSON.parse(polygonText);

    const result = await api("/manager/zones", {
      method: "POST",
      body: JSON.stringify({ name, description, polygon })
    });
    log("Зона создана", result);
    event.target.reset();
    await refreshManagerData();
  } catch (error) {
    log(`Ошибка создания зоны: ${error.message}`);
  }
});

document.getElementById("duty-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const payload = {
      employeeId: Number(document.getElementById("duty-employee").value),
      zoneId: Number(document.getElementById("duty-zone").value),
      dutyDate: document.getElementById("duty-date").value,
      startTime: document.getElementById("duty-start").value,
      endTime: document.getElementById("duty-end").value
    };
    const result = await api("/manager/duties", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    log("Дежурство назначено", result);
    event.target.reset();
  } catch (error) {
    log(`Ошибка назначения дежурства: ${error.message}`);
  }
});

document.getElementById("report-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const zoneId = Number(document.getElementById("report-zone").value);
    const dateFrom = document.getElementById("report-from").value;
    const dateTo = document.getElementById("report-to").value;
    const report = await api(
      `/manager/reports/zone?zoneId=${zoneId}&dateFrom=${encodeURIComponent(dateFrom)}&dateTo=${encodeURIComponent(dateTo)}`
    );
    renderReportTable(report.rows || []);
    log("Отчет сформирован", { rows: report.rows?.length || 0 });
  } catch (error) {
    log(`Ошибка формирования отчета: ${error.message}`);
  }
});

document.getElementById("refresh-duties-btn").addEventListener("click", async () => {
  try {
    await refreshEmployeeData();
    log("Список дежурств обновлен");
  } catch (error) {
    log(`Ошибка обновления дежурств: ${error.message}`);
  }
});

document.getElementById("result-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const observedLocal = document.getElementById("result-observed-at").value;
    const observedAt = new Date(observedLocal).toISOString();
    const payload = {
      dutyId: Number(document.getElementById("result-duty").value),
      observedAt,
      carBrand: document.getElementById("result-brand").value.trim(),
      plateNumber: document.getElementById("result-plate").value.trim(),
      speed: Number(document.getElementById("result-speed").value),
      isOvertake: document.getElementById("result-overtake").checked
    };
    const result = await api("/employee/duty-results", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    log("Результат дежурства сохранен", result);
    event.target.reset();
  } catch (error) {
    log(`Ошибка сохранения результата: ${error.message}`);
  }
});

render();
if (state.user?.role === "manager") refreshManagerData().catch((e) => log(e.message));
if (state.user?.role === "employee") refreshEmployeeData().catch((e) => log(e.message));
