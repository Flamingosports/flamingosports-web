/* =====================================================
   Flamingo Sports — Cart
   Flujo: carrito → datos de envío → MP → gracias
   ===================================================== */

const WORKER_URL = 'https://mp-preference.flamingosport-cl.workers.dev';
const PRICE      = 9990;
const CART_KEY   = 'flamingo_cart';
const COUPON_KEY = 'flamingo_coupon';

// El cupón guardado ya viene validado por el Worker; igual se revalida al pagar
function getCoupon() {
  try { return JSON.parse(sessionStorage.getItem(COUPON_KEY) || 'null'); }
  catch { return null; }
}

// ── Estado del carrito ────────────────────────────────
const Cart = {
  get() {
    try { return JSON.parse(localStorage.getItem(CART_KEY) || '[]'); }
    catch { return []; }
  },
  save(items) { localStorage.setItem(CART_KEY, JSON.stringify(items)); Cart.refresh(); },
  add(product) {
    const items = Cart.get();
    const idx   = items.findIndex(i => i.id === product.id);
    if (idx >= 0) items[idx].qty += 1;
    else          items.push({ ...product, qty: 1, price: PRICE });
    Cart.save(items);
    Cart.open();
    if (typeof gtag === 'function') gtag('event', 'add_to_cart', {
      currency: 'CLP', value: PRICE,
      items: [{ item_id: product.id, item_name: product.name, price: PRICE, quantity: 1 }],
    });
    if (typeof fbq === 'function') fbq('track', 'AddToCart', {
      content_ids: [product.id], content_name: product.name,
      content_type: 'product', currency: 'CLP', value: PRICE,
    });
  },
  remove(id)        { Cart.save(Cart.get().filter(i => i.id !== id)); },
  setQty(id, qty)   {
    const q = parseInt(qty);
    if (q < 1) { Cart.remove(id); return; }
    const items = Cart.get();
    const idx   = items.findIndex(i => i.id === id);
    if (idx >= 0) { items[idx].qty = q; Cart.save(items); }
  },
  count()  { return Cart.get().reduce((s, i) => s + i.qty, 0); },
  total()  { return Cart.get().reduce((s, i) => s + i.price * i.qty, 0); },
  discount() {
    const c = getCoupon();
    if (!c || !c.valid || Cart.count() < (c.minPairs || 1)) return 0;
    const total = Cart.total();
    const d = c.type === 'percent' ? Math.round(total * c.value / 100) : c.value;
    return Math.max(0, Math.min(d, total));
  },
  totalToPay() { return Cart.total() - Cart.discount(); },
  // Costo de envío según pares y región. Devuelve null si aún no se conoce la
  // región (y no aplica envío gratis). Debe coincidir con computeShipping() del
  // Worker, que es la fuente de verdad de lo que cobra Mercado Pago.
  shippingCost(region) {
    const pairs = Cart.count();
    if (pairs >= 4) return 0;            // envío gratis a todo Chile
    if (!region) return null;           // región aún no seleccionada
    const isRM = /metropolitana/i.test(region);
    if (pairs === 3) return isRM ? 2000 : 3000;
    return isRM ? 3000 : 4000;          // 1–2 pares
  },
  clear()  { localStorage.removeItem(CART_KEY); sessionStorage.removeItem(COUPON_KEY); Cart.refresh(); },
  open()   {
    showCartStep('items');
    document.getElementById('cart-drawer')?.classList.add('open');
    document.getElementById('cart-overlay')?.classList.add('open');
    Cart.renderItems();
  },
  close()  {
    document.getElementById('cart-drawer')?.classList.remove('open');
    document.getElementById('cart-overlay')?.classList.remove('open');
  },
  refresh() {
    const count = Cart.count();
    document.querySelectorAll('.cart-badge').forEach(el => {
      el.textContent = count;
      el.style.display = count > 0 ? 'flex' : 'none';
    });
    Cart.renderItems();
  },
  renderItems() {
    const el = document.getElementById('cart-items');
    if (!el) return;
    const items = Cart.get();
    if (items.length === 0) {
      el.innerHTML = `<div class="cart-empty"><p>Tu carrito está vacío.</p><a href="productos.html" onclick="Cart.close()">Ver productos →</a></div>`;
      document.getElementById('cart-footer').style.display = 'none';
      return;
    }
    document.getElementById('cart-footer').style.display = 'block';
    el.innerHTML = items.map(item => `
      <div class="cart-item" data-id="${item.id}">
        <div class="cart-item-img">
          ${item.image ? `<img src="${item.image}" alt="${item.name}">` : '<div class="cart-item-placeholder">🦩</div>'}
        </div>
        <div class="cart-item-info">
          <div class="cart-item-name">${item.name}</div>
          <div class="cart-item-type">${item.type || ''}</div>
          <div class="cart-item-price">$${(item.price * item.qty).toLocaleString('es-CL')}</div>
        </div>
        <div class="cart-item-controls">
          <button class="qty-btn" onclick="Cart.setQty('${item.id}', ${item.qty - 1})">−</button>
          <span class="qty-val">${item.qty}</span>
          <button class="qty-btn" onclick="Cart.setQty('${item.id}', ${item.qty + 1})">+</button>
          <button class="remove-btn" onclick="Cart.remove('${item.id}')">✕</button>
        </div>
      </div>`).join('');
    // Totales (con descuento si hay cupón aplicado)
    const coupon = getCoupon();
    const disc = Cart.discount();
    const block = document.getElementById('cart-discount-block');
    const msg = document.getElementById('coupon-msg');
    if (block) {
      if (disc > 0 && coupon) {
        block.style.display = 'block';
        document.getElementById('cart-subtotal-amount').textContent = '$' + Cart.total().toLocaleString('es-CL');
        document.getElementById('cart-discount-label').textContent = `${coupon.code} · ${coupon.label}`;
        document.getElementById('cart-discount-amount').textContent = '−$' + disc.toLocaleString('es-CL');
      } else {
        block.style.display = 'none';
        // cupón guardado pero ya no aplica (p. ej. bajó de los pares mínimos)
        if (coupon && msg && Cart.count() > 0 && Cart.count() < (coupon.minPairs || 1)) {
          msg.textContent = `El código ${coupon.code} requiere mínimo ${coupon.minPairs} pares`;
          msg.className = 'coupon-msg error';
        }
      }
    }
    document.getElementById('cart-total-amount').textContent = '$' + Cart.totalToPay().toLocaleString('es-CL');
    const rates = document.getElementById('cart-ship-rates');
    if (rates) rates.innerHTML = shipRatesHTML(Cart.count());
  },
};

// Tabla de tarifas de envío. Resalta la fila que aplica según los pares en el
// carrito, para transparentar el costo (Santiago vs regiones, por cantidad).
function shipRatesHTML(pairs) {
  const tiers = [
    { label: '1–2 pares', active: pairs <= 2,            rm: '$3.000', reg: '$4.000' },
    { label: '3 pares',   active: pairs === 3,           rm: '$2.000', reg: '$3.000' },
    { label: '4 o más',   active: pairs >= 4, free: true, rm: 'Gratis', reg: 'Gratis' },
  ];
  const cell = (txt, free) => free ? `<span class="free">${txt}</span>` : txt;
  const rows = tiers.map(t =>
    `<tr class="${t.active ? 'active' : ''}"><td>${t.label}</td><td>${cell(t.rm, t.free)}</td><td>${cell(t.reg, t.free)}</td></tr>`
  ).join('');
  return `
    <div class="ship-rates">
      <div class="ship-rates-title">🦩 Costo de envío</div>
      <table>
        <thead><tr><th>Pares</th><th>Santiago</th><th>Regiones</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// ── Cupones ───────────────────────────────────────────
async function applyCoupon() {
  const input = document.getElementById('coupon-input');
  const msg = document.getElementById('coupon-msg');
  const code = (input.value || '').trim();
  if (!code) return;
  msg.textContent = 'Verificando…';
  msg.className = 'coupon-msg';
  try {
    const res = await fetch(`${WORKER_URL}/validate-coupon?code=${encodeURIComponent(code)}&pairs=${Cart.count()}`);
    const data = await res.json();
    if (data.valid) {
      sessionStorage.setItem(COUPON_KEY, JSON.stringify(data));
      msg.textContent = `✓ Código ${data.code} aplicado`;
      msg.className = 'coupon-msg ok';
      input.value = '';
    } else {
      sessionStorage.removeItem(COUPON_KEY);
      msg.textContent = data.reason || 'Código no válido';
      msg.className = 'coupon-msg error';
    }
  } catch {
    msg.textContent = 'No pudimos verificar el código. Intenta de nuevo.';
    msg.className = 'coupon-msg error';
  }
  Cart.refresh();
}

function removeCoupon() {
  sessionStorage.removeItem(COUPON_KEY);
  const msg = document.getElementById('coupon-msg');
  if (msg) { msg.textContent = ''; msg.className = 'coupon-msg'; }
  Cart.refresh();
}

// ── Pasos del drawer ──────────────────────────────────
function showCartStep(step) {
  document.getElementById('cart-step-items').style.display   = step === 'items'    ? 'flex' : 'none';
  document.getElementById('cart-step-shipping').style.display = step === 'shipping' ? 'flex' : 'none';
}

// ── Formulario de envío ───────────────────────────────
function goToShipping() {
  if (!Cart.get().length) return;
  if (typeof gtag === 'function') gtag('event', 'begin_checkout', {
    currency: 'CLP', value: Cart.totalToPay(),
    items: Cart.get().map(i => ({ item_id: i.id, item_name: i.name, price: i.price, quantity: i.qty })),
  });
  if (typeof fbq === 'function') fbq('track', 'InitiateCheckout', {
    currency: 'CLP', value: Cart.totalToPay(), num_items: Cart.count(),
    content_ids: Cart.get().map(i => i.id), content_type: 'product',
  });
  showCartStep('shipping');
  document.getElementById('cart-header-title').textContent = 'Datos de envío';
  updateShippingSummary();
}

// Recalcula el resumen (subtotal + envío + total) en el paso de despacho.
// Se dispara al entrar al paso y cada vez que cambia la región seleccionada.
function updateShippingSummary() {
  const form = document.getElementById('shipping-form');
  if (!form) return;
  const region   = form.region.value || '';
  const subtotal = Cart.totalToPay();
  const ship     = Cart.shippingCost(region); // null = región no elegida
  const subEl  = document.getElementById('ship-subtotal');
  const costEl = document.getElementById('ship-cost');
  const totEl  = document.getElementById('ship-total');
  if (subEl)  subEl.textContent = '$' + subtotal.toLocaleString('es-CL');
  if (costEl) costEl.textContent = ship === null ? 'Según región'
                                 : ship === 0    ? 'Gratis'
                                 : '$' + ship.toLocaleString('es-CL');
  if (totEl)  totEl.textContent = '$' + (subtotal + (ship || 0)).toLocaleString('es-CL');
}

function backToCart() {
  showCartStep('items');
  document.getElementById('cart-header-title').textContent = 'Tu carrito';
}

async function submitShipping(e) {
  e.preventDefault();
  const btn = document.getElementById('shipping-submit-btn');
  const form = document.getElementById('shipping-form');

  const shipping = {
    nombre:    form.nombre.value.trim(),
    email:     form.email.value.trim(),
    telefono:  form.telefono.value.trim(),
    region:    form.region.value,
    ciudad:    form.ciudad.value.trim(),
    direccion: form.direccion.value.trim(),
    depto:     form.depto.value.trim(),
    notas:     form.notas.value.trim(),
  };

  btn.disabled = true;
  btn.textContent = 'Preparando pago…';

  try {
    const res = await fetch(WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: Cart.get(), shipping, coupon: getCoupon()?.code || null }),
    });
    const data = await res.json();
    if (!data.init_point) throw new Error('Sin init_point');
    // El carrito NO se vacía aquí: si el pago falla o se abandona, el cliente
    // vuelve con su carrito intacto. Se vacía en gracias.html con pago aprobado.
    sessionStorage.setItem('flamingo_order', JSON.stringify({
      pref: data.preference_id,
      total: Cart.totalToPay() + (Cart.shippingCost(shipping.region) || 0),
      items: Cart.get(),
    }));
    window.location.href = data.init_point;
  } catch (err) {
    console.error('Checkout error:', err);
    alert('Hubo un problema. Inténtalo de nuevo.');
    btn.disabled = false;
    btn.textContent = 'Confirmar y pagar';
  }
}

// ── Inyectar HTML del drawer ─────────────────────────
function injectCart() {
  if (document.getElementById('cart-drawer')) return;

  const style = document.createElement('style');
  style.textContent = `
    .cart-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:900;opacity:0;pointer-events:none;transition:opacity .3s;}
    .cart-overlay.open{opacity:1;pointer-events:all;}
    .cart-drawer{position:fixed;top:0;right:0;bottom:0;width:min(460px,100vw);background:#fff;z-index:901;display:flex;flex-direction:column;transform:translateX(100%);transition:transform .35s cubic-bezier(.4,0,.2,1);box-shadow:-8px 0 40px rgba(0,0,0,.18);}
    .cart-drawer.open{transform:translateX(0);}
    .cart-header{display:flex;align-items:center;justify-content:space-between;padding:20px 24px;border-bottom:2px solid #1B2D4A;flex-shrink:0;}
    .cart-header-title{font-family:'Causten',Arial,sans-serif;font-size:14px;font-weight:800;letter-spacing:2.5px;text-transform:uppercase;color:#1B2D4A;}
    .cart-close{background:none;border:none;cursor:pointer;font-size:24px;color:#555;padding:4px;line-height:1;}
    .cart-close:hover{color:#1B2D4A;}

    /* STEP ITEMS */
    #cart-step-items{flex:1;display:flex;flex-direction:column;overflow:hidden;}
    .cart-items{flex:1;overflow-y:auto;padding:16px 24px;}
    .cart-empty{text-align:center;padding:60px 0;color:#555;}
    .cart-empty p{font-family:'Causten',Arial,sans-serif;font-size:16px;margin-bottom:16px;}
    .cart-empty a{font-family:'Causten',Arial,sans-serif;font-size:13px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#F0907C;}
    .cart-item{display:grid;grid-template-columns:72px 1fr auto;gap:14px;align-items:start;padding:18px 0;border-bottom:1px solid #e8e8e8;}
    .cart-item:last-child{border-bottom:none;}
    .cart-item-img{width:72px;height:72px;border-radius:3px;overflow:hidden;background:#f0f0f0;}
    .cart-item-img img{width:100%;height:100%;object-fit:cover;}
    .cart-item-placeholder{width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:28px;}
    .cart-item-name{font-family:'Causten',Arial,sans-serif;font-size:16px;font-weight:800;color:#1B2D4A;margin-bottom:3px;line-height:1.25;}
    .cart-item-type{font-family:'Causten',Arial,sans-serif;font-size:12px;color:#666;margin-bottom:8px;letter-spacing:1px;text-transform:uppercase;}
    .cart-item-price{font-family:'Causten',Arial,sans-serif;font-size:17px;font-weight:800;color:#E07A63;}
    .cart-item-controls{display:flex;align-items:center;gap:8px;margin-top:4px;}
    .qty-btn{width:34px;height:34px;border:1.5px solid #1B2D4A;background:#fff;border-radius:3px;cursor:pointer;font-size:20px;line-height:1;display:flex;align-items:center;justify-content:center;color:#1B2D4A;font-weight:700;transition:all .15s;}
    .qty-btn:hover{background:#1B2D4A;color:#fff;}
    .qty-val{font-family:'Causten',Arial,sans-serif;font-size:16px;font-weight:800;min-width:26px;text-align:center;color:#1B2D4A;}
    .remove-btn{background:none;border:none;cursor:pointer;color:#888;font-size:16px;padding:4px;margin-left:4px;transition:color .15s;}
    .remove-btn:hover{color:#e74c3c;}
    .cart-footer{padding:20px 24px;border-top:2px solid #1B2D4A;background:#fff;flex-shrink:0;}
    .coupon-row{display:flex;gap:8px;margin-bottom:6px;}
    .coupon-row input{flex:1;padding:12px 14px;border:1.5px solid #bbb;border-radius:3px;font-family:'Causten',Arial,sans-serif;font-size:14px;color:#1B2D4A;outline:none;text-transform:uppercase;transition:border-color .15s;box-sizing:border-box;}
    .coupon-row input:focus{border-color:#1B2D4A;}
    .coupon-row input::placeholder{text-transform:none;color:#888;}
    .coupon-row button{padding:12px 20px;background:#fff;color:#1B2D4A;border:1.5px solid #1B2D4A;border-radius:3px;font-family:'Causten',Arial,sans-serif;font-size:12px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;cursor:pointer;transition:all .15s;}
    .coupon-row button:hover{background:#1B2D4A;color:#fff;}
    .coupon-msg{font-family:'Causten',Arial,sans-serif;font-size:13px;margin:0 0 10px;min-height:16px;color:#555;letter-spacing:.3px;}
    .coupon-msg.ok{color:#178045;font-weight:700;}
    .coupon-msg.error{color:#d83a2a;font-weight:700;}
    .cart-sub-line{display:flex;justify-content:space-between;align-items:center;font-family:'Causten',Arial,sans-serif;font-size:14px;color:#444;margin-bottom:7px;}
    .cart-sub-line.discount{color:#178045;font-weight:700;}
    .coupon-remove{background:none;border:none;color:#888;cursor:pointer;font-size:13px;margin-left:8px;padding:2px;vertical-align:middle;}
    .coupon-remove:hover{color:#e74c3c;}
    .cart-total-row{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;}
    .cart-total-label{font-family:'Causten',Arial,sans-serif;font-size:14px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:#1B2D4A;}
    .cart-total-price{font-family:'Causten',Arial,sans-serif;font-size:28px;font-weight:900;color:#1B2D4A;}
    #cart-checkout-btn{display:block;width:100%;padding:18px;background:#E07A63;color:#fff;border:none;border-radius:3px;font-family:'Causten',Arial,sans-serif;font-size:13px;font-weight:800;letter-spacing:2px;text-transform:uppercase;cursor:pointer;transition:background .2s;}
    #cart-checkout-btn:hover{background:#c8624c;}
    .cart-security{text-align:center;margin-top:12px;font-family:'Causten',Arial,sans-serif;font-size:12px;color:#666;letter-spacing:.5px;}

    /* Tabla de tarifas de envío */
    .ship-rates{margin:6px 0 16px;border:1.5px solid #1B2D4A;border-radius:5px;overflow:hidden;}
    .ship-rates-title{background:#1B2D4A;color:#fff;font-family:'Causten',Arial,sans-serif;font-size:12px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;padding:9px 12px;text-align:center;}
    .ship-rates table{width:100%;border-collapse:collapse;font-family:'Causten',Arial,sans-serif;}
    .ship-rates th,.ship-rates td{padding:9px 8px;font-size:13px;text-align:center;}
    .ship-rates thead th{background:#eef1f6;color:#1B2D4A;font-size:11px;font-weight:800;letter-spacing:.8px;text-transform:uppercase;}
    .ship-rates thead th:first-child{text-align:left;}
    .ship-rates tbody td:first-child{text-align:left;color:#1B2D4A;font-weight:800;}
    .ship-rates tbody tr{border-top:1px solid #e5e5e5;color:#333;font-weight:600;}
    .ship-rates tbody tr.active{background:#FDEEEA;}
    .ship-rates tbody tr.active td{color:#1B2D4A;font-weight:900;}
    .ship-rates .free{color:#178045;font-weight:900;}

    /* STEP SHIPPING */
    #cart-step-shipping{flex:1;display:none;flex-direction:column;overflow:hidden;}
    .shipping-form-wrap{flex:1;overflow-y:auto;padding:20px 24px;}
    .shipping-back{background:none;border:none;cursor:pointer;font-family:'Causten',Arial,sans-serif;font-size:12px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#555;display:flex;align-items:center;gap:6px;margin-bottom:20px;padding:0;}
    .shipping-back:hover{color:#1B2D4A;}
    .form-row{margin-bottom:16px;}
    .form-row label{display:block;font-family:'Causten',Arial,sans-serif;font-size:12px;font-weight:800;letter-spacing:1.2px;text-transform:uppercase;color:#1B2D4A;margin-bottom:6px;}
    .form-row input,.form-row select,.form-row textarea{width:100%;padding:13px 14px;border:1.5px solid #bbb;border-radius:3px;font-family:'Causten',Arial,sans-serif;font-size:15px;color:#1B2D4A;background:#fff;outline:none;transition:border-color .15s;box-sizing:border-box;}
    .form-row input:focus,.form-row select:focus,.form-row textarea:focus{border-color:#1B2D4A;}
    .form-row input::placeholder,.form-row textarea::placeholder{color:#999;}
    .form-row textarea{resize:none;height:72px;}
    .form-row-half{display:grid;grid-template-columns:1fr 1fr;gap:12px;}
    .shipping-footer{padding:20px 24px;border-top:2px solid #1B2D4A;background:#fff;flex-shrink:0;}
    .ship-summary{margin-bottom:16px;}
    .ship-line{display:flex;justify-content:space-between;align-items:center;font-family:'Causten',Arial,sans-serif;font-size:15px;color:#333;margin-bottom:9px;font-weight:600;}
    .ship-line.ship-total-line{font-size:20px;font-weight:900;color:#1B2D4A;border-top:1.5px solid #1B2D4A;padding-top:12px;margin-top:4px;}
    #shipping-submit-btn{display:block;width:100%;padding:18px;background:#E07A63;color:#fff;border:none;border-radius:3px;font-family:'Causten',Arial,sans-serif;font-size:13px;font-weight:800;letter-spacing:2px;text-transform:uppercase;cursor:pointer;transition:background .2s;}
    #shipping-submit-btn:hover{background:#c8624c;}
    #shipping-submit-btn:disabled{background:#bbb;cursor:not-allowed;}
    .shipping-security{text-align:center;margin-top:12px;font-family:'Causten',Arial,sans-serif;font-size:12px;color:#666;letter-spacing:.5px;}

    /* Nav badge */
    .cart-icon-btn{background:none;border:none;cursor:pointer;display:flex;align-items:center;gap:6px;color:rgba(255,255,255,.85);padding:8px;transition:color .2s;position:relative;}
    .cart-icon-btn:hover{color:#fff;}
    .cart-icon-btn svg{width:22px;height:22px;}
    .cart-badge{position:absolute;top:-2px;right:-2px;background:#E07A63;color:#fff;border-radius:50%;width:19px;height:19px;font-family:'Causten',Arial,sans-serif;font-size:11px;font-weight:900;display:none;align-items:center;justify-content:center;}
    .btn-add-cart{display:block;width:100%;text-align:center;font-family:'Causten',Arial,sans-serif;font-size:13px;font-weight:800;letter-spacing:2px;text-transform:uppercase;background:#1B2D4A;color:white;padding:18px 32px;border-radius:3px;transition:background .2s;margin-bottom:10px;border:none;cursor:pointer;}
    .btn-add-cart:hover{background:#0e1e32;}
  `;
  document.head.appendChild(style);

  const drawer = document.createElement('div');
  drawer.innerHTML = `
    <div id="cart-overlay" class="cart-overlay" onclick="Cart.close()"></div>
    <div id="cart-drawer" class="cart-drawer">

      <div class="cart-header">
        <span class="cart-header-title" id="cart-header-title">Tu carrito</span>
        <button class="cart-close" onclick="Cart.close()">✕</button>
      </div>

      <!-- PASO 1: Carrito -->
      <div id="cart-step-items" style="display:flex;">
        <div id="cart-items" class="cart-items"></div>
        <div id="cart-footer" class="cart-footer" style="display:none;">
          <div class="coupon-row">
            <input type="text" id="coupon-input" placeholder="Código de descuento" autocomplete="off"
                   onkeydown="if(event.key==='Enter'){event.preventDefault();applyCoupon();}">
            <button type="button" onclick="applyCoupon()">Aplicar</button>
          </div>
          <p id="coupon-msg" class="coupon-msg"></p>
          <div id="cart-discount-block" style="display:none;">
            <div class="cart-sub-line">
              <span>Subtotal</span>
              <span id="cart-subtotal-amount"></span>
            </div>
            <div class="cart-sub-line discount">
              <span id="cart-discount-label"></span>
              <span><span id="cart-discount-amount"></span><button class="coupon-remove" onclick="removeCoupon()" title="Quitar código">✕</button></span>
            </div>
          </div>
          <div class="cart-total-row">
            <span class="cart-total-label">Total</span>
            <span class="cart-total-price" id="cart-total-amount">$0</span>
          </div>
          <div id="cart-ship-rates"></div>
          <button id="cart-checkout-btn" onclick="goToShipping()">Ingresar datos de envío →</button>
          <p class="cart-security">🔒 Pago seguro con Mercado Pago</p>
        </div>
      </div>

      <!-- PASO 2: Datos de envío -->
      <div id="cart-step-shipping">
        <div class="shipping-form-wrap">
          <button class="shipping-back" onclick="backToCart()">← Volver al carrito</button>
          <form id="shipping-form" onsubmit="submitShipping(event)">
            <div class="form-row">
              <label>Nombre completo *</label>
              <input type="text" name="nombre" required placeholder="Ej: María González">
            </div>
            <div class="form-row">
              <label>Email *</label>
              <input type="email" name="email" required placeholder="tu@email.com">
            </div>
            <div class="form-row">
              <label>Teléfono *</label>
              <input type="tel" name="telefono" required placeholder="+56 9 XXXX XXXX">
            </div>
            <div class="form-row">
              <label>Región *</label>
              <select name="region" required onchange="updateShippingSummary()">
                <option value="">Selecciona una región</option>
                <option value="Región Metropolitana">Región Metropolitana</option>
                <option value="Valparaíso">Valparaíso</option>
                <option value="Biobío">Biobío</option>
                <option value="La Araucanía">La Araucanía</option>
                <option value="Los Lagos">Los Lagos</option>
                <option value="O'Higgins">O'Higgins</option>
                <option value="Maule">Maule</option>
                <option value="Coquimbo">Coquimbo</option>
                <option value="Antofagasta">Antofagasta</option>
                <option value="Los Ríos">Los Ríos</option>
                <option value="Atacama">Atacama</option>
                <option value="Tarapacá">Tarapacá</option>
                <option value="Arica y Parinacota">Arica y Parinacota</option>
                <option value="Aysén">Aysén</option>
                <option value="Magallanes">Magallanes</option>
                <option value="Ñuble">Ñuble</option>
              </select>
            </div>
            <div class="form-row-half">
              <div class="form-row" style="margin-bottom:0">
                <label>Ciudad / Comuna *</label>
                <input type="text" name="ciudad" required placeholder="Ej: Las Condes">
              </div>
              <div class="form-row" style="margin-bottom:0">
                <label>N° / Depto</label>
                <input type="text" name="depto" placeholder="Ej: Depto 302">
              </div>
            </div>
            <div class="form-row" style="margin-top:14px">
              <label>Dirección *</label>
              <input type="text" name="direccion" required placeholder="Calle y número">
            </div>
            <div class="form-row">
              <label>Notas para el despacho</label>
              <textarea name="notas" placeholder="Instrucciones adicionales (opcional)"></textarea>
            </div>
          </form>
        </div>
        <div class="shipping-footer">
          <div class="ship-summary">
            <div class="ship-line"><span>Subtotal</span><span id="ship-subtotal">$0</span></div>
            <div class="ship-line"><span>Envío</span><span id="ship-cost">Según región</span></div>
            <div class="ship-line ship-total-line"><span>Total</span><span id="ship-total">$0</span></div>
          </div>
          <button id="shipping-submit-btn" onclick="document.getElementById('shipping-form').requestSubmit()">Confirmar y pagar →</button>
          <p class="shipping-security">🔒 Pago seguro con Mercado Pago · Despacho por Bluexpress</p>
        </div>
      </div>

    </div>`;
  document.body.appendChild(drawer);
  Cart.refresh();
}

window.Cart          = Cart;
window.goToShipping  = goToShipping;
window.updateShippingSummary = updateShippingSummary;
window.backToCart    = backToCart;
window.submitShipping = submitShipping;
window.applyCoupon   = applyCoupon;
window.removeCoupon  = removeCoupon;

document.addEventListener('DOMContentLoaded', () => { injectCart(); Cart.refresh(); });
