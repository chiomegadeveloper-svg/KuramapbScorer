/* Google sign-in + day-pass credits via Supabase. Disabled (free mode) when js/config.js is empty. */
(function () {
  const cfg = window.PB_CONFIG || {};
  const enabled = !!(cfg.supabaseUrl && cfg.supabaseAnonKey);
  const SB_URLS = [
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js',
    'https://unpkg.com/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js'
  ];
  let sb = null, user = null, profile = null;
  const listeners = new Set();
  const emit = () => listeners.forEach((f) => { try { f(api); } catch (e) {} });

  async function init() {
    if (!enabled) { emit(); return api; }
    await PBCommon.loadScript(SB_URLS);
    sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' }
    });
    const { data } = await sb.auth.getSession();
    user = data.session ? data.session.user : null;
    if (user) await refresh(); else emit();
    sb.auth.onAuthStateChange((_ev, session) => {
      const was = user && user.id;
      user = session ? session.user : null;
      if ((user && user.id) !== was) { profile = null; refresh(); }
    });
    return api;
  }

  /* Live "who's online" presence for the lobby. Each open scoreboard / phone joins one shared channel.
   * onUpdate gets { online, boards, courts, phones, players, active }. Returns { update(state) }. */
  let liveClient = null;
  async function getLiveClient() {
    await PBCommon.loadScript(SB_URLS);
    if (!liveClient) liveClient = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'aopb-live' }
    });
    return liveClient;
  }
  /* Internet relay for the phone <-> scoreboard link (works on any network, no WebRTC needed). */
  async function relay(name, onMsg) {
    if (!enabled) return null;
    const c = await getLiveClient();
    const ch = c.channel(name, { config: { broadcast: { self: false, ack: false } } });
    ch.on('broadcast', { event: 'm' }, (e) => { try { onMsg(e.payload); } catch (err) {} }).subscribe();
    return {
      send(p) { try { ch.send({ type: 'broadcast', event: 'm', payload: p }); } catch (e) {} },
      close() { try { c.removeChannel(ch); } catch (e) {} }
    };
  }
  async function live(id, state, onUpdate) {
    if (!enabled) return null;
    const c = await getLiveClient();
    let stats = {}, cur = state;
    const ch = c.channel('dk-online', { config: { presence: { key: id } } });
    const tally = () => {
      let boards = 0, courts = 0, phones = 0;
      Object.values(ch.presenceState()).forEach((arr) => {
        const m = (arr && arr[0]) || {};
        if (m.r === 'board') { boards++; if (m.live) courts++; } else phones++;
      });
      onUpdate({ online: boards + phones, boards, courts, phones, players: stats.players, active: stats.active_passes });
    };
    ch.on('presence', { event: 'sync' }, tally)
      .subscribe((s) => { if (s === 'SUBSCRIBED') ch.track(cur).catch(() => {}); });
    const loadStats = async () => { try { const { data } = await c.rpc('app_stats'); if (data) { stats = data; tally(); } } catch (e) {} };
    loadStats(); setInterval(loadStats, 120000);
    return { update(s) { cur = s; ch.track(s).catch(() => {}); } };
  }

  async function refresh() {
    if (!sb || !user) { profile = null; emit(); return null; }
    // The profile row is created by a database trigger right after first sign-in; retry briefly.
    for (let i = 0; i < 4; i++) {
      const { data, error } = await sb.from('profiles').select('*').eq('id', user.id).maybeSingle();
      if (!error && data) { profile = data; break; }
      await new Promise((r) => setTimeout(r, 600));
    }
    emit();
    return profile;
  }

  function signIn(returnTo) {
    if (!sb) return;
    return sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: returnTo ? new URL(returnTo, location.href).href : location.href, queryParams: { prompt: 'select_account' } }
    });
  }
  async function signOut() { if (sb) await sb.auth.signOut(); user = null; profile = null; emit(); }

  function passUntil() { return profile && profile.pass_until ? new Date(profile.pass_until) : null; }
  function passActive() { const p = passUntil(); return !!p && p.getTime() > Date.now(); }

  async function startPass() {
    if (!sb) return { ok: false, error: 'DISABLED' };
    const { data, error } = await sb.rpc('start_day_pass');
    await refresh();
    if (error) {
      const m = String(error.message || '');
      return { ok: false, error: m.includes('NO_CREDITS') ? 'NO_CREDITS' : m };
    }
    return { ok: true, until: data };
  }

  // Admin helpers
  async function listUsers() {
    const { data, error } = await sb.from('profiles').select('id,email,full_name,avatar_url,credits,hours_balance,bound_device,pass_until,is_admin,created_at').order('created_at', { ascending: false });
    if (error) throw error; return data;
  }
  async function ledgerPage(page, size) {
    const from = page * size;
    const { data, error, count } = await sb.from('credit_ledger').select('id,user_id,delta,reason,created_at', { count: 'exact' })
      .order('created_at', { ascending: false }).range(from, from + size - 1);
    if (error) throw error; return { rows: data, total: count || 0 };
  }
  async function ledger(limit) {
    const { data, error } = await sb.from('credit_ledger').select('id,user_id,delta,reason,created_at').order('created_at', { ascending: false }).limit(limit || 50);
    if (error) throw error; return data;
  }
  async function addCredits(email, amount, note) {
    const { data, error } = await sb.rpc('admin_add_credits', { target_email: email, amount, note: note || null });
    if (error) throw new Error(String(error.message || error).replace(/^.*?(NOT_ADMIN|USER_NOT_FOUND|ZERO_AMOUNT).*$/, '$1'));
    return data;
  }

  async function accessToken() {
    if (!sb) return null;
    const { data } = await sb.auth.getSession();
    return data.session ? data.session.access_token : null;
  }

  /* Used by the TV scoreboard (not signed in itself): checks a phone's Google session with Supabase.
   * Starts a 24-hour pass (1 credit) if none is active. Returns {ok, until, name, email, credits} or {ok:false, reason}. */
  async function verifyToken(token, opts) {
    if (!enabled) return { ok: true, free: true };
    const charge = !(opts && opts.charge === false);
    if (!token) return { ok: false, reason: 'NOT_SIGNED_IN' };
    await PBCommon.loadScript(SB_URLS);
    const c = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: { Authorization: 'Bearer ' + token } }
    });
    const { data: who } = await c.auth.getUser(token);
    if (!who || !who.user) return { ok: false, reason: 'NOT_SIGNED_IN' };
    const { data: until, error } = await c.rpc('start_pass', { p_device: (opts && opts.device) || '' });
    const uid = who && who.user ? who.user.id : null;
    const { data: prof } = uid ? await c.from('profiles').select('email,full_name,credits,pass_until').eq('id', uid).maybeSingle() : { data: null };
    if (error) {
      const m = String(error.message || '');
      const reason = m.includes('NO_CREDITS') ? 'NO_CREDITS' : m.includes('OTHER_DEVICE') ? 'OTHER_DEVICE' : (m.includes('JWT') || m.includes('NOT_SIGNED_IN')) ? 'NOT_SIGNED_IN' : 'ERROR';
      return { ok: false, reason, email: prof && prof.email, name: prof && prof.full_name };
    }
    return { ok: true, until, email: prof && prof.email, name: prof && prof.full_name, credits: prof && prof.credits };
  }

  // ---- Packages & payments ----
  const FALLBACK_PACKAGES = [
    { code: 'day', label: '24 hours', hours: 24, price_php: 50 }, { code: '3day', label: '3 days', hours: 72, price_php: 150 },
    { code: 'week', label: '1 week', hours: 168, price_php: 300 }, { code: 'month', label: '1 month', hours: 720, price_php: 800 }];
  async function packages() {
    if (!sb) return FALLBACK_PACKAGES;
    const { data, error } = await sb.from('packages').select('code,label,hours,price_php').order('sort');
    return (!error && data && data.length) ? data : FALLBACK_PACKAGES;
  }
  function errCode(e) { const m = String((e && e.message) || e || ''); const k = m.match(/[A-Z_]{6,}/); return k ? k[0] : m; }
  async function requestPurchase(pkg, ref) {
    const { data, error } = await sb.rpc('request_purchase', { p_package: pkg, p_reference: ref });
    if (error) throw new Error(errCode(error)); return data;
  }
  async function myPurchases() {
    if (!sb || !user) return [];
    const { data } = await sb.from('purchases').select('id,package,amount_php,reference,status,created_at').eq('user_id', user.id).order('created_at', { ascending: false }).limit(10);
    return data || [];
  }
  async function adminPurchases(status) {
    let q = sb.from('purchases').select('id,user_id,package,hours,amount_php,reference,status,created_at,reviewed_at,note').order('created_at', { ascending: status === 'pending' }).limit(100);
    if (status) q = q.eq('status', status);
    const { data, error } = await q; if (error) throw error; return data;
  }
  async function reviewPurchase(id, approve, note) {
    const { data, error } = await sb.rpc('admin_review_purchase', { p_id: id, p_approve: approve, p_note: note || null });
    if (error) throw new Error(errCode(error)); return data;
  }
  async function addHours(email, hours, note) {
    const { data, error } = await sb.rpc('admin_add_hours', { target_email: email, p_hours: hours, note: note || null });
    if (error) throw new Error(errCode(error)); return data;
  }
  async function resetDevice(uid) {
    const { error } = await sb.rpc('admin_reset_device', { target: uid });
    if (error) throw new Error(errCode(error));
  }

  // Free mode counts as "allowed"
  function allowed() { return !enabled || passActive(); }

  const api = {
    enabled, init, refresh, signIn, signOut, startPass, passActive, passUntil, allowed, accessToken, verifyToken,
    async savePush(sub) {
      const j = sub.toJSON();
      const { error } = await sb.rpc('save_push_subscription', { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth });
      if (error) throw error;
    },
    async deletePush(endpoint) { await sb.rpc('delete_push_subscription', { p_endpoint: endpoint }); },
    get client() { return sb; },
    async undoApproval(id) { const { data, error } = await sb.rpc('admin_undo_approval', { p_id: id }); if (error) throw new Error(error.message); return data; },
    live, relay,
    listUsers, ledger, ledgerPage, addCredits, packages, requestPurchase, myPurchases, adminPurchases, reviewPurchase, addHours, resetDevice,
    get user() { return user; }, get profile() { return profile; },
    onChange(f) { listeners.add(f); return () => listeners.delete(f); }
  };
  window.PBAuth = api;
})();
