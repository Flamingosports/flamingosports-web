/* =====================================================
   Cloudflare Worker — Flamingo Sports
   Variables requeridas en Cloudflare:
     MP_ACCESS_TOKEN    — Mercado Pago Access Token producción
     BREVO_API_KEY      — API key de Brevo
     REVIEW_FORM_URL    — URL del Google Form de reviews (opcional)
     IG_ACCESS_TOKEN    — Instagram Graph API long-lived token
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
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    // ── GET /ig-feed — Feed Instagram dinámico ──────
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/ig-feed') {
      try {
        const igToken = env.IG_ACCESS_TOKEN;
        if (!igToken) return new Response(JSON.stringify({ error: 'Token no configurado' }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
        const igUrl = 'https://graph.instagram.com/me/media?fields=id,media_type,media_url,thumbnail_url,permalink&limit=6&access_token=' + igToken;
        const igRes = await fetch(igUrl);
        const rawText = await igRes.text();
        if (!igRes.ok || !rawText) {
          return new Response(JSON.stringify({ error: 'Error Instagram API', status: igRes.status, raw: rawText.slice(0, 300) }), { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } });
        }
        const igData = JSON.parse(rawText);
        const posts = (igData.data || []).map(function(p) {
          return { id: p.id, type: p.media_type, url: p.media_type === 'VIDEO' ? p.thumbnail_url : p.media_url, permalink: p.permalink };
        });
        return new Response(JSON.stringify(posts), {
          status: 200,
          headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: 'Excepcion', detail: e.message }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
      }
    }

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
        unit_price: item.price || 9990,
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
        items: items.map(item => ({ id: item.id, title: item.name, quantity: item.qty, unit_price: item.price || 8990 })),
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

    const mpRes = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.MP_ACCESS_TOKEN}` },
      body: JSON.stringify(preference),
    });
    const mpData = await mpRes.json();
    if (!mpRes.ok || !mpData.id) {
      return new Response(JSON.stringify({ error: 'Error MP', detail: mpData }), { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    // ── Emails automáticos ──────────────────────────
    if (env.BREVO_API_KEY && shipping) {
      const brevoHeaders = { 'api-key': env.BREVO_API_KEY, 'Content-Type': 'application/json' };
      const REVIEW_URL = env.REVIEW_FORM_URL || 'https://www.flamingosports.cl';
      const primerNombre = shipping.nombre.split(' ')[0];
      const itemsHtml = items.map(i =>
        `<tr><td style="padding:6px 0;font-size:13px;">${i.name} × ${i.qty}</td><td style="padding:6px 0;font-size:13px;text-align:right;">$${((i.price||9990)*i.qty).toLocaleString('es-CL')}</td></tr>`
      ).join('');
      const total = items.reduce((s, i) => s + (i.price||9990) * i.qty, 0);

      // 1 — Aviso al vendedor
      fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST', headers: brevoHeaders,
        body: JSON.stringify({
          sender: { name: 'Flamingo Sports Tienda', email: 'flamingosport.cl@gmail.com' },
          to: [{ email: 'tioflamingo@flamingosports.cl' }],
          subject: `Nuevo pedido — ${shipping.nombre}`,
          htmlContent: `<div style="font-family:Arial,sans-serif;max-width:560px;font-size:14px;color:#1a1a1a;"><p style="font-size:11px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#999;">FLAMINGO SPORTS — NUEVO PEDIDO</p><h2 style="font-size:22px;margin:8px 0 24px;">Pedido de ${shipping.nombre}</h2><table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #eee;border-bottom:1px solid #eee;margin-bottom:24px;">${itemsHtml}<tr><td style="padding:10px 0 0;font-weight:700;">Total</td><td style="padding:10px 0 0;text-align:right;font-weight:700;">$${total.toLocaleString('es-CL')}</td></tr></table><p style="font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#999;margin-bottom:8px;">DATOS DE ENVÍO</p><table cellpadding="4"><tr><td style="color:#999;font-size:12px;">Nombre</td><td style="font-size:13px;">${shipping.nombre}</td></tr><tr><td style="color:#999;font-size:12px;">Email</td><td style="font-size:13px;">${shipping.email}</td></tr><tr><td style="color:#999;font-size:12px;">Teléfono</td><td style="font-size:13px;">${shipping.telefono}</td></tr><tr><td style="color:#999;font-size:12px;">Dirección</td><td style="font-size:13px;">${shipping.direccion}${shipping.depto?', '+shipping.depto:''}</td></tr><tr><td style="color:#999;font-size:12px;">Ciudad</td><td style="font-size:13px;">${shipping.ciudad}, ${shipping.region}</td></tr>${shipping.notas?`<tr><td style="color:#999;font-size:12px;">Notas</td><td style="font-size:13px;">${shipping.notas}</td></tr>`:''}</table><p style="margin-top:24px;font-size:12px;color:#999;">Recuerda coordinar el despacho por Bluexpress.</p></div>`,
        }),
      });

      // 2 — Confirmación al cliente (inmediata)
      fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST', headers: brevoHeaders,
        body: JSON.stringify({
          sender: { name: 'Flamingo Sports', email: 'tioflamingo@flamingosports.cl' },
          to: [{ email: shipping.email, name: shipping.nombre }],
          subject: `Tu pedido está confirmado, ${primerNombre} 🦩`,
          htmlContent: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;font-size:15px;color:#1a1a1a;"><p style="font-size:11px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#999;margin-bottom:16px;">FLAMINGO SPORTS</p><h2 style="font-size:24px;font-weight:900;color:#1B2D4A;margin:0 0 20px;">Recibimos tu pedido, ${primerNombre}.</h2><p style="margin:0 0 16px;line-height:1.7;">Lo estamos preparando. En las próximas <strong>48 horas hábiles</strong> lo despachamos por Bluexpress y te llegará el número de seguimiento.</p><table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #eee;border-bottom:1px solid #eee;margin:24px 0;padding:16px 0;">${itemsHtml}<tr><td style="padding:10px 0 0;font-weight:700;">Total pagado</td><td style="padding:10px 0 0;text-align:right;font-weight:700;color:#F0907C;">$${total.toLocaleString('es-CL')}</td></tr></table><p style="margin:0 0 16px;line-height:1.7;"><strong>Dirección de entrega:</strong><br>${shipping.direccion}${shipping.depto?', '+shipping.depto:''}, ${shipping.ciudad}, ${shipping.region}</p><p style="margin:0 0 32px;line-height:1.7;">¿Tienes alguna duda? Escríbenos por <a href="https://wa.me/56992269522" style="color:#1B2D4A;font-weight:700;">WhatsApp</a> — respondemos rápido.</p><p style="margin:0 0 4px;">Un abrazo,</p><p style="margin:0 0 32px;font-weight:700;">Nico, Kimu y Pollo<br><span style="font-size:12px;color:#999;font-weight:400;letter-spacing:1px;text-transform:uppercase;">Los Tíos Flamingo</span></p><p style="font-size:11px;color:#bbb;border-top:1px solid #eee;padding-top:16px;">Flamingo Sports · Santiago, Chile · <a href="https://www.flamingosports.cl" style="color:#bbb;">flamingosports.cl</a></p></div>`,
        }),
      });

      // 3 — Review request (programado 7 días después)
      const reviewDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST', headers: brevoHeaders,
        body: JSON.stringify({
          sender: { name: 'Flamingo Sports', email: 'tioflamingo@flamingosports.cl' },
          to: [{ email: shipping.email, name: shipping.nombre }],
          subject: `${primerNombre}, ¿cómo te quedaron los calcetines?`,
          scheduledAt: reviewDate,
          htmlContent: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;font-size:15px;color:#1a1a1a;"><p style="font-size:11px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#999;margin-bottom:16px;">FLAMINGO SPORTS</p><h2 style="font-size:24px;font-weight:900;color:#1B2D4A;margin:0 0 20px;">Hola ${primerNombre}, ¿llegaron bien?</h2><p style="margin:0 0 16px;line-height:1.7;">Hace una semana despachamos tus calcetines Flamingo. Si ya los probaste en cancha, nos encantaría saber qué te parecieron.</p><p style="margin:0 0 28px;line-height:1.7;">Son 2 minutos — y tu opinión ayuda a otros jugadores a decidirse.</p><a href="${REVIEW_URL}" style="display:inline-block;background:#F0907C;color:white;font-family:Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;padding:14px 28px;border-radius:2px;text-decoration:none;margin-bottom:32px;">Dejar mi opinión →</a><p style="margin:0 0 4px;">Gracias de verdad,</p><p style="margin:0 0 32px;font-weight:700;">Nico, Kimu y Pollo<br><span style="font-size:12px;color:#999;font-weight:400;letter-spacing:1px;text-transform:uppercase;">Los Tíos Flamingo</span></p><p style="font-size:11px;color:#bbb;border-top:1px solid #eee;padding-top:16px;">Flamingo Sports · Santiago, Chile · <a href="https://www.flamingosports.cl" style="color:#bbb;">flamingosports.cl</a><br>Si no quieres recibir más correos de nuestra parte, responde este mensaje.</p></div>`,
        }),
      });
    }

    return new Response(JSON.stringify({ preference_id: mpData.id, init_point: mpData.init_point }), {
      status: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }
};
