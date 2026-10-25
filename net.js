// net.js — how two phones share one game.
//
// The whole game lives in one small record (the "room"): the orbs on the
// board, whose turn it is, the score, and the most recent shot. Whoever just
// fired writes the new record; the other phone is told and catches up.
//
// Two ways of sharing are provided with the same interface:
//   LocalTransport    - between windows of the same browser on one computer.
//                       Used for testing on the Mac. Needs no account.
//   FirebaseTransport - the real thing, through Google's Firebase service.
//                       Used automatically once firebase-config.js is filled in.

(function (root) {
  'use strict';

  var KEY = 'orbital-room-';

  // Apply an "update" object whose keys may be paths like 'players/p2'.
  function applyUpdate(state, updates) {
    state = state || {};
    Object.keys(updates).forEach(function (path) {
      var parts = path.split('/');
      var node = state;
      for (var i = 0; i < parts.length - 1; i++) {
        if (typeof node[parts[i]] !== 'object' || node[parts[i]] === null) node[parts[i]] = {};
        node = node[parts[i]];
      }
      node[parts[parts.length - 1]] = updates[path];
    });
    return state;
  }

  // Strip anything Firebase would reject (undefined values) and make a copy.
  function clean(obj) { return JSON.parse(JSON.stringify(obj)); }

  // ---------------------------------------------------------------- local
  function LocalTransport(code) {
    this.code = code;
    this.key = KEY + code;
    this.listeners = [];
  }
  LocalTransport.prototype.kind = 'local';
  LocalTransport.prototype.connect = function () {
    var self = this;
    window.addEventListener('storage', function (e) { if (e.key === self.key) self._emit(); });
    return Promise.resolve();
  };
  LocalTransport.prototype.load = function () { return Promise.resolve(this._read()); };
  LocalTransport.prototype.set = function (state) {
    localStorage.setItem(this.key, JSON.stringify(clean(state)));
    this._emit();
    return Promise.resolve();
  };
  LocalTransport.prototype.update = function (updates) {
    return this.set(applyUpdate(this._read(), clean(updates)));
  };
  LocalTransport.prototype.subscribe = function (cb) { this.listeners.push(cb); };
  LocalTransport.prototype._read = function () {
    var raw = localStorage.getItem(this.key);
    return raw ? JSON.parse(raw) : null;
  };
  LocalTransport.prototype._emit = function () {
    var s = this._read();
    this.listeners.forEach(function (cb) { cb(s); });
  };

  // ------------------------------------------------------------- firebase
  var FB_VERSION = '10.14.1';
  var fbLoading = null;

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('Could not load ' + src)); };
      document.head.appendChild(s);
    });
  }

  function loadFirebase(config) {
    if (!fbLoading) {
      var base = 'https://www.gstatic.com/firebasejs/' + FB_VERSION + '/';
      fbLoading = loadScript(base + 'firebase-app-compat.js')
        .then(function () { return loadScript(base + 'firebase-database-compat.js'); })
        .then(function () { root.firebase.initializeApp(config); });
    }
    return fbLoading;
  }

  function FirebaseTransport(code, config) {
    this.code = code;
    this.config = config;
    this.ref = null;
  }
  FirebaseTransport.prototype.kind = 'firebase';
  FirebaseTransport.prototype.connect = function () {
    var self = this;
    return loadFirebase(this.config).then(function () {
      self.ref = root.firebase.database().ref('rooms/' + self.code);
    });
  };
  FirebaseTransport.prototype.load = function () {
    return this.ref.once('value').then(function (snap) { return snap.val(); });
  };
  FirebaseTransport.prototype.set = function (state) { return this.ref.set(clean(state)); };
  FirebaseTransport.prototype.update = function (updates) { return this.ref.update(clean(updates)); };
  FirebaseTransport.prototype.subscribe = function (cb) {
    this.ref.on('value', function (snap) { cb(snap.val()); });
  };

  root.OrbitalNet = {
    create: function (code) {
      var cfg = root.FIREBASE_CONFIG;
      return cfg ? new FirebaseTransport(code, cfg) : new LocalTransport(code);
    },
    isOnline: function () { return !!root.FIREBASE_CONFIG; }
  };
})(window);
