const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const STORE_PATH = path.join(DATA_DIR, "store.json");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
};

function readStore() {
  return JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
}

function writeStore(store) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), "utf8");
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res, status, body) {
  send(res, status, JSON.stringify(body), {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
}

function cleanText(value, max = 160) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function toInt(value, fallback = 0) {
  return Math.trunc(toNumber(value, fallback));
}

function slugify(value) {
  const map = {
    ç: "c",
    ğ: "g",
    ı: "i",
    ö: "o",
    ş: "s",
    ü: "u",
    Ç: "c",
    Ğ: "g",
    İ: "i",
    I: "i",
    Ö: "o",
    Ş: "s",
    Ü: "u",
  };
  return cleanText(value)
    .replace(/[çğıöşüÇĞİIÖŞÜ]/g, (ch) => map[ch] || ch)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
}

function uniqueItemId(store, category, name) {
  const base = `${slugify(category)}-${slugify(name)}` || `item-${Date.now()}`;
  let id = base;
  let index = 2;
  while (store.items.some((item) => item.id === id)) {
    id = `${base}-${index}`;
    index += 1;
  }
  return id;
}

function itemOrder(item, index = 0) {
  const order = Number(item.order);
  return Number.isFinite(order) ? order : 100000 + index;
}

function sortItems(items) {
  return [...items].sort((a, b) =>
    itemOrder(a) - itemOrder(b) ||
    `${a.category} ${a.name}`.localeCompare(`${b.category} ${b.name}`, "tr"),
  );
}

function nextOrder(store) {
  return store.items.reduce((max, item, index) => Math.max(max, itemOrder(item, index)), 0) + 10;
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(Object.assign(new Error("İstek çok büyük."), { status: 413 }));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(Object.assign(new Error("Geçersiz JSON."), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function requirePin(store, pin) {
  if (String(pin ?? "") !== String(store.meta.adminPin ?? "")) {
    throw Object.assign(new Error("Yönetici kodu hatalı."), { status: 401 });
  }
}

function publicCatalog(store) {
  return {
    appName: store.meta.appName,
    items: sortItems(store.items)
      .filter((item) => item.active !== false && Number(item.stock || 0) > 0)
      .map((item) => ({
        id: item.id,
        name: item.name,
        category: item.category,
      })),
  };
}

function buildSummary(store) {
  const todayKey = new Date().toISOString().slice(0, 10);
  const outTransactions = store.transactions.filter((tx) => tx.type === "out");
  const activeItems = store.items.filter((item) => item.active !== false);
  const todayOut = outTransactions
    .filter((tx) => String(tx.createdAt).slice(0, 10) === todayKey)
    .reduce((sum, tx) => sum + Number(tx.quantity || 0), 0);

  const byPerson = new Map();
  const byItem = new Map();
  for (const tx of outTransactions) {
    byPerson.set(tx.person, (byPerson.get(tx.person) || 0) + tx.quantity);
    byItem.set(tx.itemName, (byItem.get(tx.itemName) || 0) + tx.quantity);
  }

  return {
    itemCount: activeItems.length,
    totalStock: activeItems.reduce((sum, item) => sum + Number(item.stock || 0), 0),
    lowStockCount: activeItems.filter((item) => Number(item.stock || 0) <= Number(item.minimumStock || 0)).length,
    todayOut,
    totalOut: outTransactions.reduce((sum, tx) => sum + Number(tx.quantity || 0), 0),
    byPerson: Array.from(byPerson, ([name, quantity]) => ({ name, quantity })).sort((a, b) => b.quantity - a.quantity),
    byItem: Array.from(byItem, ([name, quantity]) => ({ name, quantity })).sort((a, b) => b.quantity - a.quantity),
  };
}

function adminState(store) {
  return {
    ...store,
    items: sortItems(store.items),
    summary: buildSummary(store),
    transactions: [...store.transactions].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
  };
}

function makeTransaction({ type, item, quantity, person, recipient, location, note, balanceAfter }) {
  return {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    type,
    itemId: item.id,
    itemName: item.name,
    category: item.category,
    quantity,
    person: cleanText(person, 120),
    recipient: cleanText(recipient, 160),
    location: cleanText(location, 120),
    note: cleanText(note, 300),
    balanceAfter,
  };
}

function aggregateLines(lines) {
  const map = new Map();
  for (const line of Array.isArray(lines) ? lines : []) {
    const itemId = cleanText(line.itemId || line.id, 100);
    const quantity = toInt(line.quantity, 0);
    if (!itemId || quantity <= 0) continue;
    map.set(itemId, (map.get(itemId) || 0) + quantity);
  }
  return Array.from(map, ([itemId, quantity]) => ({ itemId, quantity }));
}

function handleCheckout(store, body) {
  const person = cleanText(body.person, 120);
  const recipient = cleanText(body.recipient, 160);
  const location = cleanText(body.location, 120);
  const lines = aggregateLines(body.items || body.lines);

  if (!person) throw Object.assign(new Error("Satışçı adı gerekli."), { status: 400 });
  if (!recipient) throw Object.assign(new Error("Teslim edilen kişi veya firma gerekli."), { status: 400 });
  if (!location) throw Object.assign(new Error("Lokasyon gerekli."), { status: 400 });
  if (!lines.length) throw Object.assign(new Error("En az bir ürün adedi girin."), { status: 400 });

  const checks = [];
  for (const line of lines) {
    const item = store.items.find((candidate) => candidate.id === line.itemId);
    if (!item || item.active === false) {
      throw Object.assign(new Error("Seçilen ürün bulunamadı."), { status: 400 });
    }
    if (Number(item.stock || 0) < line.quantity) {
      throw Object.assign(new Error(`${item.name} için yeterli stok yok.`), { status: 409 });
    }
    checks.push({ item, quantity: line.quantity });
  }

  const created = [];
  for (const check of checks) {
    check.item.stock = Number(check.item.stock || 0) - check.quantity;
    const tx = makeTransaction({
      type: "out",
      item: check.item,
      quantity: check.quantity,
      person,
      recipient,
      location,
      note: "",
      balanceAfter: check.item.stock,
    });
    store.transactions.push(tx);
    created.push(tx);
  }

  writeStore(store);
  return { ok: true, created };
}

function applyItemSave(store, body) {
  const name = cleanText(body.name, 140);
  const category = cleanText(body.category, 100);
  if (!name) throw Object.assign(new Error("Ürün adı gerekli."), { status: 400 });
  if (!category) throw Object.assign(new Error("Kategori gerekli."), { status: 400 });

  const stock = Math.max(0, toInt(body.stock, 0));
  const minimumStock = Math.max(0, toInt(body.minimumStock, 0));
  const active = body.active !== false;
  const order = toInt(body.order, nextOrder(store));
  let item = store.items.find((candidate) => candidate.id === cleanText(body.id, 100));
  const previousStock = item ? Number(item.stock || 0) : 0;

  if (!item) {
    item = {
      id: uniqueItemId(store, category, name),
      name,
      category,
      stock,
      minimumStock,
      active,
      order,
    };
    store.items.push(item);
  } else {
    item.name = name;
    item.category = category;
    item.stock = stock;
    item.minimumStock = minimumStock;
    item.active = active;
    item.order = order;
  }

  if (previousStock !== stock) {
    store.transactions.push(makeTransaction({
      type: "set",
      item,
      quantity: stock - previousStock,
      person: "Yönetici",
      recipient: "",
      location: "",
      note: "Stok elle güncellendi",
      balanceAfter: stock,
    }));
  }

  return item;
}

function handleItemSave(store, body) {
  requirePin(store, body.pin);
  const item = applyItemSave(store, body);
  store.items = sortItems(store.items);
  writeStore(store);
  return { ok: true, item };
}

function handleBulkItemSave(store, body) {
  requirePin(store, body.pin);
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) throw Object.assign(new Error("Kaydedilecek ürün bulunamadı."), { status: 400 });

  const saved = items.map((itemBody) => applyItemSave(store, itemBody));
  store.items = sortItems(store.items);
  writeStore(store);
  return { ok: true, count: saved.length, items: saved };
}

function handleDeleteItem(store, body) {
  requirePin(store, body.pin);
  const itemId = cleanText(body.itemId || body.id, 100);
  const index = store.items.findIndex((candidate) => candidate.id === itemId);
  if (index === -1) throw Object.assign(new Error("Ürün bulunamadı."), { status: 404 });

  const [item] = store.items.splice(index, 1);
  store.transactions.push(makeTransaction({
    type: "delete",
    item,
    quantity: 0,
    person: "Yönetici",
    recipient: "",
    location: "",
    note: "Ürün silindi",
    balanceAfter: 0,
  }));

  writeStore(store);
  return { ok: true };
}

function handleSortSave(store, body) {
  requirePin(store, body.pin);
  const orders = Array.isArray(body.orders) ? body.orders : [];
  const byId = new Map(store.items.map((item) => [item.id, item]));
  for (const row of orders) {
    const item = byId.get(cleanText(row.id, 100));
    if (item) item.order = toInt(row.order, itemOrder(item));
  }
  store.items = sortItems(store.items);
  writeStore(store);
  return { ok: true, items: store.items };
}

function handleAdjust(store, body) {
  requirePin(store, body.pin);
  const item = store.items.find((candidate) => candidate.id === cleanText(body.itemId, 100));
  if (!item) throw Object.assign(new Error("Ürün bulunamadı."), { status: 404 });

  const mode = cleanText(body.mode, 20) || "add";
  const amount = toInt(body.quantity, 0);
  if (amount <= 0) throw Object.assign(new Error("Adet pozitif olmalı."), { status: 400 });

  const previousStock = Number(item.stock || 0);
  if (mode === "set") {
    item.stock = amount;
  } else if (mode === "remove") {
    item.stock = Math.max(0, previousStock - amount);
  } else {
    item.stock = previousStock + amount;
  }

  store.transactions.push(makeTransaction({
    type: mode === "set" ? "set" : mode === "remove" ? "adjust-out" : "in",
    item,
    quantity: mode === "set" ? item.stock - previousStock : mode === "remove" ? -amount : amount,
    person: "Yönetici",
    recipient: "",
    location: "",
    note: cleanText(body.note, 300),
    balanceAfter: item.stock,
  }));

  writeStore(store);
  return { ok: true, item };
}

function handleSettings(store, body) {
  requirePin(store, body.pin);
  const newPin = cleanText(body.newPin, 40);
  if (newPin && newPin.length < 4) {
    throw Object.assign(new Error("Yeni kod en az 4 karakter olmalı."), { status: 400 });
  }
  if (newPin) store.meta.adminPin = newPin;
  writeStore(store);
  return { ok: true };
}

function networkInfo(req) {
  const hostHeader = req.headers.host || `localhost:${PORT}`;
  const currentOrigin = `http://${hostHeader}`;
  const urls = new Set([`${currentOrigin}/`]);
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) {
        urls.add(`http://${entry.address}:${PORT}/`);
      }
    }
  }
  urls.add(`http://localhost:${PORT}/`);
  return {
    urls: Array.from(urls),
    preferredUrl: Array.from(urls).find((url) => !url.includes("localhost") && !url.includes("127.0.0.1")) || currentOrigin + "/",
  };
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\r\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function exportCsv(store) {
  const rows = [
    ["Tarih", "Tip", "Satışçı", "Teslim Edilen", "Lokasyon", "Kategori", "Ürün", "Adet", "Kalan", "Not"],
    ...adminState(store).transactions.map((tx) => [
      tx.createdAt,
      tx.type,
      tx.person,
      tx.recipient,
      tx.location,
      tx.category,
      tx.itemName,
      tx.quantity,
      tx.balanceAfter,
      tx.note,
    ]),
  ];
  return `\uFEFF${rows.map((row) => row.map(csvEscape).join(";")).join("\r\n")}`;
}

function serveStatic(req, res, pathname) {
  let target = pathname === "/" ? "/index.html" : pathname;
  if (target === "/admin") target = "/admin.html";
  const filePath = path.normalize(path.join(PUBLIC_DIR, target.replace(/^\/+/, "")));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    send(res, 403, "Forbidden", { "Content-Type": "text/plain; charset=utf-8" });
    return true;
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false;
  const ext = path.extname(filePath).toLowerCase();
  send(res, 200, fs.readFileSync(filePath), {
    "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
    "Cache-Control": "no-store",
  });
  return true;
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || `localhost:${PORT}`}`);
  const pathname = decodeURIComponent(url.pathname);

  try {
    if (req.method === "GET" && pathname === "/api/catalog") {
      sendJson(res, 200, publicCatalog(readStore()));
      return;
    }

    if (req.method === "GET" && pathname === "/api/network") {
      sendJson(res, 200, networkInfo(req));
      return;
    }

    if (req.method === "GET" && pathname === "/api/admin/state") {
      const store = readStore();
      requirePin(store, url.searchParams.get("pin"));
      sendJson(res, 200, adminState(store));
      return;
    }

    if (req.method === "GET" && pathname === "/api/admin/export.csv") {
      const store = readStore();
      requirePin(store, url.searchParams.get("pin"));
      send(res, 200, exportCsv(store), {
        "Content-Type": MIME_TYPES[".csv"],
        "Content-Disposition": "attachment; filename=\"depo-envanter-hareketler.csv\"",
        "Cache-Control": "no-store",
      });
      return;
    }

    if (req.method === "POST" && pathname === "/api/checkout") {
      const store = readStore();
      const body = await readRequestBody(req);
      sendJson(res, 200, handleCheckout(store, body));
      return;
    }

    if (req.method === "POST" && pathname === "/api/admin/item") {
      const store = readStore();
      const body = await readRequestBody(req);
      sendJson(res, 200, handleItemSave(store, body));
      return;
    }

    if (req.method === "POST" && pathname === "/api/admin/items/bulk") {
      const store = readStore();
      const body = await readRequestBody(req);
      sendJson(res, 200, handleBulkItemSave(store, body));
      return;
    }

    if (req.method === "POST" && pathname === "/api/admin/item/delete") {
      const store = readStore();
      const body = await readRequestBody(req);
      sendJson(res, 200, handleDeleteItem(store, body));
      return;
    }

    if (req.method === "POST" && pathname === "/api/admin/sort") {
      const store = readStore();
      const body = await readRequestBody(req);
      sendJson(res, 200, handleSortSave(store, body));
      return;
    }

    if (req.method === "POST" && pathname === "/api/admin/adjust") {
      const store = readStore();
      const body = await readRequestBody(req);
      sendJson(res, 200, handleAdjust(store, body));
      return;
    }

    if (req.method === "POST" && pathname === "/api/admin/settings") {
      const store = readStore();
      const body = await readRequestBody(req);
      sendJson(res, 200, handleSettings(store, body));
      return;
    }

    if (req.method === "GET" && serveStatic(req, res, pathname)) return;
    send(res, 404, "Not found", { "Content-Type": "text/plain; charset=utf-8" });
  } catch (error) {
    const status = error.status || 500;
    sendJson(res, status, { ok: false, message: error.message || "Beklenmeyen hata." });
  }
}

const server = http.createServer(route);
server.listen(PORT, HOST, () => {
  const urls = networkInfo({ headers: { host: `localhost:${PORT}` } }).urls;
  console.log(`Depo Envanter calisiyor:`);
  for (const url of urls) console.log(`- ${url}`);
});
