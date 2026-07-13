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
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
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

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosTime, dosDate };
}

function createZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const { dosTime, dosDate } = dosDateTime();

  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, "utf8");
    const crc = crc32(data);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, name, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, name);

    offset += localHeader.length + name.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

function xmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function columnName(index) {
  let name = "";
  let current = index;
  while (current > 0) {
    const mod = (current - 1) % 26;
    name = String.fromCharCode(65 + mod) + name;
    current = Math.floor((current - mod) / 26);
  }
  return name;
}

function sheetCell(value, rowIndex, colIndex, style = 0) {
  if (value === null || value === undefined || value === "") return "";
  const ref = `${columnName(colIndex)}${rowIndex}`;
  const styleAttr = style ? ` s="${style}"` : "";
  if (typeof value === "number" && Number.isFinite(value)) {
    return `<c r="${ref}"${styleAttr}><v>${value}</v></c>`;
  }
  return `<c r="${ref}" t="inlineStr"${styleAttr}><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
}

function sheetRow(values, rowIndex, defaultStyle = 0) {
  const cells = values
    .map((cell, index) => {
      const payload = cell && typeof cell === "object" && !Array.isArray(cell)
        ? cell
        : { value: cell, style: defaultStyle };
      return sheetCell(payload.value, rowIndex, index + 1, payload.style ?? defaultStyle);
    })
    .join("");
  return `<row r="${rowIndex}">${cells}</row>`;
}

function exportStockXlsx(store) {
  const now = new Date();
  const reportDate = new Intl.DateTimeFormat("tr-TR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(now);
  const items = sortItems(store.items).filter((item) => item.active !== false);
  const totalStock = items.reduce((sum, item) => sum + Number(item.stock || 0), 0);
  const rows = [
    [{ value: "Depo Envanter Stok Raporu", style: 1 }, "", "", "", "", ""],
    ["Oluşturma Tarihi", reportDate, "", "", "", ""],
    ["", "", "", "", "", ""],
    ["Sıra", "Kategori", "Ürün", "Mevcut Stok", "Minimum Stok", "Durum"],
    ...items.map((item, index) => {
      const stock = Number(item.stock || 0);
      const minimum = Number(item.minimumStock || 0);
      const status = stock <= 0 ? "Tükendi" : stock <= minimum ? "Düşük stok" : "Stokta";
      return [
        Number(item.order ?? (index + 1) * 10),
        item.category,
        item.name,
        stock,
        minimum,
        status,
      ];
    }),
    ["", "", "Toplam", totalStock, "", ""],
  ];
  const totalRowIndex = rows.length;
  const sheetRows = rows
    .map((row, index) => {
      const rowNumber = index + 1;
      const style = rowNumber === 4 ? 2 : rowNumber === totalRowIndex ? 3 : 0;
      return sheetRow(row, rowNumber, style);
    })
    .join("");
  const dimension = `A1:F${rows.length}`;
  const lastItemRow = Math.max(4, rows.length - 1);
  const created = now.toISOString();

  const worksheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <dimension ref="${dimension}"/>
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="4" topLeftCell="A5" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <cols>
    <col min="1" max="1" width="10" customWidth="1"/>
    <col min="2" max="2" width="26" customWidth="1"/>
    <col min="3" max="3" width="42" customWidth="1"/>
    <col min="4" max="5" width="14" customWidth="1"/>
    <col min="6" max="6" width="16" customWidth="1"/>
  </cols>
  <sheetData>${sheetRows}</sheetData>
  <autoFilter ref="A4:F${lastItemRow}"/>
  <mergeCells count="1"><mergeCell ref="A1:F1"/></mergeCells>
  <pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>
</worksheet>`;

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="3">
    <font><sz val="11"/><name val="Calibri"/></font>
    <font><b/><sz val="16"/><color rgb="FFE30613"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
  </fonts>
  <fills count="3">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF2F6B4F"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border><left style="thin"><color rgb="FFD9E2DA"/></left><right style="thin"><color rgb="FFD9E2DA"/></right><top style="thin"><color rgb="FFD9E2DA"/></top><bottom style="thin"><color rgb="FFD9E2DA"/></bottom><diagonal/></border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="4">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
    <xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyFont="1"><alignment horizontal="right"/></xf>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

  const files = [
    {
      name: "[Content_Types].xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`,
    },
    {
      name: "_rels/.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`,
    },
    {
      name: "xl/workbook.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Stok Raporu" sheetId="1" r:id="rId1"/></sheets>
</workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
    },
    { name: "xl/worksheets/sheet1.xml", data: worksheet },
    { name: "xl/styles.xml", data: styles },
    {
      name: "docProps/core.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>Depo Envanter Stok Raporu</dc:title>
  <dc:creator>Depo Envanter</dc:creator>
  <cp:lastModifiedBy>Depo Envanter</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${created}</dcterms:modified>
</cp:coreProperties>`,
    },
    {
      name: "docProps/app.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Depo Envanter</Application>
  <DocSecurity>0</DocSecurity>
  <ScaleCrop>false</ScaleCrop>
  <HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant><vt:variant><vt:i4>1</vt:i4></vt:variant></vt:vector></HeadingPairs>
  <TitlesOfParts><vt:vector size="1" baseType="lpstr"><vt:lpstr>Stok Raporu</vt:lpstr></vt:vector></TitlesOfParts>
</Properties>`,
    },
  ];

  return createZip(files);
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

    if (req.method === "GET" && pathname === "/api/admin/stock.xlsx") {
      const store = readStore();
      requirePin(store, url.searchParams.get("pin"));
      send(res, 200, exportStockXlsx(store), {
        "Content-Type": MIME_TYPES[".xlsx"],
        "Content-Disposition": "attachment; filename=\"depo-envanter-stok.xlsx\"",
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
