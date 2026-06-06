/* =====================================================
   Flamingo Sports — Cart
   Flujo: carrito → datos de envío → MP → gracias
   ===================================================== */

const WORKER_URL = 'https://mp-preference.flamingosport-cl.workers.dev';
const PRICE      = 9990;
const CART_KEY   = 'flamingo_cart';

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
  clear()  { localStorage.removeItem(CART_KEY); Cart.refresh(); },
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
    document.getElementById('cart-total-amount').textContent = '$' + Cart.total().toLocaleString('es-CL');
  },
};

// ── Pasos del drawer ──────────────────────────────────
function showCartStep(step) {
  document.getElementById('cart-step-items').style.display   = step === 'items'    ? 'flex' : 'none';
  document.getElementById('cart-step-shipping').style.display = step === 'shipping' ? 'flex' : 'none';
}

// ── Formulario de envío ───────────────────────────────
function goToShipping() {
  if (!Cart.get().length) return;
  showCartStep('shipping');
  document.getElementById('cart-header-title').textContent = 'Datos de envío';
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
      body: JSON.stringify({ items: Cart.get(), shipping }),
    });
    const data = await res.json();
    if (!data.init_point) throw new Error('Sin init_point');
    Cart.clear();
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
    .cart-overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:900;opacity:0;pointer-events:none;transition:opacity .3s;}
    .cart-overlay.open{opacity:1;pointer-events:all;}
    .cart-drawer{position:fixed;top:0;right:0;bottom:0;width:min(440px,100vw);background:#fff;z-index:901;display:flex;flex-direction:column;transform:translateX(100%);transition:transform .35s cubic-bezier(.4,0,.2,1);box-shadow:-8px 0 40px rgba(0,0,0,.12);}
    .cart-drawer.open{transform:translateX(0);}
    .cart-header{display:flex;align-items:center;justify-content:space-between;padding:20px 24px;border-bottom:1px solid #eee;flex-shrink:0;}
    .cart-header-title{font-family:'Causten',Arial,sans-serif;font-size:11px;font-weight:800;letter-spacing:3px;text-transform:uppercase;color:#1B2D4A;}
    .cart-close{background:none;border:none;cursor:pointer;font-size:18px;color:#999;padding:4px;line-height:1;}
    .cart-close:hover{color:#1B2D4A;}

    /* STEP ITEMS */
    #cart-step-items{flex:1;display:flex;flex-direction:column;overflow:hidden;}
    .cart-items{flex:1;overflow-y:auto;padding:16px 24px;}
    .cart-empty{text-align:center;padding:60px 0;color:#999;}
    .cart-empty p{font-family:'Causten',Arial,sans-serif;font-size:13px;margin-bottom:16px;}
    .cart-empty a{font-family:'Causten',Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#F0907C;}
    .cart-item{display:grid;grid-template-columns:64px 1fr auto;gap:12px;align-items:start;padding:16px 0;border-bottom:1px solid #f0f0f0;}
    .cart-item:last-child{border-bottom:none;}
    .cart-item-img{width:64px;height:64px;border-radius:2px;overflow:hidden;background:#f5f5f5;}
    .cart-item-img img{width:100%;height:100%;object-fit:cover;}
    .cart-item-placeholder{width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:24px;}
    .cart-item-name{font-family:'Causten',Arial,sans-serif;font-size:12px;font-weight:700;color:#1B2D4A;margin-bottom:2px;}
    .cart-item-type{font-family:'Causten',Arial,sans-serif;font-size:10px;color:#999;margin-bottom:6px;letter-spacing:1px;text-transform:uppercase;}
    .cart-item-price{font-family:'Causten',Arial,sans-serif;font-size:13px;font-weight:800;color:#F0907C;}
    .cart-item-controls{display:flex;align-items:center;gap:6px;margin-top:4px;}
    .qty-btn{width:26px;height:26px;border:1px solid #ddd;background:#fff;border-radius:2px;cursor:pointer;font-size:14px;line-height:1;display:flex;align-items:center;justify-content:center;color:#1B2D4A;transition:all .15s;}
    .qty-btn:hover{background:#1B2D4A;color:#fff;border-color:#1B2D4A;}
    .qty-val{font-family:'Causten',Arial,sans-serif;font-size:12px;font-weight:700;min-width:20px;text-align:center;color:#1B2D4A;}
    .remove-btn{background:none;border:none;cursor:pointer;color:#ccc;font-size:12px;padding:4px;margin-left:4px;transition:color .15s;}
    .remove-btn:hover{color:#e74c3c;}
    .cart-footer{padding:20px 24px;border-top:1px solid #eee;background:#fff;flex-shrink:0;}
    .cart-total-row{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;}
    .cart-total-label{font-family:'Causten',Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#999;}
    .cart-total-price{font-family:'Causten',Arial,sans-serif;font-size:20px;font-weight:900;color:#1B2D4A;}
    #cart-checkout-btn{display:block;width:100%;padding:16px;background:#F0907C;color:#fff;border:none;border-radius:2px;font-family:'Causten',Arial,sans-serif;font-size:10px;font-weight:800;letter-spacing:2.5px;text-transform:uppercase;cursor:pointer;transition:background .2s;}
    #cart-checkout-btn:hover{background:#d97a68;}
    .cart-security{text-align:center;margin-top:10px;font-family:'Causten',Arial,sans-serif;font-size:9px;color:#bbb;letter-spacing:1px;}

    /* STEP SHIPPING */
    #cart-step-shipping{flex:1;display:none;flex-direction:column;overflow:hidden;}
    .shipping-form-wrap{flex:1;overflow-y:auto;padding:20px 24px;}
    .shipping-back{background:none;border:none;cursor:pointer;font-family:'Causten',Arial,sans-serif;font-size:9px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#999;display:flex;align-items:center;gap:6px;margin-bottom:20px;padding:0;}
    .shipping-back:hover{color:#1B2D4A;}
    .form-row{margin-bottom:14px;}
    .form-row label{display:block;font-family:'Causten',Arial,sans-serif;font-size:9px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#999;margin-bottom:6px;}
    .form-row input,.form-row select,.form-row textarea{width:100%;padding:11px 14px;border:1px solid #ddd;border-radius:2px;font-family:'Causten',Arial,sans-serif;font-size:13px;color:#1B2D4A;background:#fff;outline:none;transition:border-color .15s;box-sizing:border-box;}
    .form-row input:focus,.form-row select:focus,.form-row textarea:focus{border-color:#1B2D4A;}
    .form-row textarea{resize:none;height:72px;}
    .form-row-half{display:grid;grid-template-columns:1fr 1fr;gap:12px;}
    .shipping-footer{padding:20px 24px;border-top:1px solid #eee;background:#fff;flex-shrink:0;}
    #shipping-submit-btn{display:block;width:100%;padding:16px;background:#F0907C;color:#fff;border:none;border-radius:2px;font-family:'Causten',Arial,sans-serif;font-size:10px;font-weight:800;letter-spacing:2.5px;text-transform:uppercase;cursor:pointer;transition:background .2s;}
    #shipping-submit-btn:hover{background:#d97a68;}
    #shipping-submit-btn:disabled{background:#ccc;cursor:not-allowed;}
    .shipping-security{text-align:center;margin-top:10px;font-family:'Causten',Arial,sans-serif;font-size:9px;color:#bbb;letter-spacing:1px;}

    /* Nav badge */
    .cart-icon-btn{background:none;border:none;cursor:pointer;display:flex;align-items:center;gap:6px;color:rgba(255,255,255,.7);padding:8px;transition:color .2s;position:relative;}
    .cart-icon-btn:hover{color:#fff;}
    .cart-icon-btn svg{width:20px;height:20px;}
    .cart-badge{position:absolute;top:-2px;right:-2px;background:#F0907C;color:#fff;border-radius:50%;width:16px;height:16px;font-family:'Causten',Arial,sans-serif;font-size:9px;font-weight:900;display:none;align-items:center;justify-content:center;}
    .btn-add-cart{display:block;width:100%;text-align:center;font-family:'Causten',Arial,sans-serif;font-size:11px;font-weight:800;letter-spacing:2.5px;text-transform:uppercase;background:#1B2D4A;color:white;padding:17px 32px;border-radius:2px;transition:background .2s;margin-bottom:10px;border:none;cursor:pointer;}
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
          <div class="cart-total-row">
            <span class="cart-total-label">Total</span>
            <span class="cart-total-price" id="cart-total-amount">$0</span>
          </div>
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
              <select name="region" required>
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
window.backToCart    = backToCart;
window.submitShipping = submitShipping;

document.addEventListener('DOMContentLoaded', () => { injectCart(); Cart.refresh(); });
