// Adaptador Firebase (Auth + Firestore). O app só conversa com esta interface,
// o que permite trocar pelo backend de demonstração sem mudar a tela.
const V = '10.12.2';
const base = `https://www.gstatic.com/firebasejs/${V}`;

export async function criarBackend(firebaseConfig) {
  const { initializeApp, deleteApp } = await import(`${base}/firebase-app.js`);
  const A = await import(`${base}/firebase-auth.js`);
  const F = await import(`${base}/firebase-firestore.js`);

  const app = initializeApp(firebaseConfig);
  const auth = A.getAuth(app);
  const db = F.getFirestore(app);
  const snap2obj = (d) => ({ id: d.id, ...d.data() });

  function montarQuery(col, filtros = []) {
    const ref = F.collection(db, col);
    return filtros.length ? F.query(ref, ...filtros.map(([c, op, v]) => F.where(c, op, v))) : ref;
  }

  return {
    modo: 'firebase',
    auth: {
      onChange: (cb) => A.onAuthStateChanged(auth, (u) => cb(u ? { uid: u.uid, email: u.email } : null)),
      login: (email, senha) => A.signInWithEmailAndPassword(auth, email, senha),
      logout: () => A.signOut(auth),
      reset: (email) => A.sendPasswordResetEmail(auth, email),
      trocarSenha: async (atual, nova) => {
        const u = auth.currentUser;
        await A.reauthenticateWithCredential(u, A.EmailAuthProvider.credential(u.email, atual));
        await A.updatePassword(u, nova);
      },
      // Cria o login sem derrubar a sessão do admin (usa uma instância secundária do app)
      criarUsuario: async (email, senha) => {
        const sec = initializeApp(firebaseConfig, 'sec-' + Date.now());
        try {
          const sa = A.getAuth(sec);
          const cred = await A.createUserWithEmailAndPassword(sa, email, senha);
          await A.signOut(sa);
          return cred.user.uid;
        } finally {
          await deleteApp(sec);
        }
      },
    },
    db: {
      agora: () => F.serverTimestamp(),
      watch(col, filtros, cb, onErr) {
        return F.onSnapshot(montarQuery(col, filtros), (qs) => cb(qs.docs.map(snap2obj)),
          (e) => { console.error('watch', col, e); onErr && onErr(e); });
      },
      watchDoc(col, id, cb, onErr) {
        return F.onSnapshot(F.doc(db, col, id), (d) => cb(d.exists() ? snap2obj(d) : null),
          (e) => { console.error('watchDoc', col, id, e); onErr && onErr(e); });
      },
      async get(col, id) {
        const d = await F.getDoc(F.doc(db, col, id));
        return d.exists() ? snap2obj(d) : null;
      },
      async list(col, filtros) {
        const qs = await F.getDocs(montarQuery(col, filtros));
        return qs.docs.map(snap2obj);
      },
      set: (col, id, data, merge = false) => F.setDoc(F.doc(db, col, id), data, { merge }),
      add: async (col, data) => (await F.addDoc(F.collection(db, col), data)).id,
      novoId: (col) => F.doc(F.collection(db, col)).id,
      update: (col, id, patch) => F.updateDoc(F.doc(db, col, id), patch),
      del: (col, id) => F.deleteDoc(F.doc(db, col, id)),
      // ops: [{op:'set'|'update'|'delete', col, id, data, merge}] — dividido em lotes de 400
      async batch(ops) {
        for (let i = 0; i < ops.length; i += 400) {
          const b = F.writeBatch(db);
          for (const o of ops.slice(i, i + 400)) {
            const ref = F.doc(db, o.col, o.id);
            if (o.op === 'delete') b.delete(ref);
            else if (o.op === 'update') b.update(ref, o.data);
            else b.set(ref, o.data, { merge: !!o.merge });
          }
          await b.commit();
        }
      },
    },
  };
}
