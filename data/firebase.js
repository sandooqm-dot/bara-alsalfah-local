// data/firebase.js
// Firebase (Firestore) setup for "bara-alsalfah-eu" project

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-app.js";
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  getDocFromServer,
  updateDoc,
  onSnapshot,
  serverTimestamp,
  increment,
  runTransaction
} from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";

// ✅ إعدادات مشروعك الجديد (bara-alsalfah-eu)
const firebaseConfig = {
  apiKey: "AIzaSyDYxoP7QEy3ShH_KOTx19jqj3IbWGTEOd0",
  authDomain: "bara-alsalfah-eu.firebaseapp.com",
  projectId: "bara-alsalfah-eu",
  storageBucket: "bara-alsalfah-eu.firebasestorage.app",
  messagingSenderId: "657928540352",
  appId: "1:657928540352:web:dcf15096ac8501326e9d25",
  measurementId: "G-HKJGX94BJD"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);

// -------- Helpers --------
export function roomRef(roomId) {
  return doc(db, "rooms", String(roomId));
}

// ✅ إنشاء الغرفة إذا ما كانت موجودة (بدون ما نخرب أي بيانات قديمة)
export async function ensureRoom(roomId) {
  const ref = roomRef(roomId);
  const snap = await getDoc(ref);

  if (!snap.exists()) {
    await setDoc(ref, {
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      status: "lobby",          // lobby | playing
      players: [],              // [{name, joinedAt}]
      hostStartedAt: null,
      version: 1,
      tick: 0
    });
  }
  return ref;
}

// ✅ إضافة لاعب بدون تكرار نفس الاسم (Transaction)
export async function addPlayer(roomId, playerName) {
  const clean = String(playerName || "").trim();
  if (!clean) return;

  const ref = roomRef(roomId);

  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);

    // لو الغرفة غير موجودة: ننشئها + نضيف اللاعب
    if (!snap.exists()) {
      tx.set(ref, {
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        status: "lobby",
        players: [{ name: clean, joinedAt: Date.now() }],
        hostStartedAt: null,
        version: 1,
        tick: 1
      });
      return;
    }

    const data = snap.data() || {};
    const players = Array.isArray(data.players) ? data.players : [];

    // تحقق من وجود الاسم مسبقاً
    const exists = players.some(p => String(p?.name || "").trim() === clean);
    if (exists) {
      // بس نحدّث updatedAt/tick عشان يصير فيه تحديث خفيف
      tx.update(ref, {
        updatedAt: serverTimestamp(),
        tick: increment(1)
      });
      return;
    }

    // إضافة لاعب جديد
    tx.update(ref, {
      updatedAt: serverTimestamp(),
      players: [...players, { name: clean, joinedAt: Date.now() }],
      tick: increment(1)
    });
  });
}

export async function setRoomStatus(roomId, status) {
  const ref = await ensureRoom(roomId);
  await updateDoc(ref, {
    updatedAt: serverTimestamp(),
    status: status,
    tick: increment(1),
    hostStartedAt: status === "playing" ? Date.now() : null
  });
}

// ✅ تحديث حقول الغرفة لأي صفحة مثل categories.html
export async function updateRoomFields(roomId, fields = {}) {
  const ref = await ensureRoom(roomId);

  // ننظف أي قيم undefined
  const cleanFields = {};
  for (const k of Object.keys(fields || {})) {
    if (typeof fields[k] !== "undefined") cleanFields[k] = fields[k];
  }

  await updateDoc(ref, {
    updatedAt: serverTimestamp(),
    tick: increment(1),
    ...cleanFields
  });
}

// ✅ استماع للتحديثات (Snapshot) + ✅ Polling من السيرفر فقط (عشان ما يرجّع بيانات قديمة من الكاش)
export function listenRoom(roomId, cb) {
  const ref = roomRef(roomId);

  let lastJson = null;
  let lastTick = -1; // حماية ضد الرجوع لبيانات أقدم

  const shouldAccept = (data) => {
    if (!data) return true;

    const t = Number(data?.tick);
    if (Number.isFinite(t)) {
      // لا نسمح لبيانات أقدم ترجع الواجهة للخلف
      if (t < lastTick) return false;
    }
    return true;
  };

  const emitIfChanged = (data) => {
    if (!shouldAccept(data)) return;

    const t = Number(data?.tick);
    if (Number.isFinite(t)) lastTick = Math.max(lastTick, t);

    const j = data ? JSON.stringify(data) : null;
    if (j === lastJson) return;

    lastJson = j;
    cb(data);
  };

  // Snapshot (بدون metadata changes عشان ما يصير “ذبذبة”)
  const unsub = onSnapshot(
    ref,
    (snap) => {
      emitIfChanged(snap.exists() ? snap.data() : null);
    },
    (err) => {
      console.error("listenRoom error:", err);
      cb(null);
    }
  );

  // Polling احتياطي (من السيرفر فقط) — يمنع مشكلة “تطلع لحظة ثم تختفي”
  let stopped = false;

  const pollOnce = async () => {
    if (stopped) return;
    try {
      // ✅ مهم جدًا: من السيرفر وليس من الكاش
      const snap = await getDocFromServer(ref);
      emitIfChanged(snap.exists() ? snap.data() : null);
    } catch (e) {
      // إذا فشل السيرفر (ضعف نت/أوفلاين) نرجع لـ getDoc كحل أخير بدون ما نكسر اللعبة
      try {
        const snap2 = await getDoc(ref);
        emitIfChanged(snap2.exists() ? snap2.data() : null);
      } catch (e2) {
        console.error("listenRoom poll error:", e2);
      }
    }
  };

  // تنفيذ مرة مباشرة + كل 1.5 ثانية
  pollOnce();
  const pollId = setInterval(pollOnce, 1500);

  // نرجع unsubscribe حقيقي يوقف الاثنين
  return () => {
    stopped = true;
    clearInterval(pollId);
    try { unsub(); } catch (e) {}
  };
}

/* data/firebase.js برا السالفة – إصدار 2 (Fix: no stale-cache polling + tick guard) */
