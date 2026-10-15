const $ = (selector) => document.querySelector(selector);
const state = { admin: null, csrfToken: null, page: 1, pages: 1, limit: 9, participants: [], editing: null, toastTimer: null };

async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  if (state.csrfToken && options.method && options.method !== "GET") headers["x-csrf-token"] = state.csrfToken;
  const response = await fetch(url, { credentials: "same-origin", ...options, headers });
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json") ? await response.json() : null;
  if (!response.ok) throw new Error(data?.error || `Permintaan gagal (${response.status})`);
  return data;
}
function showToast(message, error = false) {
  const el = $("#toast");
  el.textContent = message; el.classList.toggle("error", error); el.classList.add("show");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => el.classList.remove("show"), 2800);
}
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}
function setAdminUI() {
  const isAdmin = Boolean(state.admin);
  $("#adminOpen").classList.toggle("hidden", isAdmin);
  $("#adminLogout").classList.toggle("hidden", !isAdmin);
  $("#adminBadge").classList.toggle("hidden", !isAdmin);
  $("#adminPanel").classList.toggle("hidden", !isAdmin);
  document.querySelectorAll(".admin-col").forEach(el => el.classList.toggle("hidden", !isAdmin));
}
async function loadStatus() {
  const data = await api("/api/status");
  if (data.authenticated) { state.admin = { username: data.admin }; state.csrfToken = data.csrfToken; }
  setAdminUI();
}
async function loadLevels() {
  const data = await api("/api/levels");
  const select = $("#levelFilter"), current = select.value;
  select.innerHTML = '<option value="">Semua level</option>' + data.levels.map(level => `<option value="${escapeHtml(level)}">${escapeHtml(level)}</option>`).join("");
  select.value = current;
}
async function loadParticipants() {
  const params = new URLSearchParams({ search: $("#searchInput").value.trim(), level: $("#levelFilter").value, page: state.page, limit: state.limit });
  const data = await api(`/api/participants?${params}`);
  state.pages = data.pages; state.participants = data.participants;
  $("#resultCount").textContent = `${data.total} peserta ditemukan`;
  $("#pageLabel").textContent = `${data.page} / ${data.pages}`;
  $("#prevPage").disabled = data.page <= 1; $("#nextPage").disabled = data.page >= data.pages;
  renderRows(data.participants);
}
function renderRows(rows) {
  const body = $("#leaderboardBody");
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="${state.admin ? 5 : 4}" class="empty">Belum ada peserta yang cocok.</td></tr>`;
    return;
  }
  body.innerHTML = rows.map(p => `<tr>
    <td><span class="rank-number ${p.rank <= 3 ? "top" : ""}">${String(p.rank).padStart(2, "0")}</span></td>
    <td class="name-cell">${escapeHtml(p.name)}</td>
    <td><span class="level-pill">${escapeHtml(p.level)}</span></td>
    <td class="points-cell ${p.points < 0 ? "points-negative" : "points-positive"}">${p.points > 0 ? "+" : ""}${p.points}</td>
    ${state.admin ? `<td class="admin-col"><div class="row-actions"><button class="mini-btn" data-edit="${p.id}">Edit</button></div></td>` : ""}
  </tr>`).join("");
  body.querySelectorAll("[data-edit]").forEach(btn => btn.addEventListener("click", () => openEdit(Number(btn.dataset.edit))));
}
async function refreshAll() {
  try {
    await loadLevels();
    await loadParticipants();
    const stats = await api("/api/stats");
    $("#totalParticipants").textContent = stats.participants;
    $("#topPoints").textContent = stats.participants ? stats.topPoints : "—";
    $("#totalLevels").textContent = stats.levels;
  } catch (err) { showToast(err.message, true); }
}
function openModal(id) { $(`#${id}`).classList.remove("hidden"); }
function closeModal(id) { $(`#${id}`).classList.add("hidden"); }
function openEdit(id) {
  const p = state.participants.find(item => item.id === id);
  if (!p) return;
  state.editing = p;
  const form = $("#editForm");
  form.elements.id.value = p.id; form.elements.name.value = p.name; form.elements.level.value = p.level;
  form.elements.mode.value = "add"; form.elements.value.value = 0; form.elements.description.value = "";
  $("#editError").textContent = "";
  $("#deleteParticipant").textContent = `Hapus ${p.name}`;
  openModal("editModal");
}
async function downloadFile(url) {
  const response = await fetch(url, { credentials: "same-origin" });
  if (!response.ok) {
    let message = "Gagal mengunduh file.";
    try { message = (await response.json()).error || message; } catch {}
    throw new Error(message);
  }
  const blob = await response.blob(), objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = objectUrl; a.download = response.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] || "loewi-race7-file";
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(objectUrl);
}
async function loadHistory() {
  const data = await api("/api/history?limit=100");
  $("#historyContent").innerHTML = data.history.length ? data.history.map(h => `<div class="history-item"><div><strong>${escapeHtml(h.participant_name || "Peserta dihapus")}</strong><span>${escapeHtml(h.description)} · ${escapeHtml(h.created_at)} · ${escapeHtml(h.admin_username || "admin")}</span></div><div class="history-delta">${h.change_amount > 0 ? "+" : ""}${h.change_amount}<br><span>→ ${h.new_points}</span></div></div>`).join("") : '<p class="muted">Belum ada riwayat perubahan poin.</p>';
  $("#historyCard").classList.remove("hidden");
}
document.addEventListener("DOMContentLoaded", async () => {
  $("#year").textContent = new Date().getFullYear();
  $("#adminOpen").addEventListener("click", () => { $("#loginError").textContent = ""; openModal("loginModal"); });
  document.querySelectorAll("[data-close]").forEach(el => el.addEventListener("click", () => closeModal(el.dataset.close + "Modal")));
  $("#refreshBtn").addEventListener("click", () => refreshAll());
  let searchTimer;
  $("#searchInput").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { state.page = 1; loadParticipants().catch(e => showToast(e.message, true)); }, 220); });
  $("#levelFilter").addEventListener("change", () => { state.page = 1; loadParticipants().catch(e => showToast(e.message, true)); });
  $("#prevPage").addEventListener("click", () => { if (state.page > 1) { state.page--; loadParticipants().catch(e => showToast(e.message, true)); } });
  $("#nextPage").addEventListener("click", () => { if (state.page < state.pages) { state.page++; loadParticipants().catch(e => showToast(e.message, true)); } });

  $("#loginForm").addEventListener("submit", async e => {
    e.preventDefault(); $("#loginError").textContent = "";
    const form = e.currentTarget;
    try {
      const data = await api("/api/login", { method: "POST", body: JSON.stringify({ username: form.elements.username.value, password: form.elements.password.value }) });
      state.admin = data.admin; state.csrfToken = data.csrfToken;
      form.reset(); closeModal("loginModal"); setAdminUI(); state.page = 1; await refreshAll(); showToast("Login admin berhasil.");
    } catch (err) { $("#loginError").textContent = err.message; }
  });
  $("#adminLogout").addEventListener("click", async () => {
    try { await api("/api/logout", { method: "POST", body: "{}" }); state.admin = null; state.csrfToken = null; setAdminUI(); await refreshAll(); showToast("Berhasil logout."); }
    catch (e) { showToast(e.message, true); }
  });
  $("#addForm").addEventListener("submit", async e => {
    e.preventDefault(); const f = e.currentTarget;
    try {
      await api("/api/participants", { method: "POST", body: JSON.stringify({ name: f.elements.name.value, level: f.elements.level.value, points: Number(f.elements.points.value) }) });
      f.reset(); f.elements.points.value = 0; state.page = 1; await refreshAll(); showToast("Peserta berhasil ditambahkan.");
    } catch (err) { showToast(err.message, true); }
  });
  $("#editForm").addEventListener("submit", async e => {
    e.preventDefault(); const f = e.currentTarget, id = Number(f.elements.id.value);
    $("#editError").textContent = "";
    try {
      await api(`/api/participants/${id}`, { method: "PUT", body: JSON.stringify({ name: f.elements.name.value, level: f.elements.level.value }) });
      await api(`/api/participants/${id}/points`, { method: "PATCH", body: JSON.stringify({ mode: f.elements.mode.value, value: Number(f.elements.value.value), description: f.elements.description.value }) });
      closeModal("editModal"); await refreshAll(); showToast("Perubahan peserta tersimpan.");
    } catch (err) { $("#editError").textContent = err.message; }
  });
  $("#deleteParticipant").addEventListener("click", async () => {
    const p = state.editing; if (!p) return;
    if (!confirm(`Yakin hapus peserta "${p.name}"? Riwayat poin peserta ini juga akan terhapus. Audit log tetap tersimpan.`)) return;
    try { await api(`/api/participants/${p.id}`, { method: "DELETE", body: "{}" }); closeModal("editModal"); await refreshAll(); showToast("Peserta berhasil dihapus."); }
    catch (err) { $("#editError").textContent = err.message; }
  });
  $("#csvExport").addEventListener("click", () => downloadFile("/api/export.csv").catch(e => showToast(e.message, true)));
  $("#pdfExport").addEventListener("click", () => downloadFile("/api/export.pdf").catch(e => showToast(e.message, true)));
  $("#backupBtn").addEventListener("click", () => downloadFile("/api/backup").catch(e => showToast(e.message, true)));
  $("#historyBtn").addEventListener("click", () => loadHistory().catch(e => showToast(e.message, true)));
  $("#closeHistory").addEventListener("click", () => $("#historyCard").classList.add("hidden"));
  try { await loadStatus(); await refreshAll(); } catch (e) { showToast(e.message, true); }
});
