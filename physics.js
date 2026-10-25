// physics.js — the rules of the game.
//
// Everything in here is "pure": it takes numbers in and gives numbers out, with
// no randomness and no dependence on how fast the screen refreshes. That is
// what lets two phones on opposite sides of an ocean replay the same shot and
// arrive at exactly the same board.
//
// Coordinates: the arena is always W wide and H tall, player 1's cannon is at
// the bottom and player 2's cannon is at the top. The screen code flips the
// picture for player 2 so each person sees their own cannon at the bottom.

(function (root) {
  'use strict';

  var C = {
    W: 400,               // arena width in game units
    H: 680,               // arena height in game units (the real game is ~1.7x taller than wide)
    STRIP: 90,            // depth of each cannon strip (the area behind the line)
    HUB_R: 48,            // radius of the semicircular cannon hub on the end wall
    BALL_R: 9,            // radius of a ball in flight / a freshly settled orb
    CENTER_R: 20,         // radius of the starting orb in the middle
    LIVES: 3,             // lives every orb starts with
    SHOT_SPEED: 1500,     // launch speed, units per second (measured from the real game)
    DT: 1 / 120,          // simulation step, seconds (fixed, never changes)
    DRAG: 2.3,            // fraction of speed lost per second, at any speed (measured: ~2.4)
    CREEP_SPEED: 45,      // below this the ball is "crawling"...
    CREEP_TIME: 1.3,      // ...and comes to a standstill over this many seconds
    // Gravity: nearby orbs turn the ball's heading at a steady rate (radians
    // per second) that does not depend on how fast the ball is going. Measured
    // from the real game: about 1 rad/s a couple of orb-widths away from big
    // orbs, almost nothing far from small ones. Speed is never added.
    GRAV_OMEGA: 2.1,      // turn rate (rad/s) at the surface of an orb
    GRAV_OMEGA_MAX: 3.0,  // cap on the total turn rate
    ORB_BOUNCE: 0.75,     // speed kept after bouncing off an orb (1 = none lost; no measurement available)
    WALL_BOUNCE: 0.95,    // speed kept after bouncing off a wall or a line (measured: nearly all)
    MAX_FLIGHT: 4,        // seconds; a ball is forced to stop after this long (safety net)
    GROW_RATE: 220,       // units per second a settled orb grows (about a third of a second)
    MAX_R: 120,           // an orb never grows past this
    AIM_LIMIT: 75 * Math.PI / 180,   // cannon sweeps from -75 to +75 degrees
    SWEEP_PERIOD: 4.4,    // seconds for a full left-right-left sweep (measured: ~1 s from centre to an end)
    MUZZLE: 75            // distance from the hub centre to where the ball waits and launches (measured)
  };

  // Where each player's cannon and death line are.
  // dir is the direction a shot travels: -1 means "toward smaller y" (up).
  // The hub sits on the end wall itself; the ball launches from its rim.
  var PLAYERS = {
    p1: { lineY: C.H - C.STRIP, dir: -1, pivotX: C.W / 2, pivotY: C.H },
    p2: { lineY: C.STRIP,       dir:  1, pivotX: C.W / 2, pivotY: 0 }
  };
  var HUBS = [
    { x: PLAYERS.p1.pivotX, y: PLAYERS.p1.pivotY },
    { x: PLAYERS.p2.pivotX, y: PLAYERS.p2.pivotY }
  ];

  function other(role) { return role === 'p1' ? 'p2' : 'p1'; }

  // How strongly orb o is felt at a point: 1 at its surface, fading slowly
  // with distance (about a third at two radii out, a fifth at three). Bigger
  // orbs therefore reach further. Used for both the physics and the grid.
  function influence(o, px, py) {
    var dx = o.x - px, dy = o.y - py;
    var d = Math.sqrt(dx * dx + dy * dy);
    var dmin = o.r + C.BALL_R;
    if (d < dmin) d = dmin;
    var q = o.r / d;
    return q * Math.sqrt(q);
  }

  function initialOrbs() {
    return [{ id: 0, x: C.W / 2, y: C.H / 2, r: C.CENTER_R, lives: C.LIVES, owner: 0 }];
  }

  function cloneOrbs(orbs) {
    var out = [];
    for (var i = 0; i < orbs.length; i++) {
      var o = orbs[i];
      out.push({ id: o.id, x: o.x, y: o.y, r: o.r, lives: o.lives, owner: o.owner });
    }
    return out;
  }

  // The cannon angle at a given moment of its sweep. 0 = straight ahead.
  // Fastest through the middle, easing into each end, like the original.
  // (Display only: the shot itself is sent as a velocity, so this never
  // needs to match between devices.)
  function sweepAngle(t) {
    return C.AIM_LIMIT * Math.sin(2 * Math.PI * t / C.SWEEP_PERIOD);
  }

  // Turn a cannon angle into a launch velocity for the given player.
  function aimVector(role, theta) {
    var p = PLAYERS[role];
    return { vx: Math.sin(theta) * C.SHOT_SPEED, vy: p.dir * Math.cos(theta) * C.SHOT_SPEED };
  }

  // Angle (for drawing the cannon) that produced a velocity.
  function angleOf(role, vx, vy) {
    var p = PLAYERS[role];
    return Math.atan2(vx, p.dir * vy);
  }

  // Build a fresh shot simulation. orbs = the board before the shot.
  function createShot(orbs, role, shotNum, vx, vy) {
    var p = PLAYERS[role];
    var ux = vx / C.SHOT_SPEED, uy = vy / C.SHOT_SPEED;
    return {
      role: role,
      shotNum: shotNum,
      orbs: cloneOrbs(orbs),
      ball: { x: p.pivotX + ux * C.MUZZLE, y: p.pivotY + uy * C.MUZZLE, vx: vx, vy: vy, armed: false },
      creepTime: 0,        // how long the ball has been crawling (final slowdown)
      grow: null,          // the orb currently growing, once the ball has stopped
      growMax: 0,
      phase: 'flying',     // 'flying' -> 'growing' -> 'done'
      t: 0,
      outcome: null,       // 'settled' or 'lost'
      loser: null,
      events: []           // things the screen may want to animate
    };
  }

  // Is the ball fully on the arena side of this player's line?
  function pastLine(p, y) {
    return p.dir < 0 ? (y + C.BALL_R < p.lineY) : (y - C.BALL_R > p.lineY);
  }

  // Advance the simulation by one fixed step. Returns true while still running.
  function step(sim) {
    if (sim.phase === 'flying') return stepFlying(sim);
    if (sim.phase === 'growing') return stepGrowing(sim);
    return false;
  }

  function stepFlying(sim) {
    var b = sim.ball, orbs = sim.orbs, R = C.BALL_R, DT = C.DT;
    var i, o, dx, dy, d2, d;

    // Gravity: nearby orbs turn the ball's heading toward them. Only the
    // direction changes; the speed is untouched.
    var kx = 0, ky = 0;
    for (i = 0; i < orbs.length; i++) {
      o = orbs[i];
      dx = o.x - b.x; dy = o.y - b.y;
      d = Math.sqrt(dx * dx + dy * dy);
      if (d < 1e-9) continue;
      var f = C.GRAV_OMEGA * influence(o, b.x, b.y);
      kx += f * dx / d; ky += f * dy / d;
    }
    var sp0 = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
    if (sp0 > 1e-9 && (kx !== 0 || ky !== 0)) {
      var ux = b.vx / sp0, uy = b.vy / sp0;
      var along = kx * ux + ky * uy;
      var px = kx - along * ux, py = ky - along * uy;   // sideways part only
      var pm = Math.sqrt(px * px + py * py);
      if (pm > 1e-12) {
        if (pm > C.GRAV_OMEGA_MAX) { px *= C.GRAV_OMEGA_MAX / pm; py *= C.GRAV_OMEGA_MAX / pm; pm = C.GRAV_OMEGA_MAX; }
        var theta = pm * DT;                             // radians to turn this step
        var nx = ux + px / pm * theta, ny = uy + py / pm * theta;
        var nm = Math.sqrt(nx * nx + ny * ny);
        b.vx = nx / nm * sp0; b.vy = ny / nm * sp0;
      }
    }

    // Drag: the same fraction of speed is lost every second, fast or slow.
    var k = 1 - C.DRAG * DT;
    b.vx *= k; b.vy *= k;

    // The crawl: once slow, the ball eases to a standstill over CREEP_TIME.
    var sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
    if (sp < C.CREEP_SPEED) {
      sim.creepTime += DT;
      var ceiling = C.CREEP_SPEED * (1 - sim.creepTime / C.CREEP_TIME);
      if (ceiling <= 0) { b.vx = 0; b.vy = 0; }
      else if (sp > ceiling && sp > 0) { b.vx *= ceiling / sp; b.vy *= ceiling / sp; }
    }

    b.x += b.vx * DT; b.y += b.vy * DT;

    // Walls.
    if (b.x < R) { b.x = R; if (b.vx < 0) { b.vx = -b.vx * C.WALL_BOUNCE; sim.events.push({ type: 'wall', x: b.x, y: b.y }); } }
    if (b.x > C.W - R) { b.x = C.W - R; if (b.vx > 0) { b.vx = -b.vx * C.WALL_BOUNCE; sim.events.push({ type: 'wall', x: b.x, y: b.y }); } }
    if (b.y < R) { b.y = R; if (b.vy < 0) { b.vy = -b.vy * C.WALL_BOUNCE; sim.events.push({ type: 'wall', x: b.x, y: b.y }); } }
    if (b.y > C.H - R) { b.y = C.H - R; if (b.vy > 0) { b.vy = -b.vy * C.WALL_BOUNCE; sim.events.push({ type: 'wall', x: b.x, y: b.y }); } }

    // The other player's line is a wall to you: the ball bounces off it.
    var opp = PLAYERS[other(sim.role)];
    if (opp.dir > 0) {            // opponent at the top: their line is at y = STRIP
      if (b.y - R < opp.lineY) { b.y = opp.lineY + R; if (b.vy < 0) { b.vy = -b.vy * C.WALL_BOUNCE; sim.events.push({ type: 'wall', x: b.x, y: b.y }); } }
    } else {                      // opponent at the bottom
      if (b.y + R > opp.lineY) { b.y = opp.lineY - R; if (b.vy > 0) { b.vy = -b.vy * C.WALL_BOUNCE; sim.events.push({ type: 'wall', x: b.x, y: b.y }); } }
    }

    // The two cannon hubs are solid: the ball bounces off them like a wall.
    for (i = 0; i < HUBS.length; i++) {
      var h = HUBS[i];
      dx = b.x - h.x; dy = b.y - h.y;
      d2 = dx * dx + dy * dy;
      var hmin = C.HUB_R + R;
      if (d2 >= hmin * hmin) continue;
      d = Math.sqrt(d2);
      var hx = d > 1e-9 ? dx / d : 0, hy = d > 1e-9 ? dy / d : -1;
      b.x += hx * (hmin - d); b.y += hy * (hmin - d);
      var hvn = b.vx * hx + b.vy * hy;
      if (hvn < 0) {
        b.vx -= (1 + C.WALL_BOUNCE) * hvn * hx;
        b.vy -= (1 + C.WALL_BOUNCE) * hvn * hy;
        sim.events.push({ type: 'wall', x: b.x, y: b.y });
      }
    }

    // Orbs: bounce off, and the orb loses a life.
    for (i = 0; i < orbs.length; i++) {
      o = orbs[i];
      dx = b.x - o.x; dy = b.y - o.y;
      d2 = dx * dx + dy * dy;
      var minD = o.r + R;
      if (d2 >= minD * minD) continue;
      d = Math.sqrt(d2);
      var nx, ny;
      if (d > 1e-9) { nx = dx / d; ny = dy / d; } else { nx = 0; ny = -1; d = 0; }
      var pen = minD - d;
      b.x += nx * pen; b.y += ny * pen;
      var vn = b.vx * nx + b.vy * ny;
      if (vn < 0) {
        b.vx -= (1 + C.ORB_BOUNCE) * vn * nx;
        b.vy -= (1 + C.ORB_BOUNCE) * vn * ny;
        // Every touch costs a life, however gentle.
        o.lives -= 1;
        sim.events.push({ type: 'hit', id: o.id, x: b.x, y: b.y, lives: o.lives });
        if (o.lives <= 0) {
          sim.events.push({ type: 'pop', id: o.id, x: o.x, y: o.y, r: o.r, owner: o.owner });
          orbs.splice(i, 1);
          i--;
        }
      }
    }

    // The death line. The ball must first fully leave the cannon strip
    // ("armed"); after that, touching your own line loses the round.
    var p = PLAYERS[sim.role];
    if (pastLine(p, b.y)) {
      b.armed = true;
    } else if (b.armed) {
      sim.events.push({ type: 'lost', x: b.x, y: b.y, role: sim.role });
      sim.outcome = 'lost';
      sim.loser = sim.role;
      sim.phase = 'done';
      return false;
    }

    sim.t += DT;
    var speed = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
    if (speed <= 0 || sim.t >= C.MAX_FLIGHT) {
      beginGrowing(sim);
    }
    return true;
  }

  // The ball has stopped: it becomes an orb and starts growing.
  function beginGrowing(sim) {
    var b = sim.ball;
    var g = { id: sim.shotNum, x: b.x, y: b.y, r: C.BALL_R, lives: C.LIVES, owner: sim.role === 'p1' ? 1 : 2 };
    sim.orbs.push(g);
    sim.grow = g;
    sim.ball = null;
    sim.phase = 'growing';
    sim.events.push({ type: 'settle', x: g.x, y: g.y });

    // Work out how big it can get before touching something.
    var max = C.MAX_R, i, o;
    for (i = 0; i < sim.orbs.length; i++) {
      o = sim.orbs[i];
      if (o === g) continue;
      var dx = o.x - g.x, dy = o.y - g.y;
      var room = Math.sqrt(dx * dx + dy * dy) - o.r;
      if (room < max) max = room;
    }
    for (i = 0; i < HUBS.length; i++) {
      var hdx = HUBS[i].x - g.x, hdy = HUBS[i].y - g.y;
      var hroom = Math.sqrt(hdx * hdx + hdy * hdy) - C.HUB_R;
      if (hroom < max) max = hroom;
    }
    if (g.x < max) max = g.x;
    if (C.W - g.x < max) max = C.W - g.x;
    if (g.y < max) max = g.y;
    if (C.H - g.y < max) max = C.H - g.y;
    var dTop = Math.abs(g.y - PLAYERS.p2.lineY);
    var dBot = Math.abs(g.y - PLAYERS.p1.lineY);
    if (dTop < max) max = dTop;
    if (dBot < max) max = dBot;
    if (max < C.BALL_R) max = C.BALL_R;   // never shrink
    sim.growMax = max;

    // Growing into a line, yours or theirs, simply stops the growth. Only the
    // ball in flight touching your own line loses the round.
  }

  function stepGrowing(sim) {
    var g = sim.grow;
    g.r += C.GROW_RATE * C.DT;
    if (g.r < sim.growMax) return true;
    g.r = sim.growMax;
    sim.phase = 'done';
    sim.outcome = 'settled';
    return false;
  }

  function runToEnd(sim) {
    var guard = 0;
    while (step(sim)) { if (++guard > 1000000) throw new Error('simulation did not finish'); }
    return sim;
  }

  // Match bookkeeping shared by both players: given the finished shot,
  // what does the board look like and whose turn is it?
  function resolveShot(state, sim) {
    var wins = { p1: state.wins.p1, p2: state.wins.p2 };
    var out = { wins: wins, round: state.round, phase: 'playing', winner: null };
    if (sim.outcome === 'lost') {
      var w = other(sim.loser);
      wins[w] += 1;
      out.roundWinner = w;
      if (wins[w] >= 3) {
        out.phase = 'over';
        out.winner = w;
        out.orbs = cloneOrbs(sim.orbs);
        out.turn = null;
      } else {
        out.round = state.round + 1;
        out.orbs = initialOrbs();
        out.turn = (out.round % 2 === 1) ? 'p1' : 'p2';   // rounds alternate who starts
      }
    } else {
      out.orbs = cloneOrbs(sim.orbs);
      out.turn = other(sim.role);
    }
    return out;
  }

  root.Orbital = {
    C: C,
    PLAYERS: PLAYERS,
    HUBS: HUBS,
    other: other,
    initialOrbs: initialOrbs,
    cloneOrbs: cloneOrbs,
    sweepAngle: sweepAngle,
    aimVector: aimVector,
    angleOf: angleOf,
    createShot: createShot,
    step: step,
    runToEnd: runToEnd,
    influence: influence,
    resolveShot: resolveShot
  };
})(typeof window !== 'undefined' ? window : this);
