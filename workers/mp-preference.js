/* =====================================================
   Cloudflare Worker — Flamingo Sports
   Crea preferencia MP + envía email de pedido a tioflamingo@flamingosports.cl
   Variables de entorno requeridas:
     MP_ACCESS_TOKEN  — Mercado Pago Access Token producción
     BREVO_API_KEY    — API key de Brevo para email de aviso
   ===================================================== */

const ALLOWED_ORIGINS = [
  'https://www.flamingosports.cl',
  'https://flamingosports.cl',
  'http://localhost:3000',
];

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const corsOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
    const cors = {
      'Access-Control-Allow-Origin': corsOrigin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: cors });

    let body;
    try { body = await request.json(); }
    catch { return new Response(JSON.stringify({ error: 'Body inválido' }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } }); }

    const { items, shipping } = body;
    if (!items?.length) return new Response(JSON.stringify({ error: 'Carrito vacío' }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } });

    // ── Preferencia MP ──────────────────────────────
    const preference = {
      items: items.map(item => ({
        id: item.id,
        title: `Flamingo Sports — ${item.name}`,
        description: 'Calcetines técnicos para tenis y pádel. Talla única 36–44 unisex.',
        unit_price: item.price || 8990,
        quantity: item.qty || 1,
        currency_id: 'CLP',
        category_id: 'clothing_accessories',
        picture_url: item.image ? `https://www.flamingosports.cl/${item.image}` : 'https://www.flamingosports.cl/images/logo-negro.png',
      })),
      payer: shipping ? {
        name: shipping.nombre?.split(' ')[0] || '',
        surname: shipping.nombre?.split(' ').slice(1).join(' ') || '',
        email: shipping.email || '',
        phone: { area_code: '56', number: (shipping.telefono || '').replace(/\D/g, '').slice(-8) },
        address: {
          street_name: shipping.direccion || '',
          street_number: shipping.depto || '',
          zip_code: '',
        },
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
        items: items.map(item => ({
          id: item.id,
          title: item.name,
          quantity: item.qty,
          unit_price: item.price || 8990,
        })),
      } : undefined,
      back_urls: {
        success: 'https://www.flamingosports.cl/gracias.html',
        failure: 'https://www.flamingosports.cl/productos.html',
        pending: 'https://www.flamingosports.cl/gracias.html',
      },
      auto_return: 'approved',
      statement_descriptor: 'FLAMINGO SPORTS',
      payment_methods: { installments: 1 },
    };

    const mpRes  = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.MP_ACCESS_TOKEN}` },
      body: JSON.stringify(preference),
    });
    const mpData = await mpRes.json();
    if (!mpRes.ok || !mpData.id) {
      return new Response(JSON.stringify({ error: 'Error MP', detail: mpData }), { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    // ── Email de aviso a tioflamingo@flamingosports.cl ──
    if (env.BREVO_API_KEY && shipping) {
      const itemsHtml = items.map(i => `<tr><td style="padding:6px 0;font-size:13px;">${i.name} × ${i.qty}</td><td style="padding:6px 0;font-size:13px;text-align:right;">$${((i.price||8990)*i.qty).toLocaleString('es-CL')}</td></tr>`).join('');
      const total = items.reduce((s, i) => s + (i.price||8990) * i.qty, 0);
      const emailBody = {
        sender: { name: 'Flamingo Sports Tienda', email: 'flamingosport.cl@gmail.com' },
        to: [{ email: 'tioflamingo@flamingosports.cl', name: 'Tíos Flamingo' }],
        subject: `🛍️ Nuevo pedido — ${shipping.nombre}`,
        htmlContent: `<div style="font-family:Arial,sans-serif;max-width:560px;font-size:14px;color:#1a1a1a;">
          <p style="font-size:11px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#999;">FLAMINGO SPORTS — NUEVO PEDIDO</p>
          <h2 style="font-size:22px;margin:8px 0 24px;">Pedido de ${shipping.nombre}</h2>
          <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #eee;border-bottom:1px solid #eee;margin-bottom:24px;">${itemsHtml}
            <tr><td style="padding:10px 0 0;font-weight:700;">Total</td><td style="padding:10px 0 0;text-align:right;font-weight:700;">$${total.toLocaleString('es-CL')}</td></tr>
          </table>
          <p style="font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#999;margin-bottom:8px;">DATOS DE ENVÍO</p>
          <table cellpadding="4">
            <tr><td style="color:#999;font-size:12px;">Nombre</td><td style="font-size:13px;">${shipping.nombre}</td></tr>
            <tr><td style="color:#999;font-size:12px;">Email</td><td style="font-size:13px;">${shipping.email}</td></tr>
            <tr><td style="color:#999;font-size:12px;">Teléfono</td><td style="font-size:13px;">${shipping.telefono}</td></tr>
            <tr><td style="color:#999;font-size:12px;">Dirección</td><td style="font-size:13px;">${shipping.direccion}${shipping.depto ? ', ' + shipping.depto : ''}</td></tr>
            <tr><td style="color:#999;font-size:12px;">Ciudad</td><td style="font-size:13px;">${shipping.ciudad}, ${shipping.region}</td></tr>
            ${shipping.notas ? `<tr><td style="color:#999;font-size:12px;">Notas</td><td style="font-size:13px;">${shipping.notas}</td></tr>` : ''}
          </table>
          <p style="margin-top:24px;font-size:12px;color:#999;">Recuerda coordinar el despacho por Bluexpress.</p>
        </div>`,
      };
      await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': env.BREVO_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(emailBody),
      });
    }

    return new Response(JSON.stringify({ preference_id: mpData.id, init_point: mpData.init_point }), {
      status: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }
};
