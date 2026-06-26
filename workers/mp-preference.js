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

  return { valid: false, reason: 'Código no válido' };
}

function randomCode(len = 4) {
  // sin caracteres ambiguos (I, L, O, 0, 1)
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, b => alphabet[b % alphabet.length]).join('');
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

  // Dedupe best-effort: MP reintenta notificaciones del mismo pago
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

  // Generar el código personal de segunda compra para ESTE comprador
  // (20%, un solo uso, sin caducidad) — va en su email de confirmación
  let codigoPersonal = '';
  if (env.COUPON_KV) {
    for (let intento = 0; intento < 5 && !codigoPersonal; intento++) {
      const candidato = `VUELVE20-${randomCode(4)}`;
      if (!(await env.COUPON_KV.get(`coupon:${candidato}`))) {
        await env.COUPON_KV.put(`coupon:${candidato}`, JSON.stringify({
          email: payment.metadata?.shipping?.email || payment.payer?.email || '',
          created: new Date().toISOString(),
          fromPaymentId: paymentId,
          used: false,
        }));
        codigoPersonal = candidato;
      }
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
