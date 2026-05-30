const https = require('https');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
  if (!ACCESS_TOKEN) {
    return { statusCode: 500, body: JSON.stringify({ error: 'MP_ACCESS_TOKEN no configurado' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Body inválido' }) };
  }

  const { productId, productName, productType } = body;

  const preference = {
    items: [
      {
        id: productId || 'calcetines-flamingo',
        title: `Flamingo Sports — ${productName || 'Calcetines'} ${productType || ''}`.trim(),
        description: 'Calcetines técnicos de alto rendimiento para tenis y pádel. Talla única 36–44 unisex.',
        unit_price: 8990,
        quantity: 1,
        currency_id: 'CLP',
        category_id: 'clothing_accessories',
      }
    ],
    back_urls: {
      success: 'https://www.flamingosports.cl/gracias.html',
      failure: 'https://www.flamingosports.cl/productos.html',
      pending: 'https://www.flamingosports.cl/gracias.html',
    },
    auto_return: 'approved',
    statement_descriptor: 'FLAMINGO SPORTS',
    external_reference: productId || 'calcetines',
    payment_methods: {
      excluded_payment_types: [],
      installments: 1,
    },
  };

  return new Promise((resolve) => {
    const data = JSON.stringify(preference);
    const options = {
      hostname: 'api.mercadopago.com',
      path: '/checkout/preferences',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ACCESS_TOKEN}`,
        'Content-Length': Buffer.byteLength(data),
      },
    };

    const req = https.request(options, (res) => {
      let responseData = '';
      res.on('data', (chunk) => { responseData += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(responseData);
          if (res.statusCode === 201 && parsed.id) {
            resolve({
              statusCode: 200,
              headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': 'https://www.flamingosports.cl',
              },
              body: JSON.stringify({ preference_id: parsed.id }),
            });
          } else {
            resolve({
              statusCode: 502,
              body: JSON.stringify({ error: 'Error al crear preferencia MP', detail: parsed }),
            });
          }
        } catch {
          resolve({ statusCode: 502, body: JSON.stringify({ error: 'Respuesta inválida de MP' }) });
        }
      });
    });

    req.on('error', (e) => {
      resolve({ statusCode: 500, body: JSON.stringify({ error: e.message }) });
    });

    req.write(data);
    req.end();
  });
};
