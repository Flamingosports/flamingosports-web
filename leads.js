/* =====================================================
   Flamingo Sports — captura de leads (popup 10% bienvenida)
   Se incluye en index, productos, producto y nosotros.
   Habla con POST /subscribe del Worker: cupón single-use
   10% + alta en Brevo + email de bienvenida.
   Estado en localStorage "flLead":
     { done:true }     → ya dejó su correo: no molestar nunca más
     { closedAt: ts }  → cerró el popup: no reabrir solo por 7 días
   La pestaña "10% OFF" queda siempre visible hasta capturar.
   ===================================================== */
(function () {
  var API = 'https://mp-preference.flamingosport-cl.workers.dev';
  var LS_KEY = 'flLead';
  var st = {};
  try { st = JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch (e) {}
  if (st.done) return;
  function save() { try { localStorage.setItem(LS_KEY, JSON.stringify(st)); } catch (e) {} }

  // ── Estilos ──
  var css = document.createElement('style');
  css.textContent = [
    '#flLeadTab{position:fixed;bottom:24px;left:24px;z-index:1190;display:flex;align-items:center;gap:8px;background:#1B2D4A;color:#fff;font-family:var(--r,\'Causten\',Arial,sans-serif);font-size:10px;font-weight:800;letter-spacing:2px;text-transform:uppercase;padding:11px 18px;border-radius:2px;border:none;cursor:pointer;box-shadow:0 4px 20px rgba(27,45,74,.4);transition:transform .2s,background .2s;}',
    '#flLeadTab:hover{background:#F0907C;transform:translateY(-2px);}',
    '#flLeadOverlay{position:fixed;inset:0;z-index:1200;background:rgba(27,45,74,.72);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;padding:20px;opacity:0;transition:opacity .25s;}',
    '#flLeadOverlay.on{opacity:1;}',
    '#flLeadCard{background:#fff;border-radius:4px;max-width:430px;width:100%;padding:38px 34px 32px;position:relative;transform:translateY(14px);transition:transform .25s;border-top:4px solid #F0907C;}',
    '#flLeadOverlay.on #flLeadCard{transform:translateY(0);}',
    '#flLeadClose{position:absolute;top:12px;right:14px;background:none;border:none;font-size:22px;line-height:1;color:#bbb;cursor:pointer;padding:6px;}',
    '#flLeadClose:hover{color:#1B2D4A;}',
    '#flLeadCard .fl-eyebrow{font-family:var(--r,\'Causten\',Arial,sans-serif);font-size:10px;font-weight:700;letter-spacing:4px;text-transform:uppercase;color:#F0907C;margin-bottom:10px;}',
    '#flLeadCard h3{font-family:var(--r,\'Causten\',Arial,sans-serif);font-size:30px;font-weight:900;line-height:1.05;letter-spacing:-0.5px;color:#1B2D4A;margin:0 0 12px;}',
    '#flLeadCard p{font-family:var(--i,\'Causten\',Arial,sans-serif);font-size:14px;color:#666;line-height:1.65;margin:0 0 22px;}',
    '#flLeadForm{display:flex;flex-direction:column;gap:10px;}',
    '#flLeadEmail{font-family:var(--i,\'Causten\',Arial,sans-serif);font-size:15px;padding:13px 14px;border:1.5px solid #ddd;border-radius:2px;outline:none;width:100%;}',
    '#flLeadEmail:focus{border-color:#1B2D4A;}',
    '#flLeadBtn{font-family:var(--r,\'Causten\',Arial,sans-serif);font-size:11px;font-weight:800;letter-spacing:2.5px;text-transform:uppercase;background:#F0907C;color:#fff;border:none;border-radius:2px;padding:14px;cursor:pointer;transition:background .2s;}',
    '#flLeadBtn:hover{background:#d97563;}',
    '#flLeadBtn:disabled{opacity:.6;cursor:wait;}',
    '#flLeadErr{font-size:12.5px;color:#c0392b;margin:0;display:none;}',
    '#flLeadFine{font-size:11px;color:#aaa;margin:14px 0 0;line-height:1.5;}',
    '#flLeadOk{display:none;text-align:center;}',
    '#flLeadOk .fl-code{font-family:var(--r,\'Causten\',Arial,sans-serif);font-size:28px;font-weight:900;letter-spacing:3px;color:#1B2D4A;background:#FDF1EE;border:1.5px dashed #F0907C;border-radius:2px;padding:14px 10px;margin:16px 0 10px;user-select:all;}',
    '@media(max-width:600px){#flLeadTab{bottom:18px;left:14px;padding:10px 14px;}#flLeadCard{padding:30px 22px 26px;}#flLeadCard h3{font-size:25px;}}',
  ].join('\n');
  document.head.appendChild(css);

  // ── Pestaña flotante ──
  var tab = document.createElement('button');
  tab.id = 'flLeadTab';
  tab.innerHTML = '🦩 10% OFF tu primera compra';
  tab.setAttribute('aria-label', 'Cupón 10% primera compra');
  tab.onclick = function () { openModal(); };
  document.body.appendChild(tab);

  // ── Modal (se construye una vez, se muestra a demanda) ──
  var overlay = null;
  function buildModal() {
    overlay = document.createElement('div');
    overlay.id = 'flLeadOverlay';
    overlay.innerHTML =
      '<div id="flLeadCard" role="dialog" aria-modal="true" aria-label="Cupón de bienvenida">' +
      '<button id="flLeadClose" aria-label="Cerrar">×</button>' +
      '<div id="flLeadMain">' +
      '<div class="fl-eyebrow">Un regalo de los tíos</div>' +
      '<h3>10% en tu<br>primera compra.</h3>' +
      '<p>Déjanos tu correo y te mandamos al tiro un cupón de <strong>10%</strong> para estrenar tus primeras Flamingo.</p>' +
      '<form id="flLeadForm">' +
      '<input id="flLeadEmail" type="email" required placeholder="tucorreo@ejemplo.cl" autocomplete="email">' +
      '<input id="flLeadWeb" type="text" name="web" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px;" aria-hidden="true">' +
      '<button id="flLeadBtn" type="submit">Quiero mi 10%</button>' +
      '<p id="flLeadErr"></p>' +
      '</form>' +
      '<p id="flLeadFine">Cero spam — solo cosas de cancha. Te puedes bajar cuando quieras.</p>' +
      '</div>' +
      '<div id="flLeadOk">' +
      '<div class="fl-eyebrow">Listo, crack</div>' +
      '<h3>Tu cupón:</h3>' +
      '<div class="fl-code" id="flLeadCode"></div>' +
      '<p id="flLeadOkMsg">También te lo enviamos al correo. Se aplica en el carrito.</p>' +
      '<a href="productos.html" id="flLeadGo" style="display:inline-block;background:#F0907C;color:#fff;font-family:var(--r,\'Causten\',Arial,sans-serif);font-size:11px;font-weight:800;letter-spacing:2.5px;text-transform:uppercase;padding:14px 30px;border-radius:2px;text-decoration:none;">Ver modelos →</a>' +
      '</div></div>';
    document.body.appendChild(overlay);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeModal(); });
    overlay.querySelector('#flLeadClose').onclick = closeModal;
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && overlay.parentNode) closeModal(); });
    overlay.querySelector('#flLeadForm').addEventListener('submit', submit);
  }

  function openModal() {
    if (!overlay) buildModal();
    if (!overlay.parentNode) document.body.appendChild(overlay);
    requestAnimationFrame(function () { overlay.classList.add('on'); });
    setTimeout(function () { var i = document.getElementById('flLeadEmail'); if (i) i.focus(); }, 260);
  }
  function closeModal() {
    if (!overlay) return;
    overlay.classList.remove('on');
    setTimeout(function () { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }, 250);
    if (!st.done) { st.closedAt = Date.now(); save(); }
  }

  function submit(e) {
    e.preventDefault();
    var btn = document.getElementById('flLeadBtn');
    var err = document.getElementById('flLeadErr');
    var email = document.getElementById('flLeadEmail').value.trim();
    err.style.display = 'none';
    btn.disabled = true;
    btn.textContent = 'Un segundo…';
    fetch(API + '/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: email,
        web: document.getElementById('flLeadWeb').value,
        source: location.pathname,
      }),
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok || !res.d.ok) throw new Error(res.d.error || 'No pudimos registrarte — inténtalo de nuevo');
        st.done = true; save();
        document.getElementById('flLeadMain').style.display = 'none';
        var ok = document.getElementById('flLeadOk');
        document.getElementById('flLeadCode').textContent = res.d.coupon || '(revisa tu correo)';
        if (res.d.already) document.getElementById('flLeadOkMsg').textContent = 'Ya estabas inscrito — este es tu mismo cupón de antes. Se aplica en el carrito.';
        else if (res.d.vence) document.getElementById('flLeadOkMsg').textContent = 'También te lo enviamos al correo. Vence el ' + res.d.vence.split('-').reverse().join('-') + ' — se aplica en el carrito.';
        ok.style.display = 'block';
        if (tab.parentNode) tab.parentNode.removeChild(tab);
        try { if (typeof gtag === 'function') gtag('event', 'generate_lead', { method: 'popup_10off' }); } catch (e2) {}
        try { if (typeof fbq === 'function') fbq('track', 'Lead'); } catch (e2) {}
      })
      .catch(function (ex) {
        err.textContent = ex.message || 'Algo falló — inténtalo de nuevo';
        err.style.display = 'block';
      })
      .then(function () {
        btn.disabled = false;
        btn.textContent = 'Quiero mi 10%';
      });
  }

  // ── Auto-apertura: 1 vez, a los 12 s o al 40% de scroll; si la cerró,
  //    no volver a abrirla sola por 7 días (la pestaña sigue disponible) ──
  var yaAbierto = false;
  function autoOpen() {
    if (yaAbierto) return;
    yaAbierto = true;
    openModal();
  }
  if (!st.closedAt || (Date.now() - st.closedAt) > 7 * 24 * 3600 * 1000) {
    setTimeout(autoOpen, 12000);
    window.addEventListener('scroll', function onScroll() {
      var h = document.documentElement;
      if ((window.scrollY || h.scrollTop) / (h.scrollHeight - h.clientHeight) > 0.4) {
        window.removeEventListener('scroll', onScroll);
        autoOpen();
      }
    }, { passive: true });
  }
})();
