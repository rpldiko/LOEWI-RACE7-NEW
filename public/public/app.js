```javascript
const $ = (selector) => document.querySelector(selector);

let csrfToken = "";
let currentPage = 1;
let currentSearch = "";
let currentLevel = "";
let editingParticipant = null;

async function api(url, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const headers = { ...(options.headers || {}) };

  if (options.body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  if (!["GET", "HEAD", "OPTIONS"].includes(method) && csrfToken) {
    headers["X-CSRF-Token"] = csrfToken;
  }

  const response = await fetch(url, {
    ...options,
    method,
    headers,
    credentials: "same-origin"
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    if (response.status === 401) showLogin();
    throw new Error(data.message || "Terjadi kesalahan pada server.");
  }

  return data;
}

function notify(message) {
  const element = $("#notice");
  if (!element) {
    alert(message);
    return;
  }

  element.textContent = message;
  element.hidden = false;

  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => {
    element.hidden = true;
  }, 3500);
}

function showLogin() {
  $("#login-view")?.removeAttribute("hidden");
  $("#app-view")?.setAttribute("hidden", "");
  csrfToken = "";
}

function showApp() {
  $("#login-view")?.setAttribute("hidden", "");
  $("#app-view")?.removeAttribute("hidden");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function formatNumber(value) {
  return new Intl.NumberFormat("id-ID").format(Number(value) || 0);
}

function participantRows(participants) {
  if (!participants.length) {
    return '<tr><td colspan="5">Belum ada peserta.</td></tr>';
  }

  return participants.map((person, index) => `
    <tr>
      <td>${(currentPage - 1) * 20 + index + 1}</td>
      <td>${escapeHtml(person.name)}</td>
      <td>${escapeHtml(person.level || "-")}</td>
      <td>${formatNumber(person.points)}</td>
      <td>
        <button type="button" data-edit="${person.id}">Edit</button>
        <button type="button" data-add="${person.id}">Tambah poin</button>
        <button type="button" data-delete="${person.id}">Hapus</button>
      </td>
    </tr>
  `).join("");
}

async function loadParticipants() {
  const params = new URLSearchParams({
    page: String(currentPage),
    limit: "20",
    search: currentSearch
  });

  if (currentLevel) params.set("level", currentLevel);

  const data = await api(`/api/participants?${params}`);
  const rows = $("#participant-rows");

  if (rows) rows.innerHTML = participantRows(data.participants || []);

  const pageInfo = $("#page-info");
  if (pageInfo) {
    const totalPages = Math.max(1, Math.ceil((data.total || 0) / 20));
    pageInfo.textContent = `Halaman ${currentPage} dari ${totalPages} · Total ${formatNumber(data.total)} peserta`;

    const previous = $("#previous-page");
    const next = $("#next-page");

    if (previous) previous.disabled = currentPage <= 1;
    if (next) next.disabled = currentPage >= totalPages;
  }
}

async function loadStats() {
  const data = await api("/api/stats");

  const totalParticipants = $("#total-participants");
  const totalPoints = $("#total-points");
  const averagePoints = $("#average-points");

  if (totalParticipants) totalParticipants.textContent = formatNumber(data.totalParticipants);
  if (totalPoints) totalPoints.textContent = formatNumber(data.totalPoints);
  if (averagePoints) averagePoints.textContent = formatNumber(data.averagePoints);
}

async function loadLevels() {
  const data = await api("/api/levels");
  const select = $("#filter-level");

  if (!select) return;

  const previousValue = currentLevel;
  select.innerHTML = '<option value="">Semua level</option>';

  for (const level of data.levels || []) {
    const option = document.createElement("option");
    option.value = level;
    option.textContent = level;
    select.appendChild(option);
  }

  select.value = previousValue;
}

async function refreshDashboard() {
  await Promise.all([
    loadStats(),
    loadParticipants(),
    loadLevels()
  ]);
}

function openParticipantForm(person = null) {
  editingParticipant = person;

  const form = $("#participant-form");
  if (!form) return;

  form.reset();

  $("#participant-form-title").textContent = person
    ? "Edit peserta"
    : "Tambah peserta";

  $("#participant-id").value = person?.id ?? "";
  $("#participant-name").value = person?.name ?? "";
  $("#participant-level").value = person?.level ?? "";
  $("#participant-points").value = person?.points ?? 0;

  const pointsField = $("#participant-points");
  if (pointsField) {
    pointsField.disabled = Boolean(person);
    pointsField.title = person
      ? "Ubah poin melalui tombol Tambah poin."
      : "Masukkan poin awal peserta.";
  }

  $("#participant-dialog")?.removeAttribute("hidden");
}

function closeParticipantForm() {
  $("#participant-dialog")?.setAttribute("hidden", "");
  editingParticipant = null;
}

async function saveParticipant(event) {
  event.preventDefault();

  const id = $("#participant-id").value;
  const name = $("#participant-name").value.trim();
  const level = $("#participant-level").value.trim();
  const points = Number($("#participant-points").value || 0);

  if (!name || !level) {
    notify("Nama dan level wajib diisi.");
    return;
  }

  if (!id && (!Number.isSafeInteger(points) || points < 0)) {
    notify("Poin awal harus berupa bilangan bulat nol atau lebih.");
    return;
  }

  try {
    if (id) {
      await api(`/api/participants/${id}`, {
        method: "PUT",
        body: JSON.stringify({ name, level })
      });
      notify("Data peserta berhasil diperbarui.");
    } else {
      await api("/api/participants", {
        method: "POST",
        body: JSON.stringify({ name, level, points })
      });
      notify("Peserta berhasil ditambahkan.");
    }

    closeParticipantForm();
    await refreshDashboard();
  } catch (error) {
    notify(error.message);
  }
}

async function addPoints(id) {
  const raw = prompt("Masukkan jumlah poin yang ingin ditambahkan:");
  if (raw === null) return;

  const amount = Number(raw);

  if (!Number.isSafeInteger(amount) || amount <= 0) {
    notify("Jumlah poin harus bilangan bulat lebih dari nol.");
    return;
  }

  try {
    await api(`/api/participants/${id}/points`, {
      method: "PATCH",
      body: JSON.stringify({ mode: "add", value: amount })
    });

    notify("Poin berhasil ditambahkan.");
    await refreshDashboard();
  } catch (error) {
    notify(error.message);
  }
}

async function deleteParticipant(id) {
  if (!confirm("Yakin ingin menghapus peserta ini?")) return;

  try {
    await api(`/api/participants/${id}`, { method: "DELETE" });
    notify("Peserta berhasil dihapus.");
    await refreshDashboard();
  } catch (error) {
    notify(error.message);
  }
}

async function loadHistory() {
  const container = $("#history-content");
  if (!container) return;

  try {
    const data = await api("/api/history");
    const items = data.history || data.rows || [];

    if (!items.length) {
      container.textContent = "Belum ada riwayat poin.";
      return;
    }

    container.innerHTML = `
      <table>
        <thead>
          <tr><th>Waktu</th><th>Peserta</th><th>Perubahan</th><th>Catatan</th></tr>
        </thead>
        <tbody>
          ${items.map((item) => `
            <tr>
              <td>${escapeHtml(item.created_at || item.timestamp || "-")}</td>
              <td>${escapeHtml(item.participant_name || item.name || "-")}</td>
              <td>${formatNumber(item.change_amount ?? item.points_change ?? item.amount ?? 0)}</td>
              <td>${escapeHtml(item.note || item.reason || "-")}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;
  } catch (error) {
    container.textContent = error.message;
  }
}

async function logout() {
  try {
    await api("/api/logout", { method: "POST", body: "{}" });
  } catch (_) {
    // Tetap kembali ke layar login jika sesi sudah berakhir.
  }

  showLogin();
}

document.addEventListener("DOMContentLoaded", async () => {
  $("#login-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();

    const username = $("#login-username").value.trim();
    const password = $("#login-password").value;

    try {
      const data = await api("/api/login", {
        method: "POST",
        body: JSON.stringify({ username, password })
      });

      csrfToken = data.csrfToken || data.csrf || "";
      showApp();
      await refreshDashboard();
      notify("Login berhasil.");
    } catch (error) {
      notify(error.message);
    }
  });

  $("#logout-button")?.addEventListener("click", logout);
  $("#participant-form")?.addEventListener("submit", saveParticipant);
  $("#cancel-participant")?.addEventListener("click", closeParticipantForm);
  $("#add-participant")?.addEventListener("click", () => openParticipantForm());

  $("#search-input")?.addEventListener("input", (event) => {
    clearTimeout(window.searchDelay);
    window.searchDelay = setTimeout(async () => {
      currentSearch = event.target.value.trim();
      currentPage = 1;

      try {
        await loadParticipants();
      } catch (error) {
        notify(error.message);
      }
    }, 300);
  });

  $("#filter-level")?.addEventListener("change", async (event) => {
    currentLevel = event.target.value;
    currentPage = 1;

    try {
      await loadParticipants();
    } catch (error) {
      notify(error.message);
    }
  });

  $("#previous-page")?.addEventListener("click", async () => {
    if (currentPage <= 1) return;
    currentPage--;

    try {
      await loadParticipants();
    } catch (error) {
      notify(error.message);
    }
  });

  $("#next-page")?.addEventListener("click", async () => {
    currentPage++;

    try {
      await loadParticipants();
    } catch (error) {
      currentPage--;
      notify(error.message);
    }
  });

  $("#participant-rows")?.addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!button) return;

    const id = button.dataset.edit || button.dataset.add || button.dataset.delete;
    if (!id) return;

    try {
      if (button.dataset.edit) {
        const data = await api(`/api/participants/${id}`);
        openParticipantForm(data.participant || data);
      } else if (button.dataset.add) {
        await addPoints(id);
      } else if (button.dataset.delete) {
        await deleteParticipant(id);
      }
    } catch (error) {
      notify(error.message);
    }
  });

  $("#export-csv")?.addEventListener("click", () => {
    window.location.href = "/api/export.csv";
  });

  $("#export-pdf")?.addEventListener("click", () => {
    window.location.href = "/api/export.pdf";
  });

  $("#show-history")?.addEventListener("click", loadHistory);

  try {
    const status = await api("/api/status");

    if (status.authenticated) {
      csrfToken = status.csrfToken || status.csrf || "";
      showApp();
      await refreshDashboard();
    } else {
      showLogin();
    }
  } catch (_) {
    showLogin();
  }
});
```
