// Backend de DEMONSTRAÇÃO: tudo em memória, com dados fictícios.
// Usado automaticamente quando o firebase-config.js ainda não foi preenchido.
// Nada é salvo: ao recarregar a página, os dados voltam ao estado inicial.

export async function criarBackend() {
  const store = { users: {}, clientes: {}, sessoes: {}, fechamentos: {}, config: {} };
  const ouvintes = new Set();
  let authCb = null, atual = null;
  const contas = {}; // email -> {uid, senha}
  let seq = 1;
  const novoId = () => 'd' + (seq++).toString(36) + Math.random().toString(36).slice(2, 7);

  const clone = (o) => JSON.parse(JSON.stringify(o, (k, v) => v), (k, v) =>
    typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) ? new Date(v) : v);
  const bate = (doc, filtros) => (filtros || []).every(([c, op, v]) =>
    op === '==' ? doc[c] === v : op === 'in' ? v.includes(doc[c]) : true);
  const notificar = () => queueMicrotask(() => ouvintes.forEach((o) => o()));

  function seed() {
    const hoje = new Date();
    const mes = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}`;
    const ant = new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1);
    const mesAnt = `${ant.getFullYear()}-${String(ant.getMonth() + 1).padStart(2, '0')}`;
    const conta = (email, uid, perfil) => { contas[email] = { uid, senha: 'demo123' }; store.users[uid] = { email, ativo: true, ...perfil }; };
    conta('admin@demo.com', 'u_admin', { nome: 'Administrador (demo)', papel: 'admin' });
    conta('bia@demo.com', 'u_bia', { nome: 'Bia (demo)', papel: 'revisora' });
    conta('alexandre@demo.com', 'u_alex', { nome: 'Alexandre (demo)', papel: 'financeiro' });
    conta('ana@demo.com', 'u_ana', { nome: 'Coach Ana (demo)', papel: 'coach',
      config: { valorA: 80, valorB: 90, limiteA: 10, bonusRecorrencia: 10, minSessoesBonus: 2, bonusAtivo: 10, extras: [] } });
    conta('bruno@demo.com', 'u_bruno', { nome: 'Coach Bruno (demo)', papel: 'coach',
      config: { valorA: 90, valorB: 164.67, limiteA: 0, bonusRecorrencia: 10, minSessoesBonus: 2, bonusAtivo: 10,
        extras: [{ id: 'mapeamento', nome: 'Mapeamento de perfil', valor: 210 }, { id: 'perfil-comportamental', nome: 'Perfil comportamental', valor: 0, livre: true }] } });
    store.config.sistema = { criadoEm: new Date() };

    const nomesAna = ['Cliente Alfa', 'Cliente Beta', 'Cliente Gama', 'Cliente Delta', 'Cliente Épsilon', 'Cliente Zeta',
      'Cliente Eta', 'Cliente Teta', 'Cliente Iota', 'Cliente Kapa', 'Cliente Lambda', 'Cliente Mi'];
    const nomesBruno = ['Pessoa Um', 'Pessoa Dois', 'Pessoa Três', 'Pessoa Quatro', 'Pessoa Cinco'];
    const cli = {};
    nomesAna.forEach((n, i) => { const id = 'c_ana_' + i; cli[n] = id;
      store.clientes[id] = { coachId: 'u_ana', nome: n, tipo: i < 10 ? 'A' : 'B', tipoConfirmado: true, ordem: i + 1, ativo: true }; });
    nomesBruno.forEach((n, i) => { const id = 'c_bruno_' + i; cli[n] = id;
      store.clientes[id] = { coachId: 'u_bruno', nome: n, tipo: i === 1 ? 'B' : 'A', tipoConfirmado: true, ordem: i + 1, ativo: true }; });
    store.clientes['c_bruno_novo'] = { coachId: 'u_bruno', nome: 'Pessoa Seis', tipo: 'A', tipoConfirmado: false, ordem: 6, ativo: true };
    cli['Pessoa Seis'] = 'c_bruno_novo';

    const ses = (coachId, nome, m, dia, status, extra = {}) => {
      const id = novoId();
      store.sessoes[id] = { coachId, clienteId: cli[nome], clienteNome: nome, data: `${m}-${String(dia).padStart(2, '0')}`, mes: m,
        quantidade: 1, servico: 'sessao', obs: '', status, criadoEm: new Date(), ...extra };
    };
    // mês anterior (fechado)
    ['Cliente Alfa', 'Cliente Beta', 'Cliente Gama', 'Cliente Kapa'].forEach((n, i) => { ses('u_ana', n, mesAnt, 3 + i, 'aprovada'); ses('u_ana', n, mesAnt, 17 + i, 'aprovada'); });
    ses('u_ana', 'Cliente Lambda', mesAnt, 10, 'aprovada');
    store.fechamentos[`u_ana_${mesAnt}`] = { coachId: 'u_ana', mes: mesAnt, status: 'fechado', origem: 'sistema',
      linhas: [{ descricao: 'Sessão — cliente Tipo A', valorUnit: 80, quantidade: 6, total: 480 },
        { descricao: 'Sessão — cliente Tipo B', valorUnit: 90, quantidade: 3, total: 270 },
        { descricao: 'Bônus cliente com 2+ sessões no mês', valorUnit: 10, quantidade: 4, total: 40 },
        { descricao: 'Bônus por cliente ativo', valorUnit: 10, quantidade: 5, total: 50 }],
      ajustes: [], subtotal: 840, total: 840, fechadoEm: new Date(), fechadoPorNome: 'Bia (demo)',
      config: { valorA: 80, valorB: 90, limiteA: 10, bonusRecorrencia: 10, minSessoesBonus: 2, bonusAtivo: 10, extras: [] } };
    store.fechamentos[`u_ana_${mesAnt}`].linhas.forEach((l, i) => (l.chave = ['A', 'B', 'bonusRec', 'bonusAtivo'][i]));
    // mês atual
    const d = (n) => Math.min(n, 28);
    ses('u_ana', 'Cliente Alfa', mes, d(2), 'aprovada'); ses('u_ana', 'Cliente Alfa', mes, d(16), 'pendente');
    ses('u_ana', 'Cliente Beta', mes, d(3), 'aprovada'); ses('u_ana', 'Cliente Beta', mes, d(17), 'pendente');
    ses('u_ana', 'Cliente Gama', mes, d(4), 'pendente');
    ses('u_ana', 'Cliente Kapa', mes, d(8), 'recusada', { comentario: 'Não encontrei esta sessão na agenda. Confere a data?' });
    ses('u_ana', 'Cliente Lambda', mes, d(9), 'pendente'); ses('u_ana', 'Cliente Lambda', mes, d(9), 'pendente');
    ses('u_ana', 'Cliente Mi', mes, d(10), 'pendente');
    ses('u_bruno', 'Pessoa Um', mes, d(1), 'pendente'); ses('u_bruno', 'Pessoa Dois', mes, d(5), 'pendente');
    ses('u_bruno', 'Pessoa Dois', mes, d(19), 'pendente');
    ses('u_bruno', 'Pessoa Seis', mes, d(12), 'pendente');
    ses('u_bruno', 'Pessoa Três', mes, d(12), 'pendente', { servico: 'mapeamento', obs: 'Mapeamento de perfil completo' });
    ses('u_bruno', 'Pessoa Quatro', mes, d(15), 'pendente', { servico: 'perfil-comportamental', valorInformado: 350 });
  }
  seed();

  const assegura = (col) => (store[col] ||= {});

  return {
    modo: 'demo',
    contasDemo: [
      ['admin@demo.com', 'Administrador'], ['bia@demo.com', 'Bia (revisora)'], ['alexandre@demo.com', 'Alexandre (financeiro)'],
      ['ana@demo.com', 'Coach Ana'], ['bruno@demo.com', 'Coach Bruno'],
    ],
    auth: {
      onChange(cb) { authCb = cb; queueMicrotask(() => cb(atual)); return () => (authCb = null); },
      async login(email, senha) {
        const c = contas[String(email).trim().toLowerCase()];
        if (!c || c.senha !== senha) { const e = new Error('Credenciais inválidas'); e.code = 'auth/invalid-credential'; throw e; }
        atual = { uid: c.uid, email }; authCb && authCb(atual);
      },
      async logout() { atual = null; authCb && authCb(null); },
      async reset() {},
      async trocarSenha(a, n) { const c = Object.values(contas).find((x) => x.uid === atual.uid); if (c.senha !== a) throw Object.assign(new Error('Senha atual incorreta'), { code: 'auth/wrong-password' }); c.senha = n; },
      async criarUsuario(email, senha) {
        email = email.trim().toLowerCase();
        if (contas[email]) throw Object.assign(new Error('E-mail já cadastrado'), { code: 'auth/email-already-in-use' });
        const uid = 'u_' + novoId(); contas[email] = { uid, senha }; return uid;
      },
    },
    db: {
      agora: () => new Date(),
      watch(col, filtros, cb) {
        const run = () => cb(Object.entries(assegura(col)).filter(([, v]) => bate(v, filtros)).map(([id, v]) => ({ id, ...clone(v) })));
        ouvintes.add(run); queueMicrotask(run);
        return () => ouvintes.delete(run);
      },
      watchDoc(col, id, cb) {
        const run = () => cb(assegura(col)[id] ? { id, ...clone(assegura(col)[id]) } : null);
        ouvintes.add(run); queueMicrotask(run);
        return () => ouvintes.delete(run);
      },
      async get(col, id) { const v = assegura(col)[id]; return v ? { id, ...clone(v) } : null; },
      async list(col, filtros) { return Object.entries(assegura(col)).filter(([, v]) => bate(v, filtros)).map(([id, v]) => ({ id, ...clone(v) })); },
      async set(col, id, data, merge = false) { assegura(col)[id] = merge ? { ...(assegura(col)[id] || {}), ...clone(data) } : clone(data); notificar(); },
      async add(col, data) { const id = novoId(); assegura(col)[id] = clone(data); notificar(); return id; },
      novoId: () => novoId(),
      async update(col, id, patch) {
        if (!assegura(col)[id]) throw Object.assign(new Error('Documento não existe'), { code: 'not-found' });
        Object.assign(assegura(col)[id], clone(patch)); notificar();
      },
      async del(col, id) { delete assegura(col)[id]; notificar(); },
      async batch(ops) {
        for (const o of ops) {
          if (o.op === 'delete') delete assegura(o.col)[o.id];
          else if (o.op === 'update') Object.assign(assegura(o.col)[o.id], clone(o.data));
          else assegura(o.col)[o.id] = o.merge ? { ...(assegura(o.col)[o.id] || {}), ...clone(o.data) } : clone(o.data);
        }
        notificar();
      },
    },
  };
}
