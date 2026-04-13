const admin = require("firebase-admin");

const serviceAccount = require("./anime-tracker-93e52-firebase-adminsdk-fbsvc-4cc405f350.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

module.exports = db;
console.log("Firebase Connected");