// Stage B6 — static assets for the hosted /simulated-checkout page (design
// v5 §6.4-6.6, correction #5's XSS-surface reduction, correction #5/§6.5's
// CSP fix). Kept as inline TS string constants rather than files on disk —
// no build step, no template engine, no new dependency, versioned with the
// rest of this feature's code exactly like every other string this
// controller already builds. Zero inline <script>/style= content in the
// HTML shell itself — everything interactive lives in APP_JS, everything
// visual in APP_CSS, served as separate same-origin static files, which is
// what makes the strict `default-src 'self'` CSP possible with no
// '"unsafe-inline"' exception anywhere.

export const SIMULATED_CHECKOUT_HTML = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>الدفع التجريبي | Macrocore</title>
<link rel="stylesheet" href="/simulated-checkout/app.css">
</head>
<body>
<div class="simulator-banner" role="status">
  <strong>بيئة محاكاة</strong>
  <span>لن يتم خصم أي مبلغ حقيقي</span>
</div>
<main class="checkout-shell">
  <header class="brand">
    <span class="brand-mark" aria-hidden="true">M</span>
    <span><strong>Macrocore</strong><small>بوابة الدفع التجريبية</small></span>
  </header>
  <section id="app" class="checkout-card" aria-live="polite">
    <p id="loading" class="loading">جاري تحميل بيانات الدفع...</p>
  </section>
  <p class="provider-note">اختبار داخلي لمجرى الدفع المستضاف — لا توجد بوابة دفع حقيقية متصلة.</p>
</main>
<dialog id="confirmation-dialog" class="confirmation-dialog" aria-labelledby="confirmation-title" aria-describedby="confirmation-message">
  <div class="confirmation-dialog-body">
    <span class="confirmation-dialog-mark" aria-hidden="true">!</span>
    <h2 id="confirmation-title">تأكيد نتيجة الدفع</h2>
    <p id="confirmation-message"></p>
    <div class="confirmation-dialog-actions">
      <button id="confirmation-submit" type="button">تأكيد</button>
      <button id="confirmation-cancel" class="btn-cancel" type="button" autofocus>تراجع</button>
    </div>
  </div>
</dialog>
<script src="/simulated-checkout/app.js"></script>
</body>
</html>
`;

export const SIMULATED_CHECKOUT_CSS = `
:root {
  --amber-50: #fffbeb; --amber-100: #fef3c7; --amber-500: #f59e0b; --amber-600: #d97706;
  --stone-50: #fafaf9; --stone-100: #f5f5f4; --stone-200: #e7e5e4; --stone-400: #a8a29e;
  --stone-500: #78716c; --stone-700: #44403c; --stone-800: #292524; --stone-900: #1c1917;
  --red-50: #fef2f2; --red-600: #dc2626; --emerald-50: #ecfdf5; --emerald-700: #047857;
  --bg: var(--stone-50); --surface: #fff; --surface-alt: var(--stone-100);
  --border: var(--stone-200); --text: var(--stone-800); --muted: var(--stone-500);
  --danger: var(--red-600); --success: var(--emerald-700);
}
* { box-sizing: border-box; }
body {
  min-height: 100vh; margin: 0; background: var(--bg); color: var(--text);
  font-family: 'Tajawal', 'Tahoma', 'Segoe UI', sans-serif;
}
.simulator-banner {
  display: flex; justify-content: center; gap: 0.55rem; flex-wrap: wrap;
  padding: 0.72rem 1rem; background: var(--stone-900); color: #fff; font-size: 0.9rem;
}
.simulator-banner strong { color: var(--amber-500); }
.checkout-shell { width: min(100% - 2rem, 460px); margin: 2.5rem auto; }
.brand { display: flex; align-items: center; gap: 0.75rem; margin: 0 0 1rem; }
.brand-mark {
  display: grid; place-items: center; width: 42px; height: 42px; border-radius: 12px;
  background: var(--amber-500); color: var(--stone-900); font-weight: 800; font-size: 1.2rem;
}
.brand strong, .brand small { display: block; }
.brand strong { font-size: 1.05rem; }
.brand small { margin-top: 0.12rem; color: var(--muted); }
.checkout-card {
  padding: 1.5rem; background: var(--surface); border: 1px solid var(--border);
  border-radius: 16px; box-shadow: 0 14px 40px rgba(28, 25, 23, 0.08);
}
h1 { margin: 0 0 0.35rem; font-size: 1.25rem; }
.intro { margin: 0 0 1.25rem; color: var(--muted); font-size: 0.9rem; line-height: 1.6; }
.details { margin: 0 0 1.25rem; border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
.row { display: flex; justify-content: space-between; gap: 1rem; padding: 0.8rem 0.9rem; background: var(--surface); font-size: 0.94rem; }
.row + .row { border-top: 1px solid var(--border); }
.row-label { color: var(--muted); }
.row-value { font-weight: 700; text-align: end; }
.amount { direction: ltr; unicode-bidi: isolate; }
.actions { display: grid; gap: 0.65rem; }
button {
  width: 100%; min-height: 46px; padding: 0.72rem 1rem; border: 1px solid transparent;
  border-radius: 10px; font: inherit; font-weight: 700; cursor: pointer; transition: transform 120ms ease, opacity 120ms ease;
}
button:hover:not(:disabled) { transform: translateY(-1px); }
button:focus-visible { outline: 3px solid var(--amber-100); outline-offset: 2px; }
button:disabled { cursor: wait; opacity: 0.58; }
.btn-success { background: var(--amber-500); color: var(--stone-900); }
.btn-success:hover:not(:disabled) { background: var(--amber-600); color: #fff; }
.btn-failure { background: var(--red-50); border-color: #fecaca; color: var(--danger); }
.btn-cancel { background: var(--surface-alt); border-color: var(--border); color: var(--text); }
.status { margin-top: 1rem; padding: 0.85rem; border-radius: 10px; text-align: center; font-weight: 700; }
.status-success { background: var(--emerald-50); color: var(--success); }
.status-failed { background: var(--red-50); color: var(--danger); }
.status-cancelled { background: var(--surface-alt); color: var(--muted); }
.loading, .error { margin: 0; padding: 1rem 0; text-align: center; line-height: 1.7; }
.loading { color: var(--muted); }
.error { color: var(--danger); }
.expired-note { margin: 0 0 1rem; padding: 0.85rem; border-radius: 10px; background: var(--surface-alt); color: var(--muted); text-align: center; font-weight: 700; }
.return-link {
  display: block; margin-top: 1rem; padding: 0.72rem 1rem; border-radius: 10px; text-align: center;
  background: var(--stone-900); color: #fff; font-weight: 700; text-decoration: none;
}
.return-link:focus-visible { outline: 3px solid var(--amber-100); outline-offset: 2px; }
.provider-note { margin: 0.9rem 0 0; color: var(--muted); text-align: center; font-size: 0.78rem; line-height: 1.6; }
.confirmation-dialog {
  width: min(calc(100% - 2rem), 420px); padding: 0; border: 1px solid var(--border);
  border-radius: 16px; background: var(--surface); color: var(--text);
  box-shadow: 0 24px 70px rgba(28, 25, 23, 0.28);
}
.confirmation-dialog::backdrop { background: rgba(28, 25, 23, 0.72); }
.confirmation-dialog-body { padding: 1.5rem; text-align: center; }
.confirmation-dialog-mark {
  display: grid; place-items: center; width: 44px; height: 44px; margin: 0 auto 0.85rem;
  border-radius: 12px; background: var(--amber-100); color: var(--amber-600); font-size: 1.35rem; font-weight: 800;
}
.confirmation-dialog h2 { margin: 0 0 0.6rem; font-size: 1.15rem; }
.confirmation-dialog p { margin: 0; color: var(--muted); font-size: 0.9rem; line-height: 1.8; }
.confirmation-dialog-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 0.65rem; margin-top: 1.25rem; }
.btn-danger { background: var(--danger); color: #fff; }
.btn-danger:hover:not(:disabled) { opacity: 0.9; }
@media (max-width: 520px) { .checkout-shell { margin: 1.5rem auto; } .checkout-card { padding: 1.15rem; } }
@media (prefers-color-scheme: dark) {
  :root {
    --bg: var(--stone-900); --surface: var(--stone-800); --surface-alt: var(--stone-700);
    --border: var(--stone-700); --text: var(--stone-100); --muted: var(--stone-400);
    --danger: #f87171; --success: #34d399; --red-50: rgba(220, 38, 38, 0.14); --emerald-50: rgba(4, 120, 87, 0.18);
  }
  .checkout-card { box-shadow: 0 14px 40px rgba(0, 0, 0, 0.25); }
  .confirmation-dialog { box-shadow: 0 24px 70px rgba(0, 0, 0, 0.5); }
  .confirmation-dialog-mark { background: rgba(245, 158, 11, 0.16); color: var(--amber-500); }
  .btn-danger { color: var(--stone-900); }
  .btn-failure { border-color: rgba(248, 113, 113, 0.35); }
  .return-link { background: var(--amber-500); color: var(--stone-900); }
}
`;

export const SIMULATED_CHECKOUT_JS = `
(function () {
  'use strict';

  var resolving = false;
  var pendingOutcome = '';
  var confirmationDialog = document.getElementById('confirmation-dialog');
  var confirmationMessage = document.getElementById('confirmation-message');
  var confirmationSubmit = document.getElementById('confirmation-submit');
  var confirmationCancel = document.getElementById('confirmation-cancel');

  function render(html) {
    document.getElementById('app').innerHTML = html;
  }

  function escapeHtml(value) {
    var div = document.createElement('div');
    div.textContent = String(value == null ? '' : value);
    return div.innerHTML;
  }

  // Read the fragment (never sent to any server, by definition of what a
  // URL fragment is) and IMMEDIATELY clear it from the visible URL/history —
  // design v5 §6.4 steps 1-3.
  var rawFragment = window.location.hash.replace(/^#/, '');
  history.replaceState(null, '', window.location.pathname);

  var lastDot = rawFragment.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === rawFragment.length - 1) {
    render('<p class="error">رابط الدفع التجريبي غير صالح أو غير مكتمل.</p>');
    return;
  }
  var sessionId = rawFragment.slice(0, lastDot);
  var token = rawFragment.slice(lastDot + 1);
  var authHeader = 'Bearer ' + sessionId + '.' + token;

  var statusLabels = {
    succeeded: 'تم تسجيل نجاح الدفع التجريبي',
    failed: 'تم تسجيل فشل الدفع التجريبي',
    cancelled: 'تم إلغاء الدفع التجريبي'
  };
  var planLabels = { bronze: 'برونزية', silver: 'فضية', gold: 'ذهبية' };
  var billingLabels = { monthly: 'شهرية', annual: 'سنوية' };

  var confirmationMessages = {
    succeeded: 'سيتم تسجيل المحاولة كناجحة ووضع الفاتورة كمدفوعة تجريبيًا. هذا الإجراء نهائي ولا يمكن التراجع عنه. هل تريد المتابعة؟',
    failed: 'سيتم تسجيل المحاولة كفاشلة نهائيًا. لإعادة المحاولة ستحتاج إلى إنشاء محاولة دفع جديدة. هل تريد المتابعة؟',
    cancelled: 'سيتم إلغاء المحاولة نهائيًا. لإعادة المحاولة ستحتاج إلى إنشاء محاولة دفع جديدة. هل تريد المتابعة؟'
  };

  function openConfirmation(outcome) {
    pendingOutcome = outcome;
    confirmationMessage.textContent = confirmationMessages[outcome];
    confirmationSubmit.textContent = outcome === 'succeeded' ? 'تأكيد نجاح الدفع' : (outcome === 'failed' ? 'تأكيد فشل الدفع' : 'تأكيد الإلغاء');
    confirmationSubmit.className = outcome === 'succeeded' ? 'btn-success' : 'btn-danger';
    confirmationDialog.showModal();
    // The safer action gets initial focus explicitly — not left to each
    // browser's autofocus handling inside a modal dialog.
    confirmationCancel.focus();
  }

  function closeConfirmation() {
    pendingOutcome = '';
    confirmationDialog.close();
  }

  confirmationCancel.addEventListener('click', closeConfirmation);
  confirmationDialog.addEventListener('cancel', function () { pendingOutcome = ''; });
  confirmationSubmit.addEventListener('click', function () {
    var outcome = pendingOutcome;
    closeConfirmation();
    if (outcome) resolve(outcome);
  });

  // Stage B7 — "return to Macrocore" link for self-service purchase sessions.
  // The URL is built server-side from FRONTEND_URL + the purchase UUID; it is
  // still re-validated here and set through the DOM href property, never
  // interpolated into HTML.
  function appendReturnLink(url) {
    if (!url) return;
    var parsed;
    try { parsed = new URL(url); } catch (e) { return; }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return;
    var link = document.createElement('a');
    link.className = 'return-link';
    link.href = parsed.toString();
    link.textContent = 'العودة إلى Macrocore';
    document.getElementById('app').appendChild(link);
  }

  function renderResult(data) {
    var session = data.session;
    var attempt = data.payment_attempt;
    // Stage B7: advisory only — the settlement transaction re-checks it under
    // locks. Absent for older payloads means "can succeed".
    var canSucceed = data.can_succeed !== false;
    var rows =
      '<div class="details">' +
      '<div class="row"><span class="row-label">الباقة</span><span class="row-value">' + escapeHtml(planLabels[attempt.plan] || attempt.plan) + '</span></div>' +
      '<div class="row"><span class="row-label">دورة الفوترة</span><span class="row-value">' + escapeHtml(billingLabels[attempt.billing_interval] || attempt.billing_interval) + '</span></div>' +
      '<div class="row"><span class="row-label">المبلغ</span><span class="row-value amount">' + escapeHtml(attempt.amount) + ' ' + escapeHtml(attempt.currency) + '</span></div>' +
      '</div>';

    if (session.status === 'pending') {
      render(
        '<h1>إتمام الدفع التجريبي</h1>' +
        (canSucceed
          ? '<p class="intro">اختر نتيجة محاكاة واحدة لاختبار دورة الدفع كاملة بدون أي خصم حقيقي.</p>'
          : '<p class="expired-note">انتهت مهلة جلسة الدفع</p>') +
        rows +
        '<div class="actions">' +
        (canSucceed ? '<button class="btn-success" data-outcome="succeeded">محاكاة نجاح الدفع</button>' : '') +
        '<button class="btn-failure" data-outcome="failed">محاكاة فشل الدفع</button>' +
        '<button class="btn-cancel" data-outcome="cancelled">إلغاء العملية التجريبية</button>' +
        '</div>'
      );
      if (!canSucceed) appendReturnLink(data.return_url);
      Array.prototype.forEach.call(document.querySelectorAll('button[data-outcome]'), function (btn) {
        btn.addEventListener('click', function () {
          if (resolving) return;
          var outcome = btn.getAttribute('data-outcome');
          openConfirmation(outcome);
        });
      });
    } else {
      var statusClass = session.status === 'succeeded' ? 'status-success' : (session.status === 'failed' ? 'status-failed' : 'status-cancelled');
      render('<h1>نتيجة الدفع التجريبي</h1>' + rows + '<div class="status ' + statusClass + '">' + escapeHtml(statusLabels[session.status] || session.status) + '</div>');
      appendReturnLink(data.return_url);
      authHeader = '';
    }
  }

  function fetchSession() {
    return fetch('/simulated-checkout/api/session', { headers: { Authorization: authHeader } })
      .then(function (r) {
        if (!r.ok) throw new Error('not found');
        return r.json();
      })
      .then(renderResult)
      .catch(function () { render('<p class="error">رابط الدفع التجريبي غير صالح أو لم يعد متاحًا.</p>'); });
  }

  function resolve(outcome) {
    if (resolving) return;
    resolving = true;
    Array.prototype.forEach.call(document.querySelectorAll('button[data-outcome]'), function (btn) { btn.disabled = true; });
    fetch('/simulated-checkout/api/resolve', {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: outcome }),
    })
      .then(function (r) {
        if (r.status === 409) return fetchSession();
        if (!r.ok) throw new Error('resolve failed');
        return r.json().then(fetchSession);
      })
      .catch(function () { render('<p class="error">تعذر تسجيل النتيجة. افتح رابط الدفع الأصلي مرة ثانية وتحقق من الحالة.</p>'); });
  }

  fetchSession();
})();
`;
