/* =====================================================
   Cloudflare Worker — Flamingo Sports
   Crea preferencias de Mercado Pago para el carrito

   Deploy:
   1. Cloudflare Dashboard → Workers & Pages → Create Worker
   2. Pegar este código
   3. Settings → Variables → agregar: MP_ACCESS_TOKEN
   4. Nombrar el worker: mp-preference
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

    const corsHeaders = {
      'Access-Control-Allow-Origin': corsOrigin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: corsHeaders });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: 'Body inválido' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const { items } = body;
    if (!items || !items.length) {
      return new Response(JSON.stringify({ error: 'Carrito vacío' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const preference = {
      items: items.map(item => ({
        id: item.id,
        title: `Flamingo Sports — ${item.name}`,
        description: 'Calcetines técnicos de alto rendimiento para tenis y pádel. Talla única 36–44 unisex.',
        unit_price: item.price || 8990,
        quantity: item.qty || 1,
        currency_id: 'CLP',
        category_id: 'clothing_accessories',
        picture_url: item.image
          ? `https://www.flamingosports.cl/${item.image}`
          : 'https://www.flamingosports.cl/images/logo-negro.png',
      })),
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
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.MP_ACCESS_TOKEN}`,
      },
      body: JSON.stringify(preference),
    });

    const mpData = await mpRes.json();

    if (!mpRes.ok || !mpData.id) {
      return new Response(JSON.stringify({ error: 'Error MP', detail: mpData }), {
        status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ preference_id: mpData.id }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
};
