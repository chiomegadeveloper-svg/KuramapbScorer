(function () {
  const $ = (id) => document.getElementById(id);
  const { esc } = PBCommon;
  let users = [];

  function show(id) {
    ['needLogin', 'notAdmin', 'notConfigured', 'panel'].forEach((k) => $(k).classList.toggle('hidden', k !== id));
  }
  function fmt(d) { return d ? new Date(d).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'; }
  function msg(t, kind) { const m = $('tMsg'); m.textContent = t; m.className = 'msg ' + (kind || ''); }

  // Copy each column header onto its cells so tables can become cards on phones
  function labelCells(tbodyId) {
    const tb = $(tbodyId); const table = tb.closest('table'); const heads = table.querySelectorAll('thead th');
    tb.querySelectorAll('tr').forEach((tr) => [...tr.children].forEach((td, i) => { if (!td.hasAttribute('colspan')) td.setAttribute('data-label', heads[i] ? heads[i].textContent : ''); }));
  }
  function renderUsers() {
    const q = $('search').value.trim().toLowerCase();
    const list = users.filter((u) => !q || (u.email || '').includes(q) || (u.full_name || '').toLowerCase().includes(q));
    $('rows').innerHTML = list.map((u) => {
      const active = u.pass_until && new Date(u.pass_until) > new Date();
      return '<tr>' +
        '<td><div class="u">' + (u.avatar_url ? '<img src="' + esc(u.avatar_url) + '" alt="">' : '<img alt="">') +
        '<div><b>' + esc(u.full_name || '—') + (u.is_admin ? ' · admin' : '') + '</b><small>' + esc(u.email || '') + '</small></div></div></td>' +
        '<td class="num">' + (u.hours_balance || 0) + ' h</td>' +
        '<td class="' + (active ? 'pass-on' : '') + '">' + (active ? 'until ' + fmt(u.pass_until) : '—') + '</td>' +
        '<td>' + (u.bound_device ? '<button class="mini-btn" data-reset="' + esc(u.id) + '" title="Allow this user to switch phones">Locked · reset</button>' : '<span style="color:var(--ink-3)">none</span>') + '</td>' +
        '<td><div class="quick">' + [[24, '+1 day'], [168, '+1 wk']].map(([n, l]) => '<button data-e="' + esc(u.email) + '" data-n="' + n + '">' + l + '</button>').join('') + '</div></td>' +
        '</tr>';
    }).join('') || '<tr><td colspan="5" style="color:var(--ink-3)">No users yet. Users appear after their first Google sign-in.</td></tr>';
    labelCells('rows');
    $('rows').querySelectorAll('button[data-e]').forEach((b) => b.onclick = () => add(b.dataset.e, Number(b.dataset.n), 'Manual hours'));
    $('rows').querySelectorAll('button[data-reset]').forEach((b) => b.onclick = async () => {
      if (!confirm('Reset the phone lock? The user can then sign in on a new phone.')) return;
      try { await PBAuth.resetDevice(b.dataset.reset); msg('Phone lock reset.', 'ok'); loadAll(); } catch (e) { msg('Error: ' + e.message, 'bad'); }
    });
  }

  async function loadPayments(byId) {
    const pend = await PBAuth.adminPurchases('pending');
    const recent = (await PBAuth.adminPurchases()).filter((p) => p.status !== 'pending').slice(0, 30);
    const refCount = {};
    pend.concat(recent).forEach((p) => { refCount[p.reference] = (refCount[p.reference] || 0) + 1; });
    const who = (id) => esc((byId[id] && (byId[id].email)) || id.slice(0, 8));
    $('pendCount').textContent = pend.length; $('pendCount').classList.toggle('zero', !pend.length);
    if (window.__setPendingBadge) window.__setPendingBadge(pend.length);
    $('pending').innerHTML = pend.map((p) => '<tr><td>' + fmt(p.created_at) + '</td><td>' + who(p.user_id) + '</td><td>' + esc(p.package) + '</td>' +
      '<td class="num">PHP ' + p.amount_php + '</td><td><span class="ref">' + esc(p.reference) + '</span>' + (refCount[p.reference] > 1 ? '<span class="dup">same digits used before — check carefully</span>' : '') + '</td>' +
      '<td><div class="act"><button class="ok" data-ok="' + p.id + '">Approve</button><button class="no" data-no="' + p.id + '">Reject</button></div></td></tr>').join('') ||
      '<tr><td colspan="6" style="color:var(--ink-3)">Nothing to check right now.</td></tr>';
    labelCells('pending');
    $('pending').querySelectorAll('[data-ok]').forEach((b) => b.onclick = () => review(Number(b.dataset.ok), true));
    $('pending').querySelectorAll('[data-no]').forEach((b) => b.onclick = () => review(Number(b.dataset.no), false));
    $('reviewed').innerHTML = recent.map((p) => '<tr><td>' + fmt(p.reviewed_at || p.created_at) + '</td><td>' + who(p.user_id) + '</td><td>' + esc(p.package) + ' · PHP ' + p.amount_php + '</td><td class="ref">' + esc(p.reference) + '</td><td class="' + (p.status === 'approved' ? 'pass-on' : '') + '" style="' + (p.status === 'rejected' ? 'color:var(--danger)' : '') + '">' + esc(p.status) + '</td></tr>').join('');
    labelCells('reviewed');
  }
  async function review(id, ok) {
    const note = ok ? '' : (prompt('Reason for rejecting (optional):') || '');
    if (ok && !confirm('Approve this payment? Only approve if you received it.')) return;
    try { await PBAuth.reviewPurchase(id, ok, note); msg(ok ? 'Approved — time added to the user.' : 'Rejected.', ok ? 'ok' : ''); loadAll(); }
    catch (e) { msg('Error: ' + e.message, 'bad'); }
  }

  async function loadAll() {
    try {
      users = await PBAuth.listUsers();
      renderUsers();
      const byId = Object.fromEntries(users.map((u) => [u.id, u]));
      await loadPayments(byId);
      const rows = await PBAuth.ledger(40);
      $('ledger').innerHTML = rows.map((r) => '<tr><td>' + fmt(r.created_at) + '</td><td>' + esc((byId[r.user_id] && byId[r.user_id].email) || r.user_id.slice(0, 8)) + '</td>' +
        '<td class="num ' + (r.delta > 0 ? 'delta-pos' : 'delta-neg') + '">' + (r.delta > 0 ? '+' : '') + r.delta + '</td><td>' + esc(r.reason) + '</td></tr>').join('') ||
        '<tr><td colspan="4" style="color:var(--ink-3)">No activity yet.</td></tr>';
      labelCells('ledger');
    } catch (e) { msg('Could not load: ' + e.message, 'bad'); }
  }

  async function add(email, amount, note) {
    email = String(email || '').trim().toLowerCase();
    if (!email) return msg('Enter the user’s Google email.', 'bad');
    if (!Number.isInteger(amount) || amount === 0) return msg('Enter a whole number of hours (not 0).', 'bad');
    msg('Saving…');
    try {
      const bal = await PBAuth.addHours(email, amount, note);
      msg((amount > 0 ? 'Added ' + amount : 'Removed ' + -amount) + ' hours · ' + email + ' time bank is now ' + bal + ' h.', 'ok');
      loadAll();
    } catch (e) {
      const m = e.message;
      msg(m === 'USER_NOT_FOUND' ? email + ' has not signed in yet. Ask them to scan the scoreboard QR and sign in with Google once.' :
        m === 'NOT_ADMIN' ? 'Your account is not an admin.' : 'Error: ' + m, 'bad');
    }
  }

  $('tGo').onclick = () => add($('tEmail').value, parseInt($('tAmount').value, 10), $('tNote').value);
  $('search').oninput = renderUsers;
  $('reload').onclick = loadAll;
  $('loginBtn').onclick = () => PBAuth.signIn();
  $('logout').onclick = $('logout2').onclick = async () => { await PBAuth.signOut(); };

  PBAuth.onChange(() => {
    const u = PBAuth.user, p = PBAuth.profile;
    $('whoTxt').textContent = u ? u.email : 'Signed out';
    $('who').classList.toggle('ok', !!(p && p.is_admin));
    if (!PBAuth.enabled) return show('notConfigured');
    if (!u) return show('needLogin');
    if (!p) return;                       // still loading
    if (!p.is_admin) { $('notAdminTxt').textContent = u.email + ' does not have admin access.'; return show('notAdmin'); }
    show('panel'); loadAll();
    if (!window._adminPoll) window._adminPoll = setInterval(loadAll, 30000);
  });
  /* ---------- Install as an app ---------- */
  PBCommon.registerSW();
  let deferredInstall = null;
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const dismissed = PBCommon.store.get('aopb.installDismissed', 0) > Date.now() - 7 * 864e5;
  function showInstall(hint) {
    if (standalone || dismissed) return;
    if (hint) $('installHint').textContent = hint;
    $('installBar').classList.remove('hidden');
  }
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; showInstall(); });
  window.addEventListener('appinstalled', () => { $('installBar').classList.add('hidden'); msg('Owner app installed.', 'ok'); });
  if (ios && !standalone) { $('installBtn').textContent = 'How?'; showInstall('On iPhone/iPad: tap the Share button, then “Add to Home Screen”.'); }
  $('installBtn').onclick = async () => {
    if (deferredInstall) { deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; $('installBar').classList.add('hidden'); }
    else if (ios) alert('Tap the Share button (square with an arrow) at the bottom of Safari, then choose “Add to Home Screen”.');
    else alert('Open your browser menu (⋮) and choose “Install app” or “Add to Home screen”.');
  };
  $('installX').onclick = () => { $('installBar').classList.add('hidden'); PBCommon.store.set('aopb.installDismissed', Date.now()); };

  // Pending count on the app icon / tab title
  const baseTitle = document.title;
  window.__setPendingBadge = (n) => {
    document.title = n ? '(' + n + ') ' + baseTitle : baseTitle;
    try { if ('setAppBadge' in navigator) { n ? navigator.setAppBadge(n) : navigator.clearAppBadge(); } } catch (e) {}
  };

  PBAuth.init().catch((e) => { $('whoTxt').textContent = 'Error'; msg(String(e.message || e), 'bad'); });
})();
