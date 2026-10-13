/**
 * SISTEMA FINANCEIRO - JD BURGÃO (V2 - SUPABASE)
 * Camada de Dados, Regras de Negócio e Serviços (Vanilla JavaScript)
 *
 * Expõe window.API compatível com o Contrato Front x Back v2.
 * 100% livre de Google Apps Script.
 */

(function (window) {
  'use strict';

  // ---------------------------------------------------------------------------
  // 1. INICIALIZAÇÃO DO CLIENTE SUPABASE
  // ---------------------------------------------------------------------------
  function obterClienteSupabase() {
    if (!window.supabase) {
      throw new Error("Biblioteca @supabase/supabase-js não foi carregada no documento.");
    }
    const config = window.JD_CONFIG || {};
    const url = config.SUPABASE_URL || config.supabaseUrl;
    const key = config.SUPABASE_ANON_KEY || config.supabaseAnonKey;
    if (!url || !key) {
      throw new Error("Configuração do Supabase (config.js) não encontrada ou inválida.");
    }
    if (!window._supabaseClientInstance) {
      window._supabaseClientInstance = window.supabase.createClient(url, key, {
        auth: {
          persistSession: true,
          autoRefreshToken: true
        }
      });
    }
    return window._supabaseClientInstance;
  }

  const supabase = obterClienteSupabase();

  // ---------------------------------------------------------------------------
  // 2. CACHE EM MEMÓRIA & INVALIDAÇÃO (SEÇÃO 8 & PONTO 5)
  // ---------------------------------------------------------------------------
  let cache = {
    valido: false,
    timestamp: 0,
    versao: 0,
    clientes: [],
    categorias: [],
    formasPagamento: [],
    lancamentos: [],
    repasses: [],
    repasseBaixas: []
  };

  let promessaCargaEmAndamento = null;
  const CACHE_TTL_MS = 120 * 1000; // Validade de 120 segundos

  function invalidarCache() {
    cache.valido = false;
    cache.timestamp = 0;
    cache.versao++;
    cache.clientes = [];
    cache.categorias = [];
    cache.formasPagamento = [];
    cache.lancamentos = [];
    cache.repasses = [];
    cache.repasseBaixas = [];
  }

  async function buscarPaginado(tabela, colunas, orderCol, ascending = true) {
    const pageSize = 1000;
    let from = 0;
    const todos = [];
    while (true) {
      let query = supabase.from(tabela).select(colunas);
      if (orderCol) {
        query = query.order(orderCol, { ascending });
      }
      query = query.range(from, from + pageSize - 1);
      const { data, error } = await query;
      if (error) {
        throw new Error(`Erro ao consultar ${tabela}: ${error.message}`);
      }
      if (!data || data.length === 0) break;
      todos.push(...data);
      if (data.length < pageSize) break;
      from += pageSize;
    }
    return todos;
  }

  async function carregarCache(tentativa = 1) {
    if (tentativa > 3) {
      throw new Error("Falha ao carregar cache: o cache foi invalidado repetidamente durante a carga.");
    }

    const agora = Date.now();
    if (cache.valido && (agora - cache.timestamp) < CACHE_TTL_MS) {
      return cache;
    }

    if (promessaCargaEmAndamento) {
      return promessaCargaEmAndamento;
    }

    const versaoAoIniciar = cache.versao;

    const promessaAtual = (async () => {
      let clientesRes, categoriasRes, formasRes, lancamentos, repasses, repasseBaixas;
      try {
        [
          clientesRes,
          categoriasRes,
          formasRes,
          lancamentos,
          repasses,
          repasseBaixas
        ] = await Promise.all([
          supabase.from('clientes').select('*').order('nome'),
          supabase.from('categorias').select('*').order('nome'),
          supabase.from('formas_pagamento').select('*').order('nome'),
          buscarPaginado('lancamentos', 'id, competencia, vencimento, data_pagamento, tipo, categoria, pessoa, forma_pagamento, valor_bruto, taxa_retida, valor_liquido, valor_recebido, status, descricao', 'competencia', true),
          buscarPaginado('repasses', 'id, forma, data_pagamento, valor, observacao, criado_por, criado_em', 'criado_em', false),
          buscarPaginado('repasse_baixas', 'id, repasse_id, lancamento_id, valor', 'id', true)
        ]);

        if (clientesRes.error) throw new Error("Erro ao carregar clientes: " + clientesRes.error.message);
        if (categoriasRes.error) throw new Error("Erro ao carregar categorias: " + categoriasRes.error.message);
        if (formasRes.error) throw new Error("Erro ao carregar formas de pagamento: " + formasRes.error.message);
      } finally {
        // Libera a promessa em andamento se ainda for esta instância
        if (promessaCargaEmAndamento === promessaAtual) {
          promessaCargaEmAndamento = null;
        }
      }

      // Se o cache foi invalidado enquanto a requisição rodava, descarta e tenta novamente
      if (cache.versao !== versaoAoIniciar) {
        return carregarCache(tentativa + 1);
      }

      cache.clientes = clientesRes.data || [];
      cache.categorias = categoriasRes.data || [];
      cache.formasPagamento = formasRes.data || [];
      cache.lancamentos = lancamentos || [];
      cache.repasses = repasses || [];
      cache.repasseBaixas = repasseBaixas || [];
      cache.timestamp = Date.now();
      cache.valido = true;
      return cache;
    })();

    promessaCargaEmAndamento = promessaAtual;
    return promessaCargaEmAndamento;
  }

  // ---------------------------------------------------------------------------
  // 3. SEGURANÇA E AUDITORIA (PONTO 8)
  // ---------------------------------------------------------------------------
  async function exigirSessao() {
    const { data: { session }, error } = await supabase.auth.getSession();
    if (error || !session || !session.user) {
      invalidarCache();
      throw new Error("Sessão expirada. Faça login novamente.");
    }
    return session.user;
  }

  async function registrarHistorico(usuario, acao, idRegistro, detalhes) {
    try {
      const { error } = await supabase.from('historico').insert({
        usuario: usuario || 'Desconhecido',
        acao: acao,
        id_registro: idRegistro ? String(idRegistro) : '-',
        detalhes: detalhes || ''
      });
      if (error) {
        console.warn("Falha ao registrar auditoria em historico:", error.message);
      }
    } catch (e) {
      console.warn("Falha ao registrar auditoria em historico:", e);
    }
  }

  // ---------------------------------------------------------------------------
  // 4. FUNÇÕES UTILITÁRIAS DE DATA E VALOR (PONTO 3)
  // ---------------------------------------------------------------------------
  function obterHojeLocalISO() {
    const agora = new Date();
    const ano = agora.getFullYear();
    const mes = ("0" + (agora.getMonth() + 1)).slice(-2);
    const dia = ("0" + agora.getDate()).slice(-2);
    return `${ano}-${mes}-${dia}`;
  }

  function formatarData(dataStr) {
    if (!dataStr) return "";
    const str = dataStr.toString().split("T")[0].trim();
    const partes = str.split("-");
    if (partes.length === 3) {
      return `${("0" + partes[2]).slice(-2)}/${("0" + partes[1]).slice(-2)}/${partes[0]}`;
    }
    return str;
  }

  function formataDataParaHtml(dataStr) {
    if (!dataStr) return "";
    const str = dataStr.toString().trim();
    if (str.indexOf("-") > -1) {
      return str.split("T")[0];
    }
    if (str.indexOf("/") > -1) {
      const p = str.split(" ")[0].split("/");
      if (p.length === 3) {
        return `${p[2].substring(0, 4)}-${("0" + p[1]).slice(-2)}-${("0" + p[0]).slice(-2)}`;
      }
    }
    return "";
  }

  function tratarValor(val) {
    if (typeof val === 'number') return isNaN(val) ? 0 : Math.round(val * 100) / 100;
    if (!val) return 0;
    let str = val.toString().trim();
    if (str.indexOf(',') > -1) str = str.replace(/\./g, '').replace(',', '.');
    const num = Number(str);
    return isNaN(num) ? 0 : Math.round(num * 100) / 100;
  }

  function somarDias(dataISO, dias) {
    if (!dataISO) return "";
    const partes = dataISO.split("T")[0].split("-");
    const y = parseInt(partes[0], 10);
    const m = parseInt(partes[1], 10) - 1;
    const d = parseInt(partes[2], 10);
    const dateObj = new Date(Date.UTC(y, m, d + (parseInt(dias, 10) || 0)));
    const ano = dateObj.getUTCFullYear();
    const mes = ("0" + (dateObj.getUTCMonth() + 1)).slice(-2);
    const dia = ("0" + dateObj.getUTCDate()).slice(-2);
    return `${ano}-${mes}-${dia}`;
  }

  // ---------------------------------------------------------------------------
  // 5. IMPLEMENTAÇÃO DO OBJETO API
  // ---------------------------------------------------------------------------
  const API = {};

  // -----------------------------------------
  // 5.1. AUTENTICAÇÃO (SEÇÃO 2)
  // -----------------------------------------
  API.auth = {
    async login(email, senha) {
      if (!email || !senha) {
        throw new Error("E-mail e senha são obrigatórios.");
      }
      const { data, error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password: senha
      });
      if (error || !data || !data.user) {
        throw new Error("E-mail ou senha inválidos.");
      }
      invalidarCache();
      return { email: data.user.email };
    },

    async logout() {
      invalidarCache();
      const { error } = await supabase.auth.signOut();
      if (error) throw new Error(error.message);
    },

    async sessaoAtual() {
      const { data: { session }, error } = await supabase.auth.getSession();
      if (error || !session || !session.user) return null;
      return { email: session.user.email };
    },

    aoMudarSessao(callback) {
      if (typeof callback !== 'function') return;
      supabase.auth.onAuthStateChange((event, session) => {
        if (event === 'SIGNED_OUT') {
          invalidarCache();
        }
        callback(session && session.user ? { email: session.user.email } : null);
      });
    }
  };

  // -----------------------------------------
  // 5.2. ATUALIZAÇÃO FORÇADA DE DADOS (PONTO 5)
  // -----------------------------------------
  API.atualizarDados = async function () {
    await exigirSessao();
    invalidarCache();
    await carregarCache();
    return true;
  };

  // -----------------------------------------
  // 5.3. LISTAS INICIAIS E CADASTROS (SEÇÃO 7)
  // -----------------------------------------
  API.buscarListasIniciais = async function () {
    await exigirSessao();
    await carregarCache();

    const clientes = (cache.clientes || []).map(c => ({
      id: c.id,
      nome: (c.nome || '').toUpperCase(),
      classificacao: c.classificacao || 'Ambos',
      tipo: c.tipo_pessoa || '',
      documento: c.documento || '',
      telefone: c.telefone || '',
      cidade: (c.cidade || '').toUpperCase(),
      status: c.status || 'Ativo'
    }));

    const categorias = (cache.categorias || []).map(cat => [cat.nome, cat.tipo]);

    const formasPagamento = (cache.formasPagamento || []).map(f => ({
      nome: f.nome,
      taxa: Number(f.taxa),
      prazo: Number(f.prazo),
      statusSugerido: f.status_sugerido,
      retemSaldo: !!f.retem_saldo
    }));

    return { clientes, categorias, formasPagamento };
  };

  API.salvarCliente = async function (dados) {
    const user = await exigirSessao();
    if (!dados) throw new Error("Dados do cliente não fornecidos.");
    const nomeMaiusculo = (dados.nome || '').trim().toUpperCase();
    if (!nomeMaiusculo) throw new Error("Nome do cliente é obrigatório.");
    const cidadeMaiuscula = (dados.cidade || '').trim().toUpperCase();

    let idCli = dados.id;
    let acaoHist = "Edição de Cadastro";

    if (idCli) {
      const { error } = await supabase.from('clientes').update({
        nome: nomeMaiusculo,
        classificacao: dados.classificacao || 'Ambos',
        tipo_pessoa: dados.tipo || '',
        documento: dados.documento || '',
        telefone: dados.telefone || '',
        cidade: cidadeMaiuscula,
        status: dados.status || 'Ativo'
      }).eq('id', idCli);
      if (error) throw new Error("Erro ao atualizar cliente: " + error.message);
    } else {
      idCli = "CLI-" + Date.now();
      acaoHist = "Novo Cadastro";
      const { error } = await supabase.from('clientes').insert({
        id: idCli,
        nome: nomeMaiusculo,
        classificacao: dados.classificacao || 'Ambos',
        tipo_pessoa: dados.tipo || '',
        documento: dados.documento || '',
        telefone: dados.telefone || '',
        cidade: cidadeMaiuscula,
        status: dados.status || 'Ativo'
      });
      if (error) throw new Error("Erro ao cadastrar cliente: " + error.message);
    }

    invalidarCache();
    await registrarHistorico(user.email, acaoHist, idCli, "Nome: " + nomeMaiusculo);
    return idCli === dados.id ? "Cadastro atualizado com sucesso!" : "Cadastro salvo com sucesso!";
  };

  API.excluirCliente = async function (id) {
    const user = await exigirSessao();
    if (!id) throw new Error("ID não informado.");
    const { error } = await supabase.from('clientes').delete().eq('id', id);
    if (error) throw new Error("Erro ao excluir cliente: " + error.message);

    invalidarCache();
    await registrarHistorico(user.email, "Exclusão de Cadastro", id, "Cliente ID: " + id);
    return "Cliente excluído!";
  };

  API.salvarNovaCategoria = async function (dados) {
    const user = await exigirSessao();
    let nome = "";
    let tipo = "Despesa";
    if (typeof dados === "string") {
      nome = dados.trim();
    } else if (typeof dados === "object" && dados !== null) {
      nome = (dados.categoria || dados.nome || "").trim();
      tipo = (dados.tipo || "Despesa").trim();
    }
    if (!nome) throw new Error("Nome da categoria é obrigatório.");

    if (tipo.toLowerCase() === "despesa") {
      const nomeNorm = nome.toLowerCase();
      const prefixoValido = (
        nomeNorm.indexOf("cmv - ") === 0 ||
        nomeNorm.indexOf("fixa - ") === 0 ||
        nomeNorm.indexOf("variável - ") === 0 ||
        nomeNorm.indexOf("variavel - ") === 0 ||
        nomeNorm.indexOf("impostos - simples nacional") === 0
      );
      if (!prefixoValido) {
        throw new Error("Categorias de despesa devem obrigatoriamente iniciar com um dos prefixos: 'CMV - ', 'Fixa - ', 'Variável - ' ou 'Impostos - Simples Nacional'.");
      }
    }

    const { error } = await supabase.from('categorias').upsert({ nome, tipo });
    if (error) throw new Error("Erro ao salvar categoria: " + error.message);

    invalidarCache();
    await registrarHistorico(user.email, "Salvar Categoria DRE", "-", `${nome} (${tipo})`);
    return "Categoria salva com sucesso!";
  };

  API.excluirCategoria = async function (nome) {
    const user = await exigirSessao();
    const nomeStr = (typeof nome === "object" && nome !== null) ? (nome.categoria || nome.nome || "").trim() : (nome || "").trim();
    if (!nomeStr) throw new Error("Nome da categoria não informado.");

    const { error } = await supabase.from('categorias').delete().eq('nome', nomeStr);
    if (error) throw new Error("Erro ao excluir categoria: " + error.message);

    invalidarCache();
    await registrarHistorico(user.email, "Exclusão Categoria DRE", "-", "Removido: " + nomeStr);
    return "Categoria removida!";
  };

  API.salvarNovaFormaPagamento = async function (dados) {
    const user = await exigirSessao();
    let nome = "";
    let taxa = 0;
    let prazo = 0;
    let statusSugerido = "Pendente";
    let retemSaldo = false;

    if (typeof dados === "string") {
      nome = dados.trim();
    } else if (typeof dados === "object" && dados !== null) {
      nome = (dados.nome || dados.forma || "").trim();
      taxa = tratarValor(dados.taxa);
      prazo = parseInt(dados.prazo, 10) || 0;
      statusSugerido = (dados.statusSugerido || "Pendente").trim();
      retemSaldo = !!dados.retemSaldo;
    }
    if (!nome) throw new Error("Nome da forma de pagamento é obrigatório.");

    const { error } = await supabase.from('formas_pagamento').upsert({
      nome,
      taxa,
      prazo,
      status_sugerido: statusSugerido,
      retem_saldo: retemSaldo
    });
    if (error) throw new Error("Erro ao salvar forma de pagamento: " + error.message);

    invalidarCache();
    await registrarHistorico(user.email, "Salvar Forma Pagamento", "-", `${nome} (Taxa: ${taxa}%, Prazo: ${prazo}d, Retém: ${retemSaldo})`);
    return "Forma de pagamento salva com sucesso!";
  };

  API.excluirFormaPagamento = async function (nome) {
    const user = await exigirSessao();
    const nomeStr = (typeof nome === "object" && nome !== null) ? (nome.nome || nome.forma || "").trim() : (nome || "").trim();
    if (!nomeStr) throw new Error("Nome da forma de pagamento não informado.");

    const { error } = await supabase.from('formas_pagamento').delete().eq('nome', nomeStr);
    if (error) throw new Error("Erro ao excluir forma de pagamento: " + error.message);

    invalidarCache();
    await registrarHistorico(user.email, "Exclusão Forma Pagamento", "-", "Removido: " + nomeStr);
    return "Forma de pagamento removida!";
  };

  // -----------------------------------------
  // 5.4. LANÇAMENTOS, EDIÇÃO E BAIXA (SEÇÕES 5, 6, 7 & PONTO 6)
  // -----------------------------------------
  API.guardarLancamento = async function (dados) {
    const user = await exigirSessao();
    if (!dados) throw new Error("Dados do lançamento não fornecidos.");

    const tipo = (dados.tipo || "").trim();
    if (tipo !== "Receita" && tipo !== "Despesa") {
      throw new Error("Tipo inválido. Deve ser 'Receita' ou 'Despesa'.");
    }

    if (!dados.dataCompetencia) throw new Error("Data de competência é obrigatória.");
    const compISO = formataDataParaHtml(dados.dataCompetencia);

    const categoria = (dados.categoria || "").trim();
    if (!categoria) throw new Error("Categoria financeira é obrigatória.");
    if (categoria.toLowerCase() === "taxas financeiras - ifood e maquininhas".toLowerCase()) {
      throw new Error("Lançamento manual não permitido para a categoria 'Taxas Financeiras - iFood e Maquininhas'. Ela é calculada automaticamente a partir das vendas.");
    }

    const valorBruto = tratarValor(dados.valor !== undefined ? dados.valor : dados.valorBruto);
    if (valorBruto <= 0) throw new Error("O valor deve ser maior que zero.");

    const pessoa = (dados.pessoa || dados.cliente || "").trim().toUpperCase();
    const forma = (dados.formaPagamento || dados.forma || "").trim();
    const observacao = (dados.observacao || "").trim();

    await carregarCache();
    const id = "LANC-" + Date.now();
    let vencimento = "";
    let dataPagamento = null;
    let taxaRetida = 0;
    let valorLiquido = 0;
    let status = "Pendente";

    if (tipo === "Receita") {
      const regra = (cache.formasPagamento || []).find(f => f.nome.toLowerCase() === forma.toLowerCase());
      if (!regra) {
        throw new Error(`Forma de pagamento '${forma}' não cadastrada. Por favor, cadastre a forma de pagamento em Cadastros antes de lançar a receita.`);
      }
      taxaRetida = Math.round(valorBruto * (Number(regra.taxa) / 100) * 100) / 100;
      valorLiquido = Math.round((valorBruto - taxaRetida) * 100) / 100;
      vencimento = somarDias(compISO, parseInt(regra.prazo, 10) || 0);

      if (regra.retem_saldo) {
        // Seção 6.1: Receita com forma retem_saldo: nasce SEMPRE Pendente, valor_recebido = 0
        status = "Pendente";
        dataPagamento = null;
      } else {
        status = (dados.status || regra.status_sugerido || "Pendente").trim();
        if (status.toLowerCase() === "pago") {
          status = "Pago";
          dataPagamento = dados.dataPagamento ? formataDataParaHtml(dados.dataPagamento) : vencimento;
        } else {
          status = "Pendente";
          dataPagamento = null;
        }
      }
    } else if (tipo === "Despesa") {
      taxaRetida = 0;
      valorLiquido = valorBruto;
      if (!dados.vencimento) throw new Error("Data de vencimento é obrigatória para despesas.");
      vencimento = formataDataParaHtml(dados.vencimento);
      status = "Pendente";
      dataPagamento = null;
    }

    const { error } = await supabase.from('lancamentos').insert({
      id,
      competencia: compISO,
      vencimento,
      data_pagamento: dataPagamento,
      tipo,
      categoria,
      pessoa,
      forma_pagamento: forma,
      valor_bruto: valorBruto,
      taxa_retida: taxaRetida,
      valor_liquido: valorLiquido,
      valor_recebido: 0,
      status,
      descricao: observacao
    });

    if (error) throw new Error("Erro ao registrar lançamento: " + error.message);

    invalidarCache();
    await registrarHistorico(user.email, "Novo Lançamento", id, `${tipo} - ${pessoa} | ${categoria} | Bruto: R$ ${valorBruto.toFixed(2)} (Líq: R$ ${valorLiquido.toFixed(2)})`);
    return "Lançamento registrado com sucesso!";
  };

  API.buscarLancamentoPorId = async function (id) {
    await exigirSessao();
    await carregarCache();
    const row = (cache.lancamentos || []).find(l => String(l.id) === String(id));
    if (!row) return null;

    const regra = (cache.formasPagamento || []).find(f => f.nome.toLowerCase() === (row.forma_pagamento || '').toLowerCase());
    return {
      id: row.id,
      competencia: formataDataParaHtml(row.competencia),
      vencimento: formataDataParaHtml(row.vencimento),
      pagamento: formataDataParaHtml(row.data_pagamento),
      tipo: row.tipo,
      categoria: row.categoria,
      pessoa: row.pessoa,
      forma: row.forma_pagamento,
      valorBruto: Number(row.valor_bruto),
      taxa: Number(row.taxa_retida),
      valorLiquido: Number(row.valor_liquido),
      status: row.status,
      observacao: row.descricao || "",
      valorRecebido: Number(row.valor_recebido || 0),
      retemSaldo: !!(regra && regra.retem_saldo)
    };
  };

  API.atualizarLancamentoEdicao = async function (dados) {
    const user = await exigirSessao();
    if (!dados || !dados.id) throw new Error("ID do lançamento é obrigatório.");
    if (!dados.motivo || !dados.motivo.trim()) throw new Error("O motivo da alteração é obrigatório.");

    const categoria = (dados.categoria || "").trim();
    if (categoria.toLowerCase() === "taxas financeiras - ifood e maquininhas".toLowerCase()) {
      throw new Error("Lançamento manual não permitido para a categoria 'Taxas Financeiras - iFood e Maquininhas'.");
    }

    await carregarCache();
    const rowAntigo = (cache.lancamentos || []).find(l => String(l.id) === String(dados.id));
    if (!rowAntigo) throw new Error("Lançamento não encontrado.");

    // Seção 6.5: Título com valor_recebido > 0 não pode ser editado nem excluído
    if (Number(rowAntigo.valor_recebido) > 0) {
      throw new Error(`Este título já possui repasse recebido (R$ ${Number(rowAntigo.valor_recebido).toFixed(2)}). Estorne o repasse antes.`);
    }

    const regraAntiga = (cache.formasPagamento || []).find(f => f.nome.toLowerCase() === (rowAntigo.forma_pagamento || '').toLowerCase());
    if (regraAntiga && regraAntiga.retem_saldo && dados.status && dados.status.toLowerCase() === "pago") {
      throw new Error("Títulos de plataformas com retenção de saldo não aceitam mudança manual para Pago. Use a tela Retenção para registrar o repasse.");
    }

    const tipo = (dados.tipo || "").trim();
    const valorBruto = tratarValor(dados.valorBruto !== undefined ? dados.valorBruto : dados.valor);
    if (valorBruto <= 0) throw new Error("O valor deve ser maior que zero.");

    const forma = (dados.forma || dados.formaPagamento || "").trim();
    const pessoa = (dados.pessoa || dados.cliente || "").trim().toUpperCase();
    let status = (dados.status || "Pendente").trim();
    let dataPagamento = null;

    let taxaRetida = 0;
    let valorLiquido = 0;
    let vencimento = "";

    if (tipo === "Receita") {
      const regra = (cache.formasPagamento || []).find(f => f.nome.toLowerCase() === forma.toLowerCase());
      if (!regra) {
        throw new Error(`Forma de pagamento '${forma}' não cadastrada. Por favor, cadastre a forma de pagamento em Cadastros antes de atualizar a receita.`);
      }
      taxaRetida = Math.round(valorBruto * (Number(regra.taxa) / 100) * 100) / 100;
      valorLiquido = Math.round((valorBruto - taxaRetida) * 100) / 100;
      vencimento = dados.vencimento ? formataDataParaHtml(dados.vencimento) : formataDataParaHtml(dados.competencia);

      if (regra.retem_saldo) {
        status = "Pendente";
        dataPagamento = null;
      } else {
        if (status.toLowerCase() === "pago") {
          if (!dados.pagamento) throw new Error("Para o status Pago, a Data de Pagamento é obrigatória.");
          dataPagamento = formataDataParaHtml(dados.pagamento);
        } else {
          status = "Pendente";
          dataPagamento = null;
        }
      }
    } else if (tipo === "Despesa") {
      taxaRetida = 0;
      valorLiquido = valorBruto;
      if (!dados.vencimento) throw new Error("Data de vencimento é obrigatória para despesas.");
      vencimento = formataDataParaHtml(dados.vencimento);

      if (status.toLowerCase() === "pago") {
        if (!dados.pagamento) throw new Error("Para o status Pago, a Data de Pagamento é obrigatória.");
        dataPagamento = formataDataParaHtml(dados.pagamento);
      } else {
        status = "Pendente";
        dataPagamento = null;
      }
    }

    // Ponto 6: Proteção contra concorrência e cache desatualizado com .eq('valor_recebido', 0).select('id')
    const { data: afetados, error } = await supabase.from('lancamentos').update({
      competencia: formataDataParaHtml(dados.competencia),
      vencimento,
      data_pagamento: dataPagamento,
      tipo,
      categoria,
      pessoa,
      forma_pagamento: forma,
      valor_bruto: valorBruto,
      taxa_retida: taxaRetida,
      valor_liquido: valorLiquido,
      status,
      descricao: dados.observacao || ""
    }).eq('id', dados.id).eq('valor_recebido', 0).select('id');

    if (error) throw new Error("Erro ao editar lançamento: " + error.message);
    if (!afetados || afetados.length === 0) {
      invalidarCache();
      throw new Error("Não foi possível editar: o título já possui repasse recebido ou foi alterado. Estorne o repasse ou atualize os dados.");
    }

    invalidarCache();
    await registrarHistorico(user.email, "Edição Lançamento", dados.id, `MOTIVO: ${dados.motivo} | ${tipo} - ${pessoa} | R$ ${valorBruto.toFixed(2)} (${categoria}) | Status: ${status}`);
    return "Lançamento editado com sucesso!";
  };

  API.excluirLancamentoReal = async function (id, motivo) {
    const user = await exigirSessao();
    if (!id) throw new Error("ID do lançamento é obrigatório.");
    if (!motivo || !motivo.trim()) throw new Error("O motivo da exclusão é obrigatório.");

    await carregarCache();
    const row = (cache.lancamentos || []).find(l => String(l.id) === String(id));
    if (!row) throw new Error("Lançamento não encontrado.");

    if (Number(row.valor_recebido) > 0) {
      throw new Error(`Este título já possui repasse recebido (R$ ${Number(row.valor_recebido).toFixed(2)}). Estorne o repasse antes.`);
    }

    // Ponto 6: Proteção com .eq('valor_recebido', 0).select('id')
    const { data: afetados, error } = await supabase.from('lancamentos').delete().eq('id', id).eq('valor_recebido', 0).select('id');
    if (error) throw new Error("Erro ao excluir lançamento: " + error.message);
    if (!afetados || afetados.length === 0) {
      invalidarCache();
      throw new Error("Não foi possível excluir: o título já possui repasse recebido ou não foi encontrado. Estorne o repasse ou atualize os dados.");
    }

    invalidarCache();
    await registrarHistorico(user.email, "Exclusão Lançamento", id, `MOTIVO: ${motivo} | ${row.tipo} - ${row.pessoa} (R$ ${Number(row.valor_bruto).toFixed(2)})`);
    return "Lançamento excluído com segurança.";
  };

  API.baixarPagamento = async function (id, dataPagamento) {
    const user = await exigirSessao();
    if (!id) throw new Error("ID do lançamento é obrigatório.");
    if (!dataPagamento) throw new Error("Data de Pagamento é obrigatória para realizar a baixa.");

    await carregarCache();
    const row = (cache.lancamentos || []).find(l => String(l.id) === String(id));
    if (!row) throw new Error("Lançamento não encontrado.");

    const regra = (cache.formasPagamento || []).find(f => f.nome.toLowerCase() === (row.forma_pagamento || '').toLowerCase());
    if (regra && regra.retem_saldo) {
      throw new Error("Use a tela Retenção para registrar o repasse.");
    }

    const dataIso = formataDataParaHtml(dataPagamento);

    // Ponto 6: Proteção com .eq('status', 'Pendente').select('id')
    const { data: afetados, error } = await supabase.from('lancamentos').update({
      data_pagamento: dataIso,
      status: 'Pago'
    }).eq('id', id).eq('status', 'Pendente').select('id');

    if (error) throw new Error("Erro ao realizar baixa: " + error.message);
    if (!afetados || afetados.length === 0) {
      invalidarCache();
      throw new Error("Não foi possível baixar o título: lançamento não encontrado ou já se encontra como Pago. Atualize os dados.");
    }

    invalidarCache();
    const valorMovimento = row.tipo === 'Receita' ? Number(row.valor_liquido) : Number(row.valor_bruto);
    await registrarHistorico(user.email, "Baixa de Título", id, `Baixado para ${row.pessoa} | Data: ${formatarData(dataIso)} | Valor: R$ ${valorMovimento.toFixed(2)}`);
    return "Baixado com sucesso!";
  };

  API.buscarPendentes = async function () {
    await exigirSessao();
    await carregarCache();

    // Ponto 3: Obter data de hoje localmente (evita avanço de dia após 21h UTC)
    const hojeISO = obterHojeLocalISO();
    const [hy, hm, hd] = hojeISO.split('-').map(Number);
    const hojeMs = Date.UTC(hy, hm - 1, hd);

    const formasMap = {};
    (cache.formasPagamento || []).forEach(f => {
      formasMap[f.nome.toLowerCase()] = f;
    });

    const pendentes = [];
    (cache.lancamentos || []).forEach(l => {
      if ((l.status || '').toLowerCase() === 'pendente') {
        const regra = formasMap[(l.forma_pagamento || '').toLowerCase()];
        const retemSaldo = !!(regra && regra.retem_saldo);
        const vencISO = formataDataParaHtml(l.vencimento);
        let diasAtraso = 0;
        let vencMs = 0;
        if (vencISO) {
          const [vy, vm, vd] = vencISO.split('-').map(Number);
          vencMs = Date.UTC(vy, vm - 1, vd);
          if (vencMs < hojeMs) {
            diasAtraso = Math.ceil((hojeMs - vencMs) / (1000 * 60 * 60 * 24));
          }
        }

        const valorBruto = Number(l.valor_bruto);
        const taxa = Number(l.taxa_retida);
        const valorLiquido = Number(l.valor_liquido);
        const valorRecebido = Number(l.valor_recebido || 0);

        // Seção 7: valor = o que ainda falta mover o caixa (Receita: valorLiquido - valorRecebido; Despesa: valorBruto)
        const valorFalta = l.tipo === 'Receita'
          ? Math.round(Math.max(0, valorLiquido - valorRecebido) * 100) / 100
          : valorBruto;

        pendentes.push({
          id: l.id,
          tipo: l.tipo,
          cliente: l.pessoa || "Não Informado",
          categoria: l.categoria || "",
          forma: l.forma_pagamento || "",
          vencimento: formatarData(l.vencimento),
          vencimentoDataObj: vencMs,
          diasAtraso,
          valorBruto,
          taxa,
          valorLiquido,
          valorRecebido,
          retemSaldo,
          valor: valorFalta
        });
      }
    });

    return pendentes;
  };

  API.buscarHistorico = async function (dataDe, dataAte, busca) {
    await exigirSessao();

    // Ponto 4: Limites de início e fim do dia no fuso local e limite de 2000 linhas se houver filtros
    const temFiltro = Boolean((dataDe && String(dataDe).trim()) || (dataAte && String(dataAte).trim()) || (busca && String(busca).trim()));
    const limite = temFiltro ? 2000 : 200;

    let query = supabase.from('historico').select('*').order('data_hora', { ascending: false }).limit(limite);

    if (dataDe && String(dataDe).trim()) {
      const isoDe = formataDataParaHtml(dataDe);
      const [ano, mes, dia] = isoDe.split('-').map(Number);
      const dIni = new Date(ano, mes - 1, dia, 0, 0, 0, 0);
      query = query.gte('data_hora', dIni.toISOString());
    }
    if (dataAte && String(dataAte).trim()) {
      const isoAte = formataDataParaHtml(dataAte);
      const [ano, mes, dia] = isoAte.split('-').map(Number);
      const dFim = new Date(ano, mes - 1, dia, 23, 59, 59, 999);
      query = query.lte('data_hora', dFim.toISOString());
    }

    const { data, error } = await query;
    if (error) throw new Error("Erro ao buscar histórico: " + error.message);

    let lista = (data || []).map(h => ({
      dataHora: new Date(h.data_hora).toLocaleString('pt-BR'),
      usuario: h.usuario || "",
      acao: h.acao || "",
      id: h.id_registro || "",
      detalhes: h.detalhes || ""
    }));

    if (busca && String(busca).trim()) {
      const termo = String(busca).trim().toLowerCase();
      lista = lista.filter(item =>
        (item.dataHora + " " + item.usuario + " " + item.acao + " " + item.id + " " + item.detalhes).toLowerCase().includes(termo)
      );
    }
    return lista;
  };

  // -----------------------------------------
  // 5.5. GESTÃO DE RETENÇÃO E REPASSES (SEÇÃO 6 & 7 & PONTO 7)
  // -----------------------------------------
  API.buscarRetencao = async function () {
    await exigirSessao();
    await carregarCache();

    const formasRetencao = (cache.formasPagamento || []).filter(f => f.retem_saldo);
    const formasRetencaoSet = new Set(formasRetencao.map(f => f.nome.toLowerCase()));

    // Títulos retidos pendentes em ordem FIFO (competência asc, id asc)
    const titulosPendentes = (cache.lancamentos || [])
      .filter(l => l.tipo === 'Receita' && (l.status || '').toLowerCase() === 'pendente' && formasRetencaoSet.has((l.forma_pagamento || '').toLowerCase()))
      .sort((a, b) => {
        const cmp = (a.competencia || '').localeCompare(b.competencia || '');
        if (cmp !== 0) return cmp;
        return (a.id || '').localeCompare(b.id || '');
      });

    const titulos = titulosPendentes.map(t => {
      const vl = Number(t.valor_liquido);
      const vr = Number(t.valor_recebido || 0);
      const saldo = Math.round(Math.max(0, vl - vr) * 100) / 100;
      return {
        id: t.id,
        forma: t.forma_pagamento,
        cliente: t.pessoa,
        competencia: formatarData(t.competencia),
        vencimento: formatarData(t.vencimento),
        valorBruto: Number(t.valor_bruto),
        taxa: Number(t.taxa_retida),
        valorLiquido: vl,
        valorRecebido: vr,
        saldo
      };
    });

    // Ponto 7: proximoVencimento deve ser o MENOR vencimento entre os títulos da forma
    const plataformas = formasRetencao.map(f => {
      const titulosDaForma = titulos.filter(t => t.forma.toLowerCase() === f.nome.toLowerCase());
      const saldoRetido = Math.round(titulosDaForma.reduce((acc, t) => acc + t.saldo, 0) * 100) / 100;
      const qtdTitulos = titulosDaForma.length;

      let proximoVencimento = "";
      if (titulosDaForma.length > 0) {
        const vencimentosValidos = titulosDaForma
          .map(t => formataDataParaHtml(t.vencimento))
          .filter(Boolean)
          .sort();
        if (vencimentosValidos.length > 0) {
          proximoVencimento = formatarData(vencimentosValidos[0]);
        }
      }

      return {
        forma: f.nome,
        saldoRetido,
        qtdTitulos,
        proximoVencimento
      };
    });

    // Mapeamento de repasses com suas baixas
    const baixasMap = {};
    (cache.repasseBaixas || []).forEach(b => {
      if (!baixasMap[b.repasse_id]) baixasMap[b.repasse_id] = [];
      baixasMap[b.repasse_id].push({
        lancamentoId: b.lancamento_id,
        valor: Number(b.valor)
      });
    });

    const repasses = (cache.repasses || []).slice(0, 100).map(r => ({
      id: r.id,
      forma: r.forma,
      data: formatarData(r.data_pagamento),
      valor: Number(r.valor),
      observacao: r.observacao || "",
      usuario: r.criado_por || "",
      baixas: baixasMap[r.id] || []
    }));

    return { plataformas, titulos, repasses };
  };

  API.registrarRepasse = async function (dados) {
    const user = await exigirSessao();
    if (!dados) throw new Error("Dados do repasse não fornecidos.");
    const forma = (dados.forma || "").trim();
    if (!forma) throw new Error("Forma de pagamento é obrigatória.");
    if (!dados.dataPagamento) throw new Error("Data de pagamento do repasse é obrigatória.");

    const valor = tratarValor(dados.valor);
    if (valor <= 0) throw new Error("Valor do repasse deve ser maior que zero.");

    const dataIso = formataDataParaHtml(dados.dataPagamento);
    const { data, error } = await supabase.rpc('registrar_repasse', {
      p_forma: forma,
      p_data: dataIso,
      p_valor: valor,
      p_obs: (dados.observacao || "").trim(),
      p_usuario: user.email
    });

    if (error) {
      throw new Error(error.message);
    }

    const repasseId = data;
    invalidarCache();
    await registrarHistorico(user.email, "Registro de Repasse", repasseId, `Forma: ${forma} | Data: ${formatarData(dataIso)} | R$ ${valor.toFixed(2)}`);
    return `Repasse ${repasseId} registrado com sucesso!`;
  };

  API.estornarRepasse = async function (id, motivo) {
    const user = await exigirSessao();
    if (!id) throw new Error("ID do repasse é obrigatório.");
    if (!motivo || !motivo.trim()) throw new Error("O motivo do estorno é obrigatório.");

    const { error } = await supabase.rpc('estornar_repasse', { p_id: id });
    if (error) {
      throw new Error(error.message);
    }

    invalidarCache();
    await registrarHistorico(user.email, "Estorno de Repasse", id, `MOTIVO: ${motivo.trim()}`);
    return "Repasse estornado com sucesso!";
  };

  // -----------------------------------------
  // 5.6. MOTOR DE BI (DRE + FLUXO DE CAIXA + CARDS + ALERTAS) (PONTO 2 & 3)
  // -----------------------------------------
  API.gerarDadosBI = async function (filtros) {
    await exigirSessao();
    await carregarCache();

    if (!filtros) filtros = { ano: "todos", mes: "todos", visao: "mensal" };
    const anoFiltro = filtros.ano ? filtros.ano.toString().trim() : "todos";
    const mesFiltro = filtros.mes ? filtros.mes.toString().trim() : "todos";
    const visaoFiltro = filtros.visao ? filtros.visao.toString().trim() : "mensal";

    function atendePeriodo(dataIso) {
      if (!dataIso) return false;
      const p = dataIso.split("T")[0].split("-");
      if (p.length < 2) return false;
      const anoStr = p[0];
      const mesStr = ("0" + parseInt(p[1], 10)).slice(-2);

      if (anoFiltro !== "todos" && anoFiltro !== anoStr) return false;
      if (mesFiltro !== "todos") {
        if (visaoFiltro === "mensal" && mesFiltro !== mesStr) return false;
        if (visaoFiltro === "acumulado" && parseInt(mesStr, 10) > parseInt(mesFiltro, 10)) return false;
      }
      return true;
    }

    function criarLinhaDRE() {
      return {
        receitaBruta: 0,
        taxas: 0,
        impostos: 0,
        deducoes: 0,
        receitaLiquida: 0,
        cmv: 0,
        lucroBruto: 0,
        despFixas: 0,
        despVariaveis: 0,
        despesasOperacionais: 0,
        lucroLiquido: 0,
        cmvPerc: 0,
        lucroLiquidoPerc: 0
      };
    }

    function finalizarLinhaDRE(l) {
      l.receitaBruta = Math.round(l.receitaBruta * 100) / 100;
      l.taxas = Math.round(l.taxas * 100) / 100;
      l.impostos = Math.round(l.impostos * 100) / 100;
      l.deducoes = Math.round((l.taxas + l.impostos) * 100) / 100;
      l.receitaLiquida = Math.round((l.receitaBruta - l.deducoes) * 100) / 100;
      l.cmv = Math.round(l.cmv * 100) / 100;
      l.lucroBruto = Math.round((l.receitaLiquida - l.cmv) * 100) / 100;
      l.despFixas = Math.round(l.despFixas * 100) / 100;
      l.despVariaveis = Math.round(l.despVariaveis * 100) / 100;
      l.despesasOperacionais = Math.round((l.despFixas + l.despVariaveis) * 100) / 100;
      l.lucroLiquido = Math.round((l.lucroBruto - l.despesasOperacionais) * 100) / 100;
      l.cmvPerc = l.receitaBruta > 0 ? Math.round(((l.cmv / l.receitaBruta) * 100) * 100) / 100 : 0;
      l.lucroLiquidoPerc = l.receitaBruta > 0 ? Math.round(((l.lucroLiquido / l.receitaBruta) * 100) * 100) / 100 : 0;
      return l;
    }

    const formasMap = {};
    (cache.formasPagamento || []).forEach(f => {
      formasMap[f.nome.toLowerCase()] = f;
    });

    // Ponto 3: Data de hoje local
    const hojeISO = obterHojeLocalISO();
    const [hy, hm, hd] = hojeISO.split('-').map(Number);
    const hojeMs = Date.UTC(hy, hm - 1, hd);

    const dreMeses = {};
    const dreTotal = criarLinhaDRE();

    const caixaMeses = {};
    const caixaTotal = { entradas: 0, saidas: 0, saldo: 0 };
    let saldoCaixaAcumulado = 0;

    const categoriasDespesa = {};
    const formasPagamento = {};

    let totalRetido = 0;
    const porFormaRetencao = {};

    const pagarAtrasadas = [];
    const receberAtrasadas = [];
    let totalAPagar = 0;
    let totalAReceber = 0;

    // 1. Processamento de Lançamentos
    (cache.lancamentos || []).forEach(linha => {
      const id = linha.id;
      const compISO = formataDataParaHtml(linha.competencia);
      const vencISO = formataDataParaHtml(linha.vencimento);
      const pagISO = formataDataParaHtml(linha.data_pagamento);

      const tipo = (linha.tipo || '').toLowerCase();
      const categoriaRaw = linha.categoria || 'Sem Categoria';
      const categoriaNorm = categoriaRaw.toLowerCase();
      const pessoa = linha.pessoa || 'Não Informado';
      const forma = linha.forma_pagamento || 'Não Informada';

      const valorBruto = Number(linha.valor_bruto);
      const taxaRetida = Number(linha.taxa_retida);
      const valorLiquido = Number(linha.valor_liquido);
      const valorRecebido = Number(linha.valor_recebido || 0);
      const status = (linha.status || 'pendente').toLowerCase();

      const regraForma = formasMap[forma.toLowerCase()];
      const retemSaldo = !!(regraForma && regraForma.retem_saldo);

      // ----------------------------------------------------
      // ALERTAS E PENDENTES (IGNORA FILTROS)
      // ----------------------------------------------------
      if (status === 'pendente') {
        if (tipo === 'despesa') {
          totalAPagar += valorBruto;
          if (vencISO) {
            const [vy, vm, vd] = vencISO.split('-').map(Number);
            const vencMs = Date.UTC(vy, vm - 1, vd);
            if (vencMs < hojeMs) {
              const diasAtraso = Math.ceil((hojeMs - vencMs) / (1000 * 60 * 60 * 24));
              pagarAtrasadas.push({
                id,
                pessoa,
                categoria: categoriaRaw,
                vencimento: formatarData(linha.vencimento),
                diasAtraso,
                valor: valorBruto
              });
            }
          }
        } else if (tipo === 'receita') {
          // Seção 7: saldo restante (liquido - recebido)
          const saldoRestante = Math.max(0, Math.round((valorLiquido - valorRecebido) * 100) / 100);
          totalAReceber += saldoRestante;
          if (vencISO) {
            const [vy, vm, vd] = vencISO.split('-').map(Number);
            const vencMs = Date.UTC(vy, vm - 1, vd);
            if (vencMs < hojeMs) {
              const diasAtraso = Math.ceil((hojeMs - vencMs) / (1000 * 60 * 60 * 24));
              receberAtrasadas.push({
                id,
                pessoa,
                categoria: categoriaRaw,
                vencimento: formatarData(linha.vencimento),
                diasAtraso,
                valor: saldoRestante
              });
            }
          }
        }

        // Retenção: saldo pendente em plataformas de delivery
        if (tipo === 'receita' && retemSaldo) {
          const saldoRetidoTitulo = Math.max(0, Math.round((valorLiquido - valorRecebido) * 100) / 100);
          totalRetido += saldoRetidoTitulo;
          porFormaRetencao[forma] = Math.round(((porFormaRetencao[forma] || 0) + saldoRetidoTitulo) * 100) / 100;
        }
      }

      // ----------------------------------------------------
      // FLUXO DE CAIXA & SALDO ACUMULADO (PONTO 2 - REGRA ROBUSTA)
      // ----------------------------------------------------
      if (status === 'pago' && pagISO) {
        if (tipo === 'despesa') {
          saldoCaixaAcumulado -= valorBruto;
          if (atendePeriodo(pagISO)) {
            const p = pagISO.split("-");
            const chaveMesPag = `${p[1]}/${p[0]}`;
            if (!caixaMeses[chaveMesPag]) {
              caixaMeses[chaveMesPag] = { entradas: 0, saidas: 0, saldo: 0, sortKey: `${p[0]}${p[1]}` };
            }
            caixaMeses[chaveMesPag].saidas += valorBruto;
            caixaTotal.saidas += valorBruto;
          }
        } else if (tipo === 'receita') {
          // Ponto 2: toda Receita com status Pago e data_pagamento entra na data_pagamento
          // pelo valor (valor_liquido - valor_recebido), somente se esse valor for maior que zero;
          // a parte recebida via repasse continua entrando pelos repasses na data de cada repasse.
          const valorCaixaReceita = Math.round(Math.max(0, valorLiquido - valorRecebido) * 100) / 100;
          if (valorCaixaReceita > 0) {
            saldoCaixaAcumulado += valorCaixaReceita;
            if (atendePeriodo(pagISO)) {
              const p = pagISO.split("-");
              const chaveMesPag = `${p[1]}/${p[0]}`;
              if (!caixaMeses[chaveMesPag]) {
                caixaMeses[chaveMesPag] = { entradas: 0, saidas: 0, saldo: 0, sortKey: `${p[0]}${p[1]}` };
              }
              caixaMeses[chaveMesPag].entradas += valorCaixaReceita;
              caixaTotal.entradas += valorCaixaReceita;
            }
          }
        }
      }

      // ----------------------------------------------------
      // DRE: REGIME DE COMPETÊNCIA (PAGO E PENDENTE)
      // ----------------------------------------------------
      if (compISO && atendePeriodo(compISO)) {
        const p = compISO.split("-");
        const chaveMesComp = `${p[1]}/${p[0]}`;
        if (!dreMeses[chaveMesComp]) {
          dreMeses[chaveMesComp] = criarLinhaDRE();
          dreMeses[chaveMesComp].sortKey = `${p[0]}${p[1]}`;
        }
        const linhaMes = dreMeses[chaveMesComp];

        if (tipo === 'receita') {
          linhaMes.receitaBruta += valorBruto;
          dreTotal.receitaBruta += valorBruto;

          linhaMes.taxas += taxaRetida;
          dreTotal.taxas += taxaRetida;

          if (!formasPagamento[forma]) {
            formasPagamento[forma] = { bruto: 0, taxa: 0, liquido: 0 };
          }
          formasPagamento[forma].bruto += valorBruto;
          formasPagamento[forma].taxa += taxaRetida;
          formasPagamento[forma].liquido += valorLiquido;

        } else if (tipo === 'despesa') {
          categoriasDespesa[categoriaRaw] = (categoriasDespesa[categoriaRaw] || 0) + valorBruto;

          if (categoriaNorm.indexOf("impostos - simples nacional") === 0) {
            linhaMes.impostos += valorBruto;
            dreTotal.impostos += valorBruto;
          } else if (categoriaNorm.indexOf("cmv -") === 0) {
            linhaMes.cmv += valorBruto;
            dreTotal.cmv += valorBruto;
          } else if (categoriaNorm.indexOf("fixa -") === 0) {
            linhaMes.despFixas += valorBruto;
            dreTotal.despFixas += valorBruto;
          } else if (categoriaNorm.indexOf("variável -") === 0 || categoriaNorm.indexOf("variavel -") === 0) {
            linhaMes.despVariaveis += valorBruto;
            dreTotal.despVariaveis += valorBruto;
          }
        }
      }
    });

    // 2. Processamento dos Repasses no Fluxo de Caixa (Seção 6.6)
    (cache.repasses || []).forEach(rep => {
      const pagISO = formataDataParaHtml(rep.data_pagamento);
      const valorRep = Number(rep.valor);
      if (pagISO) {
        saldoCaixaAcumulado += valorRep;
        if (atendePeriodo(pagISO)) {
          const p = pagISO.split("-");
          const chaveMesPag = `${p[1]}/${p[0]}`;
          if (!caixaMeses[chaveMesPag]) {
            caixaMeses[chaveMesPag] = { entradas: 0, saidas: 0, saldo: 0, sortKey: `${p[0]}${p[1]}` };
          }
          caixaMeses[chaveMesPag].entradas += valorRep;
          caixaTotal.entradas += valorRep;
        }
      }
    });

    // 3. Finalizações e Ordenações
    finalizarLinhaDRE(dreTotal);

    const dreMesesOrdenado = {};
    Object.keys(dreMeses).sort((a, b) => dreMeses[a].sortKey.localeCompare(dreMeses[b].sortKey)).forEach(k => {
      delete dreMeses[k].sortKey;
      dreMesesOrdenado[k] = finalizarLinhaDRE(dreMeses[k]);
    });

    const caixaMesesOrdenado = {};
    Object.keys(caixaMeses).sort((a, b) => caixaMeses[a].sortKey.localeCompare(caixaMeses[b].sortKey)).forEach(k => {
      const m = caixaMeses[k];
      m.entradas = Math.round(m.entradas * 100) / 100;
      m.saidas = Math.round(m.saidas * 100) / 100;
      m.saldo = Math.round((m.entradas - m.saidas) * 100) / 100;
      delete m.sortKey;
      caixaMesesOrdenado[k] = m;
    });

    caixaTotal.entradas = Math.round(caixaTotal.entradas * 100) / 100;
    caixaTotal.saidas = Math.round(caixaTotal.saidas * 100) / 100;
    caixaTotal.saldo = Math.round((caixaTotal.entradas - caixaTotal.saidas) * 100) / 100;
    saldoCaixaAcumulado = Math.round(saldoCaixaAcumulado * 100) / 100;
    totalRetido = Math.round(totalRetido * 100) / 100;

    const cards = {
      faturamentoBruto: dreTotal.receitaBruta,
      cmvPerc: dreTotal.cmvPerc,
      lucroLiquidoPerc: dreTotal.lucroLiquidoPerc,
      saldoCaixa: saldoCaixaAcumulado,
      saldoRetido: totalRetido
    };

    Object.keys(categoriasDespesa).forEach(cat => {
      categoriasDespesa[cat] = Math.round(categoriasDespesa[cat] * 100) / 100;
    });
    Object.keys(formasPagamento).forEach(f => {
      formasPagamento[f].bruto = Math.round(formasPagamento[f].bruto * 100) / 100;
      formasPagamento[f].taxa = Math.round(formasPagamento[f].taxa * 100) / 100;
      formasPagamento[f].liquido = Math.round(formasPagamento[f].liquido * 100) / 100;
    });

    pagarAtrasadas.sort((a, b) => b.diasAtraso - a.diasAtraso);
    receberAtrasadas.sort((a, b) => b.diasAtraso - a.diasAtraso);

    return {
      dre: {
        meses: dreMesesOrdenado,
        total: dreTotal
      },
      caixa: {
        meses: caixaMesesOrdenado,
        total: caixaTotal,
        saldoAcumulado: saldoCaixaAcumulado
      },
      cards,
      retencao: {
        total: totalRetido,
        porForma: porFormaRetencao
      },
      categoriasDespesa,
      formasPagamento,
      alertas: {
        pagarAtrasadas,
        receberAtrasadas,
        totalAPagar: Math.round(totalAPagar * 100) / 100,
        totalAReceber: Math.round(totalAReceber * 100) / 100
      }
    };
  };

  // ---------------------------------------------------------------------------
  // 6. EXPOSIÇÃO GLOBAL
  // ---------------------------------------------------------------------------
  window.API = API;

})(window);
