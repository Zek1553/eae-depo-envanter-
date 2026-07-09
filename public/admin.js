let pin = sessionStorage.getItem("depoAdminPin") || "";
let adminData = null;
let adminFilter = "";

const loginPanel = document.querySelector("#login-panel");
const adminContent = document.querySelector("#admin-content");
const stockTable = document.querySelector("#stock-table");
const transactionTable = document.querySelector("#transaction-table");
const personSummary = document.querySelector("#person-summary");
const itemStatus = document.querySelector("#item-status");
const settingsStatus = document.querySelector("#settings-status");

function formatNumber(value) {
  return new Intl.NumberFormat("tr-TR").format(Number(value || 0));
}

function formatDate(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("tr-TR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) throw new Error(body.message || "İşlem tamamlanamadı.");
  return body;
}

function setText(id, value) {
  document.querySelector(id).textContent = value;
}

function setStatus(element, message, tone = "") {
  element.textContent = message;
  element.dataset.tone = tone;
}

async function loadAdminState() {
  adminData = await requestJson(`/api/admin/state?pin=${encodeURIComponent(pin)}`);
  sessionStorage.setItem("depoAdminPin", pin);
  loginPanel.classList.add("hidden");
  adminContent.classList.remove("hidden");
  renderAdmin();
}

function categories() {
  return [...new Set(adminData.items.map((item) => item.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, "tr"));
}

function renderAdmin() {
  const summary = adminData.summary;
  setText("#stat-total-stock", formatNumber(summary.totalStock));
  setText("#stat-low-stock", formatNumber(summary.lowStockCount));
  setText("#stat-today-out", formatNumber(summary.todayOut));
  setText("#stat-total-out", formatNumber(summary.totalOut));

  document.querySelector("#category-list").innerHTML = categories()
    .map((category) => `<option value="${escapeHtml(category)}"></option>`)
    .join("");

  renderStockRows();
  renderTransactions();
  renderPersonSummary();
}

function renderStockRows() {
  const query = adminFilter.toLocaleLowerCase("tr-TR");
  const rows = adminData.items
    .filter((item) => `${item.name} ${item.category}`.toLocaleLowerCase("tr-TR").includes(query))
    .sort((a, b) => `${a.category} ${a.name}`.localeCompare(`${b.category} ${b.name}`, "tr"))
    .map((item) => {
      const low = Number(item.stock || 0) <= Number(item.minimumStock || 0);
      return `
        <tr data-id="${escapeHtml(item.id)}" class="${item.active === false ? "inactive-row" : ""}">
          <td><input class="table-input name-input" value="${escapeHtml(item.name)}" /></td>
          <td><input class="table-input category-input" value="${escapeHtml(item.category)}" list="category-list" /></td>
          <td><input class="table-input stock-input ${low ? "low" : ""}" type="number" min="0" value="${Number(item.stock || 0)}" /></td>
          <td><input class="table-input min-input" type="number" min="0" value="${Number(item.minimumStock || 0)}" /></td>
          <td><input class="active-input" type="checkbox" ${item.active !== false ? "checked" : ""} aria-label="Aktif" /></td>
          <td><input class="table-input add-input" type="number" min="1" placeholder="+ adet" /></td>
          <td class="action-cell">
            <button class="secondary-button small" data-action="add" type="button">Ekle</button>
            <button class="primary-button small" data-action="save" type="button">Kaydet</button>
          </td>
        </tr>
      `;
    })
    .join("");
  stockTable.innerHTML = rows || `<tr><td colspan="7" class="empty-cell">Kayıt bulunamadı.</td></tr>`;
}

function renderTransactions() {
  transactionTable.innerHTML = adminData.transactions
    .slice(0, 80)
    .map(
      (tx) => `
        <tr>
          <td>${escapeHtml(formatDate(tx.createdAt))}</td>
          <td>${escapeHtml(tx.person || "-")}</td>
          <td>${escapeHtml(tx.itemName)}</td>
          <td>${formatNumber(tx.quantity)}</td>
          <td>${formatNumber(tx.balanceAfter)}</td>
        </tr>
      `,
    )
    .join("") || `<tr><td colspan="5" class="empty-cell">Henüz hareket yok.</td></tr>`;
}

function renderPersonSummary() {
  const rows = adminData.summary.byPerson.slice(0, 12);
  personSummary.innerHTML = rows
    .map(
      (row) => `
        <div class="summary-row">
          <span>${escapeHtml(row.name || "-")}</span>
          <strong>${formatNumber(row.quantity)}</strong>
        </div>
      `,
    )
    .join("") || `<div class="empty-state">Henüz çıkış kaydı yok.</div>`;
}

async function renderQr() {
  const network = await requestJson("/api/network");
  const select = document.querySelector("#qr-url");
  const preferred = network.preferredUrl || window.location.origin + "/";
  select.innerHTML = network.urls.map((url) => `<option value="${escapeHtml(url)}">${escapeHtml(url)}</option>`).join("");
  select.value = network.urls.includes(preferred) ? preferred : network.urls[0];

  function draw() {
    const value = select.value;
    document.querySelector("#qr-link").value = value;
    try {
      window.QrCode.render(value, document.querySelector("#qr-box"));
    } catch (error) {
      document.querySelector("#qr-box").innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    }
  }

  select.addEventListener("change", draw);
  document.querySelector("#qr-link").addEventListener("focus", (event) => event.target.select());
  draw();
}

document.querySelector("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  pin = document.querySelector("#pin").value;
  const status = document.querySelector("#login-status");
  setStatus(status, "Kontrol ediliyor...");
  try {
    await loadAdminState();
    setStatus(status, "");
  } catch (error) {
    setStatus(status, error.message, "error");
  }
});

document.querySelector("#admin-search").addEventListener("input", (event) => {
  adminFilter = event.target.value;
  renderStockRows();
});

stockTable.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const row = button.closest("tr[data-id]");
  const itemId = row.dataset.id;
  const item = adminData.items.find((candidate) => candidate.id === itemId);

  try {
    if (button.dataset.action === "add") {
      const quantity = Number(row.querySelector(".add-input").value);
      await requestJson("/api/admin/adjust", {
        method: "POST",
        body: JSON.stringify({ pin, itemId, quantity, mode: "add", note: "Stok eklendi" }),
      });
      setStatus(itemStatus, `${item.name} stok eklendi.`, "success");
    } else {
      await requestJson("/api/admin/item", {
        method: "POST",
        body: JSON.stringify({
          pin,
          id: itemId,
          name: row.querySelector(".name-input").value,
          category: row.querySelector(".category-input").value,
          stock: row.querySelector(".stock-input").value,
          minimumStock: row.querySelector(".min-input").value,
          active: row.querySelector(".active-input").checked,
        }),
      });
      setStatus(itemStatus, `${item.name} güncellendi.`, "success");
    }
    await loadAdminState();
  } catch (error) {
    setStatus(itemStatus, error.message, "error");
  }
});

document.querySelector("#new-item-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  try {
    await requestJson("/api/admin/item", {
      method: "POST",
      body: JSON.stringify({
        pin,
        name: formData.get("name"),
        category: formData.get("category"),
        stock: formData.get("stock"),
        minimumStock: formData.get("minimumStock"),
        active: true,
      }),
    });
    event.currentTarget.reset();
    setStatus(itemStatus, "Ürün eklendi.", "success");
    await loadAdminState();
  } catch (error) {
    setStatus(itemStatus, error.message, "error");
  }
});

document.querySelector("#settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const newPin = new FormData(event.currentTarget).get("newPin");
  try {
    await requestJson("/api/admin/settings", {
      method: "POST",
      body: JSON.stringify({ pin, newPin }),
    });
    pin = newPin || pin;
    sessionStorage.setItem("depoAdminPin", pin);
    event.currentTarget.reset();
    setStatus(settingsStatus, "Kod güncellendi.", "success");
  } catch (error) {
    setStatus(settingsStatus, error.message, "error");
  }
});

document.querySelector("#export-csv").addEventListener("click", () => {
  window.location.href = `/api/admin/export.csv?pin=${encodeURIComponent(pin)}`;
});

document.querySelector("#print-qr").addEventListener("click", () => {
  window.print();
});

if (pin) {
  loadAdminState().catch(() => sessionStorage.removeItem("depoAdminPin"));
}
renderQr().catch(() => {});
