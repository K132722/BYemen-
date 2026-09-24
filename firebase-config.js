// تهيئة Firebase Realtime Database
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