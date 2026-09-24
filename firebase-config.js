// ============================================================
// تهيئة Firebase Realtime Database
// ============================================================
const firebaseConfig = {
  apiKey: "AIzaSyCjvtubadXahAxbvzaT0OsrCxwf5q4BiXo",
  authDomain: "by11-4be25.firebaseapp.com",
  databaseURL: "https://by11-4be25-default-rtdb.firebaseio.com",
  projectId: "by11-4be25",
  storageBucket: "by11-4be25.firebasestorage.app",
  messagingSenderId: "1001512000635",
  appId: "1:1001512000635:web:e552ec22879c4fe96156de",
  measurementId: "G-TRGYVXP1D1"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.database();

// ============================================================
// بيانات المستخدمين (السواقين + المشرف)
// ============================================================
const USERS = {
  admin: {
    id: 'admin',
    name: 'ابو جراح الخولاني',
    password: '132722',
    role: 'admin'
  },
  driver1: {
    id: 'driver1',
    name: 'هشام علي حسن الخولاني',
    phone: '770706321',
    trailer: 'قاطرة العاقل',
    password: '1672677',
    role: 'driver',
    duePerTrip: 50000
  },
  driver2: {
    id: 'driver2',
    name: 'علي صالح احمد الطلقي',
    phone: '773205722',
    trailer: 'قاطرة فامكو',
    password: '1839289',
    role: 'driver',
    duePerTrip: 50000
  },
  driver3: {
    id: 'driver3',
    name: 'محمد سعد علي عباد',
    phone: '771669016',
    trailer: 'قاطرة الزاهد',
    password: '1715291',
    role: 'driver',
    duePerTrip: 50000
  }
};

// ============================================================
// دوال المزامنة مع Firebase
// ============================================================

// رفع حملة كاملة إلى Firebase
async function fbPushTrip(trip) {
  try {
    await db.ref(`trips/${trip.driverId}/${trip.id}`).set(trip);
    await db.ref(`sync_meta/${trip.driverId}`).set({
      lastSync: Date.now(),
      lastTripNumber: trip.tripNumber
    });
    console.log('✅ fbPushTrip success:', trip.id);
    return true;
  } catch (e) {
    console.error('❌ fbPushTrip error:', e);
    return false;
  }
}

// حذف حملة من Firebase
async function fbDeleteTrip(driverId, tripId) {
  try {
    await db.ref(`trips/${driverId}/${tripId}`).remove();
    return true;
  } catch (e) {
    console.error('fbDeleteTrip error:', e);
    return false;
  }
}

// رفع تحديثات الرصيد (تسوية/خصم)
async function fbPushUpdate(update) {
  try {
    await db.ref(`updates/${update.driverId}/${update.id}`).set(update);
    console.log('✅ fbPushUpdate success:', update.id);
    return true;
  } catch (e) {
    console.error('❌ fbPushUpdate error:', e);
    return false;
  }
}

// رفع تعديلات المشرف على السائق
async function fbPushDriverOverride(driverId, patch) {
  try {
    await db.ref(`drivers_overrides/${driverId}`).update(patch);
    console.log('✅ fbPushDriverOverride success:', driverId);
    return true;
  } catch (e) {
    console.error('❌ fbPushDriverOverride error:', e);
    return false;
  }
}

// الاستماع لكل حملات سائق معين (للمشرف)
function fbListenDriverTrips(driverId, callback) {
  const ref = db.ref(`trips/${driverId}`);
  ref.on('value', (snapshot) => {
    const data = snapshot.val() || {};
    const trips = Object.values(data);
    callback(trips);
  });
  return () => ref.off('value');
}

// الاستماع لتحديثات سائق (للسائق نفسه)
function fbListenDriverUpdates(driverId, callback) {
  const ref = db.ref(`updates/${driverId}`);
  ref.on('value', (snapshot) => {
    const data = snapshot.val() || {};
    const updates = Object.values(data);
    callback(updates);
  });
  return () => ref.off('value');
}

// الاستماع لتعديلات المشرف على السائق
function fbListenDriverOverride(driverId, callback) {
  const ref = db.ref(`drivers_overrides/${driverId}`);
  ref.on('value', (snapshot) => {
    const data = snapshot.val() || {};
    callback(data);
  });
  return () => ref.off('value');
}

// الاستماع لكل السواقين (للمشرف)
function fbListenAllDrivers(callback) {
  const ref = db.ref('trips');
  ref.on('value', (snapshot) => {
    const data = snapshot.val() || {};
    callback(data);
  });
  return () => ref.off('value');
}

// الاستماع لكل التحديثات (للمشرف)
function fbListenAllUpdates(callback) {
  const ref = db.ref('updates');
  ref.on('value', (snapshot) => {
    const data = snapshot.val() || {};
    const allUpdates = [];
    for (const driverId in data) {
      for (const updId in data[driverId]) {
        allUpdates.push(data[driverId][updId]);
      }
    }
    callback(allUpdates);
  });
  return () => ref.off('value');
}

// الاستماع لكل تعديلات السواقين (للمشرف)
function fbListenAllOverrides(callback) {
  const ref = db.ref('drivers_overrides');
  ref.on('value', (snapshot) => {
    const data = snapshot.val() || {};
    callback(data);
  });
  return () => ref.off('value');
}
