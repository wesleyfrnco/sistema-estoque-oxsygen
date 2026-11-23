/**
 * oxsygen · API de estoque
 * Cloudflare Worker + D1
 *
 * Rotas
 *   GET    /api/saude                 → status e se já tem dono cadastrado
 *   GET    /api/vitrine               → público: preço e estoque por referência/cor/tamanho (loja)
 *   POST   /api/checkout              → público: registra a finalização do site e manda InitiateCheckout à Meta
 *   POST   /api/instalar              → cria o primeiro dono (só funciona com o banco vazio)
 *   POST   /api/entrar                → troca PIN por token
 *   POST   /api/sair                  → encerra a sessão
 *   GET    /api/estado                → produtos + movimentos + quem sou eu
 *   POST   /api/produtos              → cria ou atualiza peça (dono)
 *   DELETE /api/produtos/:id          → arquiva peça (dono)
 *   POST   /api/movimentos            → venda, entrada ou ajuste (atômico)
 *   DELETE /api/movimentos/:id        → desfaz movimento (dono)
 *   POST   /api/pedidos               → gera pedido com várias peças e dá baixa (atômico)
 *   POST   /api/pedidos/:id           → muda o status do pedido (cancelar devolve ao estoque, dono)
 *   PUT    /api/pedidos/:id           → edita o pedido (desfaz o antigo e grava o novo, atômico)
 *   POST   /api/pedidos/:id/pagamentos      → registra um valor recebido (quitou → status pago)
 *   DELETE /api/pedidos/:id/pagamentos/:pid → remove um pagamento lançado errado (dono)
 *   (pedido pago, enviado ou entregue → manda Purchase à Meta pela API de Conversões, uma vez)
 *   POST   /api/precos/reajustar      → aplica o markup sobre o custo em todas as peças (dono)
 *   GET    /api/equipe                → lista pessoas (dono)
 *   POST   /api/equipe                → cadastra pessoa (dono)
 *   DELETE /api/equipe/:id            → desativa pessoa (dono)
 */

const DIAS_SESSAO = 30;
const MAX_FALHAS = 8;
const JANELA_FALHAS = 10 * 60 * 1000;

/* ---------- estrutura do banco (autocorreção) ----------
   Na primeira requisição de cada instância, confere tabelas e colunas
   e cria o que faltar. Assim nenhuma migração esquecida derruba o sistema. */

let esquemaOk = false;

const TABELAS_NOVAS = [
  `CREATE TABLE IF NOT EXISTS cupons (codigo TEXT PRIMARY KEY, pessoa TEXT DEFAULT '', comissao REAL NOT NULL DEFAULT 0,
     desconto REAL NOT NULL DEFAULT 0, ativo INTEGER NOT NULL DEFAULT 1, criado_em TEXT NOT NULL DEFAULT '')`,
  `CREATE TABLE IF NOT EXISTS mapa_itens (cprod TEXT PRIMARY KEY, nome TEXT NOT NULL, cor TEXT DEFAULT '',
     tam TEXT DEFAULT '', visto_em TEXT DEFAULT '')`,
  `CREATE TABLE IF NOT EXISTS notas (chave TEXT PRIMARY KEY, numero TEXT DEFAULT '', emitente TEXT DEFAULT '',
     itens INTEGER DEFAULT 0, pecas INTEGER DEFAULT 0, valor REAL DEFAULT 0, importada_em TEXT NOT NULL, usuario TEXT DEFAULT '')`,
  `CREATE TABLE IF NOT EXISTS pedidos (id TEXT PRIMARY KEY, numero INTEGER NOT NULL, ts TEXT NOT NULL, cliente TEXT NOT NULL,
     telefone TEXT DEFAULT '', cupom TEXT DEFAULT '', origem TEXT DEFAULT '', pagamento TEXT DEFAULT '',
     status TEXT NOT NULL DEFAULT 'aguardando', obs TEXT DEFAULT '', itens TEXT NOT NULL DEFAULT '[]',
     total REAL NOT NULL DEFAULT 0, usuario TEXT DEFAULT '', criado_em TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS checkouts (codigo TEXT PRIMARY KEY, ts TEXT NOT NULL, event_id TEXT DEFAULT '',
     fbp TEXT DEFAULT '', fbc TEXT DEFAULT '', ip TEXT DEFAULT '', ua TEXT DEFAULT '', url TEXT DEFAULT '',
     nome TEXT DEFAULT '', cep TEXT DEFAULT '', valor REAL DEFAULT 0, itens TEXT DEFAULT '[]', capi TEXT DEFAULT '')`
];

const COLUNAS_NOVAS = {
  movimentos: [['unit_cheio', 'REAL DEFAULT 0'], ['cupom', "TEXT DEFAULT ''"], ['comissao_pct', 'REAL DEFAULT 0'],
               ['origem', "TEXT DEFAULT ''"], ['pedido_id', "TEXT DEFAULT ''"]],
  produtos:   [['ref', "TEXT DEFAULT ''"], ['cor_cod', "TEXT DEFAULT ''"]],
  variacoes:  [['sku', "TEXT DEFAULT ''"], ['ean', "TEXT DEFAULT ''"]],
  pedidos:    [['codigo_site', "TEXT DEFAULT ''"], ['capi', "TEXT DEFAULT ''"], ['pagamentos', "TEXT DEFAULT '[]'"]]
};

const INDICES_NOVOS = [
  'CREATE INDEX IF NOT EXISTS idx_movimentos_cupom ON movimentos(cupom)',
  'CREATE INDEX IF NOT EXISTS idx_movimentos_origem ON movimentos(origem)',
  'CREATE INDEX IF NOT EXISTS idx_movimentos_pedido ON movimentos(pedido_id)',
  'CREATE INDEX IF NOT EXISTS idx_produtos_ref ON produtos(ref, cor_cod)',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_pedidos_numero ON pedidos(numero)',
  'CREATE INDEX IF NOT EXISTS idx_pedidos_ts ON pedidos(ts DESC)',
  'CREATE INDEX IF NOT EXISTS idx_checkouts_ts ON checkouts(ts DESC)'
];

async function garantirEsquema(env) {
  if (esquemaOk) return;
  for (const sql of TABELAS_NOVAS) await env.DB.prepare(sql).run();
  for (const [tabela, colunas] of Object.entries(COLUNAS_NOVAS)) {
    const info = (await env.DB.prepare(`PRAGMA table_info(${tabela})`).all()).results || [];
    const existentes = new Set(info.map(c => c.name));
    for (const [nome, tipo] of colunas) {
      if (existentes.has(nome)) continue;
      try {
        await env.DB.prepare(`ALTER TABLE ${tabela} ADD COLUMN ${nome} ${tipo}`).run();
      } catch (e) {
        if (!/duplicate column/i.test(String(e && e.message))) throw e;   // outra instância criou antes
      }
    }
  }
  for (const sql of INDICES_NOVOS) await env.DB.prepare(sql).run();
  esquemaOk = true;
}

/* ---------- utilidades ---------- */

function cors(env, req) {
  const permitidas = (env.ORIGENS || '*').split(',').map(s => s.trim()).filter(Boolean);
  const origem = req.headers.get('Origin') || '';
  const liberada = permitidas.includes('*') ? (origem || '*')
    : (permitidas.includes(origem) ? origem : permitidas[0] || '');
  return {
    'Access-Control-Allow-Origin': liberada,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function json(dados, status, cabecalhos) {
  return new Response(JSON.stringify(dados), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, cabecalhos || {})
  });
}

const erro = (msg, status, h) => json({ erro: msg }, status || 400, h);
const agora = () => new Date().toISOString();
const novoId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 16);

async function hashPin(pin, env) {
  const dados = new TextEncoder().encode((env.SEGREDO || 'oxsygen') + ':' + String(pin));
  const buf = await crypto.subtle.digest('SHA-256', dados);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function usuarioDaRequisicao(req, env) {
  const cab = req.headers.get('Authorization') || '';
  const token = cab.startsWith('Bearer ') ? cab.slice(7) : '';
  if (!token) return null;
  const linha = await env.DB.prepare(
    `SELECT u.id, u.nome, u.papel, s.expira_em
       FROM sessoes s JOIN usuarios u ON u.id = s.usuario_id
      WHERE s.token = ? AND u.ativo = 1`
  ).bind(token).first();
  if (!linha) return null;
  if (linha.expira_em < agora()) {
    await env.DB.prepare('DELETE FROM sessoes WHERE token = ?').bind(token).run();
    return null;
  }
  return { id: linha.id, nome: linha.nome, papel: linha.papel, token };
}

const ehDono = u => u && u.papel === 'dono';

/* ---------- controle de tentativas ---------- */

async function bloqueado(ip, env) {
  const r = await env.DB.prepare('SELECT falhas, ate FROM tentativas WHERE ip = ?').bind(ip).first();
  if (!r) return false;
  if (r.ate < agora()) {
    await env.DB.prepare('DELETE FROM tentativas WHERE ip = ?').bind(ip).run();
    return false;
  }
  return r.falhas >= MAX_FALHAS;
}

async function registrarFalha(ip, env) {
  const ate = new Date(Date.now() + JANELA_FALHAS).toISOString();
  await env.DB.prepare(
    `INSERT INTO tentativas (ip, falhas, ate) VALUES (?, 1, ?)
     ON CONFLICT(ip) DO UPDATE SET falhas = falhas + 1, ate = excluded.ate`
  ).bind(ip, ate).run();
}

/* ---------- leitura do estado ---------- */

async function lerEstado(env, usuario, limite) {
  const dono = ehDono(usuario);

  const [produtosRes, variacoesRes, movimentosRes, cuponsRes] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM produtos WHERE arquivado = 0 ORDER BY nome'),
    env.DB.prepare('SELECT * FROM variacoes ORDER BY produto_id, ordem, tam'),
    env.DB.prepare('SELECT * FROM movimentos ORDER BY ts DESC LIMIT ?').bind(Math.min(5000, Math.max(1, parseInt(limite, 10) || 300))),
    env.DB.prepare('SELECT * FROM cupons ORDER BY ativo DESC, codigo')
  ]);

  let pedidosRes = { results: [] };
  try {
    pedidosRes = await env.DB.prepare('SELECT * FROM pedidos ORDER BY ts DESC, numero DESC LIMIT 500').all();
  } catch (e) { /* migracao-pedidos.sql ainda não aplicada */ }

  // custo médio ponderado e último custo pago, a partir das entradas com custo
  const custos = {};
  if (dono) {
    try {
      const [mediaRes, ultimoRes] = await env.DB.batch([
        env.DB.prepare(
          `SELECT produto_id, SUM(qtd * custo_unit) AS total, SUM(qtd) AS pecas
             FROM movimentos WHERE tipo = 'entrada' AND custo_unit > 0 AND qtd > 0
            GROUP BY produto_id`),
        env.DB.prepare(
          `SELECT m.produto_id, m.custo_unit, m.ts FROM movimentos m
            WHERE m.tipo = 'entrada' AND m.custo_unit > 0 AND m.qtd > 0
              AND m.ts = (SELECT MAX(ts) FROM movimentos
                           WHERE produto_id = m.produto_id AND tipo = 'entrada' AND custo_unit > 0 AND qtd > 0)`)
      ]);
      (mediaRes.results || []).forEach(r => {
        custos[r.produto_id] = { medio: r.pecas ? Math.round(r.total / r.pecas * 100) / 100 : null, pecas: r.pecas || 0 };
      });
      (ultimoRes.results || []).forEach(r => {
        const c = custos[r.produto_id] = custos[r.produto_id] || {};
        c.ultimo = r.custo_unit; c.ultimoEm = r.ts;
      });
    } catch (e) { console.error('custos:', e && e.message); }
  }

  const porProduto = {};
  (variacoesRes.results || []).forEach(v => {
    (porProduto[v.produto_id] = porProduto[v.produto_id] || []).push({ tam: v.tam, qtd: v.qtd, sku: v.sku || '', ean: v.ean || '' });
  });

  const produtos = (produtosRes.results || []).map(p => ({
    id: p.id,
    nome: p.nome,
    cor: p.cor || '',
    corHex: p.cor_hex || '#DDD2CA',
    ref: p.ref || '',
    corCod: p.cor_cod || '',
    custo: dono ? p.custo : null,
    custoUltimo: dono && custos[p.id] ? (custos[p.id].ultimo ?? null) : null,
    custoUltimoEm: dono && custos[p.id] ? (custos[p.id].ultimoEm ?? null) : null,
    custoMedio: dono && custos[p.id] ? (custos[p.id].medio ?? null) : null,
    pecasCompradas: dono && custos[p.id] ? (custos[p.id].pecas || 0) : 0,
    preco: p.preco,
    minimo: p.minimo,
    grade: porProduto[p.id] || []
  }));

  const movimentos = (movimentosRes.results || []).map(m => ({
    id: m.id,
    ts: m.ts,
    tipo: m.tipo,
    produtoId: m.produto_id,
    nome: m.nome,
    tam: m.tam,
    qtd: m.qtd,
    unit: m.unit,
    unitCheio: m.unit_cheio || m.unit,
    cupom: m.cupom || '',
    origem: m.origem || '',
    pedidoId: m.pedido_id || '',
    comissaoPct: dono ? (m.comissao_pct || 0) : null,
    custoUnit: dono ? m.custo_unit : null,
    usuario: m.usuario
  }));

  const cupons = (cuponsRes.results || []).map(c => ({
    codigo: c.codigo,
    pessoa: c.pessoa || '',
    comissao: dono ? c.comissao : null,
    desconto: c.desconto,
    ativo: !!c.ativo
  }));

  const pedidos = (pedidosRes.results || []).map(p => {
    let itens = [];
    try { itens = JSON.parse(p.itens || '[]'); } catch (e) { /* mantém vazio */ }
    return { id: p.id, numero: p.numero, ts: p.ts, cliente: p.cliente, telefone: p.telefone || '',
             cupom: p.cupom || '', origem: p.origem || '', pagamento: p.pagamento || '',
             status: p.status, obs: p.obs || '', itens, total: p.total, usuario: p.usuario || '',
             codigoSite: p.codigo_site || '', capi: p.capi || '', pagamentos: lerPagamentos(p) };
  });

  return { produtos, movimentos, cupons, pedidos, eu: { nome: usuario.nome, papel: usuario.papel } };
}

/* ---------- produtos ---------- */

async function salvarProduto(corpo, env) {
  const nome = String(corpo.nome || '').trim();
  if (!nome) return erro('Informe o nome da peça.');
  const grade = Array.isArray(corpo.grade) ? corpo.grade.filter(g => String(g.tam || '').trim()) : [];
  if (!grade.length) return erro('Informe ao menos um tamanho.');

  const ref = String(corpo.ref || '').trim().toUpperCase().slice(0, 30);
  const id = corpo.id || novoId();
  const existe = corpo.id
    ? await env.DB.prepare('SELECT id FROM produtos WHERE id = ?').bind(corpo.id).first()
    : null;

  const comandos = [];
  if (existe) {
    comandos.push(env.DB.prepare(
      'UPDATE produtos SET nome=?, cor=?, cor_hex=?, ref=?, custo=?, preco=?, minimo=? WHERE id=?'
    ).bind(nome, corpo.cor || '', corpo.corHex || '#DDD2CA', ref,
           Number(corpo.custo) || 0, Number(corpo.preco) || 0, Number(corpo.minimo) || 0, id));
  } else {
    comandos.push(env.DB.prepare(
      'INSERT INTO produtos (id, nome, cor, cor_hex, ref, custo, preco, minimo, arquivado) VALUES (?,?,?,?,?,?,?,?,0)'
    ).bind(id, nome, corpo.cor || '', corpo.corHex || '#DDD2CA', ref,
           Number(corpo.custo) || 0, Number(corpo.preco) || 0, Number(corpo.minimo) || 0));
  }

  const tamanhos = grade.map(g => String(g.tam).trim());
  const marcadores = tamanhos.map(() => '?').join(',');
  comandos.push(env.DB.prepare(
    `DELETE FROM variacoes WHERE produto_id = ? AND tam NOT IN (${marcadores})`
  ).bind(id, ...tamanhos));

  grade.forEach((g, i) => {
    const tam = String(g.tam).trim();
    const qtd = Math.max(0, parseInt(g.qtd, 10) || 0);
    comandos.push(env.DB.prepare(
      `INSERT INTO variacoes (produto_id, tam, qtd, ordem) VALUES (?,?,?,?)
       ON CONFLICT(produto_id, tam) DO UPDATE SET qtd = excluded.qtd, ordem = excluded.ordem`
    ).bind(id, tam, qtd, i));
  });

  await env.DB.batch(comandos);
  return json({ ok: true, id });
}

/* ---------- movimentos ---------- */

async function registrarMovimento(corpo, env, usuario) {
  const tipo = String(corpo.tipo || '');
  if (!['venda', 'entrada', 'ajuste'].includes(tipo)) return erro('Tipo de movimento inválido.');
  if (tipo !== 'venda' && !ehDono(usuario)) return erro('Só o dono registra entrada e ajuste.', 403);

  const produto = await env.DB.prepare('SELECT * FROM produtos WHERE id = ?').bind(corpo.produtoId).first();
  if (!produto) return erro('Peça não encontrada.', 404);

  const tam = String(corpo.tam || '').trim();
  const variacao = await env.DB.prepare(
    'SELECT qtd FROM variacoes WHERE produto_id = ? AND tam = ?'
  ).bind(produto.id, tam).first();
  if (!variacao) return erro('Tamanho não encontrado nesta peça.', 404);

  const qtd = Math.max(0, parseInt(corpo.qtd, 10) || 0);
  const valor = Math.max(0, Number(corpo.valor) || 0);
  const cupom = String(corpo.cupom || '').trim().toUpperCase().replace(/\s+/g, '').slice(0, 24);
  const ORIGENS_VALIDAS = ['trafego', 'organico', 'influencer', 'indicacao', 'recorrente', 'outro'];
  const origem = ORIGENS_VALIDAS.includes(corpo.origem) ? corpo.origem : '';
  const cheio = Math.max(0, Number(corpo.unitCheio) || 0) || produto.preco;
  const ts = corpo.ts || agora();
  const id = novoId();

  if (tipo === 'venda') {
    if (qtd < 1) return erro('Informe a quantidade.');
    let comissaoPct = 0;
    if (cupom) {
      const c = await env.DB.prepare('SELECT comissao FROM cupons WHERE codigo = ? AND ativo = 1').bind(cupom).first();
      if (c) comissaoPct = c.comissao || 0;
    }
    const baixa = await env.DB.prepare(
      'UPDATE variacoes SET qtd = qtd - ? WHERE produto_id = ? AND tam = ? AND qtd >= ?'
    ).bind(qtd, produto.id, tam, qtd).run();
    if (!baixa.meta.changes) {
      const atual = await env.DB.prepare('SELECT qtd FROM variacoes WHERE produto_id=? AND tam=?')
        .bind(produto.id, tam).first();
      return erro('Estoque insuficiente. Restam ' + (atual ? atual.qtd : 0) + ' no tamanho ' + tam + '.', 409);
    }
    try {
      await env.DB.prepare(
        `INSERT INTO movimentos (id, ts, tipo, produto_id, nome, tam, qtd, unit, unit_cheio, cupom, comissao_pct, origem, custo_unit, usuario)
         VALUES (?,?,'venda',?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(id, ts, produto.id, produto.nome, tam, qtd, valor || produto.preco, cheio, cupom,
             comissaoPct, origem, produto.custo, usuario.nome).run();
    } catch (e) {
      await env.DB.prepare('UPDATE variacoes SET qtd = qtd + ? WHERE produto_id=? AND tam=?')
        .bind(qtd, produto.id, tam).run();
      return erro('Não foi possível registrar a venda. Tente de novo.', 500);
    }
    return json({ ok: true, id });
  }

  if (tipo === 'entrada') {
    if (qtd < 1) return erro('Informe a quantidade.');
    const comandos = [
      env.DB.prepare('UPDATE variacoes SET qtd = qtd + ? WHERE produto_id=? AND tam=?')
        .bind(qtd, produto.id, tam),
      env.DB.prepare(
        `INSERT INTO movimentos (id, ts, tipo, produto_id, nome, tam, qtd, unit, custo_unit, usuario)
         VALUES (?,?,'entrada',?,?,?,?,0,?,?)`
      ).bind(id, ts, produto.id, produto.nome, tam, qtd, valor || produto.custo, usuario.nome)
    ];
    if (valor > 0) comandos.push(env.DB.prepare('UPDATE produtos SET custo = ? WHERE id = ?').bind(valor, produto.id));
    await env.DB.batch(comandos);
    return json({ ok: true, id });
  }

  // ajuste: qtd é o saldo correto
  await env.DB.batch([
    env.DB.prepare('UPDATE variacoes SET qtd = ? WHERE produto_id=? AND tam=?').bind(qtd, produto.id, tam),
    env.DB.prepare(
      `INSERT INTO movimentos (id, ts, tipo, produto_id, nome, tam, qtd, unit, custo_unit, usuario)
       VALUES (?,?,'ajuste',?,?,?,?,0,?,?)`
    ).bind(id, ts, produto.id, produto.nome, tam, Math.abs(qtd - variacao.qtd), produto.custo, usuario.nome)
  ]);
  return json({ ok: true, id });
}

async function desfazerMovimento(idMov, env) {
  const m = await env.DB.prepare('SELECT * FROM movimentos WHERE id = ?').bind(idMov).first();
  if (!m) return erro('Movimento não encontrado.', 404);
  if (m.tipo === 'ajuste') return erro('Ajuste não pode ser desfeito. Faça um novo ajuste.', 400);
  if (m.pedido_id) return erro('Esta venda faz parte de um pedido. Cancele o pedido para devolver as peças ao estoque.', 400);

  const delta = m.tipo === 'venda' ? m.qtd : -m.qtd;
  await env.DB.batch([
    env.DB.prepare('UPDATE variacoes SET qtd = MAX(0, qtd + ?) WHERE produto_id=? AND tam=?')
      .bind(delta, m.produto_id, m.tam),
    env.DB.prepare('DELETE FROM movimentos WHERE id = ?').bind(idMov)
  ]);
  return json({ ok: true });
}

/* ---------- pedidos ---------- */

/* telefone no padrão (85) 98501-5801, aceita +55, 0 de operadora, espaços e traços */
function formatarTelefone(valor){
  let d = String(valor || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2);
  if (d.length >= 11 && d.startsWith('0')) d = d.replace(/^0+/, '');
  if (d.length === 11) return '(' + d.slice(0,2) + ') ' + d.slice(2,7) + '-' + d.slice(7);
  if (d.length === 10) return '(' + d.slice(0,2) + ') ' + d.slice(2,6) + '-' + d.slice(6);
  if (d.length === 9)  return d.slice(0,5) + '-' + d.slice(5);
  if (d.length === 8)  return d.slice(0,4) + '-' + d.slice(4);
  return String(valor).trim();
}

const STATUS_PEDIDO = ['aguardando', 'pago', 'enviado', 'entregue', 'cancelado'];

async function criarPedido(corpo, env, usuario, idEditar) {
  // na edição, o pedido antigo é desfeito (peças voltam ao estoque) e o novo é gravado no mesmo batch
  let antigo = null, movsAntigos = [];
  if (idEditar) {
    antigo = await env.DB.prepare('SELECT * FROM pedidos WHERE id = ?').bind(idEditar).first();
    if (!antigo) return erro('Pedido não encontrado.', 404);
    if (antigo.status === 'cancelado') return erro('Pedido cancelado não pode ser editado.', 409);
    movsAntigos = (await env.DB.prepare(
      "SELECT produto_id, tam, qtd FROM movimentos WHERE pedido_id = ? AND tipo = 'venda'"
    ).bind(idEditar).all()).results || [];
  }
  const devolvido = new Map();
  movsAntigos.forEach(m => {
    const k = m.produto_id + '|' + m.tam;
    devolvido.set(k, (devolvido.get(k) || 0) + m.qtd);
  });

  const cliente = String(corpo.cliente || '').trim().slice(0, 80);
  if (!cliente) return erro('Informe o nome da cliente.');
  const telefone = formatarTelefone(String(corpo.telefone || '').slice(0, 30)).slice(0, 20);
  const pagamento = String(corpo.pagamento || '').trim().slice(0, 30);
  const obs = String(corpo.obs || '').trim().slice(0, 300);
  const status = ['aguardando', 'pago'].includes(corpo.status) ? corpo.status : 'aguardando';
  const cupom = String(corpo.cupom || '').trim().toUpperCase().replace(/\s+/g, '').slice(0, 24);
  const ORIGENS_VALIDAS = ['trafego', 'organico', 'influencer', 'indicacao', 'recorrente', 'outro'];
  const origem = ORIGENS_VALIDAS.includes(corpo.origem) ? corpo.origem : '';
  const codigoSite = String(corpo.codigoSite || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (codigoSite) {
    if (!CODIGO_SITE.test(codigoSite)) return erro('Código do site inválido. Ele tem o formato OX seguido de 4 letras ou números, ex.: OX4K7P.');
    const co = await env.DB.prepare('SELECT codigo FROM checkouts WHERE codigo = ?').bind(codigoSite).first();
    if (!co) return erro('Código do site ' + codigoSite + ' não encontrado. Confira na mensagem da cliente.', 404);
  }

  const bruto = Array.isArray(corpo.itens) ? corpo.itens : [];
  if (!bruto.length) return erro('Adicione ao menos uma peça ao pedido.');
  if (bruto.length > 60) return erro('Pedido grande demais (máximo 60 linhas).');

  // junta linhas repetidas da mesma peça e tamanho
  const linhas = [];
  for (const l of bruto) {
    const produtoId = String(l.produtoId || '');
    const tam = String(l.tam || '').trim();
    const qtd = Math.max(0, parseInt(l.qtd, 10) || 0);
    const valor = Math.max(0, Number(l.valor) || 0);
    if (!produtoId || !tam || qtd < 1) return erro('Há uma peça sem tamanho ou quantidade no pedido.');
    const igual = linhas.find(x => x.produtoId === produtoId && x.tam === tam && x.valor === valor);
    if (igual) igual.qtd += qtd; else linhas.push({ produtoId, tam, qtd, valor });
  }

  const ids = [...new Set(linhas.map(l => l.produtoId))];
  const marcas = ids.map(() => '?').join(',');
  const [prodRes, varRes, cupRes] = await env.DB.batch([
    env.DB.prepare(`SELECT * FROM produtos WHERE arquivado = 0 AND id IN (${marcas})`).bind(...ids),
    env.DB.prepare(`SELECT produto_id, tam, qtd FROM variacoes WHERE produto_id IN (${marcas})`).bind(...ids),
    env.DB.prepare('SELECT comissao FROM cupons WHERE codigo = ? AND ativo = 1').bind(cupom)
  ]);
  const produtos = new Map((prodRes.results || []).map(p => [p.id, p]));
  const saldo = new Map((varRes.results || []).map(v =>
    [v.produto_id + '|' + v.tam, v.qtd + (devolvido.get(v.produto_id + '|' + v.tam) || 0)]));
  const comissaoPct = cupom && cupRes.results && cupRes.results[0] ? (cupRes.results[0].comissao || 0) : 0;

  // confere o estoque antes de gravar (mensagem clara por peça)
  const pedido = new Map();
  for (const l of linhas) {
    const p = produtos.get(l.produtoId);
    if (!p) return erro('Uma das peças do pedido não existe mais.', 404);
    if (!saldo.has(l.produtoId + '|' + l.tam)) return erro('Tamanho ' + l.tam + ' não encontrado em ' + p.nome + '.', 404);
    const chave = l.produtoId + '|' + l.tam;
    pedido.set(chave, (pedido.get(chave) || 0) + l.qtd);
  }
  for (const [chave, qtd] of pedido) {
    const [pid, tam] = chave.split('|');
    if (qtd > saldo.get(chave)) {
      const p = produtos.get(pid);
      return erro('Estoque insuficiente: ' + p.nome + (p.cor ? ' ' + p.cor : '') + ' tamanho ' + tam +
                  ' (restam ' + saldo.get(chave) + ', pedido tem ' + qtd + ').', 409);
    }
  }

  const ts = antigo ? (corpo.ts || antigo.ts) : (corpo.ts || agora());
  const id = antigo ? antigo.id : novoId();
  const vendedor = antigo ? (antigo.usuario || usuario.nome) : usuario.nome;
  let total = 0;
  const itens = linhas.map(l => {
    const p = produtos.get(l.produtoId);
    const unit = l.valor || p.preco;
    total += unit * l.qtd;
    return { produtoId: p.id, nome: p.nome, cor: p.cor || '', ref: p.ref || '', tam: l.tam,
             qtd: l.qtd, unit, unitCheio: p.preco };
  });
  total = Math.round(total * 100) / 100;

  const parcelas = Math.min(24, Math.max(1, parseInt(corpo.parcelas, 10) || 1));
  const pagamentosIniciais = (!antigo && status === 'pago')
    ? [{ id: novoId(), ts: agora(), valor: total, forma: pagamento, parcelas, usuario: usuario.nome }] : [];

  const cmd = [];
  if (antigo) {
    movsAntigos.forEach(m => cmd.push(env.DB.prepare(
      'UPDATE variacoes SET qtd = qtd + ? WHERE produto_id = ? AND tam = ?'
    ).bind(m.qtd, m.produto_id, m.tam)));
    cmd.push(
      env.DB.prepare('DELETE FROM movimentos WHERE pedido_id = ?').bind(id),
      env.DB.prepare(
        `UPDATE pedidos SET ts = ?, cliente = ?, telefone = ?, cupom = ?, origem = ?, pagamento = ?, obs = ?,
           itens = ?, total = ?, codigo_site = ? WHERE id = ?`
      ).bind(ts, cliente, telefone, cupom, origem, pagamento, obs, JSON.stringify(itens), total, codigoSite, id)
    );
  } else {
    cmd.push(env.DB.prepare(
      `INSERT INTO pedidos (id, numero, ts, cliente, telefone, cupom, origem, pagamento, status, obs, itens, total, usuario, criado_em, codigo_site, pagamentos)
       VALUES (?, (SELECT COALESCE(MAX(numero), 0) + 1 FROM pedidos), ?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(id, ts, cliente, telefone, cupom, origem, pagamento, status, obs, JSON.stringify(itens), total, usuario.nome, agora(), codigoSite,
           JSON.stringify(pagamentosIniciais)));
  }

  itens.forEach(it => {
    const p = produtos.get(it.produtoId);
    // a guarda aborta o batch inteiro (rollback) se outra venda tirou o estoque nesse meio tempo
    cmd.push(
      env.DB.prepare(
        `SELECT CASE WHEN COALESCE((SELECT qtd FROM variacoes WHERE produto_id = ? AND tam = ?), -1) >= ?
                THEN 1 ELSE abs(-9223372036854775808) END`
      ).bind(it.produtoId, it.tam, it.qtd),
      env.DB.prepare('UPDATE variacoes SET qtd = qtd - ? WHERE produto_id = ? AND tam = ?')
        .bind(it.qtd, it.produtoId, it.tam),
      env.DB.prepare(
        `INSERT INTO movimentos (id, ts, tipo, produto_id, nome, tam, qtd, unit, unit_cheio, cupom, comissao_pct, origem, custo_unit, usuario, pedido_id)
         VALUES (?,?,'venda',?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(novoId(), ts, it.produtoId, p.nome, it.tam, it.qtd, it.unit, it.unitCheio, cupom,
             comissaoPct, origem, p.custo, vendedor, id)
    );
  });

  try {
    await env.DB.batch(cmd);
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/overflow/i.test(msg)) return erro('O estoque mudou enquanto o pedido era salvo. Confira e tente de novo.', 409);
    if (/UNIQUE/i.test(msg)) return erro('Dois pedidos foram gerados ao mesmo tempo. Tente de novo.', 409);
    console.error('criarPedido:', msg);
    if (/no such (table|column)|has no column|no column named/i.test(msg))
      return erro('Estrutura do banco incompleta para pedidos. Detalhe: ' + msg.slice(0, 160), 500);
    return erro('Não foi possível gerar o pedido (nada foi baixado do estoque). Detalhe: ' + msg.slice(0, 160), 500);
  }

  const n = await env.DB.prepare('SELECT numero FROM pedidos WHERE id = ?').bind(id).first();
  return json({ ok: true, id, numero: n ? n.numero : null, total });
}

async function mudarStatusPedido(idPedido, corpo, env, usuario) {
  const status = String(corpo.status || '');
  if (!STATUS_PEDIDO.includes(status)) return erro('Status inválido.');
  const p = await env.DB.prepare('SELECT id, status, total, pagamento, pagamentos FROM pedidos WHERE id = ?').bind(idPedido).first();
  if (!p) return erro('Pedido não encontrado.', 404);
  if (p.status === 'cancelado') return erro('Pedido cancelado não pode mudar de status.', 409);
  if (p.status === status) return json({ ok: true });

  if (status !== 'cancelado') {
    // marcar como pago quita o que faltava, registrado na forma de pagamento do pedido
    const pags = lerPagamentos(p);
    const falta = Math.round((p.total - somaPagamentos(pags)) * 100) / 100;
    if (status !== 'aguardando' && falta > 0.009) {
      pags.push({ id: novoId(), ts: agora(), valor: falta, forma: p.pagamento || '',
                  parcelas: Math.min(24, Math.max(1, parseInt(corpo.parcelas, 10) || 1)), usuario: usuario.nome });
    }
    await env.DB.prepare('UPDATE pedidos SET status = ?, pagamentos = ? WHERE id = ?')
      .bind(status, JSON.stringify(pags), idPedido).run();
    return json({ ok: true });
  }

  if (!ehDono(usuario)) return erro('Só o dono cancela pedidos.', 403);
  const movs = (await env.DB.prepare(
    "SELECT produto_id, tam, qtd FROM movimentos WHERE pedido_id = ? AND tipo = 'venda'"
  ).bind(idPedido).all()).results || [];
  const cmd = movs.map(m => env.DB.prepare(
    'UPDATE variacoes SET qtd = qtd + ? WHERE produto_id = ? AND tam = ?'
  ).bind(m.qtd, m.produto_id, m.tam));
  cmd.push(
    env.DB.prepare('DELETE FROM movimentos WHERE pedido_id = ?').bind(idPedido),
    env.DB.prepare("UPDATE pedidos SET status = 'cancelado' WHERE id = ?").bind(idPedido)
  );
  await env.DB.batch(cmd);
  return json({ ok: true });
}

/* ---------- pagamentos do pedido (entrada, restante, cartão parcelado) ---------- */

function lerPagamentos(p) {
  let pags = [];
  try { pags = JSON.parse(p.pagamentos || '[]'); } catch (e) {}
  return Array.isArray(pags) ? pags : [];
}
const somaPagamentos = pags => Math.round(pags.reduce((s, x) => s + (Number(x.valor) || 0), 0) * 100) / 100;

async function registrarPagamento(idPedido, corpo, env, usuario) {
  const p = await env.DB.prepare('SELECT id, status, total, pagamentos FROM pedidos WHERE id = ?').bind(idPedido).first();
  if (!p) return erro('Pedido não encontrado.', 404);
  if (p.status === 'cancelado') return erro('Pedido cancelado não recebe pagamento.', 409);
  const valor = Math.round((Number(corpo.valor) || 0) * 100) / 100;
  if (valor <= 0) return erro('Informe o valor recebido.');
  const pags = lerPagamentos(p);
  const falta = Math.round((p.total - somaPagamentos(pags)) * 100) / 100;
  if (valor > falta + 0.009) return erro('O valor passa do que falta receber (' + falta.toFixed(2).replace('.', ',') + ').');
  const data = /^\d{4}-\d{2}-\d{2}$/.test(String(corpo.data || '')) ? corpo.data + 'T12:00:00.000Z' : agora();
  pags.push({ id: novoId(), ts: data, valor, forma: String(corpo.forma || '').slice(0, 30),
              parcelas: Math.min(24, Math.max(1, parseInt(corpo.parcelas, 10) || 1)), usuario: usuario.nome });
  const quitou = somaPagamentos(pags) >= p.total - 0.009;
  const status = quitou && p.status === 'aguardando' ? 'pago' : p.status;
  await env.DB.prepare('UPDATE pedidos SET pagamentos = ?, status = ? WHERE id = ?').bind(JSON.stringify(pags), status, idPedido).run();
  return json({ ok: true, quitou });
}

async function removerPagamento(idPedido, idPag, env) {
  const p = await env.DB.prepare('SELECT id, status, total, pagamentos FROM pedidos WHERE id = ?').bind(idPedido).first();
  if (!p) return erro('Pedido não encontrado.', 404);
  const pags = lerPagamentos(p).filter(x => x.id !== idPag);
  // se deixou de estar quitado e ainda não saiu, volta para aguardando
  const status = p.status === 'pago' && somaPagamentos(pags) < p.total - 0.009 ? 'aguardando' : p.status;
  await env.DB.prepare('UPDATE pedidos SET pagamentos = ?, status = ? WHERE id = ?').bind(JSON.stringify(pags), status, idPedido).run();
  return json({ ok: true });
}

/* ---------- API de Conversões da Meta ----------
   META_PIXEL_ID fica em [vars] no wrangler.toml; META_CAPI_TOKEN é segredo
   (wrangler secret put META_CAPI_TOKEN). META_TEST_CODE, opcional, manda os
   eventos para a aba "Testar eventos" do Gerenciador de Eventos. */

const CODIGO_SITE = /^OX[2-9A-HJ-NP-Z]{4}$/;

async function sha256(valor) {
  const v = String(valor || '').trim().toLowerCase();
  if (!v) return '';
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

const semAcento = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z ]/g, '').trim();

async function dadosPessoa({ nome, telefone, cep }) {
  const u = { country: [await sha256('br')] };
  const partes = semAcento(nome).split(/\s+/).filter(Boolean);
  if (partes[0]) u.fn = [await sha256(partes[0])];
  if (partes.length > 1) u.ln = [await sha256(partes[partes.length - 1])];
  let fone = String(telefone || '').replace(/\D/g, '');
  if (fone.length === 10 || fone.length === 11) fone = '55' + fone;
  if (fone.length >= 12) u.ph = [await sha256(fone)];
  const z = String(cep || '').replace(/\D/g, '');
  if (z.length === 8) u.zp = [await sha256(z)];
  return u;
}

async function enviarCapi(env, eventos) {
  if (!env.META_PIXEL_ID || !env.META_CAPI_TOKEN) return 'sem configuração';
  const corpo = { data: eventos };
  if (env.META_TEST_CODE) corpo.test_event_code = env.META_TEST_CODE;
  try {
    const r = await fetch((env.META_API_BASE || 'https://graph.facebook.com/v21.0/') + env.META_PIXEL_ID + '/events?access_token=' +
      encodeURIComponent(env.META_CAPI_TOKEN), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo)
    });
    const t = await r.text();
    return (r.ok ? 'ok ' : 'erro ' + r.status + ' ') + t.slice(0, 200);
  } catch (e) {
    return 'erro ' + String((e && e.message) || e).slice(0, 200);
  }
}

// chamado pelo site quando a cliente toca em "Finalizar pelo WhatsApp"
async function registrarCheckout(corpo, req, env) {
  const codigo = String(corpo.codigo || '').toUpperCase();
  if (!CODIGO_SITE.test(codigo)) return { resp: erro('Código inválido.') };
  const eventId = String(corpo.eventId || '').slice(0, 60);
  const ip = req.headers.get('CF-Connecting-IP') || '';
  const ua = (req.headers.get('User-Agent') || '').slice(0, 400);
  const fbp = String(corpo.fbp || '').slice(0, 120);
  const fbc = String(corpo.fbc || '').slice(0, 300);
  const url = String(corpo.url || '').slice(0, 300);
  const nome = String(corpo.nome || '').trim().slice(0, 80);
  const cep = String(corpo.cep || '').replace(/\D/g, '').slice(0, 8);
  const valor = Math.max(0, Math.round((Number(corpo.valor) || 0) * 100) / 100);
  const itens = (Array.isArray(corpo.itens) ? corpo.itens : []).slice(0, 40).map(i => ({
    ref: String(i.ref || '').slice(0, 20), qtd: Math.max(1, parseInt(i.qtd, 10) || 1), preco: Math.max(0, Number(i.preco) || 0)
  }));
  const ts = agora();
  const recentes = await env.DB.prepare('SELECT COUNT(*) AS n FROM checkouts WHERE ip = ? AND ts > ?')
    .bind(ip, new Date(Date.now() - 3600e3).toISOString()).first();
  if (recentes && recentes.n >= 30) return { resp: erro('Muitas tentativas. Tente mais tarde.', 429) };
  const r = await env.DB.prepare(
    `INSERT OR IGNORE INTO checkouts (codigo, ts, event_id, fbp, fbc, ip, ua, url, nome, cep, valor, itens)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(codigo, ts, eventId, fbp, fbc, ip, ua, url, nome, cep, valor, JSON.stringify(itens)).run();
  if (!r.meta || !r.meta.changes) return { resp: json({ ok: true, repetido: true }) };

  const enviar = async () => {
    const user_data = Object.assign(await dadosPessoa({ nome, cep }), { client_ip_address: ip, client_user_agent: ua });
    if (fbp) user_data.fbp = fbp;
    if (fbc) user_data.fbc = fbc;
    const st = await enviarCapi(env, [{
      event_name: 'InitiateCheckout', event_time: Math.floor(Date.now() / 1000), event_id: eventId || codigo,
      action_source: 'website', event_source_url: url || 'https://www.useoxsygen.com.br/', user_data,
      custom_data: { currency: 'BRL', value: valor, num_items: itens.reduce((s, i) => s + i.qtd, 0),
                     content_type: 'product', content_ids: itens.map(i => i.ref),
                     contents: itens.map(i => ({ id: i.ref, quantity: i.qtd, item_price: i.preco })) }
    }]);
    await env.DB.prepare('UPDATE checkouts SET capi = ? WHERE codigo = ?').bind(st, codigo).run();
  };
  return { resp: json({ ok: true }), depois: enviar };
}

// manda a compra para a Meta quando o pedido fica pago (uma vez por pedido)
async function enviarCompra(env, idPedido) {
  const p = await env.DB.prepare('SELECT * FROM pedidos WHERE id = ?').bind(idPedido).first();
  if (!p || p.status === 'cancelado' || String(p.capi || '').startsWith('ok')) return;
  const co = p.codigo_site
    ? await env.DB.prepare('SELECT * FROM checkouts WHERE codigo = ?').bind(p.codigo_site).first() : null;
  if (!co && !String(p.telefone || '').replace(/\D/g, '')) return;   // sem como identificar a cliente
  let itens = [];
  try { itens = JSON.parse(p.itens || '[]'); } catch (e) {}
  const user_data = await dadosPessoa({ nome: p.cliente, telefone: p.telefone, cep: co ? co.cep : '' });
  const ev = {
    event_name: 'Purchase', event_time: Math.floor(Date.now() / 1000), event_id: 'pedido-' + p.id,
    action_source: co ? 'website' : 'chat', user_data,
    custom_data: { currency: 'BRL', value: p.total, order_id: String(p.numero), content_type: 'product',
                   content_ids: itens.map(i => i.ref).filter(Boolean),
                   contents: itens.map(i => ({ id: i.ref || i.produtoId, quantity: i.qtd, item_price: i.unit })) }
  };
  if (co) {
    ev.event_source_url = co.url || 'https://www.useoxsygen.com.br/';
    if (co.ip) user_data.client_ip_address = co.ip;
    if (co.ua) user_data.client_user_agent = co.ua;
    if (co.fbp) user_data.fbp = co.fbp;
    if (co.fbc) user_data.fbc = co.fbc;
  }
  const st = await enviarCapi(env, [ev]);
  await env.DB.prepare('UPDATE pedidos SET capi = ? WHERE id = ?').bind(st, p.id).run();
}

async function enviarCompraSePago(env, idPedido) {
  try {
    const p = await env.DB.prepare('SELECT status FROM pedidos WHERE id = ?').bind(idPedido).first();
    if (p && ['pago', 'enviado', 'entregue'].includes(p.status)) await enviarCompra(env, idPedido);
  } catch (e) { console.error('capi compra:', e && e.message); }
}

/* ---------- reajuste de preços pela regra da loja ---------- */

async function reajustarPrecos(corpo, env) {
  const markup = Number(corpo.markup);
  if (!isFinite(markup) || markup < 0 || markup > 1000) return erro('Markup inválido.');
  const fator = 1 + markup / 100;
  const r = await env.DB.prepare(
    'UPDATE produtos SET preco = ROUND(custo * ?, 2) WHERE arquivado = 0 AND custo > 0 AND ROUND(custo * ?, 2) <> preco'
  ).bind(fator, fator).run();
  return json({ ok: true, alterados: r.meta.changes || 0 });
}

/* ---------- importação de NF-e ---------- */

async function importarNota(corpo, env, usuario) {
  const chave = String(corpo.chave || '').replace(/\D/g, '').slice(0, 44);
  const itens = Array.isArray(corpo.itens) ? corpo.itens : [];
  if (!itens.length) return erro('A nota não tem itens para importar.');
  if (itens.length > 300) return erro('Nota grande demais (máximo 300 itens).');

  if (chave) {
    const ja = await env.DB.prepare('SELECT importada_em FROM notas WHERE chave = ?').bind(chave).first();
    if (ja) return erro('Esta nota já foi importada em ' + ja.importada_em.slice(0, 10) + '.', 409);
  }

  // uma única leitura; o resto é montado em memória e gravado num único batch (atômico)
  const existentes = (await env.DB.prepare(
    'SELECT id, nome, cor, ref, cor_cod, preco FROM produtos WHERE arquivado = 0'
  ).all()).results || [];
  const porRef = new Map(), porNome = new Map();
  existentes.forEach(p => {
    if (p.ref) porRef.set(p.ref + '|' + (p.cor_cod || ''), p);
    porNome.set(String(p.nome).toLowerCase() + '|' + String(p.cor || '').toLowerCase(), p);
  });

  const ORDEM_TAM = { PP:1, P:2, M:3, G:4, GG:5, XG:6, XGG:7, EG:8, U:9 };
  const ts = corpo.ts || agora();
  const cmd = [];
  const tocados = new Set();
  let criados = 0, atualizados = 0, pecas = 0, valor = 0, validos = 0;

  for (const it of itens) {
    const nome = String(it.nome || '').trim();
    const tam  = String(it.tam || '').trim().toUpperCase();
    const cor  = String(it.cor || '').trim();
    const ref  = String(it.ref || '').trim().toUpperCase().slice(0, 30);
    const corCod = String(it.corCod || '').trim().toUpperCase().slice(0, 10);
    const sku  = String(it.sku || '').trim().slice(0, 40);
    const ean  = String(it.ean || '').replace(/\D/g, '').slice(0, 14);
    const qtd  = Math.max(0, parseInt(it.qtd, 10) || 0);
    const custo = Math.max(0, Number(it.custo) || 0);
    const preco = Math.max(0, Number(it.preco) || 0);
    if (!nome || !tam || !qtd) continue;
    validos++;

    let produto = (ref && porRef.get(ref + '|' + corCod))
      || porNome.get(nome.toLowerCase() + '|' + cor.toLowerCase());

    if (!produto) {
      const id = novoId();
      cmd.push(env.DB.prepare(
        'INSERT INTO produtos (id, nome, cor, cor_hex, ref, cor_cod, custo, preco, minimo, arquivado) VALUES (?,?,?,?,?,?,?,?,1,0)'
      ).bind(id, nome, cor, it.corHex || '#DDD2CA', ref, corCod, custo, preco));
      produto = { id, nome, cor, ref, cor_cod: corCod, preco };
      if (ref) porRef.set(ref + '|' + corCod, produto);
      porNome.set(nome.toLowerCase() + '|' + cor.toLowerCase(), produto);
      tocados.add(id);
      criados++;
    } else if (!tocados.has(produto.id)) {
      cmd.push(env.DB.prepare(
        `UPDATE produtos SET custo = ?, preco = ?,
           ref = CASE WHEN COALESCE(ref,'') = '' THEN ? ELSE ref END,
           cor_cod = CASE WHEN COALESCE(cor_cod,'') = '' THEN ? ELSE cor_cod END
         WHERE id = ?`
      ).bind(custo, preco || produto.preco, ref, corCod, produto.id));
      tocados.add(produto.id);
      atualizados++;
    }

    cmd.push(
      env.DB.prepare(
        `INSERT INTO variacoes (produto_id, tam, qtd, ordem, sku, ean) VALUES (?,?,?,?,?,?)
         ON CONFLICT(produto_id, tam) DO UPDATE SET qtd = qtd + excluded.qtd,
           sku = CASE WHEN excluded.sku <> '' THEN excluded.sku ELSE sku END,
           ean = CASE WHEN excluded.ean <> '' THEN excluded.ean ELSE ean END`
      ).bind(produto.id, tam, qtd, ORDEM_TAM[tam] || 50, sku, ean),
      env.DB.prepare(
        `INSERT INTO movimentos (id, ts, tipo, produto_id, nome, tam, qtd, unit, custo_unit, usuario)
         VALUES (?,?,'entrada',?,?,?,?,0,?,?)`
      ).bind(novoId(), ts, produto.id, produto.nome || nome, tam, qtd, custo, usuario.nome)
    );

    if (it.cprod) {
      cmd.push(env.DB.prepare(
        `INSERT INTO mapa_itens (cprod, nome, cor, tam, visto_em) VALUES (?,?,?,?,?)
         ON CONFLICT(cprod) DO UPDATE SET nome = excluded.nome, cor = excluded.cor,
           tam = excluded.tam, visto_em = excluded.visto_em`
      ).bind(String(it.cprod), nome, cor, tam, ts));
    }

    pecas += qtd;
    valor += custo * qtd;
  }

  if (!validos) return erro('Nenhum item válido para importar.');

  if (chave) {
    cmd.push(env.DB.prepare(
      'INSERT INTO notas (chave, numero, emitente, itens, pecas, valor, importada_em, usuario) VALUES (?,?,?,?,?,?,?,?)'
    ).bind(chave, String(corpo.numero || ''), String(corpo.emitente || ''),
           validos, pecas, valor, agora(), usuario.nome));
  }

  await env.DB.batch(cmd);
  return json({ ok: true, criados, atualizados, pecas, valor });
}

/* ---------- equipe ---------- */

async function listarEquipe(env) {
  const r = await env.DB.prepare(
    'SELECT id, nome, papel, ativo, criado_em FROM usuarios ORDER BY ativo DESC, nome'
  ).all();
  return json({ equipe: r.results || [] });
}

async function criarPessoa(corpo, env) {
  const nome = String(corpo.nome || '').trim();
  const pin = String(corpo.pin || '').trim();
  const papel = corpo.papel === 'dono' ? 'dono' : 'vendedor';
  if (!nome) return erro('Informe o nome.');
  if (!/^\d{4,8}$/.test(pin)) return erro('O PIN precisa ter de 4 a 8 números.');

  const hash = await hashPin(pin, env);
  const duplicado = await env.DB.prepare('SELECT id FROM usuarios WHERE pin_hash = ? AND ativo = 1').bind(hash).first();
  if (duplicado) return erro('Esse PIN já está em uso. Escolha outro.', 409);

  const id = novoId();
  await env.DB.prepare(
    'INSERT INTO usuarios (id, nome, pin_hash, papel, ativo, criado_em) VALUES (?,?,?,?,1,?)'
  ).bind(id, nome, hash, papel, agora()).run();
  return json({ ok: true, id });
}

/* ---------- backup ---------- */

// Tabelas que não entram no backup: sessões de login e bloqueio por tentativas (temporárias).
const FORA_DO_BACKUP = ['sessoes', 'tentativas'];

async function gerarBackup(env) {
  const lista = (await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name"
  ).all()).results || [];
  const nomes = lista.map(t => t.name).filter(n => !FORA_DO_BACKUP.includes(n));
  const resultados = await env.DB.batch(nomes.map(n => env.DB.prepare('SELECT * FROM "' + n.replace(/"/g, '') + '"')));
  const tabelas = {};
  nomes.forEach((n, i) => { tabelas[n] = resultados[i].results || []; });
  return { versao: 1, gerado_em: agora(), tabelas };
}

async function gzip(texto) {
  const fluxo = new Blob([texto]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(fluxo).arrayBuffer());
}

// Roda todo dia pelo agendamento do wrangler.toml: grava no R2 e apaga cópias com mais de 90 dias.
async function backupDiario(env) {
  if (!env.BACKUP) { console.error('backup: bucket R2 BACKUP não configurado'); return; }
  const dados = await gerarBackup(env);
  const dia = dados.gerado_em.slice(0, 10);
  await env.BACKUP.put('diario/' + dia + '.json.gz', await gzip(JSON.stringify(dados)), {
    httpMetadata: { contentType: 'application/gzip' },
    customMetadata: { linhas: String(Object.values(dados.tabelas).reduce((s, t) => s + t.length, 0)) }
  });
  const limite = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
  let cursor;
  do {
    const r = await env.BACKUP.list({ prefix: 'diario/', cursor });
    const velhos = r.objects.map(o => o.key).filter(k => k.slice(7, 17) < limite);
    if (velhos.length) await env.BACKUP.delete(velhos);
    cursor = r.truncated ? r.cursor : undefined;
  } while (cursor);
}

async function listarBackups(env) {
  if (!env.BACKUP) return [];
  const itens = [];
  let cursor;
  do {
    const r = await env.BACKUP.list({ prefix: 'diario/', cursor });
    r.objects.forEach(o => itens.push({ arquivo: o.key.slice(7), tamanho: o.size, em: o.uploaded }));
    cursor = r.truncated ? r.cursor : undefined;
  } while (cursor);
  return itens.sort((a, b) => b.arquivo.localeCompare(a.arquivo));
}

/* ---------- roteador ---------- */

export default {
  async scheduled(evento, env, ctx) {
    ctx.waitUntil(backupDiario(env).catch(e => console.error('backup:', e && e.message)));
  },

  async fetch(req, env, ctx) {
    const cabecalhos = cors(env, req);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cabecalhos });

    const url = new URL(req.url);
    const rota = url.pathname.replace(/\/+$/, '') || '/';
    const ip = req.headers.get('CF-Connecting-IP') || 'desconhecido';
    const corpo = ['POST', 'PUT'].includes(req.method)
      ? await req.json().catch(() => ({}))
      : {};

    const responder = r => new Response(r.body, {
      status: r.status,
      headers: Object.assign(Object.fromEntries(r.headers), cabecalhos)
    });

    try {
      // vitrine pública da loja: preço e estoque ao vivo por referência, cor e tamanho
      if (rota === '/api/vitrine' && req.method === 'GET') {
        const r = await env.DB.prepare(
          `SELECT p.ref, p.cor_cod, p.preco, v.tam, v.qtd FROM produtos p
           JOIN variacoes v ON v.produto_id = p.id
           WHERE p.arquivado = 0 AND COALESCE(p.ref, '') <> ''`
        ).all();
        const out = {};
        for (const x of (r.results || [])) {
          const it = out[x.ref] || (out[x.ref] = { preco: x.preco, est: {} });
          if (x.preco > it.preco) it.preco = x.preco;
          const cor = it.est[x.cor_cod || ''] || (it.est[x.cor_cod || ''] = {});
          cor[x.tam] = Math.max(0, (cor[x.tam] || 0) + x.qtd);
        }
        const resp = json({ atualizado: agora(), produtos: out });
        resp.headers.set('Cache-Control', 'public, max-age=60');
        return responder(resp);
      }

      // site: cliente tocou em "Finalizar pelo WhatsApp"
      if (rota === '/api/checkout' && req.method === 'POST') {
        await garantirEsquema(env);
        const r = await registrarCheckout(corpo, req, env);
        if (r.depois) ctx.waitUntil(r.depois());
        return responder(r.resp);
      }

      if (rota === '/api/saude') {
        const n = await env.DB.prepare('SELECT COUNT(*) AS total FROM usuarios').first();
        return responder(json({ ok: true, instalado: n.total > 0 }));
      }

      if (rota === '/api/instalar' && req.method === 'POST') {
        const n = await env.DB.prepare('SELECT COUNT(*) AS total FROM usuarios').first();
        if (n.total > 0) return responder(erro('A loja já foi instalada.', 409));
        const r = await criarPessoa({ nome: corpo.nome, pin: corpo.pin, papel: 'dono' }, env);
        return responder(r);
      }

      if (rota === '/api/entrar' && req.method === 'POST') {
        if (await bloqueado(ip, env)) return responder(erro('Muitas tentativas. Espere 10 minutos.', 429));
        const hash = await hashPin(corpo.pin, env);
        const u = await env.DB.prepare(
          'SELECT id, nome, papel FROM usuarios WHERE pin_hash = ? AND ativo = 1'
        ).bind(hash).first();
        if (!u) { await registrarFalha(ip, env); return responder(erro('PIN não confere.', 401)); }

        const token = crypto.randomUUID() + crypto.randomUUID().slice(0, 8);
        const expira = new Date(Date.now() + DIAS_SESSAO * 864e5).toISOString();
        await env.DB.batch([
          env.DB.prepare('INSERT INTO sessoes (token, usuario_id, expira_em) VALUES (?,?,?)').bind(token, u.id, expira),
          env.DB.prepare('DELETE FROM sessoes WHERE expira_em < ?').bind(agora()),
          env.DB.prepare('DELETE FROM tentativas WHERE ip = ?').bind(ip)
        ]);
        return responder(json({ token, nome: u.nome, papel: u.papel, expira }));
      }

      /* daqui para baixo exige sessão */
      const usuario = await usuarioDaRequisicao(req, env);
      if (!usuario) return responder(erro('Sessão expirada. Entre de novo.', 401));

      try { await garantirEsquema(env); }
      catch (e) { console.error('garantirEsquema:', String((e && e.message) || e)); }

      if (rota === '/api/sair' && req.method === 'POST') {
        await env.DB.prepare('DELETE FROM sessoes WHERE token = ?').bind(usuario.token).run();
        return responder(json({ ok: true }));
      }

      if (rota === '/api/estado' && req.method === 'GET') {
        return responder(json(await lerEstado(env, usuario, url.searchParams.get('limite'))));
      }

      if (rota === '/api/produtos' && req.method === 'POST') {
        if (!ehDono(usuario)) return responder(erro('Só o dono cadastra peças.', 403));
        return responder(await salvarProduto(corpo, env));
      }

      if (rota.startsWith('/api/produtos/') && req.method === 'DELETE') {
        if (!ehDono(usuario)) return responder(erro('Só o dono exclui peças.', 403));
        await env.DB.prepare('UPDATE produtos SET arquivado = 1 WHERE id = ?').bind(rota.split('/')[3]).run();
        return responder(json({ ok: true }));
      }

      if (rota === '/api/movimentos' && req.method === 'POST') {
        return responder(await registrarMovimento(corpo, env, usuario));
      }

      if (rota.startsWith('/api/movimentos/') && req.method === 'DELETE') {
        if (!ehDono(usuario)) return responder(erro('Só o dono desfaz movimentos.', 403));
        return responder(await desfazerMovimento(rota.split('/')[3], env));
      }

      if (rota === '/api/pedidos' && req.method === 'POST') {
        const r = await criarPedido(corpo, env, usuario);
        if (r.ok) { const d = await r.clone().json(); ctx.waitUntil(enviarCompraSePago(env, d.id)); }
        return responder(r);
      }

      if (rota.startsWith('/api/pedidos/') && req.method === 'PUT') {
        const id = rota.split('/')[3];
        const r = await criarPedido(corpo, env, usuario, id);
        if (r.ok) ctx.waitUntil(enviarCompraSePago(env, id));
        return responder(r);
      }

      if (rota === '/api/precos/reajustar' && req.method === 'POST') {
        if (!ehDono(usuario)) return responder(erro('Só o dono reajusta preços.', 403));
        return responder(await reajustarPrecos(corpo, env));
      }

      if (/^\/api\/pedidos\/[^/]+\/pagamentos$/.test(rota) && req.method === 'POST') {
        const id = rota.split('/')[3];
        const r = await registrarPagamento(id, corpo, env, usuario);
        if (r.ok) ctx.waitUntil(enviarCompraSePago(env, id));
        return responder(r);
      }

      if (/^\/api\/pedidos\/[^/]+\/pagamentos\/[^/]+$/.test(rota) && req.method === 'DELETE') {
        if (!ehDono(usuario)) return responder(erro('Só o dono remove pagamentos.', 403));
        const [, , , id, , idPag] = rota.split('/');
        return responder(await removerPagamento(id, idPag, env));
      }

      if (rota.startsWith('/api/pedidos/') && req.method === 'POST') {
        const id = rota.split('/')[3];
        const r = await mudarStatusPedido(id, corpo, env, usuario);
        if (r.ok) ctx.waitUntil(enviarCompraSePago(env, id));
        return responder(r);
      }

      if (rota === '/api/mapa' && req.method === 'GET') {
        if (!ehDono(usuario)) return responder(erro('Só o dono importa notas.', 403));
        const r = await env.DB.prepare('SELECT * FROM mapa_itens').all();
        return responder(json({ mapa: r.results || [] }));
      }

      if (rota === '/api/importar' && req.method === 'POST') {
        if (!ehDono(usuario)) return responder(erro('Só o dono importa notas.', 403));
        return responder(await importarNota(corpo, env, usuario));
      }

      if (rota === '/api/cupons' && req.method === 'POST') {
        if (!ehDono(usuario)) return responder(erro('Só o dono cadastra cupons.', 403));
        const codigo = String(corpo.codigo || '').trim().toUpperCase().replace(/\s+/g, '').slice(0, 24);
        if (!codigo) return responder(erro('Informe o código do cupom.'));
        const comissao = Math.min(100, Math.max(0, Number(corpo.comissao) || 0));
        const desconto = Math.min(100, Math.max(0, Number(corpo.desconto) || 0));
        await env.DB.prepare(
          `INSERT INTO cupons (codigo, pessoa, comissao, desconto, ativo, criado_em) VALUES (?,?,?,?,1,?)
           ON CONFLICT(codigo) DO UPDATE SET pessoa = excluded.pessoa, comissao = excluded.comissao,
             desconto = excluded.desconto, ativo = 1`
        ).bind(codigo, String(corpo.pessoa || '').trim().slice(0, 60), comissao, desconto, agora()).run();
        return responder(json({ ok: true, codigo }));
      }

      if (rota.startsWith('/api/cupons/') && req.method === 'DELETE') {
        if (!ehDono(usuario)) return responder(erro('Só o dono desativa cupons.', 403));
        await env.DB.prepare('UPDATE cupons SET ativo = 0 WHERE codigo = ?')
          .bind(decodeURIComponent(rota.split('/')[3])).run();
        return responder(json({ ok: true }));
      }

      // backup: baixar uma cópia agora, ver a lista das cópias diárias ou baixar uma delas
      if (rota === '/api/backup' && req.method === 'GET') {
        if (!ehDono(usuario)) return responder(erro('Só o dono baixa o backup.', 403));
        const dados = await gerarBackup(env);
        const resp = new Response(JSON.stringify(dados), { headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': 'attachment; filename="oxsygen-backup-' + dados.gerado_em.slice(0, 10) + '.json"'
        } });
        return responder(resp);
      }
      if (rota === '/api/backups' && req.method === 'GET') {
        if (!ehDono(usuario)) return responder(erro('Só o dono vê os backups.', 403));
        return responder(json({ ok: true, r2: !!env.BACKUP, backups: await listarBackups(env) }));
      }
      if (rota.startsWith('/api/backups/') && req.method === 'GET') {
        if (!ehDono(usuario)) return responder(erro('Só o dono baixa o backup.', 403));
        const arquivo = decodeURIComponent(rota.split('/')[3] || '');
        if (!env.BACKUP || !/^\d{4}-\d{2}-\d{2}\.json\.gz$/.test(arquivo)) return responder(erro('Backup não encontrado.', 404));
        const obj = await env.BACKUP.get('diario/' + arquivo);
        if (!obj) return responder(erro('Backup não encontrado.', 404));
        return responder(new Response(obj.body, { headers: {
          'Content-Type': 'application/gzip',
          'Content-Disposition': 'attachment; filename="oxsygen-backup-' + arquivo + '"'
        } }));
      }

      if (rota === '/api/equipe') {
        if (!ehDono(usuario)) return responder(erro('Só o dono gerencia a equipe.', 403));
        if (req.method === 'GET') return responder(await listarEquipe(env));
        if (req.method === 'POST') return responder(await criarPessoa(corpo, env));
      }

      if (rota.startsWith('/api/equipe/') && req.method === 'DELETE') {
        if (!ehDono(usuario)) return responder(erro('Só o dono gerencia a equipe.', 403));
        const alvo = rota.split('/')[3];
        if (alvo === usuario.id) return responder(erro('Você não pode desativar o próprio acesso.', 400));
        await env.DB.batch([
          env.DB.prepare('UPDATE usuarios SET ativo = 0 WHERE id = ?').bind(alvo),
          env.DB.prepare('DELETE FROM sessoes WHERE usuario_id = ?').bind(alvo)
        ]);
        return responder(json({ ok: true }));
      }

      return responder(erro('Rota não encontrada.', 404));
    } catch (e) {
      return responder(erro('Falha no servidor: ' + e.message, 500));
    }
  }
};
