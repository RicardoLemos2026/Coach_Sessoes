// Regras de pagamento dos coaches — módulo puro (sem Firebase), testável isoladamente.
// Valores em dólar. Todas as contas são feitas em centavos para evitar erro de arredondamento.

export const CONFIG_PADRAO = {
  valorA: 80,            // valor por sessão de cliente Tipo A
  valorB: 90,            // valor por sessão de cliente Tipo B
  limiteA: 10,           // os N primeiros clientes da carteira são Tipo A (0 = tipo definido manualmente)
  bonusRecorrencia: 10,  // bônus por cliente com minSessoesBonus ou mais sessões no mês
  minSessoesBonus: 2,
  bonusAtivo: 10,        // bônus por cliente ativo (cliente distinto atendido no mês)
  extras: [],            // serviços com valor próprio: [{id, nome, valor, livre, percentual}]
                         // livre = o coach digita o valor cobrado do cliente; percentual = parte desse valor paga ao coach
};

const c = (v) => Math.round(Number(v || 0) * 100);
export const dinheiro = (cent) => cent / 100;

// Regra da casa: no Perfil comportamental o coach recebe 70% do valor cobrado,
// a menos que a tabela de valores defina outro percentual para o coach.
export const PERCENTUAL_PADRAO = { 'perfil-comportamental': 70 };

export function cfgCoach(u) {
  const cfg = { ...CONFIG_PADRAO, ...(u?.config || {}) };
  cfg.extras = (cfg.extras || []).map((e) => (e.livre && e.percentual == null && PERCENTUAL_PADRAO[e.id] != null
    ? { ...e, percentual: PERCENTUAL_PADRAO[e.id] } : e));
  return cfg;
}

/** Percentual pago ao coach num serviço de valor livre (100 quando não há regra). */
export const percentualDe = (ex) => (ex && ex.livre && Number(ex.percentual) > 0 ? Number(ex.percentual) : 100);

/** Valor pago ao coach por unidade de um serviço de valor livre, em dólares (arredondado ao centavo). */
export const valorPagoUnit = (ex, valorCobrado) => dinheiro(Math.round(c(valorCobrado) * percentualDe(ex) / 100));

/** Tipo sugerido para um cliente novo, conforme a regra da carteira. */
export function tipoSugerido(cfg, clientesDoCoach) {
  if (!cfg.limiteA) return 'A';
  const ativos = clientesDoCoach.filter((x) => x.ativo !== false).length;
  return ativos < cfg.limiteA ? 'A' : 'B';
}

/**
 * Calcula o pagamento de um coach num mês.
 * @param cfg       configuração do coach (cfgCoach)
 * @param clientes  Map/obj clienteId -> {tipo, nome}
 * @param sessoes   sessões do mês a considerar (já filtradas por status)
 * @param ajustes   [{descricao, valor}] (valor pode ser negativo)
 * @param contratos Map/obj contratoId -> {numero, nome, clienteNome, valorSessao}: sessão com contrato paga o valor do contrato
 */
export function calcularPagamento(cfg, clientes, sessoes, ajustes = [], contratos = null) {
  const getCt = (id) => (!id || !contratos ? null : (contratos instanceof Map ? contratos.get(id) : contratos[id]) || null);
  const get = (id) => (clientes instanceof Map ? clientes.get(id) : clientes[id]) || {};
  let qA = 0, qB = 0;
  const especiais = new Map();    // clienteId -> {q, valor, nome}: cliente com valor por sessão próprio
  const porContrato = new Map();  // contratoId -> {q, valor, nome}: sessões pagas pelo valor do contrato
  const porCliente = new Map();   // clienteId -> qtd de sessões (serviço "sessão")
  const extras = new Map();       // extraId -> qtd
  const livres = new Map();       // extraId -> {c: centavos somados, valores: Set}
  let semTipo = 0, semValor = 0;
  const extraDe = (id) => (cfg.extras || []).find((e) => e.id === id);
  const livre = (id) => !!extraDe(id)?.livre;

  for (const s of sessoes) {
    const q = Number(s.quantidade || 0);
    if (!q) continue;
    const ct = getCt(s.contratoId);
    if (ct) {
      // sessão de contrato: paga o valor por sessão do contrato (qualquer serviço).
      // valorUltimaSessao: a última sessão do contrato absorve a diferença de arredondamento (valor × % ÷ sessões).
      const nome = `Contrato ${ct.numero}${ct.clienteNome || get(s.clienteId).nome ? ' · ' + (ct.clienteNome || get(s.clienteId).nome) : ''}`;
      const ult = s.ultimaContrato && ct.valorUltimaSessao != null && Math.round(Number(ct.valorUltimaSessao) * 100) !== Math.round(Number(ct.valorSessao) * 100) ? 1 : 0;
      if (q - ult) {
        const e = porContrato.get(s.contratoId) || { q: 0, valor: Number(ct.valorSessao) || 0, nome };
        e.q += q - ult; porContrato.set(s.contratoId, e);
      }
      if (ult) {
        const k = s.contratoId + '#u';
        const e = porContrato.get(k) || { q: 0, valor: Number(ct.valorUltimaSessao) || 0, nome: nome + ' · última sessão (inclui arredondamento)', ultima: true };
        e.q += 1; porContrato.set(k, e);
      }
      // só o serviço "sessão" conta para os bônus
      if (!s.servico || s.servico === 'sessao') porCliente.set(s.clienteId, (porCliente.get(s.clienteId) || 0) + q);
      continue;
    }
    if (s.servico && s.servico !== 'sessao') {
      extras.set(s.servico, (extras.get(s.servico) || 0) + q);
      if (livre(s.servico)) {
        const v = Number(s.valorInformado);
        if (!(v > 0)) semValor += q;
        const l = livres.get(s.servico) || { c: 0, cobrado: 0, valores: new Set() };
        const pago = v > 0 ? valorPagoUnit(extraDe(s.servico), v) : 0;
        l.c += c(pago) * q; l.cobrado += c(v > 0 ? v : 0) * q; l.valores.add(pago);
        livres.set(s.servico, l);
      }
      continue;
    }
    const cli = get(s.clienteId);
    const esp = Number(cli.valorSessao);
    if (esp > 0) {
      const e = especiais.get(s.clienteId) || { q: 0, valor: esp, nome: cli.nome || s.clienteNome || '' };
      e.q += q; especiais.set(s.clienteId, e);
    } else {
      const tipo = cli.tipo;
      if (tipo === 'B') qB += q; else { qA += q; if (tipo !== 'A') semTipo += q; }
    }
    porCliente.set(s.clienteId, (porCliente.get(s.clienteId) || 0) + q);
  }

  const recorrentes = [...porCliente.values()].filter((q) => q >= Number(cfg.minSessoesBonus || 2)).length;
  const ativos = porCliente.size;

  const linhas = [];
  const add = (descricao, valorUnit, quantidade, chave) => {
    if (!quantidade) return;
    linhas.push({ chave, descricao, valorUnit, quantidade, total: dinheiro(c(valorUnit) * quantidade) });
  };
  add('Sessão — cliente Tipo A', Number(cfg.valorA), qA, 'A');
  add('Sessão — cliente Tipo B', Number(cfg.valorB), qB, 'B');
  for (const [id, e] of porContrato) add(`Sessão — ${e.nome}`, e.valor, e.q, e.ultima ? 'ctu:' + id.slice(0, -2) : 'ct:' + id);
  for (const [id, e] of especiais) add(`Sessão — ${e.nome} (valor especial)`, e.valor, e.q, 'cli:' + id);
  for (const ex of cfg.extras || []) {
    const q = extras.get(ex.id) || 0;
    if (!q) continue;
    if (ex.livre) {
      const l = livres.get(ex.id);
      // valorUnit = null quando os valores digitados variam entre os lançamentos
      const pct = percentualDe(ex);
      linhas.push({ chave: 'extra:' + ex.id, descricao: pct < 100 ? `${ex.nome} (${pct}% do valor cobrado)` : ex.nome, livre: true,
        percentual: pct, cobrado: dinheiro(l.cobrado),
        valorUnit: l.valores.size === 1 ? [...l.valores][0] : null, quantidade: q, total: dinheiro(l.c) });
    } else add(ex.nome, Number(ex.valor), q, 'extra:' + ex.id);
  }
  for (const [id, q] of extras) {
    if (!(cfg.extras || []).some((e) => e.id === id)) add(`Serviço removido da configuração (${id})`, 0, q, 'extra:' + id);
  }
  add(`Bônus cliente com ${cfg.minSessoesBonus}+ sessões no mês`, Number(cfg.bonusRecorrencia), recorrentes, 'bonusRec');
  add('Bônus por cliente ativo', Number(cfg.bonusAtivo), ativos, 'bonusAtivo');

  const subtotalC = linhas.reduce((a, l) => a + c(l.total), 0);
  const ajustesC = (ajustes || []).reduce((a, x) => a + c(x.valor), 0);
  return {
    linhas,
    sessoes: qA + qB + [...especiais.values(), ...porContrato.values()].reduce((a, e) => a + e.q, 0) + [...extras.values()].reduce((a, b) => a + b, 0),
    sessoesA: qA, sessoesB: qB, recorrentes, ativos, semTipo, semValor,
    subtotal: dinheiro(subtotalC),
    ajustes: dinheiro(ajustesC),
    total: dinheiro(subtotalC + ajustesC),
  };
}

/**
 * Valores de um contrato a partir do valor total, % do coach e nº de sessões (tudo em centavos, sem perda):
 * participação = valor × % ; valor por sessão = participação ÷ sessões (centavos para baixo);
 * a última sessão recebe o que sobra, para a soma das sessões bater exatamente com a participação.
 */
export function valoresContrato(valorContrato, percentual, sessoes) {
  const n = Math.max(1, parseInt(sessoes, 10) || 1);
  const partC = Math.round(c(valorContrato) * Number(percentual) / 100);
  const unitC = Math.floor(partC / n);
  const ultC = partC - unitC * (n - 1);
  return { participacao: dinheiro(partC), valorSessao: dinheiro(unitC), valorUltimaSessao: dinheiro(ultC), exato: ultC === unitC };
}

export const fmtUSD = (v) =>
  '$' + Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
