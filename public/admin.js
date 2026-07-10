let pin = sessionStorage.getItem("depoAdminPin") || "";
let adminData = null;
let adminFilter = "";
let activeReportTab = "moves";
let selectedReportPerson = "__all";

const loginPanel = document.querySelector("#login-panel");
const adminContent = document.querySelector("#admin-content");
const stockTable = document.querySelector("#stock-table");
const transactionTable = document.querySelector("#transaction-table");
const personSummary = document.querySelector("#person-summary");
const itemStatus = document.querySelector("#item-status");
const settingsStatus = document.querySelector("#settings-status");
const reportPersonSelect = document.querySelector("#report-person");
const personPie = document.querySelector("#person-pie");
const personLegend = document.querySelector("#person-legend");
const personReportTable = document.querySelector("#person-report-table");

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

function itemOrder(item, index = 0) {
  const order = Number(item.order);
  return Number.isFinite(order) ? order : 100000 + index;
}

function sortedItems(items) {
  return [...items].sort((a, b) =>
    itemOrder(a) - itemOrder(b) ||
    `${a.category} ${a.name}`.localeCompare(`${b.category} ${b.name}`, "tr"),
  );
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

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\r\n;]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function downloadCsv(filename, rows) {
  const csv = `\uFEFF${rows.map((row) => row.map(csvEscape).join(";")).join("\r\n")}`;
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function colorAt(index) {
  const colors = ["#2f6b4f", "#315a86", "#b4761b", "#8b4f8f", "#4d7c8a", "#c44f4f", "#6b7f32", "#5b5f97", "#9a6a3a", "#3f8f72"];
  return colors[index % colors.length];
}

async function loadAdminState() {
  adminData = await requestJson(`/api/admin/state?pin=${encodeURIComponent(pin)}`);
  adminData.items = sortedItems(adminData.items);
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
  renderReportSelectors();
  renderReport();
  updateReportTabs();
}

function renderStockRows() {
  const query = adminFilter.toLocaleLowerCase("tr-TR");
  const rows = sortedItems(adminData.items)
    .filter((item) => `${item.name} ${item.category}`.toLocaleLowerCase("tr-TR").includes(query))
    .map((item) => {
      const low = Number(item.stock || 0) <= Number(item.minimumStock || 0);
      return `
        <tr data-id="${escapeHtml(item.id)}" class="${item.active === false ? "inactive-row" : ""}">
          <td><input class="table-input order-input" type="number" min="1" value="${Number(item.order || 0)}" /></td>
          <td><input class="table-input name-input" value="${escapeHtml(item.name)}" /></td>
          <td><input class="table-input category-input" value="${escapeHtml(item.category)}" list="category-list" /></td>
          <td><input class="table-input stock-input ${low ? "low" : ""}" type="number" min="0" value="${Number(item.stock || 0)}" /></td>
          <td><input class="table-input min-input" type="number" min="0" value="${Number(item.minimumStock || 0)}" /></td>
          <td><input class="active-input" type="checkbox" ${item.active !== false ? "checked" : ""} aria-label="Aktif" /></td>
          <td><input class="table-input add-input" type="number" min="1" placeholder="+ adet" /></td>
          <td class="action-cell">
            <button class="secondary-button small square-button" data-action="move-up" type="button">↑</button>
            <button class="secondary-button small square-button" data-action="move-down" type="button">↓</button>
            <button class="secondary-button small" data-action="add" type="button">Ekle</button>
            <button class="primary-button small" data-action="save" type="button">Kaydet</button>
            <button class="danger-button small" data-action="delete" type="button">Sil</button>
          </td>
        </tr>
      `;
    })
    .join("");
  stockTable.innerHTML = rows || `<tr><td colspan="8" class="empty-cell">Kayıt bulunamadı.</td></tr>`;
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

function outTransactions() {
  return (adminData?.transactions || []).filter((tx) => tx.type === "out");
}

function reportPeople() {
  return [...new Set(outTransactions().map((tx) => tx.person).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "tr"));
}

function renderReportSelectors() {
  const people = reportPeople();
  if (selectedReportPerson !== "__all" && !people.includes(selectedReportPerson)) {
    selectedReportPerson = "__all";
  }
  reportPersonSelect.innerHTML = [
    `<option value="__all__">Tüm satışçılar</option>`,
    ...people.map((person) => `<option value="${escapeHtml(person)}">${escapeHtml(person)}</option>`),
  ].join("");
  reportPersonSelect.value = selectedReportPerson === "__all" ? "__all__" : selectedReportPerson;
}

function aggregateReport() {
  const allPeople = selectedReportPerson === "__all";
  const txs = outTransactions().filter((tx) => allPeople || tx.person === selectedReportPerson);
  const detail = new Map();
  const chart = new Map();

  for (const tx of txs) {
    const person = tx.person || "-";
    const item = tx.itemName || "-";
    const category = tx.category || "-";
    const quantity = Number(tx.quantity || 0);
    const detailKey = `${person}|||${item}|||${category}`;
    const current = detail.get(detailKey) || { person, item, category, quantity: 0 };
    current.quantity += quantity;
    detail.set(detailKey, current);

    const chartName = allPeople ? person : item;
    chart.set(chartName, (chart.get(chartName) || 0) + quantity);
  }

  return {
    detailRows: Array.from(detail.values()).sort((a, b) => b.quantity - a.quantity || a.person.localeCompare(b.person, "tr")),
    chartRows: Array.from(chart, ([name, quantity]) => ({ name, quantity })).sort((a, b) => b.quantity - a.quantity),
  };
}

function pieSvg(rows) {
  const total = rows.reduce((sum, row) => sum + row.quantity, 0);
  if (!total) return `<div class="empty-state">Henüz çıkış kaydı yok.</div>`;

  if (rows.length === 1) {
    return `
      <svg viewBox="0 0 220 220" class="pie-svg" role="img" aria-label="Pasta grafik">
        <circle cx="110" cy="110" r="86" fill="${colorAt(0)}"></circle>
        <circle cx="110" cy="110" r="44" fill="#fff"></circle>
        <text x="110" y="115" text-anchor="middle">${formatNumber(total)}</text>
      </svg>
    `;
  }

  let start = -Math.PI / 2;
  const paths = rows.map((row, index) => {
    const angle = (row.quantity / total) * Math.PI * 2;
    const end = start + angle;
    const large = angle > Math.PI ? 1 : 0;
    const x1 = 110 + 86 * Math.cos(start);
    const y1 = 110 + 86 * Math.sin(start);
    const x2 = 110 + 86 * Math.cos(end);
    const y2 = 110 + 86 * Math.sin(end);
    start = end;
    return `<path d="M110 110 L${x1.toFixed(2)} ${y1.toFixed(2)} A86 86 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z" fill="${colorAt(index)}"></path>`;
  });

  return `
    <svg viewBox="0 0 220 220" class="pie-svg" role="img" aria-label="Pasta grafik">
      ${paths.join("")}
      <circle cx="110" cy="110" r="44" fill="#fff"></circle>
      <text x="110" y="115" text-anchor="middle">${formatNumber(total)}</text>
    </svg>
  `;
}

function renderReport() {
  if (!adminData) return;
  const { detailRows, chartRows } = aggregateReport();

  personPie.innerHTML = pieSvg(chartRows);
  personLegend.innerHTML = chartRows
    .slice(0, 12)
    .map((row, index) => `
      <div class="legend-row">
        <span class="legend-color" style="background:${colorAt(index)}"></span>
        <span>${escapeHtml(row.name)}</span>
        <strong>${formatNumber(row.quantity)}</strong>
      </div>
    `)
    .join("") || `<div class="empty-state">Henüz çıkış kaydı yok.</div>`;

  personReportTable.innerHTML = detailRows
    .map((row) => `
      <tr>
        <td>${escapeHtml(row.person)}</td>
        <td>${escapeHtml(row.item)}</td>
        <td>${escapeHtml(row.category)}</td>
        <td>${formatNumber(row.quantity)}</td>
      </tr>
    `)
    .join("") || `<tr><td colspan="4" class="empty-cell">Henüz kayıt yok.</td></tr>`;
}

function updateReportTabs() {
  document.querySelectorAll("[data-report-tab]").forEach((button) => {
    button.classList.toggle("active", button.dataset.reportTab === activeReportTab);
  });
  document.querySelector("#moves-panel").classList.toggle("hidden", activeReportTab !== "moves");
  document.querySelector("#person-report-panel").classList.toggle("hidden", activeReportTab !== "person");
  document.querySelector("#export-csv").classList.toggle("hidden", activeReportTab !== "moves");
  document.querySelector("#export-report-csv").classList.toggle("hidden", activeReportTab !== "person");
  document.querySelector("#print-report").classList.toggle("hidden", activeReportTab !== "person");
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

document.querySelectorAll("[data-report-tab]").forEach((button) => {
  button.addEventListener("click", () => {
    activeReportTab = button.dataset.reportTab;
    updateReportTabs();
  });
});

reportPersonSelect.addEventListener("change", () => {
  selectedReportPerson = reportPersonSelect.value === "__all__" ? "__all" : reportPersonSelect.value;
  renderReport();
});

function rowToItemPayload(row) {
  return {
    id: row.dataset.id,
    name: row.querySelector(".name-input").value,
    category: row.querySelector(".category-input").value,
    stock: row.querySelector(".stock-input").value,
    minimumStock: row.querySelector(".min-input").value,
    active: row.querySelector(".active-input").checked,
    order: row.querySelector(".order-input").value,
  };
}

document.querySelector("#bulk-save-stock").addEventListener("click", async () => {
  const rows = Array.from(stockTable.querySelectorAll("tr[data-id]"));
  if (!adminData.items.length) {
    setStatus(itemStatus, "Kaydedilecek satır bulunamadı.", "error");
    return;
  }
  const visiblePayloads = new Map(rows.map((row) => [row.dataset.id, rowToItemPayload(row)]));
  const items = adminData.items.map((item) =>
    visiblePayloads.get(item.id) || {
      id: item.id,
      name: item.name,
      category: item.category,
      stock: item.stock,
      minimumStock: item.minimumStock,
      active: item.active !== false,
      order: item.order,
    },
  );

  try {
    setStatus(itemStatus, "Stoklar kaydediliyor...");
    const result = await requestJson("/api/admin/items/bulk", {
      method: "POST",
      body: JSON.stringify({
        pin,
        items,
      }),
    });
    setStatus(itemStatus, `${formatNumber(result.count)} ürün tek seferde kaydedildi.`, "success");
    await loadAdminState();
  } catch (error) {
    setStatus(itemStatus, error.message, "error");
  }
});

stockTable.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const row = button.closest("tr[data-id]");
  const itemId = row.dataset.id;
  const item = adminData.items.find((candidate) => candidate.id === itemId);

  try {
    if (button.dataset.action === "move-up" || button.dataset.action === "move-down") {
      const ordered = sortedItems(adminData.items);
      const index = ordered.findIndex((candidate) => candidate.id === itemId);
      const targetIndex = button.dataset.action === "move-up" ? index - 1 : index + 1;
      if (targetIndex < 0 || targetIndex >= ordered.length) return;
      const currentOrder = itemOrder(ordered[index], index);
      const targetOrder = itemOrder(ordered[targetIndex], targetIndex);
      ordered[index].order = targetOrder;
      ordered[targetIndex].order = currentOrder;
      await requestJson("/api/admin/sort", {
        method: "POST",
        body: JSON.stringify({
          pin,
          orders: ordered.map((candidate) => ({ id: candidate.id, order: candidate.order })),
        }),
      });
      setStatus(itemStatus, "Sıra güncellendi.", "success");
      await loadAdminState();
      return;
    }

    if (button.dataset.action === "delete") {
      if (!window.confirm(`${item.name} silinsin mi?`)) return;
      await requestJson("/api/admin/item/delete", {
        method: "POST",
        body: JSON.stringify({ pin, itemId }),
      });
      setStatus(itemStatus, `${item.name} silindi.`, "success");
      await loadAdminState();
      return;
    }

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
        body: JSON.stringify({ pin, ...rowToItemPayload(row) }),
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

document.querySelector("#export-report-csv").addEventListener("click", () => {
  const { detailRows } = aggregateReport();
  downloadCsv("depo-envanter-kisi-raporu.csv", [
    ["Satışçı", "Ürün", "Kategori", "Adet"],
    ...detailRows.map((row) => [row.person, row.item, row.category, row.quantity]),
  ]);
});

document.querySelector("#print-qr").addEventListener("click", () => {
  document.body.classList.add("print-qr");
  window.print();
});

document.querySelector("#print-report").addEventListener("click", () => {
  document.body.classList.add("print-report");
  window.print();
});

window.addEventListener("afterprint", () => {
  document.body.classList.remove("print-qr", "print-report");
});

if (pin) {
  loadAdminState().catch(() => sessionStorage.removeItem("depoAdminPin"));
}
renderQr().catch(() => {});
