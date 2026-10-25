// firebase-config.js
//
// The address of the shared "game board" on the internet (Russell's Firebase
// project). With this filled in, the game talks to Firebase instead of the
// local test mode. The database only accepts reads and writes under "rooms",
// as set in the project's Realtime Database rules. Nothing in here is secret.

window.FIREBASE_CONFIG = {
  projectId: "orbital-online-b23f1",
  databaseURL: "https://orbital-online-b23f1-default-rtdb.firebaseio.com"
};
