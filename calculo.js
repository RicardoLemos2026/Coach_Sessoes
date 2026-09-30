// Regras de pagamento dos coaches — módulo puro (sem Firebase), testável isoladamente.
// Valores em dólar. Todas as contas são feitas em centavos para evitar erro de arredondamento.

export const CONFIG_PADRAO = {
  valorA: 80,            // valor por sessão de cliente Tipo A
  valorB: 90,            // valor por sessão de cliente Tipo B
  limiteA: 10,           // os N primeiros clientes da carteira são Tipo A (0 = tipo definido manualmente)
  bonusRecorrencia: 10,  // bônus por cliente com minSessoesBonus ou mais sessões no mês
  minSessoesBonus: 2,
  bonusAtivo: 10,        // bônus por cliente ativo (cliente distinto atendido no mês)
  extras: [],            // serviços com valor próprio: [{id, nome, valor, livre}]; livre = valor digitado em cada lançamento
};

const c = (v) => Math.round(Number(v || 0) * 100);
export const dinheiro = (cent) => cent / 100;

export function cfgCoach(u) {
  return { ...CONFIG_PADRAO, ...(u?.config || {}) };
}

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
 */
export function calcularPagamento(cfg, clientes, sessoes, ajustes = []) {
  const get = (id) => (clientes instanceof Map ? clientes.get(id) : clientes[id]) || {};
  let qA = 0, qB = 0;
  const especiais = new Map();    // clienteId -> {q, valor, nome}: cliente com valor por sessão próprio
  const porCliente = new Map();   // clienteId -> qtd de sessões (serviço "sessão")
  const extras = new Map();       // extraId -> qtd
  const livres = new Map();       // extraId -> {c: centavos somados, valores: Set}
  let semTipo = 0, semValor = 0;
  const livre = (id) => (cfg.extras || []).some((e) => e.id === id && e.livre);

  for (const s of sessoes) {
    const q = Number(s.quantidade || 0);
    if (!q) continue;
    if (s.servico && s.servico !== 'sessao') {
      extras.set(s.servico, (extras.get(s.servico) || 0) + q);
      if (livre(s.servico)) {
        const v = Number(s.valorInformado);
        if (!(v > 0)) semValor += q;
        const l = livres.get(s.servico) || { c: 0, valores: new Set() };
        l.c += c(v > 0 ? v : 0) * q; l.valores.add(v > 0 ? v : 0);
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
  for (const [id, e] of especiais) add(`Sessão — ${e.nome} (valor especial)`, e.valor, e.q, 'cli:' + id);
  for (const ex of cfg.extras || []) {
    const q = extras.get(ex.id) || 0;
    if (!q) continue;
    if (ex.livre) {
      const l = livres.get(ex.id);
      // valorUnit = null quando os valores digitados variam entre os lançamentos
      linhas.push({ chave: 'extra:' + ex.id, descricao: ex.nome, livre: true,
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
    sessoes: qA + qB + [...especiais.values()].reduce((a, e) => a + e.q, 0) + [...extras.values()].reduce((a, b) => a + b, 0),
    sessoesA: qA, sessoesB: qB, recorrentes, ativos, semTipo, semValor,
    subtotal: dinheiro(subtotalC),
    ajustes: dinheiro(ajustesC),
    total: dinheiro(subtotalC + ajustesC),
  };
}

export const fmtUSD = (v) =>
  '$' + Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
