/* =====================================================
   Cloudflare Worker — Flamingo Sports
   Variables requeridas en Cloudflare:
     MP_ACCESS_TOKEN    — Mercado Pago Access Token producción
     BREVO_API_KEY      — API key de Brevo
     REVIEW_FORM_URL    — URL del Google Form de reviews (opcional)
     IG_ACCESS_TOKEN    — Instagram Graph API long-lived token

   Rutas:
     POST /                — crea preferencia de pago MP (NO envía emails)
     POST /mp-webhook      — notificación de MP: con pago APROBADO envía los
                             emails (aviso vendedor + confirmación + review +7d)
     GET  /ig-feed         — proxy del feed de Instagram (token nunca al browser)
     GET  /validate-coupon — valida un código de descuento (?code=X&pairs=N)
     GET  /admin           — panel de ventas (?key=ADMIN_KEY · &format=json)
   ===================================================== */

const ALLOWED_ORIGINS = [
  'https://www.flamingosports.cl',
  'https://flamingosports.cl',
  'http://localhost:3000',
];

// ── Cupones de descuento ──────────────────────────────
// La única fuente de verdad: el browser solo muestra lo que este Worker valida.
// type: 'percent' (value = % de dcto) | 'fixed' (value = $ CLP de dcto por orden)
// minPairs: mínimo de pares en el carrito · validUntil: fecha inclusive, hora Chile
const COUPONS = {
  // Oferta email "2 pares × $17.990" (2×9.990 − 1.990 = 17.990 exacto)
  // Vence 5 jul: cubre la tanda Fase 2 (deadline comunicado 28 jun) y la
  // tanda Fase 3 (deadline comunicado 5 jul)
  'DOSPARES': { type: 'fixed', value: 1990, minPairs: 2, validUntil: '2026-07-05', label: '2º par con $1.990 de descuento' },

  // Afiliado — profe Tomás Cunietti. 15% de descuento al comprador; cada uso
  // (pago aprobado) se cuenta en KV `affiliate:TOMAS` para pagarle a Tomás por
  // venta. Multiuso, sin mínimo de pares. La marca `affiliate:true` activa el
  // conteo en el webhook.
  'TOMAS': { type: 'percent', value: 15, minPairs: 1, validUntil: '2026-12-31', label: '15% con Tomás Cunietti', affiliate: true },
};

// Códigos personales post-compra: VUELVE20-XXXX (20%, un solo uso, sin
// caducidad). Se generan en el webhook con el pago aprobado, viven en KV
// (coupon:CODIGO → {email, created, used}) y se marcan usados al canjearse.
const VUELVE20_PREFIX = 'VUELVE20-';

async function validateCoupon(code, pairs, env) {
  const key = String(code || '').trim().toUpperCase();
  if (!key) return { valid: false, reason: 'Código no válido' };

  // 1 — códigos de campaña (estáticos, multiuso)
  const c = COUPONS[key];
  if (c) {
    if (new Date(`${c.validUntil}T23:59:59-04:00`) < new Date()) return { valid: false, reason: 'Este código ya venció' };
    if ((pairs || 0) < (c.minPairs || 1)) return { valid: false, reason: `Este código requiere mínimo ${c.minPairs} pares` };
    return { valid: true, code: key, type: c.type, value: c.value, label: c.label, minPairs: c.minPairs || 1 };
  }

  // 2 — códigos personales VUELVE20-XXXX (un solo uso, sin vencimiento)
  if (key.startsWith(VUELVE20_PREFIX) && env?.COUPON_KV) {
    const raw = await env.COUPON_KV.get(`coupon:${key}`);
    if (!raw) return { valid: false, reason: 'Código no válido' };
    let data;
    try { data = JSON.parse(raw); } catch { return { valid: false, reason: 'Código no válido' }; }
    if (data.used) return { valid: false, reason: 'Este código ya fue usado' };
    return { valid: true, code: key, type: 'percent', value: 20, label: '20% de descuento', minPairs: 1 };
  }

  // 3 — códigos manuales de UN SOLO USO (KV `single:CODE`). Guardan sus propios
  // type/value/minPairs. Se marcan usados en el webhook con el pago aprobado.
  if (env?.COUPON_KV) {
    const sraw = await env.COUPON_KV.get(`single:${key}`);
    if (sraw) {
      let s; try { s = JSON.parse(sraw); } catch { return { valid: false, reason: 'Código no válido' }; }
      if (s.used) return { valid: false, reason: 'Este código ya fue usado' };
      if (s.validUntil && new Date(`${s.validUntil}T23:59:59-04:00`) < new Date()) return { valid: false, reason: 'Este código ya venció' };
      if ((pairs || 0) < (s.minPairs || 1)) return { valid: false, reason: `Este código requiere mínimo ${s.minPairs} pares` };
      return { valid: true, code: key, type: s.type, value: s.value, label: s.label || 'Descuento', minPairs: s.minPairs || 1 };
    }
  }

  return { valid: false, reason: 'Código no válido' };
}

// Código DETERMINISTA por pago (SHA-256 del paymentId): si el webhook procesa
// el mismo pago dos veces (notificaciones MP casi simultáneas en colos
// distintos), ambos generan el MISMO código — el cliente nunca recibe dos
// cupones distintos. Sin caracteres ambiguos (I, L, O, 0, 1).
async function codeFromPayment(paymentId, len = 4) {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('vuelve20:' + paymentId)));
  return Array.from(digest.slice(0, len), b => alphabet[b % alphabet.length]).join('');
}

function computeDiscount(coupon, total) {
  if (!coupon || !coupon.valid) return 0;
  const d = coupon.type === 'percent' ? Math.round(total * coupon.value / 100) : coupon.value;
  return Math.max(0, Math.min(d, total));
}

// ── Costo de envío ────────────────────────────────────
// Reglas (según pares en el carrito y región de despacho):
//   1–2 pares → $3.000 Santiago / $4.000 regiones
//     3 pares → $2.000 Santiago / $3.000 regiones
//    4+ pares → gratis a todo Chile
// "Santiago" = Región Metropolitana. Sin región (no debería ocurrir: el form
// la exige) se cobra la tarifa de regiones para no subcobrar.
function isSantiago(region) {
  return /metropolitana/i.test(String(region || ''));
}
function computeShipping(region, pairs) {
  const p = pairs || 0;
  if (p >= 4) return 0;
  const rm = isSantiago(region);
  if (p === 3) return rm ? 2000 : 3000;
  return rm ? 3000 : 4000; // 1–2 pares
}

const WORKER_URL = 'https://mp-preference.flamingosport-cl.workers.dev';

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const corsOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
    const cors = {
      'Access-Control-Allow-Origin': corsOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);

    // ── GET /ig-feed — Feed Instagram dinámico ──────
    if (request.method === 'GET' && url.pathname === '/ig-feed') {
      try {
        const igToken = env.IG_ACCESS_TOKEN;
        if (!igToken) return json({ error: 'Token no configurado' }, 500);
        const igUrl = 'https://graph.instagram.com/me/media?fields=id,media_type,media_url,thumbnail_url,permalink&limit=6&access_token=' + igToken;
        const igRes = await fetch(igUrl);
        const rawText = await igRes.text();
        if (!igRes.ok || !rawText) {
          return json({ error: 'Error Instagram API', status: igRes.status, raw: rawText.slice(0, 300) }, 502);
        }
        const igData = JSON.parse(rawText);
        const posts = (igData.data || []).map(function (p) {
          return { id: p.id, type: p.media_type, url: p.media_type === 'VIDEO' ? p.thumbnail_url : p.media_url, permalink: p.permalink };
        });
        return new Response(JSON.stringify(posts), {
          status: 200,
          headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' },
        });
      } catch (e) {
        return json({ error: 'Excepcion', detail: e.message }, 500);
      }
    }

    // ── GET /validate-coupon — validar código de descuento ──────
    if (request.method === 'GET' && url.pathname === '/validate-coupon') {
      const pairs = parseInt(url.searchParams.get('pairs') || '0', 10) || 0;
      return json(await validateCoupon(url.searchParams.get('code'), pairs, env));
    }

    // ── GET /admin — panel de ventas (protegido con ADMIN_KEY) ──────
    if (request.method === 'GET' && url.pathname === '/admin') {
      return handleAdmin(url, env);
    }

    // ── POST /mp-webhook — notificaciones de Mercado Pago ──────
    if (request.method === 'POST' && url.pathname === '/mp-webhook') {
      return handleWebhook(request, env, ctx, url);
    }

    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: cors });

    // ── POST / — crear preferencia de pago ──────────
    let body;
    try { body = await request.json(); }
    catch { return json({ error: 'Body inválido' }, 400); }

    const { items, shipping, coupon } = body;
    if (!items?.length) return json({ error: 'Carrito vacío' }, 400);

    // Cupón: se revalida acá (el front solo muestra; el Worker decide)
    const pairsCount = items.reduce((s, i) => s + (i.qty || 1), 0);
    const baseTotal = items.reduce((s, i) => s + (i.price || 9990) * (i.qty || 1), 0);
    const cup = coupon ? await validateCoupon(coupon, pairsCount, env) : null;
    const discount = computeDiscount(cup, baseTotal);
    // Retiro en tienda ("Retiro donde los Tíos Flamingo") → envío gratis
    const isPickup = shipping?.entrega === 'retiro';
    const shippingCost = isPickup ? 0 : computeShipping(shipping?.region, pairsCount);

    // MP no acepta items con precio negativo: con descuento, la orden va como
    // un único ítem por el total rebajado (el detalle viaja en metadata y se
    // itemiza en los emails)
    const mpItems = discount > 0
      ? [{
          id: 'pedido-flamingo',
          title: `Flamingo Sports — ${pairsCount} ${pairsCount === 1 ? 'par' : 'pares'} (cód. ${cup.code})`,
          description: items.map(i => `${i.name} x${i.qty || 1}`).join(', ').slice(0, 250),
          unit_price: baseTotal - discount,
          quantity: 1,
          currency_id: 'CLP',
          category_id: 'clothing_accessories',
          picture_url: 'https://www.flamingosports.cl/images/logo-negro.png',
        }]
      : items.map(item => ({
          id: item.id,
          title: `Flamingo Sports — ${item.name}`,
          description: 'Calcetines técnicos para tenis y pádel. Talla única 36–44 unisex.',
          unit_price: item.price || 9990,
          quantity: item.qty || 1,
          currency_id: 'CLP',
          category_id: 'clothing_accessories',
          picture_url: item.image ? `https://www.flamingosports.cl/${item.image}` : 'https://www.flamingosports.cl/images/logo-negro.png',
        }));

    // Envío como ítem aparte para que MP lo cobre (gratis = no se agrega ítem)
    if (shippingCost > 0) {
      mpItems.push({
        id: 'envio',
        title: `Envío a domicilio — ${isSantiago(shipping?.region) ? 'Santiago' : 'Regiones'}`,
        description: 'Despacho por Bluexpress',
        unit_price: shippingCost,
        quantity: 1,
        currency_id: 'CLP',
        category_id: 'shipping',
        picture_url: 'https://www.flamingosports.cl/images/logo-negro.png',
      });
    }

    const preference = {
      items: mpItems,
      payer: shipping ? {
        name: shipping.nombre?.split(' ')[0] || '',
        surname: shipping.nombre?.split(' ').slice(1).join(' ') || '',
        email: shipping.email || '',
        phone: { area_code: '56', number: (shipping.telefono || '').replace(/\D/g, '').slice(-8) },
        address: { street_name: shipping.direccion || '', street_number: shipping.depto || '', zip_code: '' },
      } : undefined,
      additional_info: shipping ? {
        shipments: {
          receiver_address: {
            street_name: shipping.direccion || '',
            street_number: shipping.depto || '',
            city_name: shipping.ciudad || '',
            state_name: shipping.region || '',
            country_name: 'Chile',
          }
        },
        items: items.map(item => ({ id: item.id, title: item.name, quantity: item.qty, unit_price: item.price || 9990 })),
      } : undefined,
      // metadata viaja al objeto payment → el webhook recupera de aquí los
      // datos de envío para los emails (solo se envían con pago aprobado)
      metadata: {
        shipping: shipping || null,
        shipping_cost: shippingCost,
        cart_items: items,
        coupon: discount > 0 ? { code: cup.code, discount } : null,
      },
      external_reference: shipping?.email || '',
      notification_url: `${WORKER_URL}/mp-webhook`,
      back_urls: {
        success: 'https://www.flamingosports.cl/gracias.html',
        failure: 'https://www.flamingosports.cl/productos.html',
        pending: 'https://www.flamingosports.cl/gracias.html',
      },
      auto_return: 'approved',
      statement_descriptor: 'FLAMINGO SPORTS',
      payment_methods: { installments: 1 },
    };

    const mpRes = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.MP_ACCESS_TOKEN}` },
      body: JSON.stringify(preference),
    });
    const mpData = await mpRes.json();
    if (!mpRes.ok || !mpData.id) {
      return json({ error: 'Error MP', detail: mpData }, 502);
    }

    return json({ preference_id: mpData.id, init_point: mpData.init_point });
  }
};

// ── Webhook: emails SOLO con pago aprobado ─────────────
async function handleWebhook(request, env, ctx, url) {
  // MP exige respuesta rápida 200; el trabajo pesado va en ctx.waitUntil
  let notif = {};
  try { notif = await request.json(); } catch {}
  const paymentId = url.searchParams.get('data.id') || notif?.data?.id || url.searchParams.get('id');
  // MP notifica en dos formatos: webhook nuevo (?type=payment&data.id=N) e
  // IPN clásico (?topic=payment&id=N) — aceptar ambos
  const type = url.searchParams.get('type') || url.searchParams.get('topic') || notif?.type || notif?.action || '';

  console.log('mp-webhook recibido:', JSON.stringify({ type, paymentId, query: url.search.slice(0, 200) }));

  if (!paymentId || !String(type).includes('payment')) {
    return new Response('ignored', { status: 200 });
  }

  ctx.waitUntil(processPayment(paymentId, env));
  return new Response('ok', { status: 200 });
}

async function processPayment(paymentId, env) {
  const res = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
    headers: { 'Authorization': `Bearer ${env.MP_ACCESS_TOKEN}` },
  });
  if (!res.ok) { console.log(`pago ${paymentId}: consulta MP falló ${res.status}`); return; }
  const payment = await res.json();
  console.log(`pago ${paymentId}: status=${payment.status}`);
  if (payment.status !== 'approved') return;

  // Dedupe en dos barreras. MP a veces notifica el mismo pago DOS veces casi
  // simultáneas desde colos distintos (pasó con Kim 13 jun y Ricardo 1 jul:
  // 2 confirmaciones con 2 cupones). caches.default es regional y no cruza
  // colos; el marcador KV sí (propaga en segundos) y frena todo reintento
  // posterior. Para la ventana de milisegundos que ni KV alcanza a cubrir,
  // el cupón personal es determinista por paymentId (ver codeFromPayment):
  // el peor caso posible queda en email duplicado con el MISMO código.
  if (env.COUPON_KV) {
    if (await env.COUPON_KV.get(`processed:${paymentId}`)) return;
    await env.COUPON_KV.put(`processed:${paymentId}`, new Date().toISOString());
  }
  const cache = caches.default;
  const dedupeKey = new Request(`https://dedupe.flamingosports.cl/payment/${paymentId}`);
  if (await cache.match(dedupeKey)) return;
  await cache.put(dedupeKey, new Response('1', { headers: { 'Cache-Control': 'public, max-age=604800' } }));

  const meta = payment.metadata || {};
  const shipping = meta.shipping || null;
  const items = (meta.cart_items && meta.cart_items.length) ? meta.cart_items
    : (payment.additional_info?.items || []).map(i => ({ id: i.id, name: i.title, qty: Number(i.quantity) || 1, price: Number(i.unit_price) || 9990 }));
  const total = payment.transaction_amount || items.reduce((s, i) => s + (i.price || 9990) * (i.qty || 1), 0);
  const buyerEmail = shipping?.email || payment.payer?.email || '';
  const buyerName = shipping?.nombre || [payment.payer?.first_name, payment.payer?.last_name].filter(Boolean).join(' ') || 'Cliente';
  const primerNombre = buyerName.split(' ')[0];

  if (!env.BREVO_API_KEY) return;
  const brevoHeaders = { 'api-key': env.BREVO_API_KEY, 'Content-Type': 'application/json' };
  const REVIEW_URL = env.REVIEW_FORM_URL || 'https://www.flamingosports.cl';
  const cupMeta = meta.coupon || null;
  const discountRow = cupMeta
    ? `<tr><td style="padding:6px 0;font-size:13px;color:#1F9D55;">Descuento (${cupMeta.code})</td><td style="padding:6px 0;font-size:13px;text-align:right;color:#1F9D55;">−$${Number(cupMeta.discount).toLocaleString('es-CL')}</td></tr>`
    : '';

  // Si el pago usó un código personal VUELVE20-XXXX → marcarlo como usado
  if (cupMeta && String(cupMeta.code).startsWith('VUELVE20-') && env.COUPON_KV) {
    const kvKey = `coupon:${cupMeta.code}`;
    const raw = await env.COUPON_KV.get(kvKey);
    if (raw) {
      const data = JSON.parse(raw);
      data.used = true;
      data.usedAt = new Date().toISOString();
      data.usedPaymentId = paymentId;
      await env.COUPON_KV.put(kvKey, JSON.stringify(data));
      console.log(`código ${cupMeta.code} marcado como USADO (pago ${paymentId})`);
    }
  }

  // Afiliados (códigos de profes): contar cada uso para pagarles por venta.
  // Idempotente por paymentId: aunque el dedupe fallara, un pago nunca suma dos veces.
  if (cupMeta && COUPONS[String(cupMeta.code).toUpperCase()]?.affiliate && env.COUPON_KV) {
    const code = String(cupMeta.code).toUpperCase();
    const kvKey = `affiliate:${code}`;
    let rec; try { rec = JSON.parse(await env.COUPON_KV.get(kvKey) || '{}'); } catch { rec = {}; }
    if ((rec.payments || []).some(p => String(p.id) === String(paymentId))) {
      console.log(`afiliado ${code}: pago ${paymentId} ya contado, no se duplica`);
    } else {
      rec.uses = (rec.uses || 0) + 1;
      rec.totalSales = (rec.totalSales || 0) + Number(total || 0);
      rec.totalDiscount = (rec.totalDiscount || 0) + Number(cupMeta.discount || 0);
      rec.payments = (rec.payments || []).concat([{ id: paymentId, date: new Date().toISOString(), total, discount: cupMeta.discount }]);
      await env.COUPON_KV.put(kvKey, JSON.stringify(rec));
      console.log(`afiliado ${code}: uso #${rec.uses} (pago ${paymentId}, total $${total})`);
    }
  }

  // Códigos manuales de un solo uso (single:CODE) → marcar usado tras pago aprobado
  if (cupMeta && env.COUPON_KV) {
    const sk = `single:${String(cupMeta.code).toUpperCase()}`;
    const sraw = await env.COUPON_KV.get(sk);
    if (sraw) {
      let s; try { s = JSON.parse(sraw); } catch { s = null; }
      if (s && !s.used) {
        s.used = true; s.usedAt = new Date().toISOString(); s.usedPaymentId = paymentId;
        await env.COUPON_KV.put(sk, JSON.stringify(s));
        console.log(`código single ${cupMeta.code} marcado USADO (pago ${paymentId})`);
      }
    }
  }

  // Generar el código personal de segunda compra para ESTE comprador
  // (20%, un solo uso, sin caducidad) — va en su email de confirmación.
  // Determinista por paymentId: reprocesar el mismo pago da el mismo código.
  let codigoPersonal = '';
  if (env.COUPON_KV) {
    for (let len = 4; len <= 8 && !codigoPersonal; len++) {
      const candidato = `VUELVE20-${await codeFromPayment(paymentId, len)}`;
      const raw = await env.COUPON_KV.get(`coupon:${candidato}`);
      if (raw) {
        let prev; try { prev = JSON.parse(raw); } catch { prev = {}; }
        // mismo pago reprocesado → reusar; otro pago (colisión) → alargar código
        if (String(prev.fromPaymentId) === String(paymentId)) codigoPersonal = candidato;
        continue;
      }
      await env.COUPON_KV.put(`coupon:${candidato}`, JSON.stringify({
        email: payment.metadata?.shipping?.email || payment.payer?.email || '',
        created: new Date().toISOString(),
        fromPaymentId: paymentId,
        used: false,
      }));
      codigoPersonal = candidato;
    }
  }
  const isPickup = shipping?.entrega === 'retiro';
  const shipCost = Number(meta.shipping_cost || 0);
  const shippingRow = `<tr><td style="padding:6px 0;font-size:13px;">${isPickup ? 'Retiro en tienda' : 'Envío'}</td><td style="padding:6px 0;font-size:13px;text-align:right;">${shipCost > 0 ? '$' + shipCost.toLocaleString('es-CL') : 'Gratis'}</td></tr>`;
  const itemsHtml = items.map(i =>
    `<tr><td style="padding:6px 0;font-size:13px;">${i.name} × ${i.qty}</td><td style="padding:6px 0;font-size:13px;text-align:right;">$${((i.price || 9990) * (i.qty || 1)).toLocaleString('es-CL')}</td></tr>`
  ).join('') + discountRow + shippingRow;
  const direccionHtml = isPickup
    ? '🦩 RETIRO en Las Condes, Santiago (coordinamos el horario por WhatsApp)'
    : shipping
      ? `${shipping.direccion}${shipping.depto ? ', ' + shipping.depto : ''}, ${shipping.ciudad}, ${shipping.region}`
      : '(ver datos en Mercado Pago)';

  // Registro de la venta en KV → alimenta el panel GET /admin
  if (env.COUPON_KV) {
    await env.COUPON_KV.put(`sale:${paymentId}`, JSON.stringify({
      paymentId,
      date: payment.date_approved || new Date().toISOString(),
      name: buyerName,
      email: buyerEmail,
      phone: shipping?.telefono || '',
      address: isPickup ? 'RETIRO Las Condes' : (shipping ? `${shipping.direccion}${shipping.depto ? ', ' + shipping.depto : ''}, ${shipping.ciudad}, ${shipping.region}` : ''),
      items: items.map(i => ({ name: i.name, qty: i.qty || 1, price: i.price || 9990 })),
      coupon: cupMeta ? { code: cupMeta.code, discount: Number(cupMeta.discount) || 0 } : null,
      shippingCost: shipCost,
      pickup: !!isPickup,
      total,
      vuelve20: codigoPersonal || '',
      notas: shipping?.notas || '',
    }));
  }

  const sends = [];

  // 1 — Aviso al vendedor (pago confirmado de verdad)
  sends.push(fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST', headers: brevoHeaders,
    body: JSON.stringify({
      sender: { name: 'Flamingo Sports Tienda', email: 'tioflamingo@flamingosports.cl' },
      to: [{ email: 'tioflamingo@flamingosports.cl' }],
      subject: `💰 Pago confirmado — ${buyerName} ($${total.toLocaleString('es-CL')})`,
      htmlContent: `<div style="font-family:Arial,sans-serif;max-width:560px;font-size:14px;color:#1a1a1a;"><p style="font-size:11px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#999;">FLAMINGO SPORTS — PAGO CONFIRMADO</p><h2 style="font-size:22px;margin:8px 0 24px;">Pedido de ${buyerName}</h2><p style="font-size:12px;color:#999;">ID pago MP: ${paymentId}</p><table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #eee;border-bottom:1px solid #eee;margin-bottom:24px;">${itemsHtml}<tr><td style="padding:10px 0 0;font-weight:700;">Total pagado</td><td style="padding:10px 0 0;text-align:right;font-weight:700;">$${total.toLocaleString('es-CL')}</td></tr></table><p style="font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#999;margin-bottom:8px;">${isPickup ? 'DATOS DE RETIRO' : 'DATOS DE ENVÍO'}</p><table cellpadding="4"><tr><td style="color:#999;font-size:12px;">Nombre</td><td style="font-size:13px;">${buyerName}</td></tr><tr><td style="color:#999;font-size:12px;">Email</td><td style="font-size:13px;">${buyerEmail}</td></tr>${shipping ? `<tr><td style="color:#999;font-size:12px;">Teléfono</td><td style="font-size:13px;">${shipping.telefono || ''}</td></tr><tr><td style="color:#999;font-size:12px;">${isPickup ? 'Entrega' : 'Dirección'}</td><td style="font-size:13px;">${direccionHtml}</td></tr>${shipping.notas ? `<tr><td style="color:#999;font-size:12px;">Notas</td><td style="font-size:13px;">${shipping.notas}</td></tr>` : ''}` : ''}</table><p style="margin-top:24px;font-size:12px;color:#999;">${isPickup ? '🦩 Es RETIRO en Las Condes: contacta al cliente por WhatsApp para coordinar el horario.' : 'Recuerda coordinar el despacho por Bluexpress.'}</p></div>`,
    }),
  }));

  // 2 — Confirmación al cliente
  if (buyerEmail) {
    sends.push(fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST', headers: brevoHeaders,
      body: JSON.stringify({
        sender: { name: 'Flamingo Sports', email: 'tioflamingo@flamingosports.cl' },
        to: [{ email: buyerEmail, name: buyerName }],
        subject: `Tu pedido está confirmado, ${primerNombre} 🦩`,
        htmlContent: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;font-size:15px;color:#1a1a1a;"><p style="font-size:11px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#999;margin-bottom:16px;">FLAMINGO SPORTS</p><h2 style="font-size:24px;font-weight:900;color:#1B2D4A;margin:0 0 20px;">Recibimos tu pago, ${primerNombre}.</h2><p style="margin:0 0 16px;line-height:1.7;">${isPickup ? 'Tu pedido está confirmado. El <strong>retiro es en Las Condes, Santiago</strong>; te contactamos por <strong>WhatsApp</strong> para coordinar el horario.' : 'Tu pedido está confirmado. En las próximas <strong>48 horas hábiles</strong> lo despachamos por Bluexpress y te llegará el número de seguimiento.'}</p><table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #eee;border-bottom:1px solid #eee;margin:24px 0;padding:16px 0;">${itemsHtml}<tr><td style="padding:10px 0 0;font-weight:700;">Total pagado</td><td style="padding:10px 0 0;text-align:right;font-weight:700;color:#F0907C;">$${total.toLocaleString('es-CL')}</td></tr></table><p style="margin:0 0 16px;line-height:1.7;"><strong>${isPickup ? 'Entrega:' : 'Dirección de entrega:'}</strong><br>${direccionHtml}</p>${codigoPersonal ? `<div style="background:#FDF1EE;border-left:4px solid #F0907C;padding:14px 18px;margin:0 0 24px;"><p style="margin:0;line-height:1.6;font-size:14px;">🦩 <strong>Regalo de los tíos:</strong> tu código personal <strong style="letter-spacing:1px;">${codigoPersonal}</strong> te da un <strong>20% de descuento</strong> en tu próxima compra. No vence y es de un solo uso — guárdalo bien.</p></div>` : ''}<p style="margin:0 0 32px;line-height:1.7;">¿Tienes alguna duda? Escríbenos por <a href="https://wa.me/56992269522" style="color:#1B2D4A;font-weight:700;">WhatsApp</a> — respondemos rápido.</p><p style="margin:0 0 4px;">Un abrazo,</p><p style="margin:0 0 32px;font-weight:700;">Nico, Kimu y Pollo<br><span style="font-size:12px;color:#999;font-weight:400;letter-spacing:1px;text-transform:uppercase;">Los Tíos Flamingo</span></p><p style="font-size:11px;color:#bbb;border-top:1px solid #eee;padding-top:16px;">Flamingo Sports · Santiago, Chile · <a href="https://www.flamingosports.cl" style="color:#bbb;">flamingosports.cl</a></p></div>`,
      }),
    }));

    // 3 — Review request (programado 7 días después)
    const reviewDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    sends.push(fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST', headers: brevoHeaders,
      body: JSON.stringify({
        sender: { name: 'Flamingo Sports', email: 'tioflamingo@flamingosports.cl' },
        to: [{ email: buyerEmail, name: buyerName }],
        subject: `${primerNombre}, ¿cómo te quedaron los calcetines?`,
        scheduledAt: reviewDate,
        htmlContent: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;font-size:15px;color:#1a1a1a;"><p style="font-size:11px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#999;margin-bottom:16px;">FLAMINGO SPORTS</p><h2 style="font-size:24px;font-weight:900;color:#1B2D4A;margin:0 0 20px;">Hola ${primerNombre}, ¿llegaron bien?</h2><p style="margin:0 0 16px;line-height:1.7;">Hace una semana despachamos tus calcetines Flamingo. Si ya los probaste en cancha, nos encantaría saber qué te parecieron.</p><p style="margin:0 0 28px;line-height:1.7;">Son 2 minutos — y tu opinión ayuda a otros jugadores a decidirse.</p><a href="${REVIEW_URL}" style="display:inline-block;background:#F0907C;color:white;font-family:Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;padding:14px 28px;border-radius:2px;text-decoration:none;margin-bottom:32px;">Dejar mi opinión →</a><p style="margin:0 0 4px;">Gracias de verdad,</p><p style="margin:0 0 32px;font-weight:700;">Nico, Kimu y Pollo<br><span style="font-size:12px;color:#999;font-weight:400;letter-spacing:1px;text-transform:uppercase;">Los Tíos Flamingo</span></p><p style="font-size:11px;color:#bbb;border-top:1px solid #eee;padding-top:16px;">Flamingo Sports · Santiago, Chile · <a href="https://www.flamingosports.cl" style="color:#bbb;">flamingosports.cl</a><br>Si no quieres recibir más correos de nuestra parte, responde este mensaje.</p></div>`,
      }),
    }));
  }

  const results = await Promise.allSettled(sends);
  console.log(`pago ${paymentId}: emails enviados → ` + results.map(r =>
    r.status === 'fulfilled' ? `HTTP ${r.value.status}` : `ERROR ${r.reason?.message}`
  ).join(' · '));
}

// ── Panel de administración: GET /admin?key=ADMIN_KEY ──────────────────────
// Lee las ventas registradas en KV (sale:*), el estado de cupones personales
// (coupon:*) y los contadores de afiliados (affiliate:*). Solo lectura.
const INTERNAL_EMAILS = new Set([
  'kimuzz@gmail.com', 'cajas.nicolas@gmail.com',
  'flamingosport.cl@gmail.com', 'tioflamingo@flamingosports.cl',
]);

async function kvAll(env, prefix) {
  const out = [];
  let cursor;
  do {
    const page = await env.COUPON_KV.list({ prefix, cursor });
    for (const k of page.keys) {
      const raw = await env.COUPON_KV.get(k.name);
      if (!raw) continue;
      try { out.push({ key: k.name, ...JSON.parse(raw) }); } catch {}
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return out;
}

const clp = n => '$' + Number(n || 0).toLocaleString('es-CL');
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function handleAdmin(url, env) {
  if (!env.ADMIN_KEY || url.searchParams.get('key') !== env.ADMIN_KEY) {
    return new Response('No autorizado', { status: 401 });
  }
  if (!env.COUPON_KV) return new Response('KV no configurado', { status: 500 });

  const [sales, coupons, affiliates, singles] = await Promise.all([
    kvAll(env, 'sale:'), kvAll(env, 'coupon:'), kvAll(env, 'affiliate:'), kvAll(env, 'single:'),
  ]);
  sales.sort((a, b) => String(b.date).localeCompare(String(a.date)));

  const reales = sales.filter(s => !INTERNAL_EMAILS.has(String(s.email).toLowerCase()));
  const ingresos = reales.reduce((s, v) => s + (v.total || 0), 0);
  const pares = reales.reduce((s, v) => s + (v.items || []).reduce((a, i) => a + (i.qty || 1), 0), 0);
  const aov = reales.length ? Math.round(ingresos / reales.length) : 0;
  const canjeados = coupons.filter(c => c.used).length;

  if (url.searchParams.get('format') === 'json') {
    return new Response(JSON.stringify({ resumen: { ventasReales: reales.length, ingresos, pares, aov, cuponesEmitidos: coupons.length, cuponesCanjeados: canjeados }, ventas: sales, cupones: coupons, afiliados: affiliates, codigosManuales: singles }, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const filaVenta = s => {
    const interno = INTERNAL_EMAILS.has(String(s.email).toLowerCase());
    const itemsTxt = (s.items || []).map(i => `${esc(i.name)} × ${i.qty}`).join('<br>');
    return `<tr${interno ? ' style="opacity:.45"' : ''}>
      <td>${esc(String(s.date).slice(0, 10))}</td>
      <td><strong>${esc(s.name)}</strong>${interno ? ' <span class="tag">interno</span>' : ''}<br><span class="dim">${esc(s.email)}<br>${esc(s.phone)}</span></td>
      <td>${itemsTxt}</td>
      <td>${s.coupon ? `${esc(s.coupon.code)}<br><span class="dim">−${clp(s.coupon.discount)}</span>` : '—'}</td>
      <td>${s.pickup ? 'Retiro' : (s.shippingCost > 0 ? clp(s.shippingCost) : 'Gratis')}<br><span class="dim">${esc(s.address)}</span></td>
      <td class="num"><strong>${clp(s.total)}</strong></td>
      <td><span class="dim">${esc(s.vuelve20 || '—')}<br>MP ${esc(s.paymentId)}</span></td>
    </tr>`;
  };

  const filaAfiliado = a => `<tr><td><strong>${esc(a.key.replace('affiliate:', ''))}</strong></td><td class="num">${a.uses || 0}</td><td class="num">${clp(a.totalSales)}</td><td class="num">${clp(a.totalDiscount)}</td><td class="num">${clp((a.uses || 0) * 1500)}</td></tr>`;
  const filaCupon = c => `<tr><td>${esc(c.key.replace('coupon:', ''))}</td><td>${esc(c.email)}</td><td>${esc(String(c.created).slice(0, 10))}</td><td>${c.used ? `✅ usado ${esc(String(c.usedAt).slice(0, 10))}` : 'sin usar'}</td></tr>`;
  const filaSingle = s => `<tr><td>${esc(s.key.replace('single:', ''))}</td><td>${esc(s.label || '')}</td><td>${s.used ? `✅ usado ${esc(String(s.usedAt).slice(0, 10))}` : 'vigente'}</td></tr>`;

  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>Flamingo Sports — Panel de ventas</title>
<style>
  body{font-family:Arial,Helvetica,sans-serif;margin:0;background:#F7F5F2;color:#1a1a1a}
  header{background:#1B2D4A;color:#fff;padding:20px 28px}
  header h1{margin:0;font-size:18px;letter-spacing:2px;text-transform:uppercase}
  header .dim{color:#9fb0cc;font-size:12px}
  main{max-width:1100px;margin:0 auto;padding:24px 16px 60px}
  .cards{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:28px}
  .card{background:#fff;border-radius:8px;padding:16px 22px;flex:1;min-width:140px;box-shadow:0 1px 3px rgba(27,45,74,.08)}
  .card .v{font-size:26px;font-weight:900;color:#1B2D4A}
  .card .l{font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#999;margin-top:4px}
  h2{font-size:13px;letter-spacing:2px;text-transform:uppercase;color:#1B2D4A;margin:32px 0 10px}
  table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(27,45,74,.08)}
  th{background:#1B2D4A;color:#fff;font-size:11px;letter-spacing:1px;text-transform:uppercase;padding:10px 12px;text-align:left}
  td{padding:12px;font-size:13px;border-bottom:1px solid #f0ede8;vertical-align:top}
  tr:last-child td{border-bottom:none}
  .num{text-align:right;white-space:nowrap}
  .dim{color:#999;font-size:11.5px}
  .tag{background:#eee;color:#777;font-size:10px;padding:2px 6px;border-radius:3px;letter-spacing:1px;text-transform:uppercase}
  .mp{display:inline-block;margin-top:10px;font-size:12px;color:#9fb0cc}
  a{color:#F0907C}
</style></head><body>
<header><h1>🦩 Flamingo Sports — Panel de ventas</h1>
<span class="dim">Generado ${new Date().toLocaleString('es-CL', { timeZone: 'America/Santiago' })} (hora Chile) · datos en vivo del webhook</span></header>
<main>
<div class="cards">
  <div class="card"><div class="v">${reales.length}</div><div class="l">Ventas reales</div></div>
  <div class="card"><div class="v">${clp(ingresos)}</div><div class="l">Ingresos</div></div>
  <div class="card"><div class="v">${pares}</div><div class="l">Pares vendidos</div></div>
  <div class="card"><div class="v">${clp(aov)}</div><div class="l">Ticket promedio</div></div>
  <div class="card"><div class="v">${canjeados}/${coupons.length}</div><div class="l">Cupones canjeados</div></div>
</div>
<h2>Ventas (${sales.length}, internas atenuadas)</h2>
<table><tr><th>Fecha</th><th>Cliente</th><th>Productos</th><th>Cupón usado</th><th>Envío</th><th>Total</th><th>Ref</th></tr>${sales.map(filaVenta).join('') || '<tr><td colspan="7">Sin ventas registradas aún</td></tr>'}</table>
<h2>Afiliados (pago sugerido = usos × $1.500)</h2>
<table><tr><th>Código</th><th>Usos</th><th>Ventas generadas</th><th>Dcto. entregado</th><th>A pagar</th></tr>${affiliates.map(filaAfiliado).join('') || '<tr><td colspan="5">Sin usos de códigos de afiliado aún</td></tr>'}</table>
<h2>Cupones personales VUELVE20</h2>
<table><tr><th>Código</th><th>Cliente</th><th>Emitido</th><th>Estado</th></tr>${coupons.map(filaCupon).join('') || '<tr><td colspan="4">—</td></tr>'}</table>
<h2>Códigos manuales</h2>
<table><tr><th>Código</th><th>Descripción</th><th>Estado</th></tr>${singles.map(filaSingle).join('') || '<tr><td colspan="3">—</td></tr>'}</table>
<a class="mp" href="https://www.mercadopago.cl/activities" target="_blank">Ver movimientos de plata en Mercado Pago →</a>
</main></body></html>`;

  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}
