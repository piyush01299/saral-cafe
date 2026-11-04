// Swaadly backend - sirf Node.js built-in modules, koi npm install nahi chahiye
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'db.json');

const hash = (pw, salt = crypto.randomBytes(16).toString('hex')) =>
  salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
const verify = (pw, stored) => {
  if (typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, h] = stored.split(':');
  const actual = Buffer.from(hash(pw, salt).split(':')[1], 'hex');
  const expected = Buffer.from(h || '', 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
};

function seed() {
  const r = (id, name, cuisine, rating, time, emoji, bg, menu) =>
    ({ id, name, cuisine, rating, time, emoji, bg, menu: menu.map(([n, p]) => ({ name: n, price: p })) });
  return {
    users: [{ id: 1, name: 'Admin', email: 'admin@swaadly.com', pass: hash(process.env.ADMIN_PASSWORD || 'admin123'), isAdmin: true }],
    sessions: {}, orders: [],
    coupons: [
      { code: 'WELCOME50', type: 'flat', value: 50, min: 200, text: '₹50 off, minimum order ₹200' },
      { code: 'FOOD10', type: 'percent', value: 10, max: 100, min: 0, text: '10% off, maximum ₹100' }
    ],
    restaurants: [
      r(1, 'Punjabi Tadka', 'North Indian', 4.4, 30, '🍛', '#ffe3d6', [['Butter Chicken', 320], ['Dal Makhani', 220], ['Garlic Naan', 50], ['Paneer Tikka', 260]]),
      r(2, 'Pizza Junction', 'Pizza', 4.1, 25, '🍕', '#fff0c9', [['Margherita', 199], ['Farmhouse', 329], ['Garlic Bread', 120]]),
      r(3, 'Biryani House', 'Biryani', 4.6, 35, '🍚', '#e6f3d4', [['Chicken Biryani', 280], ['Veg Biryani', 220], ['Raita', 40]]),
      r(4, 'Burger Barn', 'Burger', 3.9, 20, '🍔', '#ffe0e0', [['Aloo Tikki Burger', 99], ['Chicken Burger', 149], ['French Fries', 89]]),
      r(5, 'South Spice', 'South Indian', 4.5, 28, '🥞', '#e0eefb', [['Masala Dosa', 110], ['Idli Sambar', 80], ['Filter Coffee', 50]]),
      r(6, 'Meetha Ghar', 'Desserts', 4.3, 22, '🍰', '#f5e1f7', [['Gulab Jamun', 90], ['Brownie', 130], ['Rasmalai', 110]])
    ]
  };
}
// ---- Storage: Upstash Redis (online, hamesha save) ya local file ----
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL, REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN, KEY = 'swaadly_db';
const redis = async cmd => {
  const r = await fetch(REDIS_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error('Database error: ' + (j.error || r.status));
  return j.result;
};
const storeGet = async () => {
  if (REDIS_URL) return await redis(['GET', KEY]);
  try { return fs.readFileSync(DB_FILE, 'utf8'); } catch { return null; }
};
const storeSet = async text => {
  if (REDIS_URL) return redis(['SET', KEY, text]);
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  fs.writeFileSync(DB_FILE, text);
};
let db, chain = Promise.resolve();
const save = () => { // writes line se chalte hain taaki data aapas mein na ulajhe
  const p = chain.then(() => storeSet(JSON.stringify(db)));
  chain = p.catch(() => {});
  return p;
};

const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const fail = (res, code, msg) => send(res, code, { error: msg });
const body = req => new Promise((ok, no) => {
  let s = ''; req.on('data', c => { s += c; if (s.length > 1e6) { no(new Error('Request bahut bada hai')); req.destroy(); } });
  req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch { no(new Error('Galat JSON')); } });
});
const authUser = req => {
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  const id = db.sessions[t];
  return db.users.find(u => u.id === id);
};
const publicUser = u => ({ id: u.id, name: u.name, email: u.email, isAdmin: !!u.isAdmin });
const newSession = async u => { const t = crypto.randomBytes(24).toString('hex'); db.sessions[t] = u.id; await save(); return { token: t, user: publicUser(u) }; };

function applyCoupon(code, subtotal) {
  if (!code) return { discount: 0 };
  const c = db.coupons.find(x => x.code === String(code).toUpperCase());
  if (!c) return { error: 'Ye coupon code galat hai' };
  if (subtotal < c.min) return { error: `Is coupon ke liye kam se kam ₹${c.min} ka order chahiye` };
  let d = c.type === 'flat' ? c.value : Math.floor(subtotal * c.value / 100);
  if (c.max) d = Math.min(d, c.max);
  return { discount: Math.min(d, subtotal), code: c.code };
}


const TAX_RATE = 0.05, DELIVERY_FEE = 30, FREE_DELIVERY_ABOVE = 300, MAX_TIP = 500;
const addMinutes = (min, from = Date.now()) => new Date(from + min * 60000).toISOString();
const orderTotal = o => {
  const subtotal = (o.items || []).reduce((s, i) => s + i.price * i.qty, 0);
  return { subtotal, total: Math.max(0, subtotal - (o.discount || 0) + (o.tax || 0) + (o.deliveryFee || 0) + (o.tip || 0)) };
};
const withTotals = o => ({ ...o, ...orderTotal(o) });

function priceCart(items, coupon, tip) {
  if (!Array.isArray(items) || !items.length) return { error: 'Cart khali hai' };
  let subtotal = 0, etaMin = 0;
  const lines = [], restaurantIds = new Set(), inCart = new Set();
  for (const it of items) {
    const rest = db.restaurants.find(r => r.id === Number(it.rid));
    const dish = rest && rest.menu.find(d => d.name === it.name);
    const qty = Math.floor(Number(it.qty));
    if (!dish || !(qty >= 1 && qty <= 20)) return { error: 'Cart mein galat item hai' };
    restaurantIds.add(rest.id);
    inCart.add(rest.id + '|' + dish.name);
    etaMin = Math.max(etaMin, Number(rest.time) || 30);
    subtotal += dish.price * qty;
    lines.push({ restaurant: rest.name, name: dish.name, price: dish.price, qty });
  }
  const c = applyCoupon(coupon, subtotal);
  if (c.error) return { error: c.error };
  const taxable = subtotal - c.discount;
  const tax = Math.round(taxable * TAX_RATE * 100) / 100;
  const freeDelivery = subtotal >= FREE_DELIVERY_ABOVE;
  const deliveryFee = freeDelivery ? 0 : DELIVERY_FEE;
  const tipAmt = Math.min(MAX_TIP, Math.max(0, Math.floor(Number(tip) || 0)));
  const suggestions = [];
  for (const rid of restaurantIds) {
    const rest = db.restaurants.find(r => r.id === rid);
    for (const d of rest.menu) {
      if (!inCart.has(rid + '|' + d.name) && suggestions.length < 3)
        suggestions.push({ rid, restaurant: rest.name, name: d.name, price: d.price });
    }
  }
  return {
    lines, subtotal, discount: c.discount, coupon: c.code || null, tax, deliveryFee, tip: tipAmt,
    total: Math.round((taxable + tax + deliveryFee + tipAmt) * 100) / 100,
    savings: c.discount + (freeDelivery ? DELIVERY_FEE : 0),
    freeDeliveryLeft: freeDelivery ? 0 : FREE_DELIVERY_ABOVE - subtotal,
    etaMinutes: etaMin + 10, estimatedDelivery: addMinutes(etaMin + 10), suggestions
  };
}

async function api(req, res, url) {
  const m = req.method, p = url.pathname;
  if (m === 'GET' && p === '/api/health')
    return send(res, 200, { ok: true, storage: REDIS_URL ? 'upstash' : 'local', app: 'Swaadly' });
  if (m === 'GET' && p === '/api/restaurants') return send(res, 200, db.restaurants);
  if (m === 'GET' && p === '/api/coupons') return send(res, 200, db.coupons);

  if (m === 'POST' && p === '/api/signup') {
    const { name, email, password } = await body(req);
    if (!name || !email || !password || String(password).length < 6)
      return fail(res, 400, 'Naam, email aur 6+ akshar ka password dein');
    const normalizedEmail = String(email).trim().toLowerCase();
    if (db.users.some(u => u.email === normalizedEmail)) return fail(res, 409, 'Ye email pehle se registered hai');
    const u = { id: Date.now(), name: String(name).slice(0, 60), email: normalizedEmail, pass: hash(String(password)), isAdmin: false };
    db.users.push(u);
    return send(res, 201, await newSession(u));
  }
  if (m === 'POST' && p === '/api/login') {
    const { email, password } = await body(req);
    const u = db.users.find(x => x.email === String(email || '').trim().toLowerCase());
    let valid = false;
    try { valid = !!u && verify(String(password || ''), u.pass); } catch {}
    if (!valid) return fail(res, 401, 'Email ya password galat hai');
    return send(res, 200, await newSession(u));
  }

  const user = authUser(req);
  if (!user) return fail(res, 401, 'Pehle login karein');
  if (m === 'GET' && p === '/api/me') return send(res, 200, publicUser(user));

  if (m === 'POST' && p === '/api/coupon/check') {
    const { code, subtotal } = await body(req);
    const r = applyCoupon(code, Number(subtotal) || 0);
    return r.error ? fail(res, 400, r.error) : send(res, 200, r);
  }
  if (m === 'POST' && p === '/api/cart/quote') {
    const { items, coupon, tip } = await body(req);
    const q = priceCart(items, coupon, tip);
    return q.error ? fail(res, 400, q.error) : send(res, 200, q);
  }
  if (m === 'POST' && p === '/api/orders') {
    const { items, address, coupon, tip, instructions, paymentMethod = 'COD' } = await body(req);
    if (!address || String(address).trim().length < 5) return fail(res, 400, 'Delivery address likhein');
    if (!['COD', 'UPI', 'CARD'].includes(paymentMethod)) return fail(res, 400, 'Payment ka tareeka chunein');
    const q = priceCart(items, coupon, tip);
    if (q.error) return fail(res, 400, q.error);
    const order = {
      id: db.orders.reduce((n, o) => Math.max(n, Number(o.id) || 1000), 1000) + 1,
      userId: user.id, userName: user.name, items: q.lines,
      subtotal: q.subtotal, discount: q.discount, coupon: q.coupon,
      tax: q.tax, deliveryFee: q.deliveryFee, tip: q.tip, total: q.total,
      paymentMethod,
      paymentStatus: paymentMethod === 'COD' ? 'Cash on delivery' : 'Gateway integration pending',
      instructions: String(instructions || '').slice(0, 200) || null,
      address: String(address).slice(0, 200), status: 'Placed',
      createdAt: new Date().toISOString(), etaMinutes: q.etaMinutes,
      estimatedDelivery: q.estimatedDelivery
    };
    db.orders.push(order); await save();
    return send(res, 201, withTotals(order));
  }
  if (m === 'GET' && p === '/api/orders')
    return send(res, 200, db.orders.filter(o => o.userId === user.id).reverse().map(withTotals));

  const cancelMatch = p.match(/^\/api\/orders\/(\d+)\/cancel$/);
  if (m === 'POST' && cancelMatch) {
    const o = db.orders.find(x => x.id === Number(cancelMatch[1]) && x.userId === user.id);
    if (!o) return fail(res, 404, 'Order nahi mila');
    if (o.status !== 'Placed') return fail(res, 400, 'Order ab cancel nahi ho sakta');
    const { reason } = await body(req);
    o.status = 'Cancelled'; o.cancelledAt = new Date().toISOString();
    o.cancelReason = String(reason || '').slice(0, 200) || null;
    o.estimatedDelivery = null; o.etaMinutes = null;
    await save(); return send(res, 200, withTotals(o));
  }

  if (p.startsWith('/api/admin/')) {
    if (!user.isAdmin) return fail(res, 403, 'Sirf admin ke liye');
    if (m === 'GET' && p === '/api/admin/orders')
      return send(res, 200, [...db.orders].reverse().map(withTotals));
    if (m === 'GET' && p === '/api/admin/summary') {
      const all = db.orders.map(withTotals);
      const live = all.filter(o => o.status !== 'Cancelled');
      const delivered = live.filter(o => o.status === 'Delivered');
      return send(res, 200, {
        orders: live.length, totalSales: live.reduce((s, o) => s + o.total, 0),
        deliveredSales: delivered.reduce((s, o) => s + o.total, 0),
        pending: live.filter(o => o.status !== 'Delivered').length,
        cancelled: all.length - live.length,
        cancelledValue: all.filter(o => o.status === 'Cancelled').reduce((s, o) => s + o.total, 0)
      });
    }
    if (m === 'POST' && p === '/api/admin/restaurants') {
      const b = await body(req);
      if (!b.name || !b.cuisine) return fail(res, 400, 'Naam aur cuisine zaroori hai');
      const r = { id: Date.now(), name: String(b.name).slice(0, 80), cuisine: String(b.cuisine).slice(0, 50),
        rating: 4, time: Math.min(180, Math.max(5, Number(b.time) || 30)),
        emoji: String(b.emoji || '🍽️').slice(0, 8), bg: '#f1f1f1', menu: [] };
      db.restaurants.push(r); await save(); return send(res, 201, r);
    }
    if (m === 'POST' && p === '/api/admin/dishes') {
      const { rid, name, price } = await body(req);
      const r = db.restaurants.find(x => x.id === Number(rid));
      if (!r || !name || !(Number(price) > 0) || Number(price) > 100000)
        return fail(res, 400, 'Restaurant, dish ka naam aur valid price dein');
      if (r.menu.some(d => d.name.toLowerCase() === String(name).trim().toLowerCase()))
        return fail(res, 409, 'Ye dish pehle se maujood hai');
      r.menu.push({ name: String(name).slice(0, 80), price: Number(price) });
      await save(); return send(res, 201, r);
    }
    if (m === 'POST' && p === '/api/admin/coupons') {
      const b = await body(req), code = String(b.code || '').trim().toUpperCase();
      if (!code || !['flat', 'percent'].includes(b.type) || !(Number(b.value) > 0))
        return fail(res, 400, 'Code, type aur value sahi dein');
      if (db.coupons.some(c => c.code === code)) return fail(res, 409, 'Coupon pehle se hai');
      db.coupons.push({ code, type: b.type, value: Number(b.value), min: Math.max(0, Number(b.min) || 0),
        max: b.max ? Math.max(0, Number(b.max)) : undefined,
        text: `${b.type === 'flat' ? '₹' + b.value : b.value + '%'} off` });
      await save(); return send(res, 201, db.coupons);
    }
    const deleteRestaurant = p.match(/^\/api\/admin\/restaurants\/(\d+)\/delete$/);
    if (m === 'POST' && deleteRestaurant) {
      const i = db.restaurants.findIndex(x => x.id === Number(deleteRestaurant[1]));
      if (i < 0) return fail(res, 404, 'Restaurant nahi mila');
      db.restaurants.splice(i, 1); await save(); return send(res, 200, { ok: true });
    }
    if (m === 'POST' && p === '/api/admin/dishes/delete') {
      const { rid, name } = await body(req);
      const r = db.restaurants.find(x => x.id === Number(rid));
      const i = r ? r.menu.findIndex(d => d.name === name) : -1;
      if (i < 0) return fail(res, 404, 'Dish nahi mili');
      r.menu.splice(i, 1); await save(); return send(res, 200, { ok: true });
    }
    const statusMatch = p.match(/^\/api\/admin\/orders\/(\d+)\/status$/);
    if (m === 'POST' && statusMatch) {
      const o = db.orders.find(x => x.id === Number(statusMatch[1]));
      const b = await body(req), allowed = ['Placed', 'Preparing', 'Out for delivery', 'Delivered', 'Cancelled'];
      if (!o || !allowed.includes(b.status)) return fail(res, 400, 'Galat order ya status');
      if (['Delivered', 'Cancelled'].includes(o.status)) return fail(res, 400, 'Order final ho chuka hai');
      o.status = b.status;
      if (b.status === 'Cancelled') {
        o.cancelledAt = new Date().toISOString(); o.cancelReason = String(b.reason || '').slice(0, 200) || null;
        o.etaMinutes = null; o.estimatedDelivery = null;
      } else if (b.status === 'Delivered') {
        o.deliveredAt = new Date().toISOString(); o.etaMinutes = 0; o.estimatedDelivery = o.deliveredAt;
      } else if (b.minutes !== undefined && Number(b.minutes) >= 0 && Number(b.minutes) <= 300) {
        o.etaMinutes = Number(b.minutes); o.estimatedDelivery = addMinutes(o.etaMinutes);
      } else if (b.status === 'Out for delivery') {
        o.etaMinutes = 15; o.estimatedDelivery = addMinutes(15);
      }
      await save(); return send(res, 200, withTotals(o));
    }
    const etaMatch = p.match(/^\/api\/admin\/orders\/(\d+)\/eta$/);
    if (m === 'POST' && etaMatch) {
      const o = db.orders.find(x => x.id === Number(etaMatch[1]));
      const { minutes } = await body(req);
      if (!o || ['Delivered', 'Cancelled'].includes(o.status) || !(Number(minutes) >= 0 && Number(minutes) <= 300))
        return fail(res, 400, 'Galat order ya ETA (0-300 minutes)');
      o.etaMinutes = Number(minutes); o.estimatedDelivery = addMinutes(o.etaMinutes);
      await save(); return send(res, 200, withTotals(o));
    }
  }
  return fail(res, 404, 'Ye API nahi mili');
}

const PAGES = {"app.js": "let state = { rests: [], filter: 'All', q: '', open: null, view: 'home', cart: {}, discount: 0, coupon: '', user: null, token: localStorage.getItem('token') || '', mode: 'login' };\nconst $ = id => document.getElementById(id);\nconst esc = s => String(s).replace(/[&<>\"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' }[c]));\nconst toast = m => { const t = $('toast'); t.textContent = m; t.classList.remove('hidden'); setTimeout(() => t.classList.add('hidden'), 2200); };\n\nasync function api(path, method = 'GET', data) {\n  const r = await fetch('/api' + path, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.token }, body: data ? JSON.stringify(data) : undefined });\n  const j = await r.json();\n  if (!r.ok) throw new Error(j.error || 'Kuch galat hua');\n  return j;\n}\nconst needLogin = () => { if (state.user) return false; openModal(); return true; };\n\n/* ---------- Auth ---------- */\nfunction openModal() { $('modal').classList.remove('hidden'); setMode(state.mode); }\nfunction setMode(m) {\n  state.mode = m; $('mErr').textContent = '';\n  $('mTitle').textContent = m === 'login' ? 'Login' : 'Naya account';\n  $('mName').classList.toggle('hidden', m === 'login');\n  $('mGo').textContent = m === 'login' ? 'Login karein' : 'Account banayein';\n  $('mSwitch').textContent = m === 'login' ? 'Naya account banayein' : 'Pehle se account hai? Login';\n}\n$('mSwitch').onclick = e => { e.preventDefault(); setMode(state.mode === 'login' ? 'signup' : 'login'); };\n$('mClose').onclick = e => { e.preventDefault(); $('modal').classList.add('hidden'); };\n$('mGo').onclick = async () => {\n  try {\n    const d = { email: $('mEmail').value, password: $('mPass').value, name: $('mName').value };\n    const r = await api(state.mode === 'login' ? '/login' : '/signup', 'POST', d);\n    state.token = r.token; state.user = r.user; localStorage.setItem('token', r.token);\n    $('modal').classList.add('hidden'); updateAuth(); toast('Namaste, ' + r.user.name + '!'); render();\n  } catch (e) { $('mErr').textContent = e.message; }\n};\n$('authBtn').onclick = () => {\n  if (!state.user) return openModal();\n  state.token = ''; state.user = null; localStorage.removeItem('token'); state.view = 'home'; updateAuth(); render(); toast('Logout ho gaye');\n};\nfunction updateAuth() {\n  $('authBtn').textContent = state.user ? `Logout (${state.user.name.split(' ')[0]})` : 'Login';\n  $('adminTab').classList.toggle('hidden', !(state.user && state.user.isAdmin));\n}\n\n/* ---------- Views ---------- */\ndocument.querySelectorAll('.tabs button').forEach(b => b.onclick = () => { if (b.dataset.v !== 'home' && needLogin()) return; state.view = b.dataset.v; render(); });\n$('search').oninput = e => { state.q = e.target.value; if (state.view === 'home') render(); };\n\nasync function render() {\n  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.v === state.view));\n  try {\n    if (state.view === 'home') return renderHome();\n    if (state.view === 'orders') return renderOrders();\n    if (state.view === 'admin') return await renderAdmin();\n  } catch (e) { $('view').innerHTML = `<p class=\"err\">${esc(e.message)}</p>`; }\n}\n\nfunction renderHome() {\n  const cuisines = ['All', ...new Set(state.rests.map(r => r.cuisine))], q = state.q.toLowerCase();\n  const rows = state.rests.filter(r => (state.filter === 'All' || r.cuisine === state.filter) &&\n    (!q || r.name.toLowerCase().includes(q) || r.menu.some(m => m.name.toLowerCase().includes(q))));\n  $('view').innerHTML = `<h1>Bhookh lagi hai? Order karo.</h1>\n    <div class=\"chips\">${cuisines.map(c => `<button class=\"chip ${c === state.filter ? 'on' : ''}\" data-c=\"${esc(c)}\">${esc(c)}</button>`).join('')}</div>\n    <div class=\"grid\">${rows.length ? rows.map(r => `\n      <div class=\"card\" data-id=\"${r.id}\"><div class=\"pic\" style=\"background:${esc(r.bg)}\">${esc(r.emoji)}</div>\n      <div class=\"body\"><h3>${esc(r.name)}</h3><div class=\"meta\"><span>${esc(r.cuisine)} • ${r.time} min</span><span class=\"rating\">${r.rating} ★</span></div></div></div>\n      ${r.id === state.open ? `<div class=\"menu\"><h2>${esc(r.name)} ka menu</h2>${r.menu.length ? r.menu.map((d, i) => `<div class=\"dish\"><span>${esc(d.name)} – ₹${d.price}</span><button data-add=\"${r.id}|${i}\">Add karein</button></div>`).join('') : '<p class=\"note\">Abhi menu khali hai.</p>'}</div>` : ''}`).join('') : '<p>Kuch nahi mila. Koi aur naam try karein.</p>'}</div>`;\n  $('view').querySelectorAll('.chip').forEach(b => b.onclick = () => { state.filter = b.dataset.c; state.open = null; renderHome(); });\n  $('view').querySelectorAll('.card').forEach(c => c.onclick = () => { const id = +c.dataset.id; state.open = state.open === id ? null : id; renderHome(); });\n  $('view').querySelectorAll('[data-add]').forEach(b => b.onclick = () => {\n    const [rid, i] = b.dataset.add.split('|'), r = state.rests.find(x => x.id == rid), d = r.menu[i], k = rid + '|' + d.name;\n    state.cart[k] = { rid: r.id, name: d.name, price: d.price, qty: (state.cart[k]?.qty || 0) + 1 }; resetCoupon(); renderCart(); toast(d.name + ' add hua');\n  });\n}\n\nasync function renderOrders() {\n  const orders = await api('/orders');\n  $('view').innerHTML = `<h1>Meri orders</h1>` + (orders.length ? orders.map(o => `<div class=\"item\">\n    <div class=\"row\"><strong>Order #${o.id}</strong><span class=\"badge\">${esc(o.status)}</span></div>\n    <p class=\"note\">${new Date(o.createdAt).toLocaleString('hi-IN')} • ${esc(o.address)}</p>\n    <p class=\"note\">Payment: ${esc({UPI:'UPI',CARD:'Card',COD:'Cash on delivery'}[o.paymentMethod]||'-')} • ${esc(o.paymentStatus||'')}</p>\n    ${o.items.map(i => `<div class=\"row\"><span>${esc(i.name)} × ${i.qty}</span><span>₹${i.price * i.qty}</span></div>`).join('')}\n    ${o.discount ? `<div class=\"row ok\"><span>Coupon ${esc(o.coupon)}</span><span>−₹${o.discount}</span></div>` : ''}\n    <div class=\"row\"><strong>Total</strong><strong>₹${o.total}</strong></div></div>`).join('') : '<p>Abhi tak koi order nahi. Restaurants se order karein.</p>');\n}\n\nasync function renderAdmin() {\n  const orders = await api('/admin/orders'), st = ['Placed', 'Preparing', 'Out for delivery', 'Delivered'];\n  $('view').innerHTML = `<h1>Admin panel</h1><div class=\"two\">\n    <div class=\"box\"><h3>Naya restaurant</h3><input id=\"aN\" placeholder=\"Naam\"><input id=\"aC\" placeholder=\"Cuisine\"><input id=\"aE\" placeholder=\"Emoji (🍜)\"><input id=\"aT\" placeholder=\"Delivery time (min)\" type=\"number\"><button class=\"primary wide\" id=\"aR\">Add restaurant</button></div>\n    <div class=\"box\"><h3>Nayi dish</h3><select id=\"dR\">${state.rests.map(r => `<option value=\"${r.id}\">${esc(r.name)}</option>`).join('')}</select><input id=\"dN\" placeholder=\"Dish ka naam\"><input id=\"dP\" placeholder=\"Price (₹)\" type=\"number\"><button class=\"primary wide\" id=\"aD\">Add dish</button></div>\n    <div class=\"box\"><h3>Naya coupon</h3><input id=\"cC\" placeholder=\"Code (jaise DIWALI20)\"><select id=\"cT\"><option value=\"percent\">Percent %</option><option value=\"flat\">Flat ₹</option></select><input id=\"cV\" placeholder=\"Value\" type=\"number\"><input id=\"cM\" placeholder=\"Minimum order (₹)\" type=\"number\"><button class=\"primary wide\" id=\"aCp\">Add coupon</button></div></div>\n    <h2>Restaurants aur menu</h2>${state.rests.map(r => `<div class=\"item\"><div class=\"row\"><strong>${esc(r.emoji)} ${esc(r.name)}</strong><button data-delr=\"${r.id}\">Restaurant hatayein</button></div>${r.menu.map((d, i) => `<div class=\"row\"><span>${esc(d.name)} – ₹${d.price}</span><button data-deld=\"${r.id}|${i}\">Hatayein</button></div>`).join('')}</div>`).join('')}\n    <h2>Saari orders</h2>${orders.length ? orders.map(o => `<div class=\"item\"><div class=\"row\"><strong>#${o.id} – ${esc(o.userName)}</strong><span>₹${o.total}</span></div>\n    <p class=\"note\">${o.items.map(i => esc(i.name) + '×' + i.qty).join(', ')}<br>${esc(o.address)}</p>\n    <select data-o=\"${o.id}\">${st.map(s => `<option ${s === o.status ? 'selected' : ''}>${s}</option>`).join('')}</select></div>`).join('') : '<p>Abhi koi order nahi.</p>'}`;\n  const act = (id, fn) => $(id).onclick = async () => { try { await fn(); await loadRests(); toast('Ho gaya'); render(); } catch (e) { toast(e.message); } };\n  act('aR', () => api('/admin/restaurants', 'POST', { name: $('aN').value, cuisine: $('aC').value, emoji: $('aE').value, time: $('aT').value }));\n  act('aD', () => api('/admin/dishes', 'POST', { rid: $('dR').value, name: $('dN').value, price: $('dP').value }));\n  act('aCp', () => api('/admin/coupons', 'POST', { code: $('cC').value, type: $('cT').value, value: $('cV').value, min: $('cM').value }));\n  $('view').querySelectorAll('[data-delr]').forEach(b => b.onclick = async () => { if (!confirm('Ye restaurant aur uska poora menu hat jayega. Pakka?')) return; try { await api(`/admin/restaurants/${b.dataset.delr}/delete`, 'POST', {}); await loadRests(); toast('Restaurant hat gaya'); render(); } catch (e) { toast(e.message); } });\n  $('view').querySelectorAll('[data-deld]').forEach(b => b.onclick = async () => { const [rid, i] = b.dataset.deld.split('|'), r = state.rests.find(x => x.id == rid), d = r && r.menu[i]; if (!d || !confirm(d.name + ' hatana hai?')) return; try { await api('/admin/dishes/delete', 'POST', { rid: Number(rid), name: d.name }); await loadRests(); toast('Dish hat gayi'); render(); } catch (e) { toast(e.message); } });\n  $('view').querySelectorAll('[data-o]').forEach(s => s.onchange = async () => { try { await api(`/admin/orders/${s.dataset.o}/status`, 'POST', { status: s.value }); toast('Status badal gaya'); } catch (e) { toast(e.message); } });\n}\n\n/* ---------- Cart ---------- */\nconst subtotal = () => Object.values(state.cart).reduce((s, i) => s + i.price * i.qty, 0);\nfunction resetCoupon() { state.discount = 0; state.coupon = ''; $('couponMsg').textContent = ''; }\nfunction renderCart() {\n  const items = Object.entries(state.cart), sub = subtotal();\n  $('cartItems').innerHTML = items.length ? items.map(([k, i]) => `<div class=\"line\"><span>${esc(i.name)}<br><small>₹${i.price}</small></span>\n    <span><button data-k=\"${esc(k)}\" data-d=\"-1\" aria-label=\"Kam karein\">−</button> ${i.qty} <button data-k=\"${esc(k)}\" data-d=\"1\" aria-label=\"Badhayein\">+</button></span></div>`).join('') : '<p>Cart khali hai. Menu se dish add karein.</p>';\n  $('cartItems').querySelectorAll('button').forEach(b => b.onclick = () => {\n    state.cart[b.dataset.k].qty += +b.dataset.d; if (state.cart[b.dataset.k].qty <= 0) delete state.cart[b.dataset.k]; resetCoupon(); renderCart();\n  });\n  $('cartCount').textContent = items.reduce((s, [, i]) => s + i.qty, 0);\n  $('sum').innerHTML = `<div><span>Subtotal</span><span>₹${sub}</span></div>${state.discount ? `<div class=\"ok\"><span>Discount (${esc(state.coupon)})</span><span>−₹${state.discount}</span></div>` : ''}<div><strong>Total</strong><strong>₹${sub - state.discount}</strong></div>`;\n}\n$('cartBtn').onclick = () => $('cart').classList.remove('hidden');\n$('closeCart').onclick = () => $('cart').classList.add('hidden');\n$('applyCoupon').onclick = async () => {\n  if (needLogin()) return;\n  const m = $('couponMsg'); m.className = 'note';\n  try { const r = await api('/coupon/check', 'POST', { code: $('coupon').value, subtotal: subtotal() }); state.discount = r.discount; state.coupon = r.code; m.textContent = `${r.code} lag gaya, ₹${r.discount} bachat!`; m.classList.add('ok'); renderCart(); }\n  catch (e) { m.textContent = e.message; m.classList.add('err'); }\n};\nconst luhn = n => { let s = 0, d = false; for (let i = n.length - 1; i >= 0; i--) { let x = +n[i]; if (d) { x *= 2; if (x > 9) x -= 9; } s += x; d = !d; } return s % 10 === 0; };\nlet payMethod = 'UPI';\nfunction setPay(m) {\n  payMethod = m; $('payErr').textContent = '';\n  document.querySelectorAll('#payTabs button').forEach(b => b.classList.toggle('on', b.dataset.m === m));\n  ['UPI', 'CARD', 'COD'].forEach(x => $('p' + x).classList.toggle('hidden', x !== m));\n  $('payGo').textContent = m === 'COD' ? 'Order confirm karein' : `₹${subtotal() - state.discount} pay karein`;\n}\ndocument.querySelectorAll('#payTabs button').forEach(b => b.onclick = () => setPay(b.dataset.m));\n$('cardNo').oninput = e => { e.target.value = e.target.value.replace(/\\D/g, '').slice(0, 16).replace(/(.{4})/g, '$1 ').trim(); };\n$('cardExp').oninput = e => { let v = e.target.value.replace(/\\D/g, '').slice(0, 4); e.target.value = v.length > 2 ? v.slice(0, 2) + '/' + v.slice(2) : v; };\n$('payClose').onclick = e => { e.preventDefault(); $('payModal').classList.add('hidden'); };\n\n$('checkout').onclick = () => {\n  if (needLogin()) return;\n  if (!Object.keys(state.cart).length) return toast('Pehle kuch add karein');\n  if ($('address').value.trim().length < 5) return toast('Delivery address likhein');\n  $('payModal').classList.remove('hidden'); setPay(payMethod);\n};\nfunction checkPay() {\n  if (payMethod === 'UPI' && !/^[\\w.\\-]{2,}@[a-zA-Z]{2,}$/.test($('upiId').value.trim())) return 'Sahi UPI ID likhein (jaise naam@upi)';\n  if (payMethod === 'CARD') {\n    const n = $('cardNo').value.replace(/\\s/g, ''), [mm, yy] = $('cardExp').value.split('/').map(Number), now = new Date();\n    if (n.length !== 16 || !luhn(n)) return 'Card number galat hai';\n    if (!(mm >= 1 && mm <= 12) || !(yy >= 0) || (2000 + yy) * 12 + mm < now.getFullYear() * 12 + now.getMonth() + 1) return 'Expiry date galat hai';\n    if (!/^\\d{3}$/.test($('cardCvv').value)) return 'CVV 3 ank ka hona chahiye';\n  }\n  return '';\n}\n$('payGo').onclick = async () => {\n  const err = checkPay(); $('payErr').textContent = err; if (err) return;\n  const btn = $('payGo'), label = btn.textContent; btn.disabled = true; btn.textContent = 'Payment ho rahi hai…';\n  await new Promise(r => setTimeout(r, 1500)); // demo: asli gateway yahan aayega\n  try {\n    const o = await api('/orders', 'POST', { items: Object.values(state.cart).map(i => ({ rid: i.rid, name: i.name, qty: i.qty })), address: $('address').value, coupon: state.coupon, paymentMethod: payMethod });\n    state.cart = {}; resetCoupon(); $('coupon').value = ''; ['upiId', 'cardNo', 'cardExp', 'cardCvv'].forEach(id => $(id).value = '');\n    renderCart(); $('payModal').classList.add('hidden'); $('cart').classList.add('hidden');\n    toast(`Order #${o.id} place ho gaya! 🎉`); state.view = 'orders'; render();\n  } catch (e) { $('payErr').textContent = e.message; }\n  btn.disabled = false; btn.textContent = label;\n};\n\n/* ---------- Start ---------- */\nasync function loadRests() { state.rests = await api('/restaurants'); }\n(async () => {\n  if (state.token) { try { state.user = await api('/me'); } catch { state.token = ''; localStorage.removeItem('token'); } }\n  await loadRests(); updateAuth(); renderCart(); render();\n})();\n", "style.css": ":root{--red:#e23744;--ink:#1c1c1c;--muted:#6b6b6b;--bg:#fff8f5;--line:#ecdcd5}\n*{box-sizing:border-box}body{margin:0;font-family:Georgia,serif;background:var(--bg);color:var(--ink)}\nbutton,input,select{font:inherit}input,select{padding:9px 12px;border:1px solid var(--line);border-radius:8px;width:100%;margin:4px 0;background:#fff}\nbutton{cursor:pointer;border-radius:8px;padding:9px 14px;border:1px solid var(--line);background:#fff}\n.primary{background:var(--red);color:#fff;border-color:var(--red)}.ghost{background:#fff}.wide{width:100%;margin-top:8px}\n.top{position:sticky;top:0;z-index:5;display:flex;flex-wrap:wrap;gap:10px;align-items:center;padding:10px 20px;background:#fff;border-bottom:1px solid var(--line)}\n.brand{font-size:1.5rem;font-weight:bold;font-style:italic;color:var(--red)}\n.tabs{display:flex;gap:4px}.tabs button{border:0;background:none}.tabs .on{color:var(--red);font-weight:bold;border-bottom:2px solid var(--red);border-radius:0}\n#search{flex:1;min-width:160px;width:auto;margin:0}\nmain{max-width:1000px;margin:auto;padding:20px}\nh1{font-size:clamp(1.7rem,5vw,2.6rem);margin:8px 0}\n.chips{display:flex;gap:8px;overflow-x:auto;padding:8px 0}.chip{border-radius:20px;white-space:nowrap}.chip.on{background:var(--red);color:#fff;border-color:var(--red)}\n.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:16px}\n.card{background:#fff;border:1px solid var(--line);border-radius:12px;overflow:hidden;cursor:pointer}\n.pic{height:120px;display:grid;place-items:center;font-size:3.4rem}.body{padding:12px 14px}.body h3{margin:0 0 4px}\n.meta{display:flex;justify-content:space-between;color:var(--muted);font-size:.9rem}.rating{background:#267e3e;color:#fff;border-radius:6px;padding:1px 7px}\n.box,.menu,.item{background:#fff;border:1px solid var(--line);border-radius:12px;padding:16px;margin:12px 0}\n.menu{grid-column:1/-1;margin:0}.dish,.line,.row{display:flex;justify-content:space-between;align-items:center;gap:8px}\n.dish,.line{padding:9px 0;border-top:1px solid var(--line)}\n.dish button{border-color:var(--red);color:var(--red)}\n.panel{position:fixed;right:0;top:0;bottom:0;width:min(380px,100%);background:#fff;border-left:1px solid var(--line);padding:16px;z-index:10;display:flex;flex-direction:column}\n.grow{flex:1;overflow:auto}.coupon{display:flex;gap:6px}.coupon input{margin:4px 0}.coupon button{margin:4px 0}\n.line button{width:26px;height:26px;padding:0;border-radius:50%}.sum div{display:flex;justify-content:space-between;padding:2px 0}\n.modal{position:fixed;inset:0;background:#0007;z-index:30;display:grid;place-items:center}.modal .box{width:min(380px,92%)}\n.note{color:var(--muted);font-size:.9rem;margin:4px 0}.err{color:var(--red);min-height:1.2em;margin:4px 0}.ok{color:#267e3e}\n.badge{display:inline-block;padding:2px 10px;border-radius:12px;background:#ffe3d6;font-size:.85rem}\n.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:var(--ink);color:#fff;padding:10px 18px;border-radius:8px;z-index:40}\n.two{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}\n.hidden{display:none!important}:focus-visible{outline:2px solid var(--red);outline-offset:2px}\n", "index.html": "<!DOCTYPE html>\n<html lang=\"hi\"><head><meta charset=\"UTF-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>Swaadly – Food Delivery</title><link rel=\"stylesheet\" href=\"style.css\"></head>\n<body>\n<header class=\"top\">\n  <div class=\"brand\">swaadly</div>\n  <nav class=\"tabs\"><button data-v=\"home\">Restaurants</button><button data-v=\"orders\">Meri orders</button><button data-v=\"admin\" id=\"adminTab\" class=\"hidden\">Admin</button></nav>\n  <input id=\"search\" type=\"search\" placeholder=\"Restaurant ya dish search karein…\">\n  <button id=\"authBtn\" class=\"ghost\">Login</button>\n  <button id=\"cartBtn\" class=\"primary\">Cart (<span id=\"cartCount\">0</span>)</button>\n</header>\n<main id=\"view\"></main>\n\n<aside id=\"cart\" class=\"panel hidden\">\n  <div class=\"row\"><h2>Aapka cart</h2><button id=\"closeCart\" class=\"ghost\">Band karein</button></div>\n  <div id=\"cartItems\" class=\"grow\"></div>\n  <div class=\"coupon\"><input id=\"coupon\" placeholder=\"Coupon code (jaise WELCOME50)\"><button id=\"applyCoupon\" class=\"ghost\">Lagayein</button></div>\n  <p id=\"couponMsg\" class=\"note\"></p>\n  <input id=\"address\" placeholder=\"Delivery address\">\n  <div class=\"sum\" id=\"sum\"></div>\n  <button id=\"checkout\" class=\"primary wide\">Order place karein</button>\n</aside>\n\n<div id=\"modal\" class=\"modal hidden\"><div class=\"box\">\n  <h2 id=\"mTitle\">Login</h2>\n  <input id=\"mName\" placeholder=\"Aapka naam\"><input id=\"mEmail\" type=\"email\" placeholder=\"Email\"><input id=\"mPass\" type=\"password\" placeholder=\"Password (kam se kam 6 akshar)\">\n  <p id=\"mErr\" class=\"err\"></p>\n  <button id=\"mGo\" class=\"primary wide\">Login karein</button>\n  <p class=\"note\"><a href=\"#\" id=\"mSwitch\">Naya account banayein</a> · <a href=\"#\" id=\"mClose\">Band karein</a></p>\n</div></div>\n<div id=\"payModal\" class=\"modal hidden\"><div class=\"box\">\n  <h2>Payment</h2>\n  <p class=\"note\">Demo hai: asli paise nahi kategi aur card ki details kahin save ya server par nahi bheji jaati.</p>\n  <div class=\"row\" id=\"payTabs\"><button data-m=\"UPI\" class=\"chip on\">UPI</button><button data-m=\"CARD\" class=\"chip\">Card</button><button data-m=\"COD\" class=\"chip\">Cash on delivery</button></div>\n  <div id=\"pUPI\"><input id=\"upiId\" placeholder=\"UPI ID (jaise naam@upi)\"></div>\n  <div id=\"pCARD\" class=\"hidden\"><input id=\"cardNo\" inputmode=\"numeric\" placeholder=\"Card number (test: 4242 4242 4242 4242)\" maxlength=\"19\">\n    <div class=\"coupon\"><input id=\"cardExp\" placeholder=\"MM/YY\" maxlength=\"5\"><input id=\"cardCvv\" type=\"password\" inputmode=\"numeric\" placeholder=\"CVV\" maxlength=\"3\"></div></div>\n  <p id=\"pCOD\" class=\"note hidden\">Order milne par delivery partner ko cash ya UPI se payment karein.</p>\n  <p id=\"payErr\" class=\"err\"></p>\n  <button id=\"payGo\" class=\"primary wide\">Pay karein</button>\n  <p class=\"note\"><a href=\"#\" id=\"payClose\">Wapas jayein</a></p>\n</div></div>\n<div id=\"toast\" class=\"toast hidden\"></div>\n<script src=\"app.js\"></script></body></html>\n"};
const ROUTES = {"/": "index.html", "/index.html": "index.html", "/style.css": "style.css", "/app.js": "app.js"};
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    const name = ROUTES[url.pathname];
    if (!name) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(name)] });
    res.end(PAGES[name]);
  } catch (e) { fail(res, 400, e.message || 'Kuch galat hua'); }
});
(async () => {
  try {
    const raw = await storeGet();
    db = raw ? JSON.parse(raw) : seed();
    if (!raw) await save();
  } catch (e) { // data na mile to naya khali db BANA KAR purana mita na dein: band ho jayein
    console.error('Database se connect nahi ho paya:', e.message); process.exit(1);
  }
  server.listen(PORT, () => console.log(`Swaadly chal raha hai (storage: ${REDIS_URL ? 'Upstash Redis' : 'local file'}) port ${PORT}`));
})();
