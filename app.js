import { firebaseConfig, NOME_SISTEMA } from './firebase-config.js';
import { calcularPagamento, cfgCoach, tipoSugerido, fmtUSD, CONFIG_PADRAO, percentualDe, valorPagoUnit, valoresContrato } from './calculo.js';

// ============================================================ backend
// ?demo na URL força o modo demonstração mesmo com o Firebase configurado
const configurado = firebaseConfig.apiKey && firebaseConfig.apiKey !== 'COLE_AQUI' && !new URLSearchParams(location.search).has('demo');
const B = configurado
  ? await (await import('./backend-firebase.js')).criarBackend(firebaseConfig)
  : await (await import('./backend-demo.js')).criarBackend();
const DEMO = B.modo === 'demo';
// "Ver como coach" (administrador): bloqueia qualquer gravação enquanto estiver só olhando
for (const k of ['add', 'update', 'set', 'batch', 'delete']) {
  const orig = B.db[k];
  if (typeof orig === 'function') B.db[k] = (...a) => (S.verComo ? Promise.reject(new Error('Modo "ver como coach": é só visualização, nada foi alterado.')) : orig.apply(B.db, a));
}

// ============================================================ utilidades
const $app = document.getElementById('app');
const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const hojeISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const mesAtual = () => hojeISO().slice(0, 7);
const mesLabel = (m) => `${MESES[+m.slice(5, 7) - 1]}/${m.slice(0, 4)}`;
const somaMes = (m, d) => { const dt = new Date(+m.slice(0, 4), +m.slice(5, 7) - 1 + d, 1); return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}`; };
const fmtDia = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : '');
const fmtDiaAno = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '');
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const slug = (s) => norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const toDate = (v) => (!v ? null : v.toDate ? v.toDate() : v instanceof Date ? v : new Date(v));
const fmtDataHora = (v) => { const d = toDate(v); return d ? d.toLocaleDateString('pt-BR') : ''; };
const titulo = (s) => String(s || '').trim().replace(/\s+/g, ' ');
const PAPEIS = { admin: 'Administrador', revisora: 'Revisora (Bia)', financeiro: 'Financeiro', aprovador: 'Aprovação final', coach: 'Coach' };
const STATUS = { pendente: 'Pendente', aprovada: 'Aprovada', recusada: 'Recusada' };

function toast(msg, erro = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (erro ? ' erro' : '');
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), erro ? 6000 : 3200);
}
function msgErro(e) {
  const c = e?.code || '';
  if (c.includes('permission-denied')) return 'Sem permissão para esta ação. Se o mês já foi fechado, peça para reabrir.';
  if (c.includes('invalid-credential') || c.includes('wrong-password') || c.includes('user-not-found')) return 'E-mail ou senha incorretos.';
  if (c.includes('email-already-in-use')) return 'Este e-mail já tem cadastro.';
  if (c.includes('weak-password')) return 'A senha precisa ter pelo menos 6 caracteres.';
  if (c.includes('too-many-requests')) return 'Muitas tentativas. Aguarde alguns minutos e tente de novo.';
  if (c.includes('unavailable') || c.includes('network')) return 'Sem conexão com o servidor. Verifique a internet.';
  return e?.message || 'Algo deu errado.';
}
async function tentar(fn, ok) {
  try { const r = await fn(); if (ok) toast(ok); return r === undefined ? true : r; } catch (e) { console.error(e); toast(msgErro(e), true); return undefined; }
}

// ============================================================ estado
const S = {
  auth: null, perfil: undefined, sistemaExiste: null,
  view: null, mes: mesAtual(), coachSel: null,
  usuarios: [], clientes: [], sessoes: [], fechamentos: [], contratos: [], sistema: null,
  edit: null, novoCliente: false, servicoSel: 'sessao', clienteSel: '', contratoSel: '', sel: new Set(), filtro: 'todas',
  modal: null, importacao: null, pronto: {},
  verComo: null, perfilAdmin: null,
};
const subs = {};
function sub(chave, unsub) { if (subs[chave]) subs[chave](); subs[chave] = unsub; }
function limparSubs() { Object.keys(subs).forEach((k) => { subs[k](); delete subs[k]; }); }

const staff = () => S.perfil && (S.perfil.papel === 'admin' || S.perfil.papel === 'revisora');
const isAdmin = () => S.perfil?.papel === 'admin';
const isFin = () => S.perfil?.papel === 'financeiro';
const isAprov = () => S.perfil?.papel === 'aprovador';     // Ricardo: aprovação final, depois do financeiro
const leitor = () => staff() || isFin() || isAprov();     // vê todos os coaches
const editaValores = () => isAdmin() || isFin();
const uid = () => S.verComo || S.auth?.uid;
const usuario = (id) => (id === uid() ? { id, ...S.perfil } : S.usuarios.find((u) => u.id === id));
const coaches = () => (leitor()
  ? S.usuarios.filter((u) => u.papel === 'coach').sort((a, b) => (a.ativo === false) - (b.ativo === false) || a.nome.localeCompare(b.nome))
  : [{ id: uid(), ...S.perfil }]);
const fechamento = (coachId, mes) => S.fechamentos.find((f) => f.id === `${coachId}_${mes}`);
const fechado = (coachId, mes) => fechamento(coachId, mes)?.status === 'fechado';
const clientesDe = (coachId) => S.clientes.filter((c) => c.coachId === coachId).sort((a, b) => (a.ordem || 999) - (b.ordem || 999) || a.nome.localeCompare(b.nome));
const mapaClientes = (coachId) => new Map(clientesDe(coachId).map((c) => [c.id, c]));
const sessoesDe = (coachId, mes = S.mes) => S.sessoes.filter((s) => s.coachId === coachId && s.mes === mes)
  .sort((a, b) => a.data.localeCompare(b.data) || (toDate(a.criadoEm)?.getTime() || 0) - (toDate(b.criadoEm)?.getTime() || 0));
const nomeServico = (cfg, id) => (!id || id === 'sessao' ? 'Sessão' : cfg.extras.find((e) => e.id === id)?.nome || id);
const extraLivre = (cfg, id) => !!cfg.extras.find((e) => e.id === id && e.livre);
const extraDe = (cfg, id) => cfg.extras.find((e) => e.id === id);
// "70% de $350,00 = $245,00" — cálculo do que é pago ao coach num serviço de valor livre
function textoCalculo(ex, valor, qtd = 1) {
  const v = Number(valor);
  if (!(v > 0)) return '';
  const pct = percentualDe(ex), unit = valorPagoUnit(ex, v);
  const tot = Math.round(unit * 100) * (qtd || 1) / 100;
  if (pct >= 100) return qtd > 1 ? `${qtd} × ${fmtUSD(v)} = ${fmtUSD(tot)}` : '';
  return `Pago ao coach: ${pct}% de ${fmtUSD(v)} = ${fmtUSD(unit)}${qtd > 1 ? ` × ${qtd} = ${fmtUSD(tot)}` : ''}`;
}
const servicoHTML = (cfg, s) => {
  const ex = extraDe(cfg, s.servico);
  if (!ex?.livre || s.contratoId) return esc(nomeServico(cfg, s.servico));
  const v = Number(s.valorInformado);
  if (!(v > 0)) return esc(ex.nome) + '<div class="nota" style="color:var(--bad)">sem valor informado</div>';
  const pct = percentualDe(ex);
  return esc(ex.nome) + `<div class="nota num">Cobrado ${fmtUSD(v)}${s.quantidade > 1 ? ' cada' : ''}${pct < 100 ? ` · <b>pago ${fmtUSD(valorPagoUnit(ex, v))}</b> (${pct}%)` : ''}</div>`;
};

// ---------- contratos
const exigeContrato = () => !!S.sistema?.exigirContrato;
const contrato = (id) => S.contratos.find((c) => c.id === id);
const nomeCliente = (id) => S.clientes.find((c) => c.id === id)?.nome || '';
const servicoCt = (c) => c.servico || 'sessao';
const contratosDoCliente = (clienteId, servico = null) => S.contratos.filter((c) => c.clienteId === clienteId && (!servico || servicoCt(c) === servico))
  .sort((a, b) => (a.status === 'ativo' ? 0 : 1) - (b.status === 'ativo' ? 0 : 1) || String(a.numero).localeCompare(String(b.numero), 'pt', { numeric: true }));
const mapaContratos = () => new Map(S.contratos.map((c) => [c.id, { ...c, clienteNome: nomeCliente(c.clienteId) || c.clienteNome }]));
// uso de cada contrato: sessões feitas fora do sistema + sessões lançadas (exceto recusadas), em ordem de data
let _uso = { s: null, c: null, v: null };
function usoContratos() {
  if (_uso.s === S.sessoes && _uso.c === S.contratos) return _uso.v;
  const usadas = new Map(), faixa = new Map();
  for (const c of S.contratos) usadas.set(c.id, Number(c.sessoesAnteriores) || 0);
  const ss = S.sessoes.filter((x) => x.contratoId && x.status !== 'recusada' && usadas.has(x.contratoId))
    .sort((a, b) => a.data.localeCompare(b.data) || (toDate(a.criadoEm)?.getTime() || 0) - (toDate(b.criadoEm)?.getTime() || 0));
  for (const x of ss) {
    const ini = usadas.get(x.contratoId) + 1, fim = ini + (Number(x.quantidade) || 1) - 1;
    usadas.set(x.contratoId, fim); faixa.set(x.id, { ini, fim });
  }
  _uso = { s: S.sessoes, c: S.contratos, v: { usadas, faixa } };
  return _uso.v;
}
const usadasDe = (ctId, ignorarSessao) => {
  const u = usoContratos().usadas.get(ctId) || 0;
  const s = ignorarSessao && S.sessoes.find((x) => x.id === ignorarSessao && x.contratoId === ctId && x.status !== 'recusada');
  return u - (s ? Number(s.quantidade) || 0 : 0);
};
const restantesDe = (ct, ignorarSessao) => Number(ct.sessoesContratadas) - usadasDe(ct.id, ignorarSessao);
// contrato sugerido para um cliente: o primeiro ativo que ainda tem sessões
const contratoSugerido = (clienteId, ignorarSessao, servico = 'sessao') => contratosDoCliente(clienteId, servico).find((c) => c.status === 'ativo' && restantesDe(c, ignorarSessao) > 0) || null;
// valor da sessão nº n do contrato (a última pode ter o ajuste de arredondamento)
const valorSessaoN = (ct, n) => (n === Number(ct.sessoesContratadas) && ct.valorUltimaSessao != null ? Number(ct.valorUltimaSessao) : Number(ct.valorSessao));
// texto de como o valor por sessão foi calculado
function textoValorContrato(ct) {
  if (!(Number(ct.valorContrato) > 0) || ct.percentualCoach == null) return `${fmtUSD(ct.valorSessao)} por sessão`;
  const ult = ct.valorUltimaSessao != null && Math.round(ct.valorUltimaSessao * 100) !== Math.round(ct.valorSessao * 100);
  return `${fmtUSD(ct.valorContrato)} × ${String(ct.percentualCoach).replace('.', ',')}% ÷ ${ct.sessoesContratadas} = ${fmtUSD(ct.valorSessao)} por sessão${ult ? ` (última: ${fmtUSD(ct.valorUltimaSessao)})` : ''}`;
}
// prévia do cálculo no cadastro do contrato
function calcContratoTexto(total, pct, sessoes) {
  const t = Number(total), p = Number(pct), n = parseInt(sessoes, 10);
  if (!(t > 0) || !(p > 0) || !(n >= 1)) return 'Preencha o valor do contrato, a % do coach e as sessões para ver o valor por sessão.';
  const v = valoresContrato(t, p, n);
  return `Participação do coach: ${fmtUSD(t)} × ${String(p).replace('.', ',')}% = ${fmtUSD(v.participacao)}  ·  ÷ ${n} sessões = ${fmtUSD(v.valorSessao)} por sessão`
    + (v.exato ? '' : `  ·  a última sessão fica com ${fmtUSD(v.valorUltimaSessao)} para fechar exatamente ${fmtUSD(v.participacao)}`);
}
// próximo número de contrato: AAAA-NNN, sequencial no ano
function proximoNumeroContrato() {
  const ano = hojeISO().slice(0, 4);
  const max = S.contratos.reduce((m, c) => { const r = String(c.numero || '').match(/^(\d{4})-(\d+)$/); return r && r[1] === ano ? Math.max(m, +r[2]) : m; }, 0);
  return `${ano}-${String(max + 1).padStart(3, '0')}`;
}
function rotuloContrato(sessao) {
  const ct = sessao.contratoId && contrato(sessao.contratoId);
  if (!ct) return '';
  const f = usoContratos().faixa.get(sessao.id);
  const num = f ? (f.fim > f.ini ? `sessões ${f.ini}–${f.fim}` : `sessão ${f.ini}`) : 'sessão';
  const exc = f && f.fim > Number(ct.sessoesContratadas);
  return `<div class="nota num" ${exc ? 'style="color:var(--bad)"' : ''}>Contrato ${esc(ct.numero)} · ${num} de ${ct.sessoesContratadas}${exc ? ' (acima do contratado)' : ''}</div>`;
}
function resumo(coachId, mes, statusIncluidos = ['aprovada']) {
  const cfg = cfgCoach(usuario(coachId));
  const f = fechamento(coachId, mes);
  const fx = usoContratos().faixa;
  const ss = sessoesDe(coachId, mes).filter((s) => statusIncluidos.includes(s.status)).map((s) => {
    const ct = s.contratoId && contrato(s.contratoId), f = fx.get(s.id);
    return ct && f && f.ini <= Number(ct.sessoesContratadas) && f.fim >= Number(ct.sessoesContratadas) ? { ...s, ultimaContrato: true } : s;
  });
  return calcularPagamento(cfg, mapaClientes(coachId), ss, f?.ajustes || [], mapaContratos());
}

// ============================================================ dados em tempo real
// Todas as sessões (de todos os meses) ficam carregadas: a numeração das sessões de contrato depende do histórico.
function assinarSessoes() { /* nada a fazer: as sessões de todos os meses já estão em S.sessoes */ }
function carregarSessoesEContratos() {
  const filtro = leitor() ? [] : [['coachId', '==', uid()]];
  sub('sessoes', B.db.watch('sessoes', filtro, (l) => { S.sessoes = l; S.pronto.sessoes = true; render(); }, erroLeitura));
  sub('contratos', B.db.watch('contratos', filtro, (l) => { S.contratos = l; render(); }, erroLeitura));
  sub('sistema', B.db.watchDoc('config', 'sistema', (d) => { S.sistema = d; render(); }, () => {}));
}
// Um listener recusado não volta sozinho: tenta de novo algumas vezes (ex.: logo após ativar o perfil)
let tentativasLeitura = 0, timerLeitura = null;
function erroLeitura(e) {
  if (timerLeitura) return;                        // vários listeners falham juntos: trata uma vez só
  if (tentativasLeitura < 3 && S.perfil) {
    tentativasLeitura++;
    timerLeitura = setTimeout(() => { timerLeitura = null; S.pronto = {}; iniciarDados(); }, 1500 * tentativasLeitura);
    return;
  }
  // aviso fixo no topo da tela (o toast some e a tela parece apenas vazia)
  S.erroLeitura = (e?.code || '').includes('permission-denied')
    ? 'O banco de dados recusou a leitura para o seu perfil. Avise o administrador: as regras de segurança do Firestore precisam estar atualizadas.'
    : 'Não foi possível carregar os dados: ' + msgErro(e) + ' Recarregue a página.';
  render();
}

function iniciarDados() {
  const chave = uid() + ':' + S.perfil.papel;
  if (S.pronto.chave === chave) return;
  S.pronto = { chave }; S.erroLeitura = null;
  if (leitor()) {
    sub('usuarios', B.db.watch('users', [], (l) => { S.usuarios = l; tentativasLeitura = 0; render(); }, erroLeitura));
    sub('clientes', B.db.watch('clientes', [], (l) => { S.clientes = l; render(); }, erroLeitura));
    sub('fech', B.db.watch('fechamentos', [], (l) => { S.fechamentos = l; render(); }, erroLeitura));
    S.view ||= isAprov() ? 'aprovacao' : isFin() ? 'valores' : 'painel';
  } else {
    sub('clientes', B.db.watch('clientes', [['coachId', '==', uid()]], (l) => { S.clientes = l; render(); }, erroLeitura));
    sub('fech', B.db.watch('fechamentos', [['coachId', '==', uid()]], (l) => { S.fechamentos = l; render(); }, erroLeitura));
    S.view ||= 'lancar';
  }
  carregarSessoesEContratos();
}

B.auth.onChange(async (u) => {
  limparSubs();
  Object.assign(S, { auth: u, perfil: undefined, verComo: null, perfilAdmin: null, view: null, mes: mesAtual(), coachSel: null, importacao: null, contratos: [], sistema: null, clienteSel: '', usuarios: [], clientes: [], sessoes: [], fechamentos: [], pronto: {}, modal: null, edit: null });
  if (!u) { render(); return; }
  render();
  sub('perfil', B.db.watchDoc('users', u.uid, async (p) => {
    if (S.verComo) { S.perfilAdmin = p; render(); return; }
    const papelMudou = S.perfil && p && S.perfil.papel !== p.papel;
    S.perfil = p;
    if (!p) S.sistemaExiste = !!(await B.db.get('config', 'sistema').catch(() => ({})));
    if (p && p.ativo !== false) { if (papelMudou) { S.view = null; S.pronto = {}; } iniciarDados(); }
    render();
  }, (e) => { S.perfil = null; S.sistemaExiste = true; toast(msgErro(e), true); render(); }));
});

// ============================================================ render com preservação de formulário
function render(semRestaurar = false) {
  if (S.verComo) { const c = S.usuarios.find((u) => u.id === S.verComo); if (c) S.perfil = { ...c, papel: 'coach' }; }
  const campos = {};
  if (!semRestaurar) $app.querySelectorAll('input[id], select[id], textarea[id]').forEach((el) => {
    campos[el.id] = el.type === 'checkbox' ? el.checked : el.type === 'file' ? undefined : el.value;
  });
  const foco = document.activeElement?.id;
  const selStart = document.activeElement?.selectionStart;
  const scroll = window.scrollY;

  $app.classList.toggle("modo-ver", !!S.verComo);
  $app.innerHTML = tela();

  for (const [id, v] of Object.entries(campos)) {
    const el = document.getElementById(id);
    if (!el || v === undefined || el.dataset.fixo !== undefined) continue;
    if (el.type === 'checkbox') el.checked = v; else if (el.tagName !== 'SELECT' || [...el.options].some((o) => o.value === v)) el.value = v;
  }
  if (foco) { const el = document.getElementById(foco); if (el) { el.focus(); try { if (selStart != null) el.setSelectionRange(selStart, selStart); } catch {} } }
  window.scrollTo(0, scroll);
}

function tela() {
  if (S.auth === null) return telaLogin();
  if (S.perfil === undefined) return '<div class="carregando">Carregando…</div>';
  if (!S.perfil) return telaSemPerfil();
  if (S.perfil.ativo === false) return telaSimples('Acesso desativado', 'Seu acesso foi desativado. Fale com o administrador do sistema.');
  const erro = S.erroLeitura ? `<div class="aviso erro"><div><b>Dados não carregados.</b> ${esc(S.erroLeitura)}</div></div>` : '';
  return topo() + `<main>${erro}${conteudo()}</main>` + (S.modal ? modal() : '');
}

function telaSimples(t, p, extra = '') {
  return `<div class="login"><div class="card"><h1>${esc(t)}</h1><p>${p}</p>${extra}
    <button class="btn" data-acao="sair">Sair</button></div></div>`;
}

function telaLogin() {
  return `<div class="login"><form class="card" data-form="login" autocomplete="on">
    <div class="marca"><span class="selo">CS</span>${esc(NOME_SISTEMA)}</div>
    <div><h1>Entrar</h1><p>Coaches registram as sessões realizadas; a Bia confere e fecha o mês.</p></div>
    <div class="campo"><label for="l-email">E-mail</label><input id="l-email" type="email" required autocomplete="username"></div>
    <div class="campo"><label for="l-senha">Senha</label><input id="l-senha" type="password" required autocomplete="current-password"></div>
    <button class="btn pri" type="submit">Entrar</button>
    <button class="link" type="button" data-acao="esqueci">Esqueci minha senha</button>
    ${DEMO ? `<div class="aviso atencao"><div><b>Modo demonstração.</b> Os dados são fictícios e somem ao recarregar a página. Escolha um perfil para testar:</div></div>
      <div class="demo-contas">${B.contasDemo.map(([e, n]) => `<button type="button" class="btn" data-acao="loginDemo" data-email="${e}">${esc(n)} <span class="nota">${e}</span></button>`).join('')}</div>` : ''}
  </form></div>`;
}

function telaSemPerfil() {
  if (S.sistemaExiste === false) {
    return `<div class="login"><form class="card" data-form="bootstrap">
      <h1>Primeiro acesso</h1>
      <p>O sistema ainda não tem administrador. Você (${esc(S.auth.email)}) será o administrador e poderá cadastrar a Bia e os coaches.</p>
      <div class="campo"><label for="b-nome">Seu nome</label><input id="b-nome" required></div>
      <button class="btn pri" type="submit">Ativar como administrador</button>
      <button class="btn" type="button" data-acao="sair">Sair</button></form></div>`;
  }
  return telaSimples('Acesso não liberado', `O login ${esc(S.auth.email)} ainda não tem perfil no sistema. Peça ao administrador para cadastrar você.`);
}

function topo() {
  const itens = isAprov()
    ? [['aprovacao', 'Aprovação final'], ['contratos', 'Contratos'], ['tabela', 'Tabela de valores'], ['fechamentos', 'Fechamentos']]
    : isFin()
    ? [['valores', 'Conferência de valores'], ['contratos', 'Contratos'], ['tabela', 'Tabela de valores'], ['fechamentos', 'Fechamentos']]
    : staff()
    ? [['painel', 'Painel'], ['conferencia', 'Conferência'], ['carteiras', 'Carteiras'], ['contratos', 'Contratos'], ['fechamentos', 'Fechamentos'],
       ...(isAdmin() ? [['valores', 'Conferência de valores'], ['aprovacao', 'Aprovação final']] : []), ['tabela', 'Tabela de valores'],
       ...(isAdmin() ? [['usuarios', 'Usuários'], ['importar', 'Importar histórico']] : [])]
    : [['lancar', 'Minhas sessões'], ['carteira', 'Minha carteira'], ['historico', 'Meus fechamentos']];
  return `${S.verComo ? `<div class="demo-faixa ver-como">Você está vendo o sistema como <b>${esc(S.perfil.nome)}</b> (coach) — só visualização, nada pode ser alterado. <button class="btn sm" data-acao="sairVerComo">Voltar ao administrador</button></div>` : ''}${DEMO ? '<div class="demo-faixa">Modo demonstração — dados fictícios. Preencha o firebase-config.js para usar de verdade.</div>' : ''}
  <header class="topo"><div class="topo-in">
    <div class="marca"><span class="selo">CS</span>${esc(NOME_SISTEMA)}</div>
    <nav class="nav">${itens.map(([v, t]) => `<button data-acao="ir" data-view="${v}" ${S.view === v ? 'aria-current="page"' : ''}>${t}</button>`).join('')}</nav>
    <div class="quem"><span><b>${esc(S.perfil.nome)}</b> <span class="email">· ${esc(PAPEIS[S.perfil.papel] || '')}</span></span>
      ${S.verComo ? '' : '<button class="ico" data-acao="modal" data-tipo="senha">Senha</button>'}
      <button class="ico" data-acao="sair">Sair</button></div>
  </div></header>`;
}

const seletorMes = () => `<div class="mes"><button data-acao="mes" data-d="-1" aria-label="Mês anterior">‹</button><span class="num">${mesLabel(S.mes)}</span><button data-acao="mes" data-d="1" aria-label="Próximo mês">›</button></div>`;
const pill = (st) => `<span class="pill p-${st}">${STATUS[st] || st}</span>`;
const pillMes = (coachId, mes) => (fechado(coachId, mes) ? '<span class="pill p-fechado">Fechado</span>' : '<span class="pill p-aberto">Aberto</span>');
const tipoBadge = (c) => (c && Number(c.valorSessao) > 0 ? `<span class="tipo B" title="Valor especial: ${fmtUSD(c.valorSessao)} por sessão">$</span>` : c ? `<span class="tipo ${c.tipo || ''} ${c.tipoConfirmado === false ? 'q' : ''}" title="${c.tipoConfirmado === false ? 'Tipo ainda não confirmado pela Bia' : 'Cliente Tipo ' + c.tipo}">${esc(c.tipo || '?')}</span>` : '<span class="tipo q">?</span>');

function conteudo() {
  const v = S.view;
  if (!leitor()) return v === 'carteira' ? vCarteiraCoach() : v === 'historico' ? vHistoricoCoach() : vLancar();
  if (v === 'tabela') return vTabela();
  if (v === 'contratos') return vContratos();
  if (v === 'fechamentos') return vFechamentos();
  if (isAprov() || (v === 'aprovacao' && isAdmin())) return vValores('aprovacao');
  if (isFin() || (v === 'valores' && isAdmin())) return vValores('conferencia');
  if (v === 'conferencia') return vConferencia();
  if (v === 'carteiras') return vCarteiras();
  if (v === 'fechamentos') return vFechamentos();
  if (v === 'usuarios' && isAdmin()) return vUsuarios();
  if (v === 'importar' && isAdmin()) return vImportar();
  return vPainel();
}

// ============================================================ COACH: lançar
// Campo "Contrato" do formulário do coach (aparece para Sessão quando o cliente tem contrato)
// contratos que o coach pode escolher no formulário (cliente + serviço selecionados) e o escolhido
function contratosDoForm(e) {
  const clienteId = S.clienteSel, servico = S.servicoSel || 'sessao';
  if (!clienteId || clienteId === '__novo') return { cts: [], ct: null };
  const cts = contratosDoCliente(clienteId, servico).filter((c) => c.status === 'ativo' || c.id === e?.contratoId);
  if (!cts.length) return { cts, ct: null };
  const sel = cts.some((c) => c.id === S.contratoSel) ? S.contratoSel : (e?.contratoId && cts.some((c) => c.id === e.contratoId) ? e.contratoId : contratoSugerido(clienteId, e?.id, servico)?.id || cts[0].id);
  return { cts, ct: contrato(sel) };
}
function campoContrato(e) {
  const clienteId = S.clienteSel, servico = S.servicoSel || 'sessao';
  if (!clienteId || clienteId === '__novo') {
    return clienteId === '__novo' && exigeContrato() && servico === 'sessao'
      ? '<div class="campo largo"><div class="aviso erro"><div>Cliente novo não tem contrato. Peça ao financeiro para cadastrar o contrato antes de lançar sessões.</div></div></div>' : '';
  }
  const { cts, ct } = contratosDoForm(e);
  if (!cts.length) {
    if (servico !== 'sessao') return '';
    return `<div class="campo largo"><div class="aviso ${exigeContrato() ? 'erro' : 'atencao'}"><div>${exigeContrato()
      ? 'Este cliente não tem contrato ativo. Peça ao financeiro para cadastrar o contrato antes de lançar sessões.'
      : 'Este cliente não tem contrato cadastrado: o valor segue a tabela (Tipo A/B).'}</div></div></div>`;
  }
  const sel = ct.id;
  const rest = restantesDe(ct, e?.id);
  const prox = usadasDe(ct.id, e?.id) + 1;
  return `<div class="campo largo"><label for="f-contrato">Contrato</label><select id="f-contrato" data-change="contrato">
      ${cts.map((c) => { const r = restantesDe(c, e?.id); return `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>Nº ${esc(c.numero)}${c.nome ? ' · ' + esc(c.nome) : ''} — ${c.sessoesContratadas - r} de ${c.sessoesContratadas} sessões usadas${r <= 0 ? ' (completo)' : ''}</option>`; }).join('')}</select>
    <div class="dica num" style="${rest <= 0 ? 'color:var(--bad)' : ''}">${rest <= 0
      ? `Contrato completo (${ct.sessoesContratadas} de ${ct.sessoesContratadas}). Para lançar mais sessões, o financeiro precisa cadastrar um novo contrato.`
      : `Esta será a sessão ${prox} de ${ct.sessoesContratadas} · você recebe ${fmtUSD(valorSessaoN(ct, prox))} · restam ${rest}`}</div></div>`;
}

function vLancar() {
  const me = uid();
  const cfg = cfgCoach(S.perfil);
  const f = fechamento(me, S.mes);
  const trav = fechado(me, S.mes);
  const lista = sessoesDe(me);
  const mapa = mapaClientes(me);
  const carteira = clientesDe(me).filter((c) => c.ativo !== false);
  const e = S.edit ? S.sessoes.find((s) => s.id === S.edit) : null;
  const hoje = hojeISO();
  const dataPadrao = S.mes === mesAtual() ? hoje : `${S.mes}-01`;
  const cont = { pendente: 0, aprovada: 0, recusada: 0 };
  lista.forEach((s) => cont[s.status]++);
  const livreSemCt = extraLivre(cfg, S.servicoSel) && !contratosDoForm(e).ct;

  const form = trav ? '' : `<form class="card" data-form="sessao">
    <div class="cab"><h2>${e ? 'Editar sessão' : 'Registrar sessão'}</h2>${e ? '<button type="button" class="link" data-acao="cancelarEdit">Cancelar edição</button>' : ''}</div>
    ${e?.status === 'recusada' ? `<div class="aviso erro" style="margin-bottom:12px"><div><b>Recusada pela Bia:</b> ${esc(e.comentario || '')}<br>Corrija e salve para reenviar.</div></div>` : ''}
    <div class="form">
      <div class="campo"><label for="f-data">Data da sessão</label><input id="f-data" type="date" required max="${hoje}" value="${e ? e.data : dataPadrao}"></div>
      <div class="campo"><label for="f-cliente">Cliente</label><select id="f-cliente" required data-change="cliente">
        <option value="">Selecione…</option>
        ${carteira.map((c) => `<option value="${c.id}" ${e?.clienteId === c.id ? 'selected' : ''}>${esc(c.nome)}</option>`).join('')}
        <option value="__novo">+ Cliente novo</option></select></div>
      <div class="campo" ${S.novoCliente ? '' : 'hidden'}><label for="f-novo">Nome do cliente novo</label><input id="f-novo" placeholder="Nome e sobrenome" ${S.novoCliente ? 'required' : ''}></div>
      ${campoContrato(e)}
      <div class="campo"><label for="f-servico">Serviço</label><select id="f-servico" data-change="servico">
        <option value="sessao">Sessão</option>${cfg.extras.map((x) => `<option value="${x.id}" ${e?.servico === x.id ? 'selected' : ''}>${esc(x.nome)}</option>`).join('')}</select></div>
      <div class="campo" ${livreSemCt ? '' : 'hidden'}><label for="f-valor">Valor cobrado ($)</label><input id="f-valor" type="number" min="0.01" step="0.01" placeholder="Ex.: 350" value="${e?.valorInformado ?? ''}" ${livreSemCt ? 'required' : ''}>
        <div class="dica num" id="f-calc" data-servico="${esc(S.servicoSel)}">${esc(textoCalculo(extraDe(cfg, S.servicoSel), e?.valorInformado, e?.quantidade || 1))}</div></div>
      <div class="campo"><label for="f-qtd">Quantidade</label><input id="f-qtd" type="number" min="1" max="20" step="1" required value="${e ? e.quantidade : 1}"></div>
      <div class="campo largo"><label for="f-obs">Observação (opcional)</label><input id="f-obs" maxlength="300" value="${esc(e?.obs || '')}" placeholder="Ex.: sessão remarcada do dia 12"></div>
    </div>
    <div class="acoes" style="margin-top:14px"><button class="btn pri" type="submit">${e ? (e.status === 'recusada' ? 'Salvar e reenviar' : 'Salvar alteração') : 'Registrar sessão'}</button>
      <span class="dica">A sessão entra como <b>pendente</b> até a Bia conferir.</span></div>
  </form>`;

  const linhas = lista.map((s) => {
    const c = mapa.get(s.clienteId);
    const podeMexer = !trav && s.status !== 'aprovada';
    return `<tr class="${s.status === 'recusada' && s.comentario ? 'linha-rec' : ''}">
      <td class="num">${fmtDia(s.data)}</td>
      <td>${esc(c?.nome || s.clienteNome)} ${tipoBadge(c)}${rotuloContrato(s)}${s.obs ? `<div class="nota">${esc(s.obs)}</div>` : ''}</td>
      <td>${servicoHTML(cfg, s)}</td><td class="r">${s.quantidade}</td><td>${pill(s.status)}</td>
      <td class="r">${podeMexer ? `<button class="ico" data-acao="editar" data-id="${s.id}">Editar</button><button class="ico bad" data-acao="excluir" data-id="${s.id}">Excluir</button>` : ''}</td></tr>
      ${s.status === 'recusada' && s.comentario ? `<tr class="coment"><td></td><td colspan="5"><div class="coment-box"><b>Bia:</b> ${esc(s.comentario)}</div></td></tr>` : ''}`;
  }).join('');

  return `<div class="cab"><div><h1>Minhas sessões</h1><p>Registre cada sessão realizada. A Bia confere e aprova.</p></div>${seletorMes()}</div>
    ${trav ? `<div class="aviso fechado"><div><b>Mês fechado</b> em ${fmtDataHora(f.fechadoEm)}${f.fechadoPorNome ? ' por ' + esc(f.fechadoPorNome) : ''}. Os lançamentos deste mês não podem mais ser alterados.</div></div>` : ''}
    ${cont.recusada ? `<div class="aviso erro"><div><b>${cont.recusada} ${cont.recusada > 1 ? 'sessões recusadas' : 'sessão recusada'}.</b> Veja o comentário da Bia, corrija e reenvie.</div></div>` : ''}
    <div class="grid2"><div style="display:grid;gap:18px;min-width:0">${form}
      <section class="card"><div class="cab"><h2>Sessões de ${mesLabel(S.mes)}</h2>
        <span class="nota num">${lista.length} lançamentos · ${cont.pendente} pendentes · ${cont.aprovada} aprovadas</span></div>
        ${lista.length ? `<div class="tabwrap"><table><thead><tr><th>Data</th><th>Cliente</th><th>Serviço</th><th class="r">Qtd</th><th>Status</th><th></th></tr></thead><tbody>${linhas}</tbody></table></div>`
          : `<div class="vazio">Nenhuma sessão registrada em ${mesLabel(S.mes)}.${trav ? '' : ' Use o formulário acima para lançar a primeira.'}</div>`}
      </section></div>
      ${cardResumo(me, S.mes, false)}</div>`;
}

function cardResumo(coachId, mes, painelBia) {
  const f = fechamento(coachId, mes);
  if (f?.status === 'fechado') {
    return `<section class="card"><div class="cab"><h2>Pagamento de ${mesLabel(mes)}</h2>${pillMes(coachId, mes)}</div>
      ${tabelaLinhas(f.linhas || [], f.ajustes || [], false)}
      ${f.subtotal != null && (f.ajustes || []).length ? `<div class="sub-total"><span>Subtotal</span><span class="num">${fmtUSD(f.subtotal)}</span></div>` : ''}
      <div class="total-grande"><span>Valor fechado</span><strong>${fmtUSD(f.total)}</strong></div>
      <p class="nota">${f.origem === 'planilha' ? 'Fechamento importado da planilha antiga.' : `Fechado em ${fmtDataHora(f.fechadoEm)}${f.fechadoPorNome ? ' por ' + esc(f.fechadoPorNome) : ''}.`}</p>
      ${painelBia && f.conferencia ? avisoEtapa('Valores conferidos', f.conferencia) : painelBia && f.origem !== 'planilha' ? '<p class="nota">Aguardando conferência dos valores pelo financeiro.</p>' : ''}
      ${painelBia && f.aprovacao ? avisoEtapa('Aprovação final', f.aprovacao) : ''}
      ${!painelBia && f.aprovacao?.status === 'ok' ? '<p class="nota"><b>Pagamento aprovado.</b></p>' : !painelBia && f.conferencia?.status === 'ok' ? '<p class="nota">Valores conferidos pelo financeiro.</p>' : ''}
      ${painelBia ? botoesFechamento(coachId, mes, true) : ''}</section>`;
  }
  const aprov = resumo(coachId, mes, ['aprovada']);
  const pend = sessoesDe(coachId, mes).filter((s) => s.status === 'pendente');
  if (painelBia) {
    return `<section class="card"><div class="cab"><h2>Pagamento de ${mesLabel(mes)}</h2>${pillMes(coachId, mes)}</div>
      <p class="nota" style="margin:0 0 8px">Considera só as sessões <b>aprovadas</b>.</p>
      ${tabelaLinhas(aprov.linhas, fechamento(coachId, mes)?.ajustes || [], true, coachId, mes)}
      <div class="total-grande"><span>Total a pagar</span><strong>${fmtUSD(aprov.total)}</strong></div>
      ${formAjuste()}
      ${botoesFechamento(coachId, mes, false, pend.length)}</section>`;
  }
  const prev = resumo(coachId, mes, ['aprovada', 'pendente']);
  return `<section class="card"><div class="cab"><h2>Previsão de pagamento</h2>${pillMes(coachId, mes)}</div>
    ${tabelaLinhas(prev.linhas, fechamento(coachId, mes)?.ajustes || [], false)}
    <div class="sub-total"><span>Já aprovado pela Bia</span><span class="num">${fmtUSD(aprov.total)}</span></div>
    <div class="total-grande"><span>Previsão com pendentes</span><strong>${fmtUSD(prev.total)}</strong></div>
    <p class="nota">${pend.length ? `${pend.length} ${pend.length > 1 ? 'lançamentos aguardam' : 'lançamento aguarda'} conferência. ` : ''}Sessões recusadas não entram no cálculo. O valor final é definido no fechamento do mês.</p></section>`;
}

function tabelaLinhas(linhas, ajustes, editavel, coachId, mes) {
  if (!linhas.length && !ajustes.length) return '<div class="vazio" style="padding:14px">Nenhum valor neste mês ainda.</div>';
  return `<table class="resumo"><tbody>
    ${linhas.map((l) => `<tr><td>${esc(l.descricao)}<div class="nota num">${l.livre && l.percentual < 100 ? `${l.percentual}% de ${fmtUSD(l.cobrado)} cobrado (${l.quantidade} lançamento${l.quantidade > 1 ? 's' : ''})` : l.valorUnit == null ? `${l.quantidade} lançamento(s) · valores informados` : `${l.quantidade} × ${fmtUSD(l.valorUnit)}`}</div></td><td class="r">${fmtUSD(l.total)}</td></tr>`).join('')}
    ${ajustes.map((a) => `<tr><td>Ajuste: ${esc(a.descricao)}${editavel ? ` <button class="ico bad" data-acao="removerAjuste" data-id="${a.id}" data-coach="${coachId}" data-mes="${mes}">remover</button>` : ''}</td><td class="r">${fmtUSD(a.valor)}</td></tr>`).join('')}
  </tbody></table>`;
}

// ============================================================ COACH: carteira e histórico
function vCarteiraCoach() {
  const cfg = cfgCoach(S.perfil);
  const lista = clientesDe(uid());
  return `<div class="cab"><div><h1>Minha carteira</h1><p>${regraTexto(cfg)}</p></div></div>
    <section class="card">
      <form class="form" data-form="novoClienteCoach" style="margin-bottom:14px">
        <div class="campo"><label for="nc-nome">Adicionar cliente</label><input id="nc-nome" required placeholder="Nome e sobrenome"></div>
        <div><button class="btn pri" type="submit">Adicionar</button></div></form>
      ${lista.length ? `<div class="tabwrap"><table><thead><tr><th>Nº</th><th>Cliente</th><th>Tipo</th><th class="r">Valor especial</th><th>Situação</th></tr></thead><tbody>
        ${lista.map((c) => `<tr><td class="num">${c.ordem || ''}</td><td>${esc(c.nome)}${contratosDoCliente(c.id).map((ct) => `<div class="nota num">Contrato Nº ${esc(ct.numero)}${servicoCt(ct) !== 'sessao' ? ' · ' + esc(nomeServico(cfgCoach(S.perfil), servicoCt(ct))) : ''} · ${usadasDe(ct.id)} de ${ct.sessoesContratadas} sessões · ${fmtUSD(ct.valorSessao)}/sessão${ct.status !== 'ativo' ? ' · encerrado' : ''}</div>`).join('')}</td><td>${tipoBadge(c)}</td><td class="r num">${Number(c.valorSessao) > 0 ? fmtUSD(c.valorSessao) : '<span class="nota">—</span>'}</td>
          <td>${c.ativo === false ? '<span class="nota">Inativo</span>' : c.tipoConfirmado === false ? '<span class="nota">Tipo a confirmar pela Bia</span>' : '<span class="nota">Ativo</span>'}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="vazio">Sua carteira está vazia. Adicione clientes aqui ou direto ao registrar uma sessão.</div>'}
    </section>`;
}
function regraTexto(cfg) {
  const extras = cfg.extras.map((x) => `${esc(x.nome)}: ${x.livre ? `valor livre${percentualDe(x) < 100 ? ` (coach recebe ${percentualDe(x)}%)` : ''}` : fmtUSD(x.valor)}`).join(' · ');
  return `Tipo A: ${fmtUSD(cfg.valorA)} por sessão · Tipo B: ${fmtUSD(cfg.valorB)} por sessão${cfg.limiteA ? ` · os ${cfg.limiteA} primeiros clientes ativos da carteira são Tipo A` : ''}${extras ? ' · ' + extras : ''} · bônus de ${fmtUSD(cfg.bonusAtivo)} por cliente ativo e ${fmtUSD(cfg.bonusRecorrencia)} por cliente com ${cfg.minSessoesBonus}+ sessões no mês.`;
}
function vHistoricoCoach() {
  const lista = [...S.fechamentos].filter((f) => f.status === 'fechado').sort((a, b) => b.mes.localeCompare(a.mes));
  return `<div class="cab"><div><h1>Meus fechamentos</h1><p>Valores fechados pela Bia em cada mês.</p></div></div>
  <section class="card">${lista.length ? `<div class="tabwrap"><table><thead><tr><th>Mês</th><th class="r">Sessões</th><th class="r">Valor</th><th>Fechado em</th><th></th></tr></thead><tbody>
    ${lista.map((f) => `<tr><td>${mesLabel(f.mes)}</td><td class="r">${(f.linhas || []).filter((l) => !/^B[ôo]nus/i.test(l.descricao)).reduce((a, l) => a + l.quantidade, 0)}</td>
      <td class="r"><b>${fmtUSD(f.total)}</b></td><td>${f.origem === 'planilha' ? 'Planilha antiga' : fmtDataHora(f.fechadoEm)}</td>
      <td class="r"><button class="ico" data-acao="abrirMes" data-mes="${f.mes}">Ver</button></td></tr>`).join('')}
    </tbody><tfoot><tr><td>Total</td><td></td><td class="r">${fmtUSD(lista.reduce((a, f) => a + Math.round(f.total * 100), 0) / 100)}</td><td colspan="2"></td></tr></tfoot></table></div>`
    : '<div class="vazio">Nenhum mês fechado ainda.</div>'}</section>`;
}

// ============================================================ BIA: painel
function vPainel() {
  const cs = coaches().filter((c) => c.ativo !== false);
  let pend = 0, rec = 0, totalC = 0, nFech = 0;
  const linhas = cs.map((c) => {
    const ss = sessoesDe(c.id);
    const n = { pendente: 0, aprovada: 0, recusada: 0 };
    ss.forEach((s) => (n[s.status] += 1));
    const qtd = ss.reduce((a, s) => a + s.quantidade, 0);
    const f = fechamento(c.id, S.mes);
    const valor = f?.status === 'fechado' ? f.total : resumo(c.id, S.mes).total;
    pend += n.pendente; rec += n.recusada; totalC += Math.round(valor * 100); if (f?.status === 'fechado') nFech++;
    return `<tr><td><b>${esc(c.nome)}</b></td><td class="r">${ss.length}</td><td class="r">${qtd}</td>
      <td class="r">${n.pendente ? `<span class="pill p-pendente">${n.pendente}</span>` : '0'}</td>
      <td class="r">${n.recusada ? `<span class="pill p-recusada">${n.recusada}</span>` : '0'}</td>
      <td class="r">${n.aprovada}</td><td class="r"><b>${fmtUSD(valor)}</b></td><td>${pillMes(c.id, S.mes)}</td><td>${f?.status === 'fechado' ? pillConf(f) : ''}</td>
      <td class="r"><button class="btn sm ${n.pendente ? 'pri' : ''}" data-acao="conferir" data-coach="${c.id}">Conferir</button></td></tr>`;
  }).join('');
  return `<div class="cab"><div><h1>Painel de conferência</h1><p>Situação dos lançamentos de cada coach no mês.</p></div>${seletorMes()}</div>
    <div class="kpis">
      <div class="kpi ${pend ? 'alerta' : ''}"><small>Aguardando conferência</small><strong>${pend}</strong></div>
      <div class="kpi"><small>Recusadas em correção</small><strong>${rec}</strong></div>
      <div class="kpi"><small>Total aprovado no mês</small><strong>${fmtUSD(totalC / 100)}</strong></div>
      <div class="kpi"><small>Meses fechados</small><strong>${nFech} de ${cs.length}</strong></div>
    </div>
    <section class="card">${cs.length ? `<div class="tabwrap"><table><thead><tr><th>Coach</th><th class="r">Lançamentos</th><th class="r">Sessões</th><th class="r">Pendentes</th><th class="r">Recusadas</th><th class="r">Aprovadas</th><th class="r">Valor aprovado</th><th>Mês</th><th>Financeiro</th><th></th></tr></thead>
      <tbody>${linhas}</tbody></table></div>` : `<div class="vazio">Nenhum coach cadastrado.${isAdmin() ? ' Cadastre em <b>Usuários</b>.' : ''}</div>`}</section>`;
}

// ============================================================ BIA: conferência
function coachAtual() {
  const cs = coaches();
  if (!S.coachSel || !cs.some((c) => c.id === S.coachSel)) S.coachSel = cs.find((c) => c.ativo !== false)?.id || cs[0]?.id || null;
  return S.coachSel;
}
function seletorCoach(acao = 'coach') {
  const cs = coaches();
  return `<div class="campo" style="min-width:220px"><label for="sel-coach">Coach</label><select id="sel-coach" data-change="${acao}" data-fixo>
    ${cs.map((c) => `<option value="${c.id}" ${c.id === S.coachSel ? 'selected' : ''}>${esc(c.nome)}${c.ativo === false ? ' (inativo)' : ''}</option>`).join('')}</select></div>`;
}

function alertas(coachId, lista, mapa) {
  const itens = [];
  const semTipo = [...new Set(lista.filter((s) => mapa.get(s.clienteId)?.tipoConfirmado === false).map((s) => mapa.get(s.clienteId).nome))];
  if (semTipo.length) itens.push(`Cliente novo com tipo ainda não confirmado: <b>${semTipo.map(esc).join(', ')}</b>. Confirme em <button class="link" data-acao="ir" data-view="carteiras">Carteiras</button>.`);
  const vistos = {};
  lista.filter((s) => s.status !== 'recusada').forEach((s) => { const k = s.clienteId + s.data + s.servico; vistos[k] = (vistos[k] || 0) + 1; });
  const dup = lista.filter((s, i) => vistos[s.clienteId + s.data + s.servico] > 1 && lista.findIndex((x) => x.clienteId === s.clienteId && x.data === s.data && x.servico === s.servico) === i);
  dup.forEach((s) => itens.push(`Possível lançamento em dobro: <b>${esc(mapa.get(s.clienteId)?.nome || s.clienteNome)}</b> em ${fmtDia(s.data)}.`));
  // contratos: sessões acima do contratado e sessões sem contrato de clientes que têm contrato ativo
  const uso = usoContratos();
  const excedidos = S.contratos.filter((c) => c.coachId === coachId && (uso.usadas.get(c.id) || 0) > Number(c.sessoesContratadas));
  excedidos.forEach((c) => itens.push(`Contrato <b>Nº ${esc(c.numero)}</b> (${esc(nomeCliente(c.clienteId))}) passou do limite: ${uso.usadas.get(c.id)} de ${c.sessoesContratadas} sessões.`));
  const semCt = lista.filter((s) => s.status !== 'recusada' && !s.contratoId
    && contratosDoCliente(s.clienteId, s.servico || 'sessao').some((c) => c.status === 'ativo'));
  if (semCt.length) itens.push(`${semCt.length} sessão(ões) sem contrato de cliente que tem contrato ativo (${[...new Set(semCt.map((s) => esc(mapa.get(s.clienteId)?.nome || s.clienteNome)))].join(', ')}). Use <b>Editar</b> para escolher o contrato.`);
  if (exigeContrato()) {
    const semNenhum = lista.filter((s) => s.status !== 'recusada' && (s.servico || 'sessao') === 'sessao' && !s.contratoId && !contratosDoCliente(s.clienteId).length);
    if (semNenhum.length) itens.push(`${semNenhum.length} sessão(ões) de cliente sem contrato cadastrado.`);
  }
  const cfgA = cfgCoach(usuario(coachId));
  const semValor = lista.filter((s) => s.status !== 'recusada' && !s.contratoId && extraLivre(cfgA, s.servico) && !(Number(s.valorInformado) > 0));
  if (semValor.length) itens.push(`${semValor.length} lançamento(s) de serviço com valor livre sem valor informado. Corrija em Editar.`);
  const fut = lista.filter((s) => s.data > hojeISO());
  if (fut.length) itens.push(`${fut.length} lançamento(s) com data futura.`);
  return itens.length ? `<div class="aviso atencao"><div><b>Pontos de atenção</b><ul>${itens.map((i) => `<li>${i}</li>`).join('')}</ul></div></div>` : '';
}

function vConferencia() {
  const coachId = coachAtual();
  if (!coachId) return `<div class="cab"><h1>Conferência</h1></div><section class="card"><div class="vazio">Nenhum coach cadastrado.</div></section>`;
  const c = usuario(coachId);
  const cfg = cfgCoach(c);
  const mapa = mapaClientes(coachId);
  const trav = fechado(coachId, S.mes);
  const todas = sessoesDe(coachId);
  const lista = S.filtro === 'todas' ? todas : todas.filter((s) => s.status === S.filtro);
  const pendIds = todas.filter((s) => s.status === 'pendente').map((s) => s.id);
  S.sel = new Set([...S.sel].filter((id) => todas.some((s) => s.id === id && s.status !== 'aprovada')));
  const cont = { todas: todas.length, pendente: 0, aprovada: 0, recusada: 0 };
  todas.forEach((s) => cont[s.status]++);

  const linhas = lista.map((s) => {
    const cl = mapa.get(s.clienteId);
    const selecionavel = !trav && s.status === 'pendente';
    return `<tr class="${s.status === 'recusada' && s.comentario ? 'linha-rec' : ''}">
      <td>${selecionavel ? `<input type="checkbox" aria-label="Selecionar" data-acao="sel" data-id="${s.id}" ${S.sel.has(s.id) ? 'checked' : ''}>` : ''}</td>
      <td class="num">${fmtDia(s.data)}</td>
      <td>${esc(cl?.nome || s.clienteNome)} ${tipoBadge(cl)}${rotuloContrato(s)}${s.obs ? `<div class="nota">${esc(s.obs)}</div>` : ''}${s.reenviadaEm ? '<div class="nota">Reenviada após correção</div>' : ''}</td>
      <td>${servicoHTML(cfg, s)}</td><td class="r">${s.quantidade}</td><td>${pill(s.status)}</td>
      <td class="r" style="white-space:nowrap">${trav ? '' : s.status === 'pendente'
        ? `<button class="ico ok" data-acao="aprovar" data-id="${s.id}">Aprovar</button><button class="ico bad" data-acao="recusar" data-id="${s.id}">Recusar</button><button class="ico" data-acao="editarBia" data-id="${s.id}">Editar</button>`
        : `<button class="ico" data-acao="voltarPendente" data-id="${s.id}">Desfazer</button>`}</td></tr>
      ${s.status === 'recusada' && s.comentario ? `<tr class="coment"><td></td><td></td><td colspan="5"><div class="coment-box"><b>Motivo:</b> ${esc(s.comentario)}</div></td></tr>` : ''}`;
  }).join('');

  const filtros = [['todas', 'Todas'], ['pendente', 'Pendentes'], ['aprovada', 'Aprovadas'], ['recusada', 'Recusadas']];
  return `<div class="cab"><div><h1>Conferência</h1><p>${esc(c.nome)} · ${regraTexto(cfg)}</p></div>
      <div class="acoes" style="align-items:end">${seletorCoach()}${seletorMes()}</div></div>
    ${trav ? '<div class="aviso fechado"><div><b>Mês fechado.</b> Nenhum lançamento pode ser alterado. ' + (isAdmin() ? 'Você pode reabrir no quadro de pagamento.' : 'Para corrigir, peça ao administrador para reabrir.') + '</div></div>' : alertas(coachId, todas, mapa)}
    <div class="grid2">
      <section class="card">
        <div class="cab"><div class="acoes">${filtros.map(([k, t]) => `<button class="btn sm ${S.filtro === k ? 'pri' : ''}" data-acao="filtro" data-f="${k}">${t} <span class="num">${cont[k]}</span></button>`).join('')}</div>
          ${trav ? '' : `<div class="acoes"><button class="btn sm ok" data-acao="aprovarSel" ${S.sel.size ? '' : 'disabled'}>Aprovar selecionadas (${S.sel.size})</button>
            <button class="btn sm" data-acao="aprovarTodas" ${pendIds.length ? '' : 'disabled'}>Aprovar todas as pendentes</button></div>`}</div>
        ${lista.length ? `<div class="tabwrap"><table><thead><tr><th>${!trav && pendIds.length ? `<input type="checkbox" aria-label="Selecionar todas" data-acao="selTodas" ${pendIds.length && pendIds.every((id) => S.sel.has(id)) ? 'checked' : ''}>` : ''}</th><th>Data</th><th>Cliente</th><th>Serviço</th><th class="r">Qtd</th><th>Status</th><th></th></tr></thead><tbody>${linhas}</tbody></table></div>`
          : `<div class="vazio">${todas.length ? 'Nenhum lançamento com este filtro.' : `${esc(c.nome)} não lançou sessões em ${mesLabel(S.mes)}.`}</div>`}
      </section>
      ${cardResumo(coachId, S.mes, true)}
    </div>`;
}

function formAjuste() {
  return `<form class="form" data-form="ajuste" style="margin-top:14px;grid-template-columns:minmax(0,2fr) minmax(0,1fr) auto">
    <div class="campo"><label for="aj-desc">Ajuste manual</label><input id="aj-desc" required maxlength="200" placeholder="Ex.: diferença de sessão Tipo B de junho"></div>
    <div class="campo"><label for="aj-valor">Valor ($)</label><input id="aj-valor" type="number" step="0.01" required placeholder="10 ou -10"></div>
    <div><button class="btn" type="submit">Adicionar</button></div></form>`;
}
function botoesFechamento(coachId, mes, estaFechado, nPend = 0) {
  if (estaFechado) {
    return `<div class="acoes" style="margin-top:14px"><button class="btn" data-acao="pdf" data-coach="${coachId}">Recibo em PDF</button><button class="btn" data-acao="csv" data-coach="${coachId}">Exportar CSV</button>
      ${isAdmin() ? `<button class="btn" data-acao="modal" data-tipo="reabrir">Reabrir mês</button>` : ''}</div>`;
  }
  return `<div class="acoes" style="margin-top:14px"><button class="btn pri" data-acao="modal" data-tipo="fechar">Fechar mês</button>
    <button class="btn" data-acao="csv" data-coach="${coachId}">Exportar CSV</button></div>
    ${nPend ? `<p class="nota">${nPend} pendente(s): confira todas antes de fechar.</p>` : ''}`;
}

// ============================================================ BIA: carteiras
function vCarteiras() {
  const coachId = coachAtual();
  if (!coachId) return `<div class="cab"><h1>Carteiras</h1></div><section class="card"><div class="vazio">Nenhum coach cadastrado.</div></section>`;
  const cfg = cfgCoach(usuario(coachId));
  const lista = clientesDe(coachId);
  const sug = tipoSugerido(cfg, lista);
  return `<div class="cab"><div><h1>Carteiras</h1><p>${regraTexto(cfg)}</p></div><div class="acoes" style="align-items:end">${seletorCoach()}</div></div>
    <section class="card">
      <form class="form" data-form="novoClienteBia" style="margin-bottom:14px;grid-template-columns:minmax(0,2fr) minmax(0,1fr) auto">
        <div class="campo"><label for="cb-nome">Novo cliente</label><input id="cb-nome" required placeholder="Nome e sobrenome"></div>
        <div class="campo"><label for="cb-tipo">Tipo</label><select id="cb-tipo"><option ${sug === 'A' ? 'selected' : ''}>A</option><option ${sug === 'B' ? 'selected' : ''}>B</option></select></div>
        <div><button class="btn pri" type="submit">Adicionar</button></div></form>
      ${lista.length ? `<div class="tabwrap"><table><thead><tr><th>Nº</th><th>Cliente</th><th>Tipo</th><th class="r">Valor especial</th><th>Situação</th><th></th></tr></thead><tbody>
      ${lista.map((c) => `<tr><td class="num">${c.ordem || ''}</td><td>${esc(c.nome)}${c.mescladoEm ? '<div class="nota">Mesclado em outro cadastro</div>' : ''}</td>
        <td><select aria-label="Tipo de ${esc(c.nome)}" data-change="tipoCliente" data-id="${c.id}" id="tp-${c.id}" data-fixo><option ${c.tipo === 'A' ? 'selected' : ''}>A</option><option ${c.tipo === 'B' ? 'selected' : ''}>B</option></select></td>
        <td class="r num">${Number(c.valorSessao) > 0 ? `<b>${fmtUSD(c.valorSessao)}</b>` : '<span class="nota">—</span>'}</td>
        <td>${c.ativo === false ? '<span class="pill p-aberto">Inativo</span>' : c.tipoConfirmado === false ? `<button class="btn sm pri" data-acao="confirmarTipo" data-id="${c.id}">Confirmar tipo</button>` : '<span class="pill p-aprovada">Ativo</span>'}</td>
        <td class="r" style="white-space:nowrap"><button class="ico" data-acao="modal" data-tipo="cliente" data-id="${c.id}">Editar</button>
          <button class="ico" data-acao="modal" data-tipo="mesclar" data-id="${c.id}">Mesclar</button>
          <button class="ico" data-acao="ativoCliente" data-id="${c.id}">${c.ativo === false ? 'Reativar' : 'Inativar'}</button></td></tr>`).join('')}
      </tbody></table></div>` : '<div class="vazio">Carteira vazia.</div>'}
      <p class="nota">Mudar o tipo de um cliente altera o cálculo dos meses <b>abertos</b>. Meses fechados mantêm o valor fechado. Use <b>Mesclar</b> quando o mesmo cliente foi cadastrado com nomes diferentes. <b>Valor especial</b> (em Editar) substitui o valor de Tipo A/B só para aquele cliente, por exemplo um pacote fechado com outro preço; o cliente continua contando para os bônus.</p>
    </section>`;
}

// ============================================================ BIA: histórico de fechamentos
function vFechamentos() {
  const ano = S.mes.slice(0, 4);
  const cs = coaches();
  const tot = Object.fromEntries(cs.map((c) => [c.id, 0]));
  const rows = MESES.map((nome, i) => {
    const m = `${ano}-${pad(i + 1)}`;
    let soma = 0;
    const cels = cs.map((c) => {
      const f = fechamento(c.id, m);
      if (f?.status === 'fechado') { tot[c.id] += Math.round(f.total * 100); soma += Math.round(f.total * 100);
        return `<td class="r"><button class="link num" data-acao="irConf" data-coach="${c.id}" data-mes="${m}">${fmtUSD(f.total)}</button>${f.origem === 'planilha' ? '<div class="nota">planilha</div>' : ''}${f.aprovacao?.status === 'ok' ? '<div class="nota" style="color:var(--ok)">aprovado</div>' : f.aprovacao?.status === 'divergencia' ? '<div class="nota" style="color:var(--bad)">problema na aprovação</div>' : f.conferencia?.status === 'ok' ? '<div class="nota" style="color:var(--ok)">conferido</div>' : f.conferencia?.status === 'divergencia' ? '<div class="nota" style="color:var(--bad)">divergência</div>' : ''}</td>`; }
      if (m === S.mes && sessoesDe(c.id, m).length) return `<td class="r"><button class="link" data-acao="irConf" data-coach="${c.id}" data-mes="${m}">aberto</button></td>`;
      return '<td class="r nota">—</td>';
    }).join('');
    return `<tr><td>${nome}</td>${cels}<td class="r"><b>${soma ? fmtUSD(soma / 100) : ''}</b></td></tr>`;
  }).join('');
  const geral = Object.values(tot).reduce((a, b) => a + b, 0);
  return `<div class="cab"><div><h1>Fechamentos ${ano}</h1><p>Valores fechados por coach e mês. Clique num valor para abrir a conferência.</p></div>
    <div class="mes"><button data-acao="mes" data-d="-12" aria-label="Ano anterior">‹</button><span class="num">${ano}</span><button data-acao="mes" data-d="12" aria-label="Próximo ano">›</button></div></div>
    <section class="card"><div class="tabwrap"><table><thead><tr><th>Mês</th>${cs.map((c) => `<th class="r">${esc(c.nome)}</th>`).join('')}<th class="r">Total</th></tr></thead>
      <tbody>${rows}</tbody><tfoot><tr><td>Total ${ano}</td>${cs.map((c) => `<td class="r">${fmtUSD(tot[c.id] / 100)}</td>`).join('')}<td class="r">${fmtUSD(geral / 100)}</td></tr></tfoot></table></div></section>`;
}

// ============================================================ ADMIN: usuários
function vUsuarios() {
  const lista = [...S.usuarios].sort((a, b) => a.papel.localeCompare(b.papel) || a.nome.localeCompare(b.nome));
  return `<div class="cab"><div><h1>Usuários</h1><p>Quem acessa o sistema e os valores de cada coach.</p></div>
    <button class="btn pri" data-acao="modal" data-tipo="novoUsuario">Novo usuário</button></div>
    <section class="card"><div class="tabwrap"><table><thead><tr><th>Nome</th><th>E-mail</th><th>Perfil</th><th>Valores</th><th>Situação</th><th></th></tr></thead><tbody>
    ${lista.map((u) => { const cfg = cfgCoach(u); return `<tr><td><b>${esc(u.nome)}</b></td><td>${esc(u.email)}</td><td>${PAPEIS[u.papel] || u.papel}</td>
      <td class="num">${u.papel === 'coach' ? `A ${fmtUSD(cfg.valorA)} · B ${fmtUSD(cfg.valorB)}${cfg.limiteA ? ` · ${cfg.limiteA} primeiros = A` : ''}${cfg.extras.length ? ` · ${cfg.extras.length} extra(s)` : ''}` : '<span class="nota">—</span>'}</td>
      <td>${u.ativo === false ? '<span class="pill p-aberto">Desativado</span>' : '<span class="pill p-aprovada">Ativo</span>'}</td>
      <td class="r" style="white-space:nowrap">${u.papel === 'coach' && u.ativo !== false ? `<button class="ico" data-acao="verComo" data-id="${u.id}">Ver como coach</button>` : ''}<button class="ico" data-acao="modal" data-tipo="usuario" data-id="${u.id}">Editar</button></td></tr>`; }).join('')}
    </tbody></table></div></section>`;
}

// ============================================================ ADMIN: importar histórico
function vImportar() {
  const h = S.importacao;
  const cs = coaches();
  let corpo = `<form class="form" data-form="lerHistorico"><div class="campo largo"><label for="imp-arq">Arquivo historico.json</label><input id="imp-arq" type="file" accept=".json,application/json" required></div>
    <div><button class="btn pri" type="submit">Ler arquivo</button></div></form>
    <p class="nota">O arquivo é gerado a partir das planilhas antigas (pasta <b>dados-privados</b> do pacote). Ele contém nomes de clientes: não publique no GitHub.</p>`;
  if (h) {
    const porCoach = (k, arr) => arr.filter((x) => x.coach === k).length;
    corpo += `<hr style="border:0;border-top:1px solid var(--line);margin:16px 0">
      <form data-form="importar" style="display:grid;gap:14px">
      <table><thead><tr><th>Planilha</th><th class="r">Clientes</th><th class="r">Sessões</th><th class="r">Meses fechados</th><th>Importar para o coach</th></tr></thead><tbody>
      ${h.coaches.map((c) => `<tr><td><b>${esc(c.nome)}</b></td><td class="r">${porCoach(c.chave, h.clientes)}</td><td class="r">${porCoach(c.chave, h.sessoes)}</td><td class="r">${porCoach(c.chave, h.fechamentos)}</td>
        <td><select id="imp-${c.chave}" aria-label="Coach para ${esc(c.nome)}"><option value="">Não importar</option>
          ${cs.map((u) => `<option value="${u.id}" ${norm(u.nome).includes(norm(c.nome).split(' ')[0]) ? 'selected' : ''}>${esc(u.nome)}</option>`).join('')}</select></td></tr>`).join('')}
      </tbody></table>
      <label class="acoes"><input type="checkbox" id="imp-valores" checked> Atualizar os valores de cada coach com os da planilha (A, B, limite de Tipo A, bônus e serviços extras)</label>
      ${cs.length ? '' : '<div class="aviso atencao"><div>Cadastre os coaches em <b>Usuários</b> antes de importar.</div></div>'}
      <div class="acoes"><button class="btn pri" type="submit" ${cs.length ? '' : 'disabled'}>Importar</button><span class="dica">Pode repetir sem duplicar: os registros importados são sobrescritos. Meses já fechados no sistema são pulados.</span></div>
      </form>`;
  }
  return `<div class="cab"><div><h1>Importar histórico</h1><p>Traz a carteira, as sessões e os fechamentos de janeiro a agosto das planilhas antigas.</p></div></div><section class="card">${corpo}</section>`;
}

// ============================================================ valores do coach (formulário compartilhado)
function camposValores(cfg, legenda) {
  return `<fieldset style="border:1px solid var(--line);border-radius:8px;padding:12px;display:grid;gap:12px"><legend class="nota">${esc(legenda)}</legend>
      <div class="form">
        <div class="campo"><label for="eu-a">Sessão Tipo A ($)</label><input id="eu-a" type="number" step="0.01" min="0" value="${cfg.valorA}"></div>
        <div class="campo"><label for="eu-b">Sessão Tipo B ($)</label><input id="eu-b" type="number" step="0.01" min="0" value="${cfg.valorB}"></div>
        <div class="campo"><label for="eu-lim">Primeiros clientes Tipo A</label><input id="eu-lim" type="number" min="0" step="1" value="${cfg.limiteA}"></div>
        <div class="campo"><label for="eu-bat">Bônus cliente ativo ($)</label><input id="eu-bat" type="number" step="0.01" min="0" value="${cfg.bonusAtivo}"></div>
        <div class="campo"><label for="eu-brec">Bônus recorrência ($)</label><input id="eu-brec" type="number" step="0.01" min="0" value="${cfg.bonusRecorrencia}"></div>
        <div class="campo"><label for="eu-min">Sessões p/ recorrência</label><input id="eu-min" type="number" min="2" step="1" value="${cfg.minSessoesBonus}"></div>
        <div class="campo largo"><label for="eu-extras">Serviços extras (um por linha: nome | valor, ou nome | livre 70%)</label><textarea id="eu-extras" placeholder="Mapeamento de perfil | 210&#10;Perfil comportamental | livre 70%">${esc(cfg.extras.map((x) => `${x.nome} | ${x.livre ? `livre${percentualDe(x) < 100 ? ` ${percentualDe(x)}%` : ''}` : x.valor}`).join('\n'))}</textarea></div>
      </div><p class="nota" style="margin:0">"Primeiros clientes Tipo A" = 0 quando o tipo de cada cliente é marcado manualmente. "livre" = o coach digita o valor em cada lançamento. Mudanças valem para meses abertos; meses fechados guardam os valores da época.</p></fieldset>`;
}
function lerValores(u) {
  const num = (id) => Math.round(parseFloat(val(id) || '0') * 100) / 100;
  const antigos = cfgCoach(u).extras;
  const extras = val('eu-extras').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const [nome, v = ''] = l.split('|').map((x) => x.trim());
    const velho = antigos.find((x) => norm(x.nome) === norm(nome));
    const m = norm(v).match(/^livre(?:\s+(\d+(?:[.,]\d+)?)\s*%?)?$/);   // "livre" ou "livre 70%"
    const livre = !!m;
    const percentual = m && m[1] ? Math.min(100, parseFloat(m[1].replace(',', '.'))) : (livre ? 100 : undefined);
    return { id: velho?.id || slug(nome) || Math.random().toString(36).slice(2, 8), nome, livre,
      ...(livre ? { percentual } : {}),
      valor: livre ? 0 : Math.round(parseFloat(v.replace(',', '.')) * 100) / 100 };
  });
  if (extras.some((x) => !x.nome || !(x.valor >= 0))) { toast('Serviços extras: uma linha por serviço, no formato "Nome | valor" ou "Nome | livre".', true); return null; }
  return { valorA: num('eu-a'), valorB: num('eu-b'), limiteA: parseInt(val('eu-lim') || '0', 10), bonusAtivo: num('eu-bat'),
    bonusRecorrencia: num('eu-brec'), minSessoesBonus: Math.max(2, parseInt(val('eu-min') || '2', 10)), extras };
}

// ============================================================ CONTRATOS
const editaContratos = () => isAdmin() || isFin();
function vContratos() {
  const cs = coaches();
  const filtro = S.ctCoach || '';
  const busca = norm(S.ctBusca || '');
  const lista = S.contratos.filter((c) => (!filtro || c.coachId === filtro) && (!busca || norm(`${c.numero} ${c.nome} ${nomeCliente(c.clienteId)}`).includes(busca)))
    .sort((a, b) => (a.status === 'ativo' ? 0 : 1) - (b.status === 'ativo' ? 0 : 1) || String(a.numero).localeCompare(String(b.numero), 'pt', { numeric: true }));
  const nAtivos = S.contratos.filter((c) => c.status === 'ativo').length;
  const nAcabando = S.contratos.filter((c) => c.status === 'ativo' && restantesDe(c) <= 2 && restantesDe(c) > 0).length;
  const nCompletos = S.contratos.filter((c) => c.status === 'ativo' && restantesDe(c) <= 0).length;
  const linhas = lista.map((c) => {
    const usadas = usadasDe(c.id), tot = Number(c.sessoesContratadas), pct = Math.min(100, Math.round(usadas / tot * 100));
    const cor = usadas > tot ? 'var(--bad)' : usadas >= tot ? 'var(--pend)' : 'var(--accent)';
    return `<tr><td class="num" style="white-space:nowrap"><b>${esc(c.numero)}</b></td><td>${esc(c.nome || '')}${servicoCt(c) !== 'sessao' ? `<div class="nota">Serviço: ${esc(nomeServico(cfgCoach(usuario(c.coachId)), servicoCt(c)))}</div>` : ''}${c.obs ? `<div class="nota">${esc(c.obs)}</div>` : ''}</td>
      <td>${esc(nomeCliente(c.clienteId) || c.clienteNome || '')}</td><td>${esc(usuario(c.coachId)?.nome || '')}</td>
      <td class="num" style="min-width:130px">${usadas} de ${tot}${Number(c.sessoesAnteriores) ? `<div class="nota">${c.sessoesAnteriores} antes do sistema</div>` : ''}
        <div style="height:5px;border-radius:3px;background:var(--line);margin-top:4px"><div style="height:5px;border-radius:3px;width:${pct}%;background:${cor}"></div></div></td>
      <td class="r">${fmtUSD(c.valorSessao)}${Number(c.valorContrato) > 0 ? `<div class="nota num">${fmtUSD(c.valorContrato)} × ${String(c.percentualCoach).replace('.', ',')}% ÷ ${tot}</div>` : ''}${c.valorUltimaSessao != null && Math.round(c.valorUltimaSessao * 100) !== Math.round(c.valorSessao * 100) ? `<div class="nota num">última: ${fmtUSD(c.valorUltimaSessao)}</div>` : ''}</td><td>${c.dataInicio ? fmtDiaAno(c.dataInicio) : '<span class="nota">—</span>'}</td>
      <td>${c.status !== 'ativo' ? '<span class="pill p-aberto">Encerrado</span>' : usadas >= tot ? '<span class="pill p-pendente">Completo</span>' : '<span class="pill p-aprovada">Ativo</span>'}</td>
      <td class="r" style="white-space:nowrap">${editaContratos() ? `<button class="ico" data-acao="modal" data-tipo="contrato" data-id="${c.id}">Editar</button>
        <button class="ico" data-acao="statusContrato" data-id="${c.id}">${c.status === 'ativo' ? 'Encerrar' : 'Reativar'}</button>` : ''}
        ${isAdmin() && !S.sessoes.some((x) => x.contratoId === c.id) ? `<button class="ico bad" data-acao="modal" data-tipo="excluirContrato" data-id="${c.id}">Excluir</button>` : ''}</td></tr>`;
  }).join('');
  return `<div class="cab"><div><h1>Contratos</h1><p>Cada contrato define o cliente, o coach, o serviço, quantas sessões foram contratadas e quanto o coach recebe por sessão (valor do contrato × % do coach ÷ sessões). O sistema numera as sessões e bloqueia o lançamento quando o contrato acaba.</p></div>
      ${editaContratos() ? '<button class="btn pri" data-acao="modal" data-tipo="contrato">Novo contrato</button>' : ''}</div>
    <div class="kpis"><div class="kpi"><small>Contratos ativos</small><strong>${nAtivos}</strong></div>
      <div class="kpi ${nAcabando ? 'alerta' : ''}"><small>Com 2 ou menos sessões restantes</small><strong>${nAcabando}</strong></div>
      <div class="kpi ${nCompletos ? 'alerta' : ''}"><small>Completos (ainda ativos)</small><strong>${nCompletos}</strong></div></div>
    ${isAdmin() ? `<section class="card"><label class="acoes"><input type="checkbox" id="cfg-exigir" data-change="exigirContrato" ${exigeContrato() ? 'checked' : ''}>
      <span><b>Exigir contrato para lançar sessões.</b> <span class="nota">Ligado: o coach só lança "Sessão" para clientes com contrato ativo. Desligado: cliente sem contrato continua pela tabela (Tipo A/B). Deixe desligado até cadastrar os contratos dos clientes atuais.</span></span></label></section>` : ''}
    <section class="card"><div class="acoes" style="margin-bottom:12px;align-items:end">
        <div class="campo" style="min-width:200px"><label for="ct-filtro">Coach</label><select id="ct-filtro" data-change="ctFiltro"><option value="">Todos</option>${cs.map((c) => `<option value="${c.id}" ${c.id === filtro ? 'selected' : ''}>${esc(c.nome)}</option>`).join('')}</select></div>
        <div class="campo" style="min-width:220px"><label for="ct-busca">Buscar</label><input id="ct-busca" data-input="ctBusca" placeholder="Nº, nome ou cliente" value="${esc(S.ctBusca || '')}"></div></div>
      ${lista.length ? `<div class="tabwrap"><table><thead><tr><th>Nº</th><th>Contrato</th><th>Cliente</th><th>Coach</th><th>Sessões</th><th class="r">Valor/sessão</th><th>Início</th><th>Situação</th><th></th></tr></thead><tbody>${linhas}</tbody></table></div>`
        : `<div class="vazio">${S.contratos.length ? 'Nenhum contrato com esse filtro.' : `Nenhum contrato cadastrado ainda.${editaContratos() ? ' Clique em <b>Novo contrato</b> para começar.' : ''}`}</div>`}
    </section>`;
}

// ============================================================ FINANCEIRO: tabela de valores e conferência
// etapas depois do fechamento da Bia: conferência (financeiro) → aprovação final (Ricardo)
const pillConf = (f) => (!f || f.status !== 'fechado') ? '<span class="pill p-aberto">Aguardando fechamento</span>'
  : f.origem === 'planilha' && !f.conferencia ? '<span class="pill p-fechado">Histórico (planilha)</span>'
  : f.aprovacao?.status === 'ok' ? '<span class="pill p-aprovada">Pagamento aprovado</span>'
  : f.aprovacao?.status === 'divergencia' ? '<span class="pill p-recusada">Problema na aprovação</span>'
  : f.conferencia?.status === 'ok' ? '<span class="pill p-fechado">Conferido · aguardando aprovação</span>'
  : f.conferencia?.status === 'divergencia' ? '<span class="pill p-recusada">Divergência</span>'
  : '<span class="pill p-pendente">A conferir</span>';
const avisoEtapa = (rotulo, x) => `<div class="aviso ${x.status === 'ok' ? 'fechado' : 'erro'}" style="margin-bottom:10px"><div><b>${rotulo}${x.status === 'ok' ? '' : ': problema apontado'}</b> por ${esc(x.porNome)} em ${fmtDataHora(x.em)}${x.comentario ? `<br>${esc(x.comentario)}` : ''}</div></div>`;

function vTabela() {
  const cs = coaches().filter((c) => c.ativo !== false);
  const extrasTxt = (cfg) => cfg.extras.length ? cfg.extras.map((x) => `${esc(x.nome)}: ${x.livre ? `<i>valor livre</i>${percentualDe(x) < 100 ? ` · <b>${percentualDe(x)}%</b> do cobrado` : ''}` : fmtUSD(x.valor)}`).join('<br>') : '<span class="nota">—</span>';
  return `<div class="cab"><div><h1>Tabela de valores</h1><p>Referência do que cada coach recebe. É esta tabela que o sistema usa para calcular os meses abertos.</p></div></div>
    <section class="card">${cs.length ? `<div class="tabwrap"><table><thead><tr><th>Coach</th><th class="r">Sessão Tipo A</th><th class="r">Sessão Tipo B</th><th>Regra de tipo</th><th class="r">Bônus cliente ativo</th><th class="r">Bônus recorrência</th><th>Serviços extras</th><th>Última alteração</th><th></th></tr></thead><tbody>
    ${cs.map((u) => { const cfg = cfgCoach(u); return `<tr><td><b>${esc(u.nome)}</b></td>
      <td class="r">${fmtUSD(cfg.valorA)}</td><td class="r">${fmtUSD(cfg.valorB)}</td>
      <td>${cfg.limiteA ? `${cfg.limiteA} primeiros clientes = A, demais = B` : 'Marcado cliente a cliente'}</td>
      <td class="r">${fmtUSD(cfg.bonusAtivo)}</td><td class="r">${fmtUSD(cfg.bonusRecorrencia)}<div class="nota">a partir de ${cfg.minSessoesBonus} sessões</div></td>
      <td>${extrasTxt(cfg)}${clientesDe(u.id).filter((c) => Number(c.valorSessao) > 0 && c.ativo !== false).map((c) => `<div class="nota">${esc(c.nome)}: ${fmtUSD(c.valorSessao)}/sessão (valor especial)</div>`).join('')}</td>
      <td class="nota">${u.valoresAlteradosEm ? `${fmtDataHora(u.valoresAlteradosEm)}${u.valoresAlteradosPorNome ? '<br>' + esc(u.valoresAlteradosPorNome) : ''}` : '—'}</td>
      <td class="r">${editaValores() ? `<button class="ico" data-acao="modal" data-tipo="valores" data-id="${u.id}">Editar</button>` : ''}</td></tr>`; }).join('')}
    </tbody></table></div>` : '<div class="vazio">Nenhum coach cadastrado.</div>'}
    <p class="nota">Bônus de cliente ativo: cada cliente distinto com pelo menos 1 sessão no mês. Bônus de recorrência: cada cliente com o número mínimo de sessões no mês. Serviços extras não contam para os bônus.</p></section>`;
}

// compara cada linha fechada com a tabela atual
function refTabela(cfg, l) {
  if (l.chave === 'A') return cfg.valorA;
  if (l.chave === 'B') return cfg.valorB;
  if (l.chave === 'bonusRec') return cfg.bonusRecorrencia;
  if (l.chave === 'bonusAtivo') return cfg.bonusAtivo;
  if (l.chave?.startsWith('ct:')) { const c = contrato(l.chave.slice(3)); return c ? Number(c.valorSessao) : undefined; }
  if (l.chave?.startsWith('ctu:')) { const c = contrato(l.chave.slice(4)); return c ? Number(c.valorUltimaSessao ?? c.valorSessao) : undefined; }
  if (l.chave?.startsWith('cli:')) { const c = S.clientes.find((x) => x.id === l.chave.slice(4)); return Number(c?.valorSessao) > 0 ? Number(c.valorSessao) : undefined; }
  if (l.chave?.startsWith('extra:')) { const x = cfg.extras.find((e) => 'extra:' + e.id === l.chave); return x ? (x.livre ? (percentualDe(x) < 100 ? `livre ${percentualDe(x)}%` : 'livre') : x.valor) : undefined; }
  return undefined;
}

function vValores(modo = 'conferencia') {
  const aprov = modo === 'aprovacao';
  const cs = coaches().filter((c) => c.ativo !== false || fechamento(c.id, S.mes));
  if (!S.coachSel || !cs.some((c) => c.id === S.coachSel)) S.coachSel = cs[0]?.id || null;
  const linhasTab = cs.map((c) => {
    const f = fechamento(c.id, S.mes);
    const valor = f?.status === 'fechado' ? fmtUSD(f.total) : `<span class="nota">${fmtUSD(resumo(c.id, S.mes).total)} (parcial)</span>`;
    return `<tr ${c.id === S.coachSel ? 'style="background:var(--accent-soft)"' : ''}><td><b>${esc(c.nome)}</b></td><td>${pillMes(c.id, S.mes)}</td><td class="r">${valor}</td><td>${pillConf(f)}</td>
      <td class="r"><button class="btn sm ${f?.status === 'fechado' && (aprov ? f.conferencia?.status === 'ok' && !f.aprovacao : !f.conferencia) ? 'pri' : ''}" data-acao="verValores" data-coach="${c.id}">Ver detalhes</button></td></tr>`;
  }).join('');
  // fila: meses fechados pela Bia (no sistema) que ainda não foram conferidos, em qualquer mês
  const fila = S.fechamentos.filter((f) => f.status === 'fechado' && f.origem !== 'planilha'
      && (aprov ? f.conferencia?.status === 'ok' && !f.aprovacao : !f.conferencia))
    .sort((a, b) => a.mes.localeCompare(b.mes) || (usuario(a.coachId)?.nome || '').localeCompare(usuario(b.coachId)?.nome || ''));
  const divs = S.fechamentos.filter((f) => f.status === 'fechado' && (aprov ? f.aprovacao?.status === 'divergencia' : f.conferencia?.status === 'divergencia'));
  const nHist = S.fechamentos.filter((f) => f.origem === 'planilha').length;
  const filaHTML = `<section class="card"><div class="cab"><h2>${aprov ? 'Aguardando sua aprovação' : 'Aguardando sua conferência'}</h2><span class="nota">${fila.length} mês(es)</span></div>
    ${fila.length ? `<div class="tabwrap"><table><thead><tr><th>Coach</th><th>Mês</th><th class="r">Valor fechado</th><th>${aprov ? 'Conferido em' : 'Fechado em'}</th><th></th></tr></thead><tbody>
      ${fila.map((f) => `<tr><td><b>${esc(usuario(f.coachId)?.nome || '—')}</b></td><td>${mesLabel(f.mes)}</td><td class="r">${fmtUSD(f.total)}</td>
        <td>${aprov ? `${fmtDataHora(f.conferencia.em)} · ${esc(f.conferencia.porNome || '')}` : `${fmtDataHora(f.fechadoEm)}${f.fechadoPorNome ? ' · ' + esc(f.fechadoPorNome) : ''}`}</td>
        <td class="r"><button class="btn sm pri" data-acao="irValores" data-coach="${f.coachId}" data-mes="${f.mes}">${aprov ? 'Revisar e aprovar' : 'Conferir'}</button></td></tr>`).join('')}</tbody></table></div>`
      : `<div class="vazio" style="padding:14px">${aprov ? 'Nenhum mês aguardando aprovação. Os meses aparecem aqui assim que o financeiro marca os valores como conferidos.' : 'Nenhum mês aguardando conferência. Os meses aparecem aqui assim que a Bia fecha.'}</div>`}
    ${divs.length ? `<p class="nota">${divs.length} mês(es) com ${aprov ? 'problema apontado na aprovação' : 'divergência apontada'}, aguardando correção: ${divs.map((f) => `<button class="link" data-acao="irValores" data-coach="${f.coachId}" data-mes="${f.mes}">${esc(usuario(f.coachId)?.nome || '')} · ${mesLabel(f.mes)}</button>`).join(', ')}.</p>` : ''}
    ${nHist ? `<p class="nota">O histórico importado das planilhas (${nHist} meses fechados) está na aba <button class="link" data-acao="ir" data-view="fechamentos">Fechamentos</button> ou navegando pelos meses com as setas.</p>` : ''}
  </section>`;
  const fechs = cs.map((c) => fechamento(c.id, S.mes)).filter((f) => f?.status === 'fechado');
  const totGeral = Math.round(fechs.reduce((a, f) => a + Math.round(Number(f.total || 0) * 100), 0)) / 100;
  const totParcial = Math.round(cs.filter((c) => fechamento(c.id, S.mes)?.status !== 'fechado').reduce((a, c) => a + Math.round(resumo(c.id, S.mes).total * 100), 0)) / 100;
  const prontos = fechs.filter((f) => f.origem !== 'planilha' && f.conferencia?.status === 'ok' && !f.aprovacao);
  const rodape = `<tfoot><tr><td>Total do mês (fechados: ${fechs.length} de ${cs.length})</td><td></td><td class="r">${fmtUSD(totGeral)}${totParcial ? `<div class="nota">+ ${fmtUSD(totParcial)} parcial em meses abertos</div>` : ''}</td><td></td><td class="r">${aprov && prontos.length ? `<button class="btn sm pri" data-acao="modal" data-tipo="aprovarTodos">${prontos.length > 1 ? `Aprovar os ${prontos.length} conferidos` : "Aprovar o conferido"}</button>` : ''}</td></tr></tfoot>`;
  const titulo = aprov
    ? '<h1>Aprovação final</h1><p>Veja o total de cada coach já conferido pelo financeiro e dê a aprovação final. Você pode abrir os detalhes de um coach ou aprovar todos os conferidos de uma vez.</p>'
    : '<h1>Conferência de valores</h1><p>Confira o valor de cada coach depois que a Bia fechar o mês. Durante o mês, os valores aparecem como parciais (só sessões já aprovadas).</p>';
  return `<div class="cab"><div>${titulo}</div>${seletorMes()}</div>
    ${filaHTML}
    <section class="card"><div class="cab"><h2>Coaches em ${mesLabel(S.mes)}</h2></div>${cs.length ? `<div class="tabwrap"><table><thead><tr><th>Coach</th><th>Mês</th><th class="r">Valor</th><th>Situação</th><th></th></tr></thead><tbody>${linhasTab}</tbody>${rodape}</table></div>` : '<div class="vazio">Nenhum coach cadastrado.</div>'}</section>
    ${S.coachSel ? detalheValores(S.coachSel) : ''}`;
}

function detalheValores(coachId) {
  const u = usuario(coachId);
  const cfg = cfgCoach(u);
  const f = fechamento(coachId, S.mes);
  const fech = f?.status === 'fechado';
  const linhas = fech ? (f.linhas || []) : resumo(coachId, S.mes).linhas;
  const ajustes = f?.ajustes || [];
  const recalc = resumo(coachId, S.mes);          // sessões aprovadas x tabela atual
  const cfgEpoca = fech && f.config ? { ...cfg, ...f.config } : null;
  const mapa = mapaClientes(coachId);
  const livres = sessoesDe(coachId).filter((s) => s.status === 'aprovada' && !s.contratoId && extraLivre(cfg, s.servico));
  let divergencias = 0;
  const rows = linhas.map((l) => {
    const ref = refTabela(cfg, l);
    const usado = l.valorUnit;
    const bate = ref === undefined || typeof ref === 'string' || usado == null ? null : Math.round(ref * 100) === Math.round(usado * 100);
    if (bate === false) divergencias++;
    return `<tr><td>${esc(l.descricao)}</td><td class="r">${l.quantidade}</td>
      <td class="r">${usado == null ? '<span class="nota">variável</span>' : fmtUSD(usado)}</td>
      <td class="r">${ref === undefined ? '<span class="nota">—</span>' : typeof ref === 'string' ? `<span class="nota">${esc(ref)}</span>` : fmtUSD(ref)}</td>
      <td class="r"><b>${fmtUSD(l.total)}</b></td>
      <td>${bate === null ? '' : bate ? '<span class="pill p-aprovada">Confere</span>' : '<span class="pill p-recusada">Diferente</span>'}</td></tr>`;
  }).join('');
  const diffTotal = fech ? Math.round((f.total - recalc.total) * 100) / 100 : 0;
  const conf = f?.conferencia;
  return `<div class="grid2">
    <section class="card"><div class="cab"><h2>${esc(u.nome)} · ${mesLabel(S.mes)}</h2>${pillConf(f)}</div>
      ${!fech ? '<div class="aviso atencao" style="margin-bottom:12px"><div>A Bia ainda não fechou este mês. Os valores abaixo são parciais (só sessões aprovadas até agora).</div></div>' : ''}
      ${f?.origem === 'planilha' ? '<div class="aviso fechado" style="margin-bottom:12px"><div>Mês importado da planilha antiga: as linhas não têm vínculo automático com a tabela.</div></div>' : ''}
      <div class="tabwrap"><table><thead><tr><th>Item</th><th class="r">Qtd</th><th class="r">Valor usado</th><th class="r">Tabela atual</th><th class="r">Total</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6" class="vazio">Sem valores neste mês.</td></tr>'}
      ${ajustes.map((a) => `<tr><td>Ajuste: ${esc(a.descricao)}<div class="nota">${esc(a.por || '')}</div></td><td></td><td></td><td></td><td class="r"><b>${fmtUSD(a.valor)}</b></td><td></td></tr>`).join('')}</tbody>
      <tfoot><tr><td>Total ${fech ? 'fechado' : 'parcial'}</td><td></td><td></td><td></td><td class="r">${fmtUSD(fech ? f.total : recalc.total)}</td><td></td></tr></tfoot></table></div>
      ${fech && f.origem !== 'planilha' ? `<p class="nota">Recalculando as sessões aprovadas com a tabela atual: <b class="num">${fmtUSD(recalc.total)}</b>${diffTotal ? ` (diferença de <b class="num">${fmtUSD(diffTotal)}</b> em relação ao fechado)` : ' (igual ao fechado)'}.${divergencias ? ` ${divergencias} valor(es) unitário(s) diferente(s) da tabela atual.` : ''}</p>` : ''}
      ${cfgEpoca && f.config ? `<p class="nota">Regra usada no fechamento: A ${fmtUSD(cfgEpoca.valorA)} · B ${fmtUSD(cfgEpoca.valorB)} · bônus ${fmtUSD(cfgEpoca.bonusAtivo)} / ${fmtUSD(cfgEpoca.bonusRecorrencia)}.</p>` : ''}
    </section>
    <section class="card"><h2>Conferência e aprovação</h2>
      ${fech && f.fechadoPorNome ? `<p class="nota" style="margin:0 0 8px">Fechado por ${esc(f.fechadoPorNome)}${f.fechadoEm ? ' em ' + fmtDataHora(f.fechadoEm) : ''}.</p>` : ''}
      ${conf ? avisoEtapa('Valores conferidos', conf) : fech && f.origem !== 'planilha' ? '<p class="nota">Aguardando a conferência do financeiro.</p>' : ''}
      ${f?.aprovacao ? avisoEtapa('Aprovação final', f.aprovacao) : conf?.status === 'ok' ? '<p class="nota">Aguardando a aprovação final.</p>' : ''}
      ${livres.length ? `<h3 style="margin:4px 0 6px">Serviços com valor livre</h3><table class="resumo"><tbody>${livres.map((s) => { const ex = extraDe(cfg, s.servico); const v = Number(s.valorInformado); const pct = percentualDe(ex);
        return `<tr><td>${fmtDia(s.data)} · ${esc(mapa.get(s.clienteId)?.nome || s.clienteNome)}<div class="nota num">${esc(nomeServico(cfg, s.servico))}${s.quantidade > 1 ? ` · ${s.quantidade}×` : ''}${v > 0 && pct < 100 ? ` · cobrado ${fmtUSD(v * s.quantidade)}, ${pct}% ao coach` : ''}</div></td>
        <td class="r">${v > 0 ? fmtUSD(Math.round(valorPagoUnit(ex, v) * 100) * s.quantidade / 100) : '<span style="color:var(--bad)">sem valor</span>'}</td></tr>`; }).join('')}</tbody></table>` : ''}
      ${fech && (isFin() || (isAdmin() && S.view === 'valores')) && !f.aprovacao ? `<div class="acoes" style="margin-top:14px"><button class="btn pri" data-acao="conferirValores" data-coach="${coachId}">Valores conferidos</button>
        <button class="btn bad" data-acao="modal" data-tipo="divergencia" data-id="${coachId}">Apontar divergência</button></div>` : ''}
      ${fech && (isAprov() || (isAdmin() && S.view === 'aprovacao')) && conf?.status === 'ok' && !f.aprovacao ? `<div class="acoes" style="margin-top:14px"><button class="btn pri" data-acao="modal" data-tipo="aprovar" data-id="${coachId}">Aprovar pagamento</button>
        <button class="btn bad" data-acao="modal" data-tipo="problemaAprov" data-id="${coachId}">Apontar problema</button></div>` : ''}
      ${fech && isFin() && f.aprovacao ? '<p class="nota">Este mês já tem aprovação final. Para mudar a conferência, o administrador precisa reabrir o mês.</p>' : ''}
      ${fech ? `<div class="acoes" style="margin-top:10px"><button class="btn" data-acao="pdf" data-coach="${coachId}">Recibo em PDF</button>
        <button class="btn" data-acao="csv" data-coach="${coachId}">Exportar CSV (Excel)</button></div>` : ''}
      <p class="nota">Tabela atual: ${regraTexto(cfg)}</p>
    </section></div>`;
}

// ============================================================ modais
function modal() {
  const m = S.modal;
  let corpo = '';
  if (m.tipo === 'recusar') {
    const s = S.sessoes.find((x) => x.id === m.id);
    corpo = `<form data-form="recusar" style="display:grid;gap:14px"><h2>Recusar lançamento</h2>
      <p>${esc(s?.clienteNome)} · ${fmtDiaAno(s?.data)}. O coach verá o motivo e poderá corrigir e reenviar.</p>
      <div class="campo"><label for="rc-motivo">Motivo</label><textarea id="rc-motivo" required maxlength="500" placeholder="Ex.: não encontrei esta sessão na agenda"></textarea></div>
      <div class="acoes"><button class="btn pri" type="submit">Recusar</button><button class="btn" type="button" data-acao="fecharModal">Cancelar</button></div></form>`;
  } else if (m.tipo === 'excluir') {
    corpo = `<h2>Excluir lançamento?</h2><p>Esta sessão será apagada. Não dá para desfazer.</p>
      <div class="acoes"><button class="btn pri" data-acao="confirmarExcluir">Excluir</button><button class="btn" data-acao="fecharModal">Cancelar</button></div>`;
  } else if (m.tipo === 'fechar') {
    const coachId = S.coachSel;
    const todas = sessoesDe(coachId);
    const pend = todas.filter((s) => s.status === 'pendente').length;
    const rec = todas.filter((s) => s.status === 'recusada').length;
    const r = resumo(coachId, S.mes);
    corpo = `<h2>Fechar ${mesLabel(S.mes)} de ${esc(usuario(coachId)?.nome)}</h2>
      ${pend ? `<div class="aviso erro"><div>Ainda há <b>${pend}</b> lançamento(s) pendente(s). Aprove ou recuse todos antes de fechar.</div></div>` : ''}
      ${rec ? `<div class="aviso atencao"><div><b>${rec}</b> lançamento(s) recusado(s) ficarão fora do pagamento.</div></div>` : ''}
      <p>Valor que será fechado: <b class="num">${fmtUSD(r.total)}</b> (${r.sessoes} sessões, ${r.ativos} clientes ativos). Depois de fechado, ninguém consegue alterar os lançamentos deste mês${isAdmin() ? '' : ' (só o administrador pode reabrir)'}.</p>
      <div class="acoes"><button class="btn pri" data-acao="confirmarFechar" ${pend ? 'disabled' : ''}>Fechar mês</button><button class="btn" data-acao="fecharModal">Cancelar</button></div>`;
  } else if (m.tipo === 'reabrir') {
    corpo = `<h2>Reabrir ${mesLabel(S.mes)}?</h2><p>Os lançamentos voltam a poder ser alterados e o valor passa a ser recalculado com as regras atuais. O valor fechado anteriormente (${fmtUSD(fechamento(S.coachSel, S.mes)?.total)}) fica registrado no histórico do documento.</p>
      <div class="acoes"><button class="btn pri" data-acao="confirmarReabrir">Reabrir</button><button class="btn" data-acao="fecharModal">Cancelar</button></div>`;
  } else if (m.tipo === 'editarBia') {
    const s = S.sessoes.find((x) => x.id === m.id);
    const cfg = cfgCoach(usuario(s.coachId));
    corpo = `<form data-form="editarBia" style="display:grid;gap:14px"><h2>Corrigir lançamento</h2>
      <div class="form">
        <div class="campo"><label for="eb-data">Data</label><input id="eb-data" type="date" required value="${s.data}"></div>
        <div class="campo"><label for="eb-cliente">Cliente</label><select id="eb-cliente" data-change="clienteBia">${clientesDe(s.coachId).map((c) => `<option value="${c.id}" ${c.id === s.clienteId ? 'selected' : ''}>${esc(c.nome)}</option>`).join('')}</select></div>
        <div class="campo"><label for="eb-servico">Serviço</label><select id="eb-servico" data-change="servicoBia"><option value="sessao">Sessão</option>${cfg.extras.map((x) => `<option value="${x.id}" ${(m.servico ?? s.servico) === x.id ? 'selected' : ''}>${esc(x.nome)}</option>`).join('')}</select></div>
        <div class="campo" ${extraLivre(cfg, m.servico ?? s.servico) ? '' : 'hidden'}><label for="eb-valor">Valor cobrado ($)</label><input id="eb-valor" type="number" min="0.01" step="0.01" value="${s.valorInformado ?? ''}">
          <div class="dica num" id="eb-calc">${esc(textoCalculo(extraDe(cfg, m.servico ?? s.servico), s.valorInformado, s.quantidade))}</div></div>
        <div class="campo"><label for="eb-qtd">Quantidade</label><input id="eb-qtd" type="number" min="1" max="20" required value="${s.quantidade}"></div>
        ${(() => {
          const cliId = m.cliente ?? s.clienteId;
          const sv = m.servico ?? s.servico ?? 'sessao';
          const cts = contratosDoCliente(cliId, sv).filter((c) => c.status === 'ativo' || c.id === s.contratoId);
          if (!cts.length) return sv === 'sessao' ? `<div class="campo largo"><p class="nota" style="margin:0">Cliente sem contrato: o valor segue a tabela (Tipo A/B).</p></div>` : '';
          const sel = m.contrato || (cliId === s.clienteId && s.contratoId && cts.some((c) => c.id === s.contratoId) ? s.contratoId : contratoSugerido(cliId, s.id, sv)?.id || cts[0].id);
          return `<div class="campo largo"><label for="eb-contrato">Contrato</label><select id="eb-contrato" data-change="contratoBia">${cts.map((c) => `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>Nº ${esc(c.numero)}${c.nome ? ' · ' + esc(c.nome) : ''} — restam ${Math.max(0, restantesDe(c, s.id))} de ${c.sessoesContratadas}</option>`).join('')}</select></div>`;
        })()}
      </div>
      <label class="acoes"><input type="checkbox" id="eb-aprovar" checked> Aprovar após salvar</label>
      <div class="acoes"><button class="btn pri" type="submit">Salvar</button><button class="btn" type="button" data-acao="fecharModal">Cancelar</button></div></form>`;
  } else if (m.tipo === 'cliente') {
    const c = S.clientes.find((x) => x.id === m.id);
    corpo = `<form data-form="editarCliente" style="display:grid;gap:14px"><h2>Editar cliente</h2>
      <div class="form"><div class="campo largo"><label for="ec-nome">Nome</label><input id="ec-nome" required value="${esc(c.nome)}"></div>
      <div class="campo"><label for="ec-ordem">Nº na carteira</label><input id="ec-ordem" type="number" min="1" value="${c.ordem || ''}"></div>
      <div class="campo"><label for="ec-valor">Valor especial por sessão ($)</label><input id="ec-valor" type="number" min="0" step="0.01" placeholder="vazio = usa Tipo ${esc(c.tipo || 'A')}" value="${Number(c.valorSessao) > 0 ? c.valorSessao : ''}"></div></div>
      <p class="nota">O nº na carteira define a ordem usada pela regra "N primeiros clientes são Tipo A". Valor especial: preencha só quando este cliente tem um preço próprio (ex.: pacote de $2.718,50 × 70% ÷ 10 sessões = $190,30). Vale para meses abertos.</p>
      <div class="acoes"><button class="btn pri" type="submit">Salvar</button><button class="btn" type="button" data-acao="fecharModal">Cancelar</button></div></form>`;
  } else if (m.tipo === 'mesclar') {
    const c = S.clientes.find((x) => x.id === m.id);
    const outros = clientesDe(c.coachId).filter((x) => x.id !== c.id && x.ativo !== false);
    corpo = `<form data-form="mesclar" style="display:grid;gap:14px"><h2>Mesclar "${esc(c.nome)}"</h2>
      <p>Use quando o mesmo cliente foi cadastrado duas vezes. Os lançamentos de meses abertos passam para o cadastro escolhido e "${esc(c.nome)}" fica inativo. Meses fechados não mudam.</p>
      <div class="campo"><label for="mg-destino">Manter o cadastro</label><select id="mg-destino" required><option value="">Selecione…</option>${outros.map((x) => `<option value="${x.id}">${esc(x.nome)} (Tipo ${x.tipo})</option>`).join('')}</select></div>
      <div class="acoes"><button class="btn pri" type="submit">Mesclar</button><button class="btn" type="button" data-acao="fecharModal">Cancelar</button></div></form>`;
  } else if (m.tipo === 'novoUsuario') {
    corpo = `<form data-form="novoUsuario" style="display:grid;gap:14px"><h2>Novo usuário</h2>
      <div class="form">
        <div class="campo largo"><label for="nu-nome">Nome</label><input id="nu-nome" required></div>
        <div class="campo largo"><label for="nu-email">E-mail</label><input id="nu-email" type="email" required></div>
        <div class="campo"><label for="nu-senha">Senha provisória</label><input id="nu-senha" required minlength="6" value="${Math.random().toString(36).slice(2, 10)}"></div>
        <div class="campo"><label for="nu-papel">Perfil</label><select id="nu-papel"><option value="coach">Coach</option><option value="revisora">Revisora (Bia)</option><option value="financeiro">Financeiro (Alexandre)</option><option value="aprovador">Aprovação final (Ricardo)</option><option value="admin">Administrador</option></select></div>
      </div>
      <p class="nota">Anote a senha provisória e envie para a pessoa. Ela pode trocar depois em "Senha", no topo. Os valores do coach começam com o padrão ($${CONFIG_PADRAO.valorA} / $${CONFIG_PADRAO.valorB}) e podem ser ajustados em Editar.</p>
      <div class="acoes"><button class="btn pri" type="submit">Criar usuário</button><button class="btn" type="button" data-acao="fecharModal">Cancelar</button></div></form>`;
  } else if (m.tipo === 'usuario') {
    const u = S.usuarios.find((x) => x.id === m.id);
    const cfg = cfgCoach(u);
    corpo = `<form data-form="editarUsuario" style="display:grid;gap:14px"><h2>${esc(u.nome)}</h2>
      <div class="form">
        <div class="campo largo"><label for="eu-nome">Nome</label><input id="eu-nome" required value="${esc(u.nome)}"></div>
        <div class="campo"><label for="eu-papel">Perfil</label><select id="eu-papel" ${u.id === uid() ? 'disabled' : ''}>${Object.entries(PAPEIS).map(([k, t]) => `<option value="${k}" ${u.papel === k ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
        <div class="campo"><label for="eu-ativo">Situação</label><select id="eu-ativo" ${u.id === uid() ? 'disabled' : ''}><option value="1" ${u.ativo !== false ? 'selected' : ''}>Ativo</option><option value="0" ${u.ativo === false ? 'selected' : ''}>Desativado</option></select></div>
      </div>
      ${camposValores(cfg, 'Valores (usados quando o perfil é Coach)')}
      <div class="acoes"><button class="btn pri" type="submit">Salvar</button><button class="btn" type="button" data-acao="resetSenha" data-email="${esc(u.email)}">Enviar e-mail de nova senha</button><button class="btn" type="button" data-acao="fecharModal">Cancelar</button></div></form>`;
  } else if (m.tipo === 'valores') {
    const u = S.usuarios.find((x) => x.id === m.id);
    corpo = `<form data-form="salvarValores" style="display:grid;gap:14px"><h2>Valores de ${esc(u.nome)}</h2>
      ${camposValores(cfgCoach(u), 'Tabela do coach')}
      <div class="acoes"><button class="btn pri" type="submit">Salvar valores</button><button class="btn" type="button" data-acao="fecharModal">Cancelar</button></div></form>`;
  } else if (m.tipo === 'divergencia') {
    const u = usuario(m.id);
    corpo = `<form data-form="divergencia" style="display:grid;gap:14px"><h2>Apontar divergência</h2>
      <p>${esc(u?.nome)} · ${mesLabel(S.mes)}. A Bia e o administrador veem o comentário. Para corrigir, o administrador reabre o mês.</p>
      <div class="campo"><label for="dv-txt">O que está diferente</label><textarea id="dv-txt" required maxlength="800" placeholder="Ex.: sessão Tipo B deveria ser $95 a partir de setembro"></textarea></div>
      <div class="acoes"><button class="btn pri" type="submit">Registrar divergência</button><button class="btn" type="button" data-acao="fecharModal">Cancelar</button></div></form>`;
  } else if (m.tipo === 'contrato') {
    const c = m.id ? contrato(m.id) : null;
    const coachId = m.coach ?? c?.coachId ?? (S.ctCoach || coaches().find((x) => x.ativo !== false)?.id || '');
    const clis = coachId ? clientesDe(coachId).filter((x) => x.ativo !== false || x.id === c?.clienteId) : [];
    const cliente = m.cliente ?? c?.clienteId ?? '';
    const cfgC = coachId ? cfgCoach(usuario(coachId)) : { extras: [] };
    const servico = m.servico ?? (c ? servicoCt(c) : 'sessao');
    const forma = m.forma ?? (c && !(Number(c.valorContrato) > 0) ? 'fixo' : 'pct');
    const travaUso = c && usadasDe(c.id) - (Number(c.sessoesAnteriores) || 0) > 0;
    const abertasSem = !c && cliente && cliente !== '__novo'
      ? S.sessoes.filter((x) => x.clienteId === cliente && !x.contratoId && (x.servico || 'sessao') === servico && x.status !== 'recusada' && !fechado(x.coachId, x.mes)) : [];
    corpo = `<form data-form="contrato" style="display:grid;gap:14px"><h2>${c ? `Contrato Nº ${esc(c.numero)}` : 'Novo contrato'}</h2>
      <div class="form">
        <div class="campo"><label for="ct-numero">Nº do contrato</label><input id="ct-numero" required maxlength="40" value="${esc(c?.numero || proximoNumeroContrato())}">${c ? '' : '<div class="dica">Gerado automaticamente (sequencial do ano).</div>'}</div>
        <div class="campo"><label for="ct-nome">Nome do contrato</label><input id="ct-nome" maxlength="120" value="${esc(c?.nome || '')}" placeholder="Ex.: Mentoria 10 sessões"></div>
        <div class="campo"><label for="ct-coach">Coach</label><select id="ct-coach" required data-change="ctCoach" ${travaUso ? 'disabled' : ''}><option value="">Selecione…</option>${coaches().filter((x) => x.ativo !== false || x.id === coachId).map((x) => `<option value="${x.id}" ${x.id === coachId ? 'selected' : ''}>${esc(x.nome)}</option>`).join('')}</select></div>
        <div class="campo"><label for="ct-cliente">Cliente</label><select id="ct-cliente" required data-change="ctCliente" ${travaUso ? 'disabled' : ''}><option value="">Selecione…</option>${clis.map((x) => `<option value="${x.id}" ${x.id === cliente ? 'selected' : ''}>${esc(x.nome)}</option>`).join('')}<option value="__novo" ${cliente === '__novo' ? 'selected' : ''}>+ Cliente novo</option></select></div>
        <div class="campo largo" ${cliente === '__novo' ? '' : 'hidden'}><label for="ct-cliente-novo">Nome do cliente novo</label><input id="ct-cliente-novo" ${cliente === '__novo' ? 'required' : ''} placeholder="Nome e sobrenome"></div>
        <div class="campo"><label for="ct-servico">Serviço do contrato</label><select id="ct-servico" data-change="ctServico" ${travaUso ? 'disabled' : ''}><option value="sessao">Sessão</option>${cfgC.extras.map((x) => `<option value="${x.id}" ${servico === x.id ? 'selected' : ''}>${esc(x.nome)}</option>`).join('')}</select></div>
        <div class="campo"><label for="ct-forma">Como calcular o valor ao coach</label><select id="ct-forma" data-change="ctForma"><option value="pct" ${forma === 'pct' ? 'selected' : ''}>Valor do contrato × % do coach</option><option value="fixo" ${forma === 'fixo' ? 'selected' : ''}>Valor fixo por sessão</option></select></div>
        <div class="campo"><label for="ct-sessoes">Sessões contratadas</label><input id="ct-sessoes" type="number" min="1" max="500" step="1" required value="${c?.sessoesContratadas ?? 10}"></div>
        <div class="campo"><label for="ct-anteriores">Sessões já feitas antes do sistema</label><input id="ct-anteriores" type="number" min="0" step="1" value="${c?.sessoesAnteriores ?? 0}"></div>
        ${forma === 'pct' ? `<div class="campo"><label for="ct-total">Valor do contrato ($)</label><input id="ct-total" type="number" min="0.01" step="0.01" required value="${c?.valorContrato ?? ''}" placeholder="Ex.: 2500"></div>
        <div class="campo"><label for="ct-pct">Participação do coach (%)</label><input id="ct-pct" type="number" min="0.01" max="100" step="0.01" required value="${c?.percentualCoach ?? ''}" placeholder="Ex.: 40"></div>
        <div class="campo largo"><div class="aviso fechado"><div class="num" id="ct-calc">${esc(calcContratoTexto(c?.valorContrato, c?.percentualCoach, c?.sessoesContratadas ?? 10))}</div></div></div>`
        : `<div class="campo"><label for="ct-valor">Valor ao coach por sessão ($)</label><input id="ct-valor" type="number" min="0" step="0.01" required value="${c?.valorSessao ?? ''}"></div>`}
        <div class="campo"><label for="ct-inicio">Início (opcional)</label><input id="ct-inicio" type="date" value="${c?.dataInicio || ''}"></div>
        <div class="campo largo"><label for="ct-obs">Observação (opcional)</label><input id="ct-obs" maxlength="300" value="${esc(c?.obs || '')}"></div>
      </div>
      ${abertasSem.length ? `<label class="acoes"><input type="checkbox" id="ct-vincular" checked> Vincular a este contrato as ${abertasSem.length} sessão(ões) deste cliente já lançadas em meses abertos (${[...new Set(abertasSem.map((x) => mesLabel(x.mes)))].join(', ')}). Elas passam a contar no contrato e a usar o valor dele.</label>` : ''}
      <p class="nota" style="margin:0">"Sessões já feitas antes do sistema" são as que aconteceram antes de usar o sistema (ou fora dele). As sessões lançadas no sistema e vinculadas ao contrato são contadas automaticamente: não some as duas coisas.${c ? ' Mudar o valor altera os meses abertos; meses fechados não mudam.' : ''}</p>
      <div class="acoes"><button class="btn pri" type="submit">${c ? 'Salvar' : 'Cadastrar contrato'}</button><button class="btn" type="button" data-acao="fecharModal">Cancelar</button></div></form>`;
  } else if (m.tipo === 'excluirContrato') {
    const c = contrato(m.id);
    corpo = `<h2>Excluir contrato Nº ${esc(c?.numero || '')}</h2>
      <p>${esc(c?.nome || '')} · ${esc(nomeCliente(c?.clienteId) || c?.clienteNome || '')} · ${esc(usuario(c?.coachId)?.nome || '')}</p>
      <p>O contrato será apagado de vez. Só é possível excluir contrato sem nenhuma sessão lançada nele.</p>
      <div class="acoes"><button class="btn bad" data-acao="confirmarExcluirContrato">Excluir</button><button class="btn" data-acao="fecharModal">Cancelar</button></div>`;
  } else if (m.tipo === 'aprovarTodos') {
    const fs = coaches().map((c) => fechamento(c.id, S.mes)).filter((f) => f?.status === 'fechado' && f.origem !== 'planilha' && f.conferencia?.status === 'ok' && !f.aprovacao);
    const tot = fs.reduce((a, f) => a + Math.round(Number(f.total || 0) * 100), 0) / 100;
    corpo = `<h2>Aprovar pagamentos de ${mesLabel(S.mes)}</h2>
      <table class="resumo"><tbody>${fs.map((f) => `<tr><td>${esc(usuario(f.coachId)?.nome || '')}<div class="nota">conferido por ${esc(f.conferencia.porNome || '')} em ${fmtDataHora(f.conferencia.em)}</div></td><td class="r num">${fmtUSD(f.total)}</td></tr>`).join('')}
      <tr><td><b>Total</b></td><td class="r num"><b>${fmtUSD(tot)}</b></td></tr></tbody></table>
      <p>Sua aprovação fica registrada em cada um, com seu nome e a data, e aparece no recibo em PDF.</p>
      <div class="acoes"><button class="btn pri" data-acao="confirmarAprovarTodos">${fs.length > 1 ? `Aprovar os ${fs.length} pagamentos` : "Aprovar o pagamento"}</button><button class="btn" data-acao="fecharModal">Cancelar</button></div>`;
  } else if (m.tipo === 'aprovar') {
    const u = usuario(m.id), f = fechamento(m.id, S.mes);
    corpo = `<h2>Aprovar pagamento</h2>
      <p>${esc(u?.nome)} · ${mesLabel(S.mes)} · <b class="num">${fmtUSD(f?.total)}</b></p>
      <p>Conferido por ${esc(f?.conferencia?.porNome || '')} em ${fmtDataHora(f?.conferencia?.em)}. Ao aprovar, sua aprovação fica registrada com seu nome e a data, como uma assinatura, e aparece no recibo em PDF.</p>
      <div class="acoes"><button class="btn pri" data-acao="confirmarAprovacao">Aprovar pagamento</button><button class="btn" data-acao="fecharModal">Cancelar</button></div>`;
  } else if (m.tipo === 'problemaAprov') {
    const u = usuario(m.id);
    corpo = `<form data-form="problemaAprov" style="display:grid;gap:14px"><h2>Apontar problema</h2>
      <p>${esc(u?.nome)} · ${mesLabel(S.mes)}. O financeiro, a Bia e o administrador veem o comentário. Para corrigir, o administrador reabre o mês.</p>
      <div class="campo"><label for="pa-txt">O que está errado</label><textarea id="pa-txt" required maxlength="800"></textarea></div>
      <div class="acoes"><button class="btn pri" type="submit">Registrar problema</button><button class="btn" type="button" data-acao="fecharModal">Cancelar</button></div></form>`;
  } else if (m.tipo === 'credenciais') {
    const txt = `Acesso ao ${NOME_SISTEMA}\nEndereço: ${location.origin}${location.pathname}\nLogin: ${m.email}\nSenha provisória: ${m.senha}`;
    corpo = `<h2>${esc(m.nome)} cadastrado(a)</h2><p>Envie estes dados para a pessoa. A senha provisória não aparece de novo; se perder, use "Enviar e-mail de nova senha".</p>
      <div class="cred" id="cred-txt">${esc(txt).replace(/\n/g, '<br>')}</div>
      <div class="acoes"><button class="btn pri" data-acao="copiar" data-txt="${esc(txt)}">Copiar</button><button class="btn" data-acao="fecharModal">Fechar</button></div>`;
  } else if (m.tipo === 'senha') {
    corpo = `<form data-form="senha" style="display:grid;gap:14px"><h2>Trocar senha</h2>
      <div class="campo"><label for="ts-atual">Senha atual</label><input id="ts-atual" type="password" required autocomplete="current-password"></div>
      <div class="campo"><label for="ts-nova">Nova senha</label><input id="ts-nova" type="password" required minlength="6" autocomplete="new-password"></div>
      <div class="acoes"><button class="btn pri" type="submit">Trocar senha</button><button class="btn" type="button" data-acao="fecharModal">Cancelar</button></div></form>`;
  }
  return `<div class="modal-bg" data-acao="fundoModal"><div class="modal" role="dialog" aria-modal="true">${corpo}</div></div>`;
}

// ============================================================ ações (cliques)
const val = (id) => document.getElementById(id)?.value?.trim() ?? '';
const quemRevisa = () => ({ revisadoPor: uid(), revisadoPorNome: S.perfil.nome, revisadoEm: B.db.agora() });

const acoes = {
  async loginDemo(d) { await tentar(() => B.auth.login(d.email, 'demo123')); },
  async sair() { await B.auth.logout(); },
  async esqueci() {
    const email = val('l-email');
    if (!email) return toast('Digite seu e-mail no campo acima e clique de novo em "Esqueci minha senha".', true);
    await tentar(() => B.auth.reset(email), 'Se o e-mail estiver cadastrado, você receberá um link para criar nova senha.');
  },
  verComo(d) {
    if (!isAdmin()) return;
    const c = S.usuarios.find((u) => u.id === d.id);
    if (!c) return;
    S.perfilAdmin = S.perfil; S.verComo = c.id; S.perfil = { ...c, papel: 'coach' };
    Object.assign(S, { view: 'lancar', edit: null, novoCliente: false, servicoSel: 'sessao', clienteSel: '', contratoSel: '', modal: null });
    S.sel.clear(); render(true); window.scrollTo(0, 0);
  },
  sairVerComo() {
    const id = S.verComo;
    S.verComo = null; S.perfil = S.perfilAdmin; S.perfilAdmin = null;
    Object.assign(S, { view: 'usuarios', edit: null, novoCliente: false, servicoSel: 'sessao', clienteSel: '', contratoSel: '', modal: null, coachSel: id });
    render(true); window.scrollTo(0, 0);
  },
  ir(d) { S.view = d.view; S.edit = null; S.sel.clear(); S.filtro = 'todas'; S.modal = null; render(); window.scrollTo(0, 0); },
  mes(d) { S.mes = somaMes(S.mes, +d.d); S.edit = null; S.sel.clear(); assinarSessoes(); render(); },
  abrirMes(d) { S.mes = d.mes; S.view = 'lancar'; assinarSessoes(); render(); },
  conferir(d) { S.coachSel = d.coach; S.view = 'conferencia'; S.filtro = 'todas'; S.sel.clear(); render(); window.scrollTo(0, 0); },
  irConf(d) { S.coachSel = d.coach; S.mes = d.mes; S.view = isAprov() ? 'aprovacao' : isFin() ? 'valores' : 'conferencia'; S.filtro = 'todas'; assinarSessoes(); render(); window.scrollTo(0, 0); },
  editar(d) { const x = S.sessoes.find((y) => y.id === d.id); S.edit = d.id; S.novoCliente = false; S.servicoSel = x?.servico || 'sessao'; S.clienteSel = x?.clienteId || ''; S.contratoSel = x?.contratoId || ''; render(true); window.scrollTo(0, 0); },
  cancelarEdit() { S.edit = null; S.novoCliente = false; S.servicoSel = 'sessao'; S.clienteSel = ''; S.contratoSel = ''; render(true); },
  excluir(d) { S.modal = { tipo: 'excluir', id: d.id }; render(); },
  async confirmarExcluir() { const id = S.modal.id; S.modal = null; if (S.edit === id) S.edit = null; render(); await tentar(() => B.db.del('sessoes', id), 'Lançamento excluído.'); },
  modal(d) { S.modal = { tipo: d.tipo, id: d.id }; render(); },
  fecharModal() { S.modal = null; render(); },
  fundoModal(d, el, ev) { if (ev.target === el) acoes.fecharModal(); },
  filtro(d) { S.filtro = d.f; render(); },
  sel(d, el) { el.checked ? S.sel.add(d.id) : S.sel.delete(d.id); render(); },
  selTodas(d, el) { const ids = sessoesDe(S.coachSel).filter((s) => s.status === 'pendente').map((s) => s.id); if (el.checked) ids.forEach((i) => S.sel.add(i)); else S.sel.clear(); render(); },
  async aprovar(d) { await tentar(() => B.db.update('sessoes', d.id, { status: 'aprovada', comentario: '', ...quemRevisa() })); },
  recusar(d) { S.modal = { tipo: 'recusar', id: d.id }; render(); },
  editarBia(d) { S.modal = { tipo: 'editarBia', id: d.id }; render(); },
  async voltarPendente(d) { await tentar(() => B.db.update('sessoes', d.id, { status: 'pendente', ...quemRevisa() }), 'Lançamento voltou para pendente.'); },
  async aprovarSel() { await aprovarVarias([...S.sel]); },
  async aprovarTodas() { await aprovarVarias(sessoesDe(S.coachSel).filter((s) => s.status === 'pendente').map((s) => s.id)); },
  async confirmarTipo(d) { await tentar(() => B.db.update('clientes', d.id, { tipoConfirmado: true }), 'Tipo confirmado.'); },
  async ativoCliente(d) { const c = S.clientes.find((x) => x.id === d.id); await tentar(() => B.db.update('clientes', d.id, { ativo: c.ativo === false })); },
  async removerAjuste(d) {
    const f = fechamento(d.coach, d.mes);
    await tentar(() => B.db.update('fechamentos', f.id, { ajustes: (f.ajustes || []).filter((a) => a.id !== d.id) }), 'Ajuste removido.');
  },
  async confirmarFechar() {
    const coachId = S.coachSel, mes = S.mes;
    const cfg = cfgCoach(usuario(coachId));
    const r = resumo(coachId, mes);
    const f = fechamento(coachId, mes);
    const lanc = sessoesDe(coachId, mes);
    S.modal = null; render();
    await tentar(() => B.db.set('fechamentos', `${coachId}_${mes}`, {
      coachId, mes, status: 'fechado', origem: 'sistema',
      linhas: r.linhas, ajustes: f?.ajustes || [], subtotal: r.subtotal, total: r.total,
      resumo: { sessoes: r.sessoes, sessoesA: r.sessoesA, sessoesB: r.sessoesB, ativos: r.ativos, recorrentes: r.recorrentes,
        lancamentos: lanc.length, recusadas: lanc.filter((s) => s.status === 'recusada').length },
      config: { valorA: cfg.valorA, valorB: cfg.valorB, limiteA: cfg.limiteA, bonusAtivo: cfg.bonusAtivo, bonusRecorrencia: cfg.bonusRecorrencia, minSessoesBonus: cfg.minSessoesBonus, extras: cfg.extras },
      historico: [...(f?.historico || [])],
      fechadoPor: uid(), fechadoPorNome: S.perfil.nome, fechadoEm: B.db.agora(),
    }), `${mesLabel(mes)} fechado: ${fmtUSD(r.total)}.`);
  },
  async confirmarReabrir() {
    const f = fechamento(S.coachSel, S.mes);
    S.modal = null; render();
    const reg = { acao: 'reaberto', totalAnterior: f.total, conferencia: f.conferencia || null, aprovacao: f.aprovacao || null, por: S.perfil.nome, em: new Date().toISOString() };
    await tentar(() => B.db.update('fechamentos', f.id, { status: 'aberto', conferencia: null, aprovacao: null, historico: [...(f.historico || []), reg], reabertoPorNome: S.perfil.nome, reabertoEm: B.db.agora() }), 'Mês reaberto.');
  },
  async resetSenha(d) { await tentar(() => B.auth.reset(d.email), `E-mail de nova senha enviado para ${d.email}.`); },
  csv(d) { exportarCSV(d.coach, S.mes); },
  verValores(d) { S.coachSel = d.coach; render(); },
  irValores(d) { S.coachSel = d.coach; S.mes = d.mes; S.view = isAprov() || S.view === 'aprovacao' ? 'aprovacao' : 'valores'; assinarSessoes(); render(); window.scrollTo(0, 0); },
  async confirmarAprovacao() {
    const coachId = S.modal.id;
    S.modal = null; render();
    await tentar(() => B.db.update('fechamentos', `${coachId}_${S.mes}`, { aprovacao: { status: 'ok', comentario: '', porNome: S.perfil.nome, por: uid(), em: new Date().toISOString() } }),
      'Pagamento aprovado.');
  },
  async confirmarAprovarTodos() {
    const fs = coaches().map((c) => fechamento(c.id, S.mes)).filter((f) => f?.status === 'fechado' && f.origem !== 'planilha' && f.conferencia?.status === 'ok' && !f.aprovacao);
    S.modal = null; render();
    const ap = { status: 'ok', comentario: '', porNome: S.perfil.nome, por: uid(), em: new Date().toISOString() };
    await tentar(() => Promise.all(fs.map((f) => B.db.update('fechamentos', f.id, { aprovacao: ap }))), `${fs.length} pagamento(s) aprovado(s).`);
  },
  async pdf(d) { await tentar(() => exportarPDF(d.coach, S.mes)); },
  async confirmarExcluirContrato() {
    const c = contrato(S.modal.id);
    S.modal = null; render();
    if (!c) return;
    if (S.sessoes.some((x) => x.contratoId === c.id)) return toast('Este contrato já tem sessões lançadas. Use Encerrar.', true);
    await tentar(() => B.db.batch([{ op: 'delete', col: 'contratos', id: c.id }]), `Contrato Nº ${c.numero} excluído.`);
  },
  async statusContrato(d) {
    const c = contrato(d.id);
    await tentar(() => B.db.update('contratos', c.id, { status: c.status === 'ativo' ? 'encerrado' : 'ativo', atualizadoEm: B.db.agora(), atualizadoPorNome: S.perfil.nome }),
      c.status === 'ativo' ? `Contrato Nº ${c.numero} encerrado.` : `Contrato Nº ${c.numero} reativado.`);
  },
  async conferirValores(d) {
    await tentar(() => B.db.update('fechamentos', `${d.coach}_${S.mes}`, { conferencia: { status: 'ok', comentario: '', porNome: S.perfil.nome, por: uid(), em: new Date().toISOString() } }),
      'Valores marcados como conferidos.');
  },
  async copiar(d) {
    try { await navigator.clipboard.writeText(d.txt); toast('Copiado.'); }
    catch { const r = document.createRange(); r.selectNodeContents(document.getElementById('cred-txt')); const s = getSelection(); s.removeAllRanges(); s.addRange(r); toast('Selecionado: use Ctrl+C para copiar.'); }
  },
};

// As regras do Firestore leem no máximo 20 documentos diferentes por lote. Cada sessão faz as regras
// consultarem o fechamento do seu mês, então os lotes de sessões são separados por coach + mês.
async function gravarPorMes(ops, progresso) {
  const grupos = new Map();
  for (const o of ops) { const k = o.chave || ''; if (!grupos.has(k)) grupos.set(k, []); grupos.get(k).push(o); }
  let i = 0;
  for (const lote of grupos.values()) {
    i++; progresso && progresso(i, grupos.size);
    await B.db.batch(lote.map(({ chave, ...o }) => o));
  }
}

async function aprovarVarias(ids) {
  if (!ids.length) return;
  const extra = quemRevisa();
  await tentar(() => B.db.batch(ids.map((id) => ({ op: 'update', col: 'sessoes', id, data: { status: 'aprovada', comentario: '', ...extra } }))),
    `${ids.length} lançamento(s) aprovado(s).`);
  S.sel.clear(); render();
}

// ============================================================ formulários
async function clienteNovo(coachId, nome, tipoForcado) {
  nome = titulo(nome);
  const lista = clientesDe(coachId);
  const existente = lista.find((c) => norm(c.nome) === norm(nome));
  if (existente) return { id: existente.id, nome: existente.nome, jaExistia: true };
  const cfg = cfgCoach(usuario(coachId));
  const dados = { coachId, nome, tipo: tipoForcado || tipoSugerido(cfg, lista), tipoConfirmado: staff() || isFin(),
    ordem: lista.reduce((m, c) => Math.max(m, c.ordem || 0), 0) + 1, ativo: true, criadoEm: B.db.agora(), criadoPor: uid() };
  const id = await B.db.add('clientes', dados);
  return { id, nome };
}

const forms = {
  async login() { await tentar(() => B.auth.login(val('l-email'), document.getElementById('l-senha').value)); },
  async bootstrap() {
    await tentar(() => B.db.batch([
      { op: 'set', col: 'users', id: uid(), data: { nome: val('b-nome'), email: S.auth.email, papel: 'admin', ativo: true, criadoEm: B.db.agora() } },
      { op: 'set', col: 'config', id: 'sistema', data: { criadoEm: B.db.agora(), criadoPor: uid() } },
    ]), 'Pronto! Você é o administrador.');
  },
  async sessao(form) {
    const me = uid();
    const data = val('f-data');
    const qtd = parseInt(val('f-qtd'), 10);
    const mes = data.slice(0, 7);
    if (!data || data > hojeISO()) return toast('A data da sessão não pode ser no futuro.', true);
    if (!(qtd >= 1 && qtd <= 20)) return toast('Quantidade deve ser entre 1 e 20.', true);
    if (fechado(me, mes)) return toast(`${mesLabel(mes)} já foi fechado. Fale com a Bia.`, true);
    let clienteId = val('f-cliente'), clienteNome;
    if (clienteId === '__novo') {
      const nome = val('f-novo');
      if (nome.length < 2) return toast('Digite o nome do cliente novo.', true);
      const c = await tentar(() => clienteNovo(me, nome));
      if (!c) return;
      clienteId = c.id; clienteNome = c.nome;
      if (c.jaExistia) toast(`"${c.nome}" já estava na sua carteira; usei o cadastro existente.`);
    } else {
      clienteNome = S.clientes.find((c) => c.id === clienteId)?.nome;
      if (!clienteNome) return toast('Selecione o cliente.', true);
    }
    const servico = val('f-servico') || 'sessao';
    const eEdit = S.edit ? S.sessoes.find((s) => s.id === S.edit) : null;
    let contratoId = null;
    {
      const cts = contratosDoCliente(clienteId, servico).filter((c) => c.status === 'ativo' || c.id === eEdit?.contratoId);
      if (cts.length) {
        const ct = contrato(val('f-contrato')) || contratoSugerido(clienteId, eEdit?.id, servico);
        if (!ct) return toast('Escolha o contrato da sessão.', true);
        const rest = restantesDe(ct, eEdit?.id);
        if (qtd > rest) return toast(rest <= 0 ? `O contrato Nº ${ct.numero} já usou todas as ${ct.sessoesContratadas} sessões. Peça ao financeiro um novo contrato.` : `O contrato Nº ${ct.numero} só tem mais ${rest} sessão(ões).`, true);
        contratoId = ct.id;
      } else if (exigeContrato() && servico === 'sessao') return toast('Este cliente não tem contrato ativo. Peça ao financeiro para cadastrar o contrato.', true);
    }
    const dados = { coachId: me, clienteId, clienteNome, data, mes, quantidade: qtd, servico, contratoId, obs: val('f-obs'), atualizadoEm: B.db.agora() };
    if (extraLivre(cfgCoach(S.perfil), servico) && !contratoId) {
      const v = Math.round(parseFloat(val('f-valor')) * 100) / 100;
      if (!(v > 0)) return toast(`Informe o valor cobrado de ${nomeServico(cfgCoach(S.perfil), servico)}.`, true);
      dados.valorInformado = v;
    } else dados.valorInformado = null;
    const e = S.edit ? S.sessoes.find((s) => s.id === S.edit) : null;
    let ok;
    if (e) {
      ok = await tentar(() => B.db.update('sessoes', e.id, { ...dados, status: 'pendente', ...(e.status === 'recusada' ? { reenviadaEm: B.db.agora() } : {}) }),
        e.status === 'recusada' ? 'Sessão corrigida e reenviada para a Bia.' : 'Alteração salva.');
    } else {
      ok = await tentar(() => B.db.add('sessoes', { ...dados, status: 'pendente', criadoEm: B.db.agora(), criadoPor: me }),
        mes === S.mes ? 'Sessão registrada.' : `Sessão registrada em ${mesLabel(mes)}.`);
    }
    if (ok === undefined) return;
    S.edit = null; S.novoCliente = false; S.servicoSel = 'sessao'; S.clienteSel = ''; S.contratoSel = '';
    render(true);
  },
  async recusar() {
    const motivo = val('rc-motivo');
    const id = S.modal.id;
    S.modal = null; render();
    await tentar(() => B.db.update('sessoes', id, { status: 'recusada', comentario: motivo, ...quemRevisa() }), 'Lançamento recusado. O coach foi avisado na tela dele.');
  },
  async editarBia() {
    const id = S.modal.id;
    const s = S.sessoes.find((x) => x.id === id);
    const data = val('eb-data');
    const cli = S.clientes.find((c) => c.id === val('eb-cliente'));
    if (data.slice(0, 7) !== s.mes && fechado(s.coachId, data.slice(0, 7))) return toast('O mês da nova data já está fechado.', true);
    let contratoId = null;
    if (cli) {
      const cts = contratosDoCliente(cli.id, val('eb-servico') || 'sessao').filter((c) => c.status === 'ativo' || c.id === s.contratoId);
      if (cts.length) {
        const ct = contrato(val('eb-contrato')) || contratoSugerido(cli.id, s.id, val('eb-servico') || 'sessao');
        const q = parseInt(val('eb-qtd'), 10) || 1;
        if (!ct) return toast('Escolha o contrato.', true);
        if (q > restantesDe(ct, s.id)) return toast(`O contrato Nº ${ct.numero} não tem sessões suficientes (restam ${Math.max(0, restantesDe(ct, s.id))}).`, true);
        contratoId = ct.id;
      }
    }
    const aprovar = document.getElementById('eb-aprovar').checked;
    const servico = val('eb-servico');
    let valorInformado = null;
    if (extraLivre(cfgCoach(usuario(s.coachId)), servico) && !contratoId) {
      valorInformado = Math.round(parseFloat(val('eb-valor')) * 100) / 100;
      if (!(valorInformado > 0)) return toast('Informe o valor cobrado.', true);
    }
    // lê todos os campos ANTES de fechar a janela (depois de fechar, os campos não existem mais)
    const quantidade = parseInt(val('eb-qtd'), 10);
    if (!(quantidade >= 1 && quantidade <= 20)) return toast('Quantidade deve ser um número inteiro entre 1 e 20.', true);
    if (!cli) return toast('Selecione o cliente.', true);
    S.modal = null; render();
    await tentar(() => B.db.update('sessoes', id, { data, mes: data.slice(0, 7), clienteId: cli.id, clienteNome: cli.nome, servico, valorInformado, contratoId,
      quantidade, corrigidoPorNome: S.perfil.nome, ...(aprovar ? { status: 'aprovada', comentario: '', ...quemRevisa() } : {}) }), 'Lançamento corrigido.');
  },
  async ajuste() {
    const coachId = S.coachSel, mes = S.mes;
    const valor = Math.round(parseFloat(val('aj-valor')) * 100) / 100;
    if (!valor) return toast('Informe um valor diferente de zero (use negativo para desconto).', true);
    const a = { id: Math.random().toString(36).slice(2, 10), descricao: val('aj-desc'), valor, por: S.perfil.nome, em: new Date().toISOString() };
    const f = fechamento(coachId, mes);
    const ok = await tentar(() => (f
      ? B.db.update('fechamentos', f.id, { ajustes: [...(f.ajustes || []), a] })
      : B.db.set('fechamentos', `${coachId}_${mes}`, { coachId, mes, status: 'aberto', ajustes: [a] })), 'Ajuste adicionado.');
    if (ok !== undefined) { document.getElementById('aj-desc').value = ''; document.getElementById('aj-valor').value = ''; }
  },
  async novoClienteCoach() {
    const c = await tentar(() => clienteNovo(uid(), val('nc-nome')));
    if (c) { toast(c.jaExistia ? `"${c.nome}" já está na carteira.` : `"${c.nome}" adicionado. A Bia vai confirmar o tipo.`); document.getElementById('nc-nome').value = ''; }
  },
  async novoClienteBia() {
    const c = await tentar(() => clienteNovo(S.coachSel, val('cb-nome'), val('cb-tipo')));
    if (c) { toast(c.jaExistia ? `"${c.nome}" já está na carteira.` : `"${c.nome}" adicionado.`); document.getElementById('cb-nome').value = ''; }
  },
  async editarCliente() {
    const id = S.modal.id;
    const nome = titulo(val('ec-nome'));
    const ordem = parseInt(val('ec-ordem'), 10) || null;
    const v = Math.round(parseFloat(val('ec-valor')) * 100) / 100;
    const valorSessao = v > 0 ? v : null;
    S.modal = null; render();
    await tentar(() => B.db.update('clientes', id, { nome, ordem, valorSessao }), 'Cliente atualizado.');
  },
  async mesclar() {
    const origem = S.clientes.find((x) => x.id === S.modal.id);
    const destino = S.clientes.find((x) => x.id === val('mg-destino'));
    if (!destino) return toast('Escolha o cadastro que será mantido.', true);
    S.modal = null; render();
    await tentar(async () => {
      const ss = await B.db.list('sessoes', [['clienteId', '==', origem.id]]);
      const abertas = ss.filter((s) => !fechado(s.coachId, s.mes));
      await gravarPorMes(abertas.map((s) => ({ op: 'update', col: 'sessoes', id: s.id, chave: `${s.coachId}_${s.mes}`,
        data: { clienteId: destino.id, clienteNome: destino.nome } })));
      await B.db.update('clientes', origem.id, { ativo: false, mescladoEm: destino.id });
      toast(`${abertas.length} lançamento(s) passaram para "${destino.nome}".${ss.length - abertas.length ? ` ${ss.length - abertas.length} em meses fechados ficaram como estavam.` : ''}`);
    });
  },
  async novoUsuario() {
    const nome = val('nu-nome'), email = val('nu-email').toLowerCase(), senha = val('nu-senha'), papel = val('nu-papel');
    await tentar(async () => {
      const novoUid = await B.auth.criarUsuario(email, senha);
      await B.db.set('users', novoUid, { nome, email, papel, ativo: true, criadoEm: B.db.agora(),
        ...(papel === 'coach' ? { config: { ...CONFIG_PADRAO } } : {}) });
      S.modal = { tipo: 'credenciais', nome, email, senha }; render();
    });
  },
  async editarUsuario() {
    const u = S.usuarios.find((x) => x.id === S.modal.id);
    const config = lerValores(u);
    if (!config) return;
    const patch = { nome: val('eu-nome'), config };
    if (JSON.stringify(config) !== JSON.stringify(cfgCoach(u))) Object.assign(patch, { valoresAlteradosEm: B.db.agora(), valoresAlteradosPorNome: S.perfil.nome });
    if (u.id !== uid()) { patch.papel = val('eu-papel'); patch.ativo = val('eu-ativo') === '1'; }
    S.modal = null; render();
    await tentar(() => B.db.update('users', u.id, patch), 'Usuário atualizado.');
  },
  async salvarValores() {
    const u = S.usuarios.find((x) => x.id === S.modal.id);
    const config = lerValores(u);
    if (!config) return;
    S.modal = null; render();
    await tentar(() => B.db.update('users', u.id, { config, valoresAlteradosEm: B.db.agora(), valoresAlteradosPorNome: S.perfil.nome }), `Valores de ${u.nome} atualizados.`);
  },
  async contrato() {
    const c = S.modal.id ? contrato(S.modal.id) : null;
    const numero = val('ct-numero'), nome = val('ct-nome');
    const coachId = c && document.getElementById('ct-coach').disabled ? c.coachId : val('ct-coach');
    let clienteId = c && document.getElementById('ct-cliente').disabled ? c.clienteId : val('ct-cliente');
    const sessoes = parseInt(val('ct-sessoes'), 10), anteriores = parseInt(val('ct-anteriores') || '0', 10);
    const servico = c && document.getElementById('ct-servico').disabled ? servicoCt(c) : (val('ct-servico') || 'sessao');
    const forma = val('ct-forma') || 'fixo';
    let valor, valorContrato = null, percentualCoach = null, valorUltimaSessao = null;
    if (forma === 'pct') {
      valorContrato = Math.round(parseFloat(val('ct-total')) * 100) / 100;
      percentualCoach = Math.round(parseFloat(val('ct-pct')) * 100) / 100;
      if (!(valorContrato > 0)) return toast('Informe o valor do contrato.', true);
      if (!(percentualCoach > 0 && percentualCoach <= 100)) return toast('Participação do coach: de 0,01% a 100%.', true);
      const v = valoresContrato(valorContrato, percentualCoach, parseInt(val('ct-sessoes'), 10) || 1);
      valor = v.valorSessao; valorUltimaSessao = v.valorUltimaSessao;
    } else valor = Math.round(parseFloat(val('ct-valor')) * 100) / 100;
    const vincular = !!document.getElementById('ct-vincular')?.checked;
    const novoNome = val('ct-cliente-novo');
    if (!numero) return toast('Informe o número do contrato.', true);
    if (S.contratos.some((x) => x.id !== c?.id && norm(x.numero) === norm(numero))) return toast(`Já existe um contrato Nº ${numero}.`, true);
    if (!coachId) return toast('Escolha o coach.', true);
    if (!clienteId || (clienteId === '__novo' && novoNome.length < 2)) return toast('Escolha o cliente (ou digite o nome do cliente novo).', true);
    if (!(sessoes >= 1 && sessoes <= 500)) return toast('Sessões contratadas: número inteiro de 1 a 500.', true);
    if (!(anteriores >= 0 && anteriores <= sessoes)) return toast('Sessões já feitas antes do sistema: de 0 até o total contratado.', true);
    if (!(valor >= 0)) return toast('Informe o valor ao coach por sessão.', true);
    const abertas = !c && vincular && clienteId !== '__novo'
      ? S.sessoes.filter((x) => x.clienteId === clienteId && !x.contratoId && (x.servico || 'sessao') === servico && x.status !== 'recusada' && !fechado(x.coachId, x.mes)) : [];
    const jaLancadas = c ? usadasDe(c.id) - (Number(c.sessoesAnteriores) || 0) : abertas.reduce((a, x) => a + (Number(x.quantidade) || 1), 0);
    if (anteriores + jaLancadas > sessoes) return toast(`O total passaria do contratado: ${anteriores} antes do sistema + ${jaLancadas} lançadas no sistema = ${anteriores + jaLancadas} de ${sessoes}.`, true);
    S.modal = null; render();
    await tentar(async () => {
      if (clienteId === '__novo') { const n = await clienteNovo(coachId, novoNome, 'A'); clienteId = n.id; }
      const dados = { numero, nome, coachId, clienteId, clienteNome: nomeCliente(clienteId) || novoNome, sessoesContratadas: sessoes, sessoesAnteriores: anteriores,
        servico, valorContrato, percentualCoach, valorSessao: valor, valorUltimaSessao, dataInicio: val('ct-inicio') || null, obs: val('ct-obs'), atualizadoEm: B.db.agora(), atualizadoPorNome: S.perfil.nome };
      let id = c?.id;
      if (c) await B.db.update('contratos', c.id, dados);
      else id = await B.db.add('contratos', { ...dados, status: 'ativo', criadoEm: B.db.agora(), criadoPorNome: S.perfil.nome });
      if (abertas.length) await gravarPorMes(abertas.map((x) => ({ op: 'update', col: 'sessoes', id: x.id, chave: `${x.coachId}_${x.mes}`, data: { contratoId: id } })));
      toast(c ? `Contrato Nº ${numero} atualizado.` : `Contrato Nº ${numero} cadastrado${abertas.length ? ` e ${abertas.length} sessão(ões) vinculada(s)` : ''}.`);
    });
  },
  async problemaAprov() {
    const coachId = S.modal.id, txt = val('pa-txt');
    S.modal = null; render();
    await tentar(() => B.db.update('fechamentos', `${coachId}_${S.mes}`, { aprovacao: { status: 'divergencia', comentario: txt, porNome: S.perfil.nome, por: uid(), em: new Date().toISOString() } }),
      'Problema registrado.');
  },
  async divergencia() {
    const coachId = S.modal.id, txt = val('dv-txt');
    S.modal = null; render();
    await tentar(() => B.db.update('fechamentos', `${coachId}_${S.mes}`, { conferencia: { status: 'divergencia', comentario: txt, porNome: S.perfil.nome, por: uid(), em: new Date().toISOString() } }),
      'Divergência registrada.');
  },
  async senha() {
    const a = document.getElementById('ts-atual').value, n = document.getElementById('ts-nova').value;
    const ok = await tentar(() => B.auth.trocarSenha(a, n), 'Senha alterada.');
    if (ok !== undefined) { S.modal = null; render(); }
  },
  async lerHistorico() {
    const arq = document.getElementById('imp-arq').files[0];
    if (!arq) return;
    try {
      const h = JSON.parse(await arq.text());
      if (!h.coaches || !h.sessoes) throw new Error('Arquivo não é um historico.json válido.');
      S.importacao = h; render();
    } catch (e) { toast(e.message, true); }
  },
  async importar() {
    const h = S.importacao;
    const atualizar = document.getElementById('imp-valores').checked;
    const ops = [], fechOps = [];
    const resumoImp = [];
    for (const c of h.coaches) {
      const alvo = val('imp-' + c.chave);
      if (!alvo) continue;
      if (atualizar) {
        const { chave, nome, ...cfg } = c;
        ops.push({ op: 'update', col: 'users', id: alvo, data: { config: cfg } });
      }
      const idCliente = {};
      const atuais = clientesDe(alvo);
      for (const cl of h.clientes.filter((x) => x.coach === c.chave)) {
        const ex = atuais.find((a) => norm(a.nome) === norm(cl.nome) && !String(a.id).startsWith('imp_'));
        const id = ex ? ex.id : `imp_${alvo}_${slug(cl.nome)}`;
        idCliente[cl.nome] = id;
        if (!ex) ops.push({ op: 'set', col: 'clientes', id, data: { coachId: alvo, nome: cl.nome, tipo: cl.tipo, tipoConfirmado: true, ordem: cl.ordem, valorSessao: cl.valorSessao || null, ativo: true, importado: true, criadoEm: B.db.agora() } });
      }
      const pulados = new Set();
      let nS = 0;
      for (const s of h.sessoes.filter((x) => x.coach === c.chave)) {
        if (fechado(alvo, s.mes)) { pulados.add(s.mes); continue; }
        nS++;
        ops.push({ op: 'set', col: 'sessoes', id: `imp_${alvo}_${slug(s.linha)}`, chave: `${alvo}_${s.mes}`, data: {
          coachId: alvo, clienteId: idCliente[s.cliente], clienteNome: s.cliente, data: s.data, mes: s.mes, quantidade: s.quantidade,
          servico: s.servico, obs: s.nomeOriginal !== s.cliente ? `Na planilha: ${s.nomeOriginal}` : '', status: 'aprovada', importado: true,
          revisadoPorNome: 'Importado da planilha', criadoEm: B.db.agora() } });
      }
      let nF = 0;
      for (const f of h.fechamentos.filter((x) => x.coach === c.chave)) {
        if (fechado(alvo, f.mes)) continue;
        nF++;
        fechOps.push({ op: 'set', col: 'fechamentos', id: `${alvo}_${f.mes}`, data: {
          coachId: alvo, mes: f.mes, status: 'fechado', origem: 'planilha', linhas: f.linhas,
          ajustes: f.ajustes.map((a, i) => ({ id: 'imp' + i, ...a, por: 'Planilha' })), subtotal: f.totalPlanilha, total: f.total,
          fechadoPorNome: 'Importado da planilha', fechadoEm: B.db.agora() } });
      }
      resumoImp.push(`${c.nome}: ${nS} sessões, ${nF} meses fechados${pulados.size ? ` (pulados por já estarem fechados: ${[...pulados].map(mesLabel).join(', ')})` : ''}`);
    }
    if (!ops.length && !fechOps.length) return toast('Escolha pelo menos um coach para importar.', true);
    const prog = (t) => { const el = document.querySelector('form[data-form="importar"] .dica'); if (el) el.textContent = t; };
    const ok = await tentar(async () => {
      const sessOps = ops.filter((o) => o.col === 'sessoes');
      await B.db.batch(ops.filter((o) => o.col !== 'sessoes'));           // usuários e clientes
      await gravarPorMes(sessOps, (i, n) => prog(`Gravando sessões: mês ${i} de ${n}…`));
      await B.db.batch(fechOps);
    });
    if (ok === undefined) return;
    toast('Importação concluída. ' + resumoImp.join(' · '));
    S.importacao = null; render();
  },
};

// ============================================================ exportação CSV (abre no Excel)
// Linhas de cabeçalho com o mês de referência e quem fechou, conferiu e aprovou
function etapasTexto(f) {
  const t = (x) => fmtDataHora(x);
  return [
    ['Fechado pela revisão', f?.status === 'fechado' ? `${f.fechadoPorNome || ''}${f.fechadoEm ? ' em ' + t(f.fechadoEm) : ''}` : 'Mês ainda aberto'],
    ['Valores conferidos', f?.conferencia ? `${f.conferencia.status === 'ok' ? '' : 'PROBLEMA APONTADO - '}${f.conferencia.porNome} em ${t(f.conferencia.em)}` : 'Pendente'],
    ['Aprovação final', f?.aprovacao ? `${f.aprovacao.status === 'ok' ? '' : 'PROBLEMA APONTADO - '}${f.aprovacao.porNome} em ${t(f.aprovacao.em)}` : 'Pendente'],
  ];
}
function dadosExportacao(coachId, mes) {
  const c = usuario(coachId);
  const cfg = cfgCoach(c);
  const mapa = mapaClientes(coachId);
  const f = fechamento(coachId, mes);
  const r = f?.status === 'fechado' ? { linhas: f.linhas || [], total: f.total } : resumo(coachId, mes);
  return { c, cfg, mapa, f, r, ajustes: f?.ajustes || [], sessoes: sessoesDe(coachId, mes) };
}
function exportarCSV(coachId, mes) {
  const { c, cfg, mapa, f, r, ajustes, sessoes } = dadosExportacao(coachId, mes);
  const n = (v) => String(v).replace('.', ',');
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const L = [[`Controle de Sessões | ${c.nome} | ${mesLabel(mes)}`],
    ['Coach', c.nome], ['Mês de referência', mesLabel(mes)], ...etapasTexto(f), ['Exportado em', new Date().toLocaleString('pt-BR')], [],
    ['Mês', 'Data', 'Cliente', 'Tipo', 'Serviço', 'Contrato', 'Nº da sessão no contrato', 'Valor cobrado', 'Valor pago ao coach (unit.)', 'Quantidade', 'Status', 'Observação', 'Comentário da revisão']];
  sessoes.forEach((s) => { const cl = mapa.get(s.clienteId); const ct = s.contratoId && contrato(s.contratoId), fx = usoContratos().faixa.get(s.id);
    L.push([mesLabel(mes), fmtDiaAno(s.data), cl?.nome || s.clienteNome, cl?.tipo || '', nomeServico(cfg, s.servico), ct ? ct.numero : '', fx && ct ? `${fx.fim > fx.ini ? fx.ini + ' a ' + fx.fim : fx.ini} de ${ct.sessoesContratadas}` : '', s.valorInformado ? n(s.valorInformado) : '', ct ? n(fx && fx.ini === fx.fim ? valorSessaoN(ct, fx.ini) : ct.valorSessao) : s.valorInformado ? n(valorPagoUnit(extraDe(cfg, s.servico), s.valorInformado)) : '', s.quantidade, STATUS[s.status], s.obs || '', s.comentario || '']); });
  L.push([], [`Resumo de valores - ${mesLabel(mes)}` + (f?.status === 'fechado' ? ' (fechado)' : ' (aprovadas, mês aberto)')], ['Tipo', 'Valor unitário', 'Quantidade', 'Valor total']);
  r.linhas.forEach((l) => L.push([l.descricao, l.valorUnit == null ? 'variável' : n(l.valorUnit), l.quantidade, n(l.total)]));
  ajustes.forEach((a) => L.push(['Ajuste: ' + a.descricao, '', '', n(a.valor)]));
  L.push(['Total a receber', '', '', n(r.total)]);
  const csv = '﻿' + L.map((row) => row.map(q).join(';')).join('\r\n');
  baixar(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `sessoes_${slug(c.nome)}_${mes}.csv`);
}
function baixar(blob, nome) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = nome;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ============================================================ recibo em PDF
// Bibliotecas jsPDF + AutoTable ficam na pasta vendor/ do próprio site (carregadas só quando usadas)
let _jspdf = null;
function carregarScript(src) {
  return new Promise((ok, erro) => {
    const el = document.createElement('script');
    el.src = src; el.onload = ok;
    el.onerror = () => erro(new Error('Não foi possível carregar o gerador de PDF. Verifique se a pasta vendor foi enviada ao site.'));
    document.head.appendChild(el);
  });
}
function carregarJsPDF() {
  if (!_jspdf) {
    _jspdf = (async () => {
      if (!window.jspdf) await carregarScript('vendor/jspdf.umd.min.js');
      if (!window.jspdf?.jsPDF?.API?.autoTable) await carregarScript('vendor/jspdf.plugin.autotable.min.js');
      return window.jspdf.jsPDF;
    })().catch((e) => { _jspdf = null; throw e; });
  }
  return _jspdf;
}
// As fontes padrão do PDF só têm caracteres Latin-1: troca travessões e aspas curvas
const pdfTxt = (t) => String(t ?? '').replace(/[–—]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/…/g, '...');

async function exportarPDF(coachId, mes) {
  const { c, cfg, mapa, f, r, ajustes, sessoes } = dadosExportacao(coachId, mes);
  if (f?.status !== 'fechado') throw new Error('O recibo só pode ser gerado depois que o mês for fechado.');
  const jsPDF = await carregarJsPDF();
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const W = 210, M = 16;
  const verde = [14, 107, 91], cinza = [91, 106, 102], tinta = [21, 32, 30];
  const aprovado = f.aprovacao?.status === 'ok';

  // faixa do topo
  doc.setFillColor(...verde); doc.rect(0, 0, W, 30, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(17); doc.text('RECIBO DE PAGAMENTO', M, 14);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.text(pdfTxt(`${NOME_SISTEMA} - sessões de coaching`), M, 21);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.text('MÊS DE REFERÊNCIA', W - M, 12, { align: 'right' });
  doc.setFontSize(15); doc.text(pdfTxt(mesLabel(mes)), W - M, 20, { align: 'right' });

  // coach e valor
  let y = 42;
  doc.setTextColor(...cinza); doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.text('COACH', M, y);
  doc.text('VALOR TOTAL', W - M, y, { align: 'right' });
  doc.setTextColor(...tinta); doc.setFont('helvetica', 'bold'); doc.setFontSize(14);
  doc.text(pdfTxt(c.nome), M, y + 7);
  doc.setFontSize(18); doc.text(fmtUSD(r.total), W - M, y + 8, { align: 'right' });
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...cinza);
  if (c.email) doc.text(pdfTxt(c.email), M, y + 12.5);
  if (!aprovado) {
    doc.setTextColor(179, 38, 30); doc.setFont('helvetica', 'bold');
    doc.text(f.aprovacao ? 'ATENÇÃO: problema apontado na aprovação final' : 'ATENÇÃO: pagamento ainda sem aprovação final', W - M, y + 14, { align: 'right' });
  }
  y += 20;

  // resumo de valores
  const corpo = r.linhas.map((l) => [pdfTxt(l.descricao), String(l.quantidade),
    l.valorUnit == null ? (l.livre && l.percentual < 100 ? `${l.percentual}% de ${fmtUSD(l.cobrado)}` : 'variável') : fmtUSD(l.valorUnit), fmtUSD(l.total)]);
  ajustes.forEach((a) => corpo.push([pdfTxt('Ajuste: ' + a.descricao), '', '', fmtUSD(a.valor)]));
  doc.autoTable({
    startY: y, margin: { left: M, right: M }, theme: 'grid',
    head: [['Resumo de valores', 'Qtd', 'Valor unit.', 'Total']], body: corpo,
    foot: [['Total a receber', '', '', fmtUSD(r.total)]],
    styles: { font: 'helvetica', fontSize: 9, cellPadding: 2.2, textColor: tinta, lineColor: [219, 226, 223], lineWidth: 0.2 },
    headStyles: { fillColor: [226, 241, 237], textColor: verde, fontStyle: 'bold' },
    footStyles: { fillColor: [243, 245, 243], textColor: tinta, fontStyle: 'bold', fontSize: 10 },
    columnStyles: { 1: { halign: 'right', cellWidth: 16 }, 2: { halign: 'right', cellWidth: 34 }, 3: { halign: 'right', cellWidth: 28 } },
    didParseCell: (h) => { if (h.section !== 'body' && h.column.index > 0) h.cell.styles.halign = 'right'; },
  });
  y = doc.lastAutoTable.finalY + 7;

  // sessões do mês (aprovadas)
  const aprovadas = sessoes.filter((s) => s.status === 'aprovada');
  doc.autoTable({
    startY: y, margin: { left: M, right: M }, theme: 'striped',
    head: [['Data', 'Cliente', 'Tipo', 'Serviço', 'Qtd']],
    body: aprovadas.map((s) => {
      const cl = mapa.get(s.clienteId), ex = extraDe(cfg, s.servico);
      let serv = nomeServico(cfg, s.servico);
      if (ex?.livre && Number(s.valorInformado) > 0) serv += ` (cobrado ${fmtUSD(s.valorInformado)}; pago ${fmtUSD(valorPagoUnit(ex, s.valorInformado))})`;
      const ct = s.contratoId && contrato(s.contratoId), fx = usoContratos().faixa.get(s.id);
      if (ct) serv += ` - contrato ${ct.numero}, sessão ${fx ? (fx.fim > fx.ini ? fx.ini + ' a ' + fx.fim : fx.ini) : '?'} de ${ct.sessoesContratadas}`;
      return [fmtDiaAno(s.data), pdfTxt(cl?.nome || s.clienteNome), ct ? 'Contrato' : Number(cl?.valorSessao) > 0 ? 'Especial' : (cl?.tipo || ''), pdfTxt(serv), String(s.quantidade)];
    }),
    styles: { font: 'helvetica', fontSize: 8.5, cellPadding: 1.8, textColor: tinta },
    headStyles: { fillColor: verde, textColor: 255 },
    columnStyles: { 0: { cellWidth: 22 }, 2: { cellWidth: 16 }, 4: { halign: 'right', cellWidth: 12 } },
    didParseCell: (h) => { if (h.section === 'head' && h.column.index === 4) h.cell.styles.halign = 'right'; },
  });
  y = doc.lastAutoTable.finalY + 8;

  // trilha de conferência e aprovação
  if (y > 230) { doc.addPage(); y = 20; }
  doc.autoTable({
    startY: y, margin: { left: M, right: M }, theme: 'plain',
    head: [['Etapa', 'Responsável e data']],
    body: etapasTexto(f).map(([a, b]) => [pdfTxt(a), pdfTxt(b)]),
    styles: { font: 'helvetica', fontSize: 9, cellPadding: 1.8, textColor: tinta },
    headStyles: { textColor: verde, fontStyle: 'bold' }, columnStyles: { 0: { cellWidth: 48, fontStyle: 'bold' } },
  });
  y = doc.lastAutoTable.finalY + 10;

  // declaração e assinatura
  if (y > 245) { doc.addPage(); y = 24; }
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(...tinta);
  const decl = doc.splitTextToSize(pdfTxt(`Declaro ter recebido o valor de ${fmtUSD(r.total)} referente às sessões de coaching realizadas em ${mesLabel(mes)}, conforme o resumo acima.`), W - 2 * M);
  doc.text(decl, M, y);
  y += decl.length * 5 + 16;
  doc.setDrawColor(...cinza); doc.line(M, y, M + 80, y); doc.line(W - M - 60, y, W - M, y);
  doc.setFontSize(8.5); doc.setTextColor(...cinza);
  doc.text(pdfTxt(`${c.nome} (coach)`), M, y + 4.5); doc.text('Data', W - M - 60, y + 4.5);

  // rodapé em todas as páginas
  const total = doc.getNumberOfPages();
  for (let i = 1; i <= total; i++) {
    doc.setPage(i); doc.setFontSize(7.5); doc.setTextColor(...cinza);
    doc.text(pdfTxt(`Emitido em ${new Date().toLocaleString('pt-BR')} por ${S.perfil.nome} - ${NOME_SISTEMA}`), M, 290);
    doc.text(`${i} / ${total}`, W - M, 290, { align: 'right' });
  }
  baixar(doc.output('blob'), `recibo_${slug(c.nome)}_${mes}.pdf`);
  toast('Recibo gerado.');
}

// ============================================================ eventos (delegação)
$app.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-acao]');
  if (!el || !acoes[el.dataset.acao]) return;
  if (el.type === 'checkbox') { acoes[el.dataset.acao](el.dataset, el, ev); return; }
  if (el.dataset.acao === 'fundoModal' && ev.target !== el) return;
  ev.preventDefault();
  if (S.verComo && ['modal', 'excluir', 'reenviar'].includes(el.dataset.acao)) return toast('Modo "ver como coach": é só visualização.', true);
  acoes[el.dataset.acao](el.dataset, el, ev);
});
$app.addEventListener('submit', async (ev) => {
  const f = ev.target.closest('form[data-form]');
  if (!f || !forms[f.dataset.form]) return;
  ev.preventDefault();
  if (S.verComo) return toast('Modo "ver como coach": é só visualização, nada foi enviado.', true);
  const btn = f.querySelector('button[type="submit"]');
  if (btn?.disabled) return;
  if (btn) btn.disabled = true;
  try { await forms[f.dataset.form](f); } finally { const b = document.contains(btn) ? btn : null; if (b) b.disabled = false; }
});
$app.addEventListener('input', (ev) => {
  const id = ev.target.id;
  if (ev.target.dataset.input === 'ctBusca') { S.ctBusca = ev.target.value; render(); return; }
  if (['ct-total', 'ct-pct', 'ct-sessoes'].includes(id)) { const el = document.getElementById('ct-calc'); if (el) el.textContent = calcContratoTexto(val('ct-total'), val('ct-pct'), val('ct-sessoes')); return; }
  const par = { 'f-valor': ['f-calc', 'f-qtd', 'f-servico', () => cfgCoach(S.perfil)], 'f-qtd': ['f-calc', 'f-qtd', 'f-servico', () => cfgCoach(S.perfil)],
    'eb-valor': ['eb-calc', 'eb-qtd', 'eb-servico', () => cfgCoach(usuario(S.sessoes.find((x) => x.id === S.modal?.id)?.coachId))],
    'eb-qtd': ['eb-calc', 'eb-qtd', 'eb-servico', () => cfgCoach(usuario(S.sessoes.find((x) => x.id === S.modal?.id)?.coachId))] }[id];
  if (!par) return;
  const [alvo, qtdId, servId, cfgFn] = par;
  const el = document.getElementById(alvo);
  if (!el) return;
  const valorId = alvo === 'f-calc' ? 'f-valor' : 'eb-valor';
  el.textContent = textoCalculo(extraDe(cfgFn(), val(servId)), val(valorId), parseInt(val(qtdId), 10) || 1);
});
$app.addEventListener('change', async (ev) => {
  const el = ev.target;
  const k = el.dataset.change;
  if (k === 'servico') { S.servicoSel = el.value; render(); }
  else if (k === 'servicoBia') { S.modal.servico = el.value; render(); }
  else if (k === 'cliente') { S.novoCliente = el.value === '__novo'; S.clienteSel = el.value; S.contratoSel = ''; render(); if (S.novoCliente) document.getElementById('f-novo')?.focus(); }
  else if (k === 'contrato') { S.contratoSel = el.value; render(); }
  else if (k === 'ctFiltro') { S.ctCoach = el.value; render(); }
  else if (k === 'exigirContrato') { await tentar(() => B.db.set('config', 'sistema', { exigirContrato: el.checked }, true), el.checked ? 'Contrato passa a ser obrigatório para lançar sessões.' : 'Contrato deixa de ser obrigatório.'); }
  else if (k === 'clienteBia') { S.modal.cliente = el.value; S.modal.contrato = ''; render(); }
  else if (k === 'contratoBia') { S.modal.contrato = el.value; render(); }
  else if (k === 'ctCoach') { S.modal.coach = el.value; S.modal.cliente = ''; S.modal.servico = 'sessao'; render(); }
  else if (k === 'ctServico') { S.modal.servico = el.value; render(); }
  else if (k === 'ctForma') { S.modal.forma = el.value; render(); }
  else if (k === 'ctCliente') { S.modal.cliente = el.value; render(); }
  else if (k === 'coach') { S.coachSel = el.value; S.sel.clear(); render(); }
  else if (k === 'tipoCliente') { await tentar(() => B.db.update('clientes', el.dataset.id, { tipo: el.value, tipoConfirmado: true }), 'Tipo do cliente atualizado.'); }
});
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && S.modal) acoes.fecharModal(); });
