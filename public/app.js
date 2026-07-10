const state = {
  catalog: null,
  quantities: new Map(),
  filter: "",
};

const itemList = document.querySelector("#item-list");
const form = document.querySelector("#checkout-form");
const statusText = document.querySelector("#form-status");
const searchInput = document.querySelector("#search");
const selectedCount = document.querySelector("#selected-count");

function formatNumber(value) {
  return new Intl.NumberFormat("tr-TR").format(Number(value || 0));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function setStatus(message, tone = "") {
  statusText.textContent = message;
  statusText.dataset.tone = tone;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) {
    throw new Error(body.message || "İşlem tamamlanamadı.");
  }
  return body;
}

function groupItems(items) {
  return items.reduce((groups, item) => {
    const key = item.category || "Diğer";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
    return groups;
  }, new Map());
}

function getQty(itemId) {
  return Number(state.quantities.get(itemId) || 0);
}

function setQty(itemId, quantity) {
  const next = Math.max(0, Number(quantity || 0));
  if (next > 0) state.quantities.set(itemId, next);
  else state.quantities.delete(itemId);
  renderItems();
}

function updateSelectedCount() {
  const itemCount = Array.from(state.quantities.values()).filter((qty) => qty > 0).length;
  selectedCount.textContent = `${formatNumber(itemCount)} kalem`;
}

function renderItems() {
  if (!state.catalog) return;
  const query = state.filter.toLocaleLowerCase("tr-TR");
  const items = state.catalog.items
    .filter((item) => `${item.name} ${item.category}`.toLocaleLowerCase("tr-TR").includes(query));

  if (!items.length) {
    itemList.innerHTML = `<div class="empty-state">Uygun ürün bulunamadı.</div>`;
    updateSelectedCount();
    return;
  }

  const groups = groupItems(items);
  itemList.innerHTML = Array.from(groups.entries())
    .map(([category, categoryItems]) => {
      const rows = categoryItems
        .map((item) => {
          const qty = getQty(item.id);
          return `
            <article class="item-row" data-id="${escapeHtml(item.id)}">
              <div class="item-main">
                <strong>${escapeHtml(item.name)}</strong>
              </div>
              <div class="qty-control">
                <button type="button" class="icon-button" data-action="minus" ${qty <= 0 ? "disabled" : ""} aria-label="Adet azalt">-</button>
                <input type="number" min="0" value="${qty}" data-action="qty" aria-label="${escapeHtml(item.name)} adedi" />
                <button type="button" class="icon-button" data-action="plus" aria-label="Adet artır">+</button>
              </div>
            </article>
          `;
        })
        .join("");
      return `
        <section class="category-group">
          <h3>${escapeHtml(category)}</h3>
          <div class="category-items">${rows}</div>
        </section>
      `;
    })
    .join("");

  updateSelectedCount();
}

async function loadCatalog() {
  const catalog = await requestJson("/api/catalog");
  state.catalog = catalog;
  renderItems();
}

itemList.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const row = button.closest(".item-row");
  const item = state.catalog.items.find((candidate) => candidate.id === row.dataset.id);
  const qty = getQty(item.id);
  setQty(item.id, button.dataset.action === "plus" ? qty + 1 : qty - 1);
});

itemList.addEventListener("input", (event) => {
  if (event.target.dataset.action !== "qty") return;
  const row = event.target.closest(".item-row");
  const item = state.catalog.items.find((candidate) => candidate.id === row.dataset.id);
  setQty(item.id, event.target.value);
});

searchInput.addEventListener("input", () => {
  state.filter = searchInput.value;
  renderItems();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  setStatus("Kaydediliyor...");
  const items = Array.from(state.quantities, ([itemId, quantity]) => ({ itemId, quantity }));
  if (!items.length) {
    setStatus("En az bir ürüne adet girin.", "error");
    return;
  }
  const payload = {
    person: document.querySelector("#person").value,
    location: document.querySelector("#location").value,
    recipient: document.querySelector("#recipient").value,
    items,
  };

  try {
    await requestJson("/api/checkout", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    state.quantities.clear();
    form.reset();
    await loadCatalog();
    setStatus("Kayıt alındı, stok güncellendi.", "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
});

loadCatalog().catch((error) => {
  itemList.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
});
