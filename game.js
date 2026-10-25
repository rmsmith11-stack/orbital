// game.js — what you see and touch.
//
// Draws the board, sweeps the cannon, fires on tap, and keeps the picture in
// step with the shared game record. All the rules live in physics.js; all the
// talking-to-the-other-phone lives in net.js.

(function () {
  'use strict';

  var P = window.Orbital, C = P.C, Net = window.OrbitalNet;
  function $(id) { return document.getElementById(id); }

  var canvas = $('game'), ctx = canvas.getContext('2d');
  var bgLayer = document.createElement('canvas');     // stars and nebula, drawn once
  var gridLayer = document.createElement('canvas');   // the bending grid, redrawn when orbs change
  var gridSig = '';

  var COLORS = { 0: '#ffffff', 1: '#5ee7ff', 2: '#ff5fd2' };   // neutral, player 1, player 2
  var ROLE_NUM = { p1: 1, p2: 2 };
  var HUD_H = 44;
  var BANNER_MS = 2600;
  var GRID_SPACING = 10, GRID_K = 36;

  // ------------------------------------------------------------ app state
  var mode = null;          // 'online' or 'practice'
  var me = null;            // 'p1' or 'p2' when online
  var flip = false;         // player 2 sees the board upside down so their cannon is at the bottom
  var transport = null, roomCode = null;
  var room = null;          // the shared game record as last applied to the screen
  var pending = null;       // a newer record waiting for an animation to finish
  var lastShotSeen = 0;
  var anim = null;          // { sim, t0, steps } while a shot is in the air / growing
  var disp = { orbs: [] };  // the orbs currently drawn
  var fx = [], trail = [], hitFlash = {};
  var banner = null, holdUntil = 0;
  var flash = null;          // short "YOUR TURN" notice, does not block play
  var sweepStart = null, cannon = { p1: 0, p2: 0 };
  var turnArmedAt = 0;       // taps are ignored for a moment after a turn starts (no accidental shots)
  var ARM_DELAY = 500;
  var L = { scale: 1, ox: 0, oy: 0, dpr: 1, w: 0, h: 0 };
  var urlParams = new URLSearchParams(location.search);

  // Testing hooks (harmless in normal play): ?demo=N fires N shots by itself,
  // ?speed=X runs the clock X times faster, ?snap=MS posts a picture of the
  // screen to the test server after MS milliseconds, ?log=1 prints sync events.
  var demoShots = parseInt(urlParams.get('demo') || '0', 10), demoIndex = 0;
  var speed = parseFloat(urlParams.get('speed') || '1') || 1;
  var snapAt = parseInt(urlParams.get('snap') || '0', 10);
  var logging = !!urlParams.get('log');
  function orbList(orbs) { return orbs.map(function (o) { return o.owner + ':' + Math.round(o.x) + ',' + Math.round(o.y) + ',' + Math.round(o.r) + ',' + o.lives; }).join(' '); }
  function log(msg) { if (logging) console.log('[' + (me || 'practice') + '] ' + msg); }

  // ------------------------------------------------------------- helpers
  function nameOf(role) {
    var p = room && room.players && room.players[role];
    return p && p.name ? p.name : (role === 'p1' ? 'P1' : 'P2');
  }
  function colorOf(role) { return COLORS[ROLE_NUM[role]]; }
  function busy() { return !!anim || performance.now() < holdUntil; }
  function canFire() {
    return !!room && room.phase === 'playing' && !busy() && !!room.players.p2 &&
      (mode === 'practice' || room.turn === me);
  }
  function showError(msg) {
    var box = $('error');
    box.textContent = String(msg && msg.message ? msg.message : msg);
    box.hidden = false;
    clearTimeout(showError.timer);
    showError.timer = setTimeout(function () { box.hidden = true; }, 6000);
    console.error(msg);
  }
  function normalize(state) {
    if (!state) return null;
    state.orbs = state.orbs || [];
    state.players = state.players || {};
    state.wins = state.wins || { p1: 0, p2: 0 };
    if (state.lastShot) state.lastShot.orbsBefore = state.lastShot.orbsBefore || [];
    return state;
  }
  function randomCode() {
    var letters = 'ABCDEFGHJKMNPQRSTUVWXYZ', s = '';
    for (var i = 0; i < 5; i++) s += letters[Math.floor(Math.random() * letters.length)];
    return s;
  }
  function newRoomState(code, hostName) {
    return {
      v: 1, code: code, createdAt: Date.now(), match: 1,
      players: { p1: { name: hostName }, p2: null },
      phase: 'lobby', round: 1, wins: { p1: 0, p2: 0 }, turn: 'p1',
      orbs: P.initialOrbs(), lastShot: null, winner: null
    };
  }

  // Remembering which player this device is. On real phones that's saved on
  // the phone; in local test mode each browser window remembers its own, so
  // two windows on one Mac can be the two players.
  var roleStore = Net.isOnline() ? localStorage : sessionStorage;
  function savedRole(code) {
    var fromUrl = urlParams.get('as');
    if (fromUrl === 'p1' || fromUrl === 'p2') return fromUrl;
    return roleStore.getItem('orbital-role-' + code);
  }
  function rememberRole(code, role) { roleStore.setItem('orbital-role-' + code, role); }

  function shareUrl(code) {
    return location.origin + location.pathname + '?room=' + code;
  }

  // ------------------------------------------------------- game record flow
  // A new copy of the shared record has arrived (from the other phone, or
  // from ourselves). Decide whether to replay a shot or just show the result.
  function handleIncoming(state) {
    state = normalize(state);
    if (!state) return;
    log('incoming shot=' + (state.lastShot ? state.lastShot.num + ' by ' + state.lastShot.by : 'none') + ' turn=' + state.turn + ' busy=' + busy() + ' lastSeen=' + lastShotSeen);
    if (busy()) { pending = state; return; }
    var shot = state.lastShot;
    var replay = mode === 'online' && shot && room && room.phase === 'playing' &&
      shot.by !== me && shot.num === lastShotSeen + 1 && (shot.match || 1) === (room.match || 1);
    if (replay) startReplay(shot, state); else applyState(state);
  }

  function applyState(state) {
    log('apply turn=' + state.turn + ' orbs=' + orbList(state.orbs));
    var turnChanged = !room || room.turn !== state.turn || room.round !== state.round;
    room = state;
    if (turnChanged) turnArmedAt = performance.now() + ARM_DELAY;
    if (turnChanged && state.phase === 'playing' && state.players.p2 && (mode === 'practice' || state.turn === me)) {
      flash = { text: mode === 'practice' ? 'YOUR TURN, ' + nameOf(state.turn).toUpperCase() : 'YOUR TURN', color: colorOf(state.turn), until: performance.now() + 1100 };
    }
    disp.orbs = P.cloneOrbs(room.orbs);
    lastShotSeen = room.lastShot ? room.lastShot.num : 0;
    pending = null;
    sweepStart = null;
    updateHud();
    updatePanels();
  }

  function startReplay(shot, state) {
    pending = state;
    lastShotSeen = shot.num;
    cannon[shot.by] = P.angleOf(shot.by, shot.vx, shot.vy);
    startAnimation(P.createShot(shot.orbsBefore, shot.by, shot.num, shot.vx, shot.vy));
    updateHud();
  }

  function fire() {
    if (!canFire() || performance.now() < turnArmedAt) return;
    var role = room.turn;
    var v = P.aimVector(role, cannon[role]);
    var num = (room.lastShot ? room.lastShot.num : 0) + 1;

    // Work out the whole shot instantly so the other phone can be told now,
    // then animate the same shot for ourselves.
    var finalSim = P.runToEnd(P.createShot(room.orbs, role, num, v.vx, v.vy));
    var res = P.resolveShot(room, finalSim);
    var next = JSON.parse(JSON.stringify(room));
    next.orbs = res.orbs; next.turn = res.turn; next.round = res.round;
    next.wins = res.wins; next.phase = res.phase; next.winner = res.winner;
    next.lastShot = { num: num, by: role, vx: v.vx, vy: v.vy, outcome: finalSim.outcome,
                      orbsBefore: P.cloneOrbs(room.orbs), match: room.match || 1 };
    next.updatedAt = Date.now();

    lastShotSeen = num;
    pending = next;
    // Start our own animation before telling the transport: the transport
    // echoes the new record straight back, and the echo must wait for the
    // animation to finish rather than replace the board mid-flight.
    startAnimation(P.createShot(room.orbs, role, num, v.vx, v.vy));
    if (transport) transport.set(next).catch(showError);
    updateHud();
  }

  function startAnimation(sim) {
    log('animate shot ' + sim.shotNum + ' by ' + sim.role + ' from ' + orbList(sim.orbs));
    anim = { sim: sim, t0: performance.now(), steps: 0 };
    disp.orbs = sim.orbs;
    trail = [];
  }

  function finishAnimation(now) {
    var sim = anim.sim;
    anim = null;
    var next = pending;
    pending = null;
    if (sim.outcome === 'lost') {
      var w = P.other(sim.loser);
      var matchOver = next && next.phase === 'over';
      banner = { text: matchOver ? nameOf(w) + ' wins the match!' : nameOf(w) + ' takes round ' + room.round,
                 color: colorOf(w), until: now + BANNER_MS };
      holdUntil = now + BANNER_MS;
      setTimeout(function () {
        holdUntil = 0; banner = null;
        var s = pending || next; pending = null;
        if (s) handleIncoming(s);
      }, BANNER_MS);
    } else if (next) {
      handleIncoming(next);
    }
    updateHud();
  }

  function playAgain() {
    if (!room) return;
    var next = JSON.parse(JSON.stringify(room));
    next.match = (room.match || 1) + 1;
    next.phase = 'playing'; next.round = 1; next.wins = { p1: 0, p2: 0 };
    next.turn = (next.match % 2 === 1) ? 'p1' : 'p2';
    next.orbs = P.initialOrbs(); next.lastShot = null; next.winner = null;
    next.updatedAt = Date.now();
    if (transport) transport.set(next).catch(showError);
    handleIncoming(next);
  }

  // ----------------------------------------------------------- lobby flow
  function startPractice() {
    mode = 'practice'; me = null; flip = false; transport = null;
    var s = newRoomState('LOCAL', 'P1');
    s.players.p2 = { name: 'P2' };
    s.phase = 'playing';
    $('lobby').hidden = true;
    applyState(s);
  }

  function createOnline(name, fixedCode) {
    mode = 'online'; me = 'p1'; flip = false;
    roomCode = fixedCode || randomCode();
    transport = Net.create(roomCode);
    var s = newRoomState(roomCode, name);
    return transport.connect()
      .then(function () { return transport.set(s); })
      .then(function () {
        rememberRole(roomCode, 'p1');
        transport.subscribe(handleIncoming);
        $('lobby').hidden = true;
        applyState(s);
        if (!fixedCode) history.replaceState(null, '', shareUrl(roomCode));
      });
  }

  function joinOnline(code, name) {
    mode = 'online'; roomCode = code;
    transport = Net.create(code);
    return transport.connect()
      .then(function () { return transport.load(); })
      .then(function (s) {
        s = normalize(s);
        if (!s) throw new Error('No game found with code ' + code + '. Ask your friend for a fresh link.');
        var saved = savedRole(code);
        if (saved === 'p1' || saved === 'p2') {
          me = saved;
          if (me === 'p2' && !s.players.p2) return transport.update({ 'players/p2': { name: name }, phase: 'playing' });
          return null;
        }
        if (!s.players.p2) {
          me = 'p2';
          rememberRole(code, 'p2');
          return transport.update({ 'players/p2': { name: name }, phase: 'playing' });
        }
        throw new Error('This game already has two players.');
      })
      .then(function () { return transport.load(); })
      .then(function (s) {
        flip = me === 'p2';
        gridSig = '';
        transport.subscribe(handleIncoming);
        $('lobby').hidden = true;
        applyState(normalize(s));
      });
  }

  function updatePanels() {
    var waiting = mode === 'online' && room && !room.players.p2;
    $('waiting').hidden = !waiting;
    if (waiting) {
      $('shareLink').textContent = shareUrl(roomCode);
      $('codeLabel').textContent = roomCode;
    }
    var over = room && room.phase === 'over';
    $('over').hidden = !over;
    if (over) {
      var w = room.winner;
      var youWon = mode === 'online' && w === me;
      $('overTitle').textContent = youWon ? 'You win the match!' : nameOf(w) + ' wins the match!';
      $('overTitle').className = w === 'p1' ? 'c1' : 'c2';
      $('overSub').textContent = room.wins.p1 + ' – ' + room.wins.p2 + ' in rounds';
    }
  }

  function updateHud() {
    if (!room) return;
    $('roundLabel').textContent = room.phase === 'over' ? 'Match over' : 'Round ' + room.round + ' · first to 3';
    var st = $('status'), text = '', cls = '';
    if (room.phase === 'lobby') text = 'Waiting for your friend to join…';
    else if (room.phase === 'over') text = '';
    else if (anim) { text = nameOf(anim.sim.role) + ' fires…'; cls = anim.sim.role === 'p1' ? 'c1' : 'c2'; }
    else if (banner) text = '';
    else if (mode === 'practice') { text = nameOf(room.turn) + ': tap to fire'; cls = room.turn === 'p1' ? 'c1' : 'c2'; }
    else if (room.turn === me) { text = 'Your turn — tap to fire'; cls = me === 'p1' ? 'c1' : 'c2'; }
    else { text = 'Waiting for ' + nameOf(room.turn) + '…'; cls = room.turn === 'p1' ? 'c1' : 'c2'; }
    st.textContent = text; st.className = cls;
  }

  // -------------------------------------------------------------- drawing
  function resize() {
    var dpr = window.devicePixelRatio || 1;
    var w = window.innerWidth, h = window.innerHeight;
    if (w === L.w && h === L.h && dpr === L.dpr) return;
    L.w = w; L.h = h; L.dpr = dpr;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    var pad = 4;
    var availW = w - pad * 2, availH = h - HUD_H - pad;
    L.scale = Math.min(availW / C.W, availH / C.H);
    L.ox = (w - C.W * L.scale) / 2;
    L.oy = HUD_H + (availH - C.H * L.scale) / 2;
    buildBackground();
    gridSig = '';
  }

  function rgba(hex, a) {
    var r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }

  // Put a drawing context into arena coordinates (0..W, 0..H), flipped for player 2.
  function arenaTransform(g) {
    g.setTransform(L.dpr, 0, 0, L.dpr, 0, 0);
    g.translate(L.ox, L.oy);
    g.scale(L.scale, L.scale);
    if (flip) { g.translate(C.W, C.H); g.rotate(Math.PI); }
  }

  // A neon stroke: a wide faint pass under a thin bright pass.
  function glow(g, color, width, alpha) {
    g.strokeStyle = rgba(color, alpha || 0.28); g.lineWidth = width * 4; g.stroke();
    g.strokeStyle = color; g.lineWidth = width; g.stroke();
  }

  var stars = (function () {
    var seed = 20260101, out = [];
    function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
    for (var i = 0; i < 170; i++) out.push({ x: rnd() * C.W, y: rnd() * C.H, r: 0.4 + rnd() * 1.0, a: 0.2 + rnd() * 0.6 });
    return out;
  })();

  function buildBackground() {
    bgLayer.width = canvas.width; bgLayer.height = canvas.height;
    var g = bgLayer.getContext('2d');
    g.setTransform(L.dpr, 0, 0, L.dpr, 0, 0);
    g.fillStyle = '#04050b'; g.fillRect(0, 0, L.w, L.h);
    arenaTransform(g);
    g.beginPath(); g.rect(0, 0, C.W, C.H); g.clip();
    g.fillStyle = '#07080f'; g.fillRect(0, 0, C.W, C.H);
    [[110, 190, 230, '120,130,200,0.11'], [320, 430, 260, '160,110,190,0.09'], [170, 560, 210, '90,150,210,0.08']].forEach(function (n) {
      var gr = g.createRadialGradient(n[0], n[1], 0, n[0], n[1], n[2]);
      gr.addColorStop(0, 'rgba(' + n[3] + ')'); gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr; g.fillRect(0, 0, C.W, C.H);
    });
    for (var i = 0; i < stars.length; i++) {
      var s = stars[i];
      g.fillStyle = 'rgba(255,255,255,' + s.a.toFixed(2) + ')';
      g.beginPath(); g.arc(s.x, s.y, s.r, 0, Math.PI * 2); g.fill();
    }
  }

  // Where a grid point ends up after the orbs' gravity bends it. Uses the
  // same zones of influence as the physics, so the grid shows where the pull is.
  function warp(px, py, orbs, out) {
    var dx = 0, dy = 0, nearest = 1e9;
    for (var i = 0; i < orbs.length; i++) {
      var o = orbs[i], ex = o.x - px, ey = o.y - py;
      var d = Math.sqrt(ex * ex + ey * ey);
      var surf = d - o.r;
      if (surf < nearest) nearest = surf;
      if (d < 1e-6) continue;
      var f = P.influence(o, px, py);
      var pull = GRID_K * f * f;          // squared: show the strong near field, not the faint far one
      var maxPull = surf > 0 ? surf * 0.85 : 0;
      if (pull > maxPull) pull = maxPull;
      dx += ex / d * pull; dy += ey / d * pull;
    }
    var mag = Math.sqrt(dx * dx + dy * dy);
    var cap = nearest > 0 ? nearest * 0.9 : 0;
    if (mag > cap && mag > 0) { dx *= cap / mag; dy *= cap / mag; }
    out[0] = px + dx; out[1] = py + dy;
  }

  var pt = [0, 0];
  function buildGrid() {
    gridLayer.width = canvas.width; gridLayer.height = canvas.height;
    var g = gridLayer.getContext('2d');
    arenaTransform(g);
    g.beginPath(); g.rect(0, 0, C.W, C.H); g.clip();
    var orbs = disp.orbs, x, y, S = GRID_SPACING;
    g.strokeStyle = 'rgba(190,205,235,0.20)';
    g.lineWidth = 0.7;
    g.beginPath();
    for (x = 0; x <= C.W; x += S) {
      warp(x, 0, orbs, pt); g.moveTo(pt[0], pt[1]);
      for (y = S; y <= C.H; y += S) { warp(x, y, orbs, pt); g.lineTo(pt[0], pt[1]); }
    }
    for (y = 0; y <= C.H; y += S) {
      warp(0, y, orbs, pt); g.moveTo(pt[0], pt[1]);
      for (x = S; x <= C.W; x += S) { warp(x, y, orbs, pt); g.lineTo(pt[0], pt[1]); }
    }
    g.stroke();
  }

  function orbSignature() {
    var s = flip + '|' + L.w + 'x' + L.h + '|';
    for (var i = 0; i < disp.orbs.length; i++) { var o = disp.orbs[i]; s += o.id + ':' + (o.r * 10 | 0) + ','; }
    return s;
  }

  function drawStripsAndLines(now) {
    ['p1', 'p2'].forEach(function (role) {
      var p = P.PLAYERS[role], col = colorOf(role);
      var y0 = role === 'p1' ? p.lineY : 0;
      ctx.fillStyle = rgba(col, 0.04);
      ctx.fillRect(0, y0, C.W, C.STRIP);
      var flash = fx.some(function (f) { return f.type === 'lineflash' && f.role === role && now < f.t0 + f.dur; });
      ctx.beginPath(); ctx.moveTo(0, p.lineY); ctx.lineTo(C.W, p.lineY);
      glow(ctx, flash ? '#ff4d4d' : col, flash ? 3 : 2, 0.35);
    });
  }

  function drawHubs() {
    ['p1', 'p2'].forEach(function (role) {
      var p = P.PLAYERS[role], col = colorOf(role);
      var active = canFire() && room.turn === role;
      var theta = cannon[role];
      var ux = Math.sin(theta), uy = p.dir * Math.cos(theta);
      // The hub: a glowing half circle on the end wall.
      ctx.beginPath();
      if (role === 'p1') ctx.arc(p.pivotX, p.pivotY, C.HUB_R, Math.PI, Math.PI * 2);
      else ctx.arc(p.pivotX, p.pivotY, C.HUB_R, 0, Math.PI);
      ctx.fillStyle = rgba(col, active ? 0.10 : 0.05); ctx.fill();
      glow(ctx, col, active ? 2.5 : 1.8, 0.3);
      // The barrel: a small square riding the rim.
      var bx = p.pivotX + ux * (C.HUB_R + 1), by = p.pivotY + uy * (C.HUB_R + 1);
      ctx.save();
      ctx.translate(bx, by);
      ctx.rotate(Math.atan2(uy, ux));
      ctx.beginPath(); ctx.rect(-7, -7, 14, 14);
      ctx.fillStyle = '#07080f'; ctx.fill();
      glow(ctx, active ? '#ffffff' : col, 2, 0.35);
      ctx.restore();
      // The waiting ball at the barrel tip while it's this player's turn.
      if (active) {
        ctx.beginPath(); ctx.arc(p.pivotX + ux * C.MUZZLE, p.pivotY + uy * C.MUZZLE, C.BALL_R, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff'; ctx.fill();
        glow(ctx, col, 1.5, 0.5);
      }
      // The player's name inside the hub, upright for that player.
      ctx.save();
      ctx.translate(p.pivotX, p.pivotY + p.dir * 22);
      var rot = (role === 'p2' ? Math.PI : 0) + (flip ? Math.PI : 0);
      ctx.rotate(rot);
      ctx.fillStyle = col;
      ctx.font = '800 15px -apple-system, Helvetica, Arial, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      var label = nameOf(role);
      if (label.length > 10) label = label.slice(0, 9) + '…';
      ctx.fillText(label, 0, 0);
      ctx.restore();
    });
  }

  // Three dots per player in their corner: filled = rounds won.
  function drawScore() {
    ['p1', 'p2'].forEach(function (role) {
      var col = colorOf(role), wins = room ? room.wins[role] : 0;
      for (var i = 0; i < 3; i++) {
        var x = role === 'p1' ? 24 + i * 26 : C.W - 24 - i * 26;
        var y = role === 'p1' ? C.H - 26 : 26;
        ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2);
        if (i < wins) { ctx.fillStyle = col; ctx.fill(); }
        glow(ctx, col, 1.5, 0.3);
      }
    });
  }

  function drawOrbs(now) {
    var orbs = disp.orbs;
    for (var i = 0; i < orbs.length; i++) {
      var o = orbs[i], col = COLORS[o.owner] || COLORS[0];
      ctx.beginPath(); ctx.arc(o.x, o.y, o.r, 0, Math.PI * 2);
      ctx.fillStyle = rgba(col, 0.07); ctx.fill();
      var since = now - (hitFlash[o.id] || -1e9);
      if (since < 180) { ctx.fillStyle = 'rgba(255,255,255,' + (0.5 * (1 - since / 180)).toFixed(3) + ')'; ctx.fill(); }
      glow(ctx, col, 2.2, 0.3);
      if (o.r >= 10) {
        var size = Math.max(12, Math.min(44, o.r * 0.85));
        ctx.save();
        ctx.translate(o.x, o.y);
        if (flip) ctx.rotate(Math.PI);
        ctx.fillStyle = col;
        ctx.font = '800 ' + size + 'px -apple-system, Helvetica, Arial, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(String(o.lives), 0, 1);
        ctx.restore();
      }
    }
  }

  function drawBall() {
    if (!anim || !anim.sim.ball) return;
    var b = anim.sim.ball, col = colorOf(anim.sim.role);
    for (var i = 1; i < trail.length; i++) {
      ctx.strokeStyle = rgba(col, 0.45 * i / trail.length);
      ctx.lineWidth = C.BALL_R * 1.6 * i / trail.length;
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(trail[i - 1].x, trail[i - 1].y); ctx.lineTo(trail[i].x, trail[i].y); ctx.stroke();
    }
    ctx.beginPath(); ctx.arc(b.x, b.y, C.BALL_R, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff'; ctx.fill();
    glow(ctx, col, 1.5, 0.5);
  }

  function drawFx(now) {
    for (var i = fx.length - 1; i >= 0; i--) {
      var f = fx[i], k = (now - f.t0) / f.dur;
      if (k >= 1) { fx.splice(i, 1); continue; }
      if (f.type === 'ring') {
        ctx.strokeStyle = rgba(f.color, 1 - k);
        ctx.lineWidth = f.width || 2;
        ctx.beginPath(); ctx.arc(f.x, f.y, f.r0 + (f.r1 - f.r0) * k, 0, Math.PI * 2); ctx.stroke();
      }
    }
  }

  function drawFlash(now) {
    if (!flash) return;
    if (now > flash.until) { flash = null; return; }
    var k = Math.min(1, (flash.until - now) / 300);
    ctx.setTransform(L.dpr, 0, 0, L.dpr, 0, 0);
    var cx = L.ox + C.W * L.scale / 2, cy = L.oy + C.H * L.scale * 0.42;
    ctx.fillStyle = rgba(flash.color, k);
    ctx.font = '800 ' + Math.round(22 * Math.min(1.4, L.scale * 1.2 + 0.3)) + 'px -apple-system, Helvetica, Arial, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(flash.text, cx, cy);
  }

  function drawBanner(now) {
    if (!banner) return;
    var k = Math.min(1, (now - (banner.until - BANNER_MS)) / 250);
    ctx.setTransform(L.dpr, 0, 0, L.dpr, 0, 0);
    var cx = L.ox + C.W * L.scale / 2, cy = L.oy + C.H * L.scale / 2;
    ctx.fillStyle = 'rgba(0,0,0,' + (0.6 * k).toFixed(3) + ')';
    ctx.fillRect(L.ox, cy - 44, C.W * L.scale, 88);
    ctx.fillStyle = rgba(banner.color, k);
    ctx.font = '800 ' + Math.round(26 * Math.min(1.4, L.scale * 1.2 + 0.3)) + 'px -apple-system, Helvetica, Arial, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(banner.text, cx, cy);
  }

  function draw(now) {
    var sig = orbSignature();
    if (sig !== gridSig) { buildGrid(); gridSig = sig; }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(bgLayer, 0, 0);
    ctx.drawImage(gridLayer, 0, 0);
    arenaTransform(ctx);
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, C.W, C.H); ctx.clip();
    drawStripsAndLines(now);
    drawScore();
    drawHubs();
    drawOrbs(now);
    drawBall();
    drawFx(now);
    ctx.restore();
    ctx.beginPath(); ctx.rect(0, 0, C.W, C.H);
    glow(ctx, '#9fdcff', 1.5, 0.25);
    drawFlash(now);
    drawBanner(now);
  }

  // ---------------------------------------------------------- frame loop
  function drainEvents(sim, now) {
    var ev = sim.events;
    for (var i = 0; i < ev.length; i++) {
      var e = ev[i];
      if (e.type === 'hit') {
        hitFlash[e.id] = now;
        fx.push({ type: 'ring', x: e.x, y: e.y, r0: 6, r1: 24, color: '#ffffff', t0: now, dur: 260 });
      } else if (e.type === 'pop') {
        fx.push({ type: 'ring', x: e.x, y: e.y, r0: e.r, r1: e.r * 1.9, color: COLORS[e.owner] || COLORS[0], t0: now, dur: 520, width: 4 });
        fx.push({ type: 'ring', x: e.x, y: e.y, r0: e.r * 0.4, r1: e.r * 1.3, color: '#ffffff', t0: now, dur: 380 });
      } else if (e.type === 'wall') {
        fx.push({ type: 'ring', x: e.x, y: e.y, r0: 4, r1: 16, color: '#ffffff', t0: now, dur: 220 });
      } else if (e.type === 'lost') {
        fx.push({ type: 'ring', x: e.x, y: e.y, r0: 10, r1: 90, color: '#ff4d4d', t0: now, dur: 800, width: 4 });
        fx.push({ type: 'lineflash', role: e.role, t0: now, dur: 1200 });
      }
    }
    ev.length = 0;
  }

  function frame(now) {
    if (anim) {
      var target = Math.floor((now - anim.t0) * speed / 1000 / C.DT);
      var running = true, guard = 0;
      while (anim.steps < target && running && guard++ < 2400) {
        running = P.step(anim.sim);
        anim.steps++;
      }
      drainEvents(anim.sim, now);
      if (anim.sim.ball) {
        trail.push({ x: anim.sim.ball.x, y: anim.sim.ball.y });
        if (trail.length > 18) trail.shift();
      } else {
        trail = [];
      }
      if (!running) finishAnimation(now);
    }
    if (canFire()) {
      if (sweepStart === null) sweepStart = now;
      cannon[room.turn] = P.sweepAngle((now - sweepStart) * speed / 1000);
      if (demoShots > 0 && now >= turnArmedAt && (now - sweepStart) * speed > 300 + (demoIndex * 517) % 1900) { demoShots--; demoIndex++; fire(); }
    }
    resize();
    draw(now);
    requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------- input
  canvas.addEventListener('pointerdown', function (e) { e.preventDefault(); fire(); });
  window.addEventListener('keydown', function (e) { if (e.code === 'Space') { e.preventDefault(); fire(); } });
  window.addEventListener('resize', resize);

  var nameInput = $('nameInput');
  nameInput.value = localStorage.getItem('orbital-name') || '';
  function myName() {
    var n = nameInput.value.trim() || 'Player';
    localStorage.setItem('orbital-name', n);
    return n;
  }
  $('practiceBtn').addEventListener('click', startPractice);
  $('newBtn').addEventListener('click', function () { createOnline(myName()).catch(showError); });
  $('joinBtn').addEventListener('click', function () {
    joinOnline(urlParams.get('room').toUpperCase(), myName()).catch(showError);
  });
  $('againBtn').addEventListener('click', playAgain);
  $('shareBtn').addEventListener('click', function () {
    var url = shareUrl(roomCode);
    if (navigator.share) navigator.share({ title: 'Play Orbital with me', text: 'Tap to join my Orbital game', url: url }).catch(function () {});
    else copyLink();
  });
  function copyLink() {
    var url = shareUrl(roomCode);
    if (navigator.clipboard) navigator.clipboard.writeText(url).then(function () { $('copyBtn').textContent = 'Copied!'; });
    else window.prompt('Copy this link', url);
  }
  $('copyBtn').addEventListener('click', copyLink);

  // ---------------------------------------------------------------- start
  var joining = urlParams.get('room');
  if (joining) {
    $('joinBox').hidden = false; $('newBox').hidden = true;
    $('joinCode').textContent = joining.toUpperCase();
  }
  $('netNote').textContent = Net.isOnline() ? '' : 'Local test mode: online games only work between windows on this computer until Firebase is set up.';
  if (urlParams.get('player')) nameInput.value = urlParams.get('player');
  if (urlParams.get('practice') === '1') startPractice();
  if (urlParams.get('board') === 'huge' && room) {        // testing hook: a board with a giant orb
    room.orbs = [{ id: 0, x: 200, y: 340, r: 20, lives: 3, owner: 0 }, { id: 1, x: 120, y: 250, r: 110, lives: 3, owner: 2 }, { id: 2, x: 330, y: 480, r: 14, lives: 3, owner: 1 }];
    applyState(room);
  }
  if (urlParams.get('create')) createOnline(myName(), urlParams.get('create').toUpperCase()).catch(showError);   // testing hook
  if (joining && urlParams.get('autojoin') === '1') {                                                           // testing hook
    setTimeout(function () { joinOnline(joining.toUpperCase(), myName()).catch(showError); }, 800);
  }
  if (snapAt) setTimeout(function () {
    log('SNAP anim=' + !!anim + ' hold=' + (performance.now() < holdUntil) + ' disp=' + orbList(disp.orbs) + ' | room=' + (room ? orbList(room.orbs) : '-'));
    var summary = room ? ('turn=' + room.turn + ' round=' + room.round + ' wins=' + room.wins.p1 + '-' + room.wins.p2 + ' shot=' + (room.lastShot ? room.lastShot.num : 0) + ' anim=' + !!anim + ' orbs=' + orbList(room.orbs)) : 'no room';
    canvas.toBlob(function (blob) {
      fetch('/snap?name=' + (urlParams.get('name') || 'snap') + '&vp=' + window.innerWidth + 'x' + window.innerHeight + '&st=' + encodeURIComponent(summary), { method: 'POST', body: blob });
    }, 'image/png');
  }, snapAt);

  resize();
  requestAnimationFrame(frame);
})();
