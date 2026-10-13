# Contrato Front x Back v2 — JD Burgão (Supabase, sem Google Apps Script)

Pasta do projeto (trabalhe SOMENTE nela): `C:\Users\Felipe\OneDrive\Documentos\HTML\Sistema_JDBurgao`
Fontes obrigatórias: `mapa_do_projeto.md` e `escopo_de_neg_cios_jd_burg_o.md` (a matemática de taxas, prazos, DRE e Caixa do escopo continua valendo integralmente).
Ponto de partida: `index.html` e `codigo.js` atuais (versão Apps Script, já revisada). É uma REFATORAÇÃO: preserve telas, regras e nomes; troque o transporte.

## 0. Arquivos e donos
| Arquivo | Dono | Conteúdo |
|---|---|---|
| `index.html` | FRONT (Claude Code) | Login + todas as telas, CSS e JS de interface. Nenhuma chamada `google.script.run`. Nenhum acesso direto ao Supabase: só via `window.API`. |
| `codigo.js` | BACK (Antigravity) | Camada de dados e regras em JavaScript de navegador. Expõe `window.API`. Zero Apps Script (`SpreadsheetApp`, `HtmlService`, `doGet` etc. removidos). |
| `config.js` | BACK | `window.JD_CONFIG = { SUPABASE_URL, SUPABASE_ANON_KEY }` |
| `schema.sql` | BACK | DDL + RLS + sementes + funções RPC, idempotente, para colar no SQL Editor do Supabase. |
| `logo.png` | já existe | Usar no cabeçalho/sidebar e na tela de login. |

Ordem dos scripts no `index.html` (antes do script inline da interface):
```html
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js"></script>
<script src="config.js"></script>
<script src="codigo.js"></script>
```

## 1. Segurança (inegociável)
- Navegador não lê `.env`. O BACK copia do `.env.txt` para o `config.js` SOMENTE `SUPABASE_URL` e `SUPABASE_ANON_KEY`.
- `SUPABASE_URL` no config deve ser a URL base, SEM o sufixo `/rest/v1/`: `https://kahwdvqhbowqffmjnfer.supabase.co`.
- `SUPABASE_DB_URL` (contém a senha do Postgres) NUNCA pode aparecer em `config.js`, `codigo.js`, `index.html`, `schema.sql`, comentários ou logs. Ninguém conecta direto no Postgres.
- Toda tabela com `enable row level security` e política única: `for all to authenticated using (true) with check (true)`. Papel `anon` sem acesso a nada.
- Não existe tela de cadastro de usuário (sem `signUp`). Usuários são criados no painel do Supabase.

## 2. Autenticação (login obrigatório nativo do Supabase Auth)
`window.API.auth`:
- `login(email, senha)` → Promise<{email}> (usa `signInWithPassword`; erro → `throw new Error("E-mail ou senha inválidos.")`)
- `logout()` → Promise<void>
- `sessaoAtual()` → Promise<{email} | null>
- `aoMudarSessao(callback)` → chama `callback({email} | null)` em login, logout e expiração.

FRONT: ao carregar, mostra só a tela de login (logo, e-mail, senha, botão Entrar, mensagem de erro). O container do sistema fica `display:none` e nenhum dado é buscado até `sessaoAtual()` devolver usuário. Com sessão: esconde login, mostra o app, exibe o e-mail do usuário e o botão Sair. Em logout/expiração: limpa a tela e volta ao login. Toda função de dados do BACK chama internamente uma guarda que faz `throw new Error("Sessão expirada. Faça login novamente.")` se não houver sessão.

## 3. Convenção de chamadas
- Todas as funções de `window.API` são `async` (retornam Promise). Sucesso de escrita devolve string de mensagem; erro de regra faz `throw new Error("mensagem")`.
- FRONT troca cada `google.script.run.withSuccessHandler(ok).withFailureHandler(falha).fn(args)` por `API.fn(args).then(ok).catch(falha)` (ou async/await com try/catch). `configurarAbas` deixa de existir.
- Datas: FRONT envia `yyyy-MM-dd`; banco guarda `date`. BACK devolve datas de exibição em `dd/MM/yyyy` e datas para inputs em `yyyy-MM-dd`, exatamente nos mesmos campos da v1. Manipular datas como texto ISO / UTC para não haver deslocamento de fuso.
- Dinheiro: Number com 2 casas (arredondar com `Math.round(v*100)/100`).
- Auditoria: toda escrita grava em `historico` (usuário = e-mail da sessão).

## 4. Banco (schema.sql)
```
clientes(id text pk, nome text, classificacao text, tipo_pessoa text, documento text, telefone text, cidade text, status text)
categorias(nome text pk, tipo text)                       -- 'Receita' | 'Despesa'
formas_pagamento(nome text pk, taxa numeric, prazo int, status_sugerido text, retem_saldo boolean default false)
lancamentos(id text pk, competencia date, vencimento date, data_pagamento date, tipo text, categoria text, pessoa text,
            forma_pagamento text, valor_bruto numeric(14,2), taxa_retida numeric(14,2), valor_liquido numeric(14,2),
            valor_recebido numeric(14,2) default 0, status text, descricao text, criado_em timestamptz default now())
repasses(id text pk, forma text, data_pagamento date, valor numeric(14,2), observacao text, criado_por text, criado_em timestamptz default now())
repasse_baixas(id bigserial pk, repasse_id text references repasses(id) on delete cascade,
               lancamento_id text references lancamentos(id), valor numeric(14,2))
historico(id bigserial pk, data_hora timestamptz default now(), usuario text, acao text, id_registro text, detalhes text)
```
- Índices em `lancamentos(competencia)`, `lancamentos(data_pagamento)`, `lancamentos(status)`, `repasse_baixas(lancamento_id)`.
- Sementes (`on conflict do nothing`): as 21 categorias do item 3.1 do escopo e as 6 formas da v1 (Pix 0/0/Pago, Dinheiro 0/0/Pago, Cartão de Débito 1.5/1/Pendente, Cartão de Crédito 3.5/30/Pendente, iFood 15.2/30/Pendente, Voucher (VR/VA/Ticket) 3.5/15/Pendente). `retem_saldo = true` apenas para iFood.
- Script idempotente (`create table if not exists`, `drop policy if exists` antes de `create policy`, `create or replace function`).

## 5. Regras mantidas da v1 (não regredir)
- Receita: `taxa_retida = bruto * taxa/100`; `liquido = bruto - taxa`; `vencimento = competência + prazo`. O BACK recalcula sempre a partir de `formas_pagamento`; forma não cadastrada em Receita → erro.
- Despesa: taxa 0, líquido = bruto, vencimento obrigatório, nasce SEMPRE `Pendente` sem data de pagamento.
- Status `Pago` exige data de pagamento real; voltar a `Pendente` limpa a data.
- Categoria `Taxas Financeiras - iFood e Maquininhas` é automática: lançamento/edição manual nela → erro.
- Nova categoria de Despesa precisa começar com `CMV - `, `Fixa - `, `Variável - ` ou `Impostos - Simples Nacional`.
- DRE (competência): todas as linhas Pago ou Pendente, agrupadas só pela Competência; cascata de 7 linhas idêntica à v1 (receitaBruta; taxas + impostos = deducoes; receitaLiquida; cmv; lucroBruto; despFixas + despVariaveis = despesasOperacionais; lucroLiquido; cmvPerc; lucroLiquidoPerc). Despesa fora dos prefixos não entra na cascata.

## 6. NOVO — Retenção de saldo (iFood / plataformas de delivery)
Conceito: venda feita por uma forma com `retem_saldo = true` não vira dinheiro na hora; o valor LÍQUIDO fica **retido na plataforma**. A plataforma paga em **repasses fracionados** ao longo das semanas. Cada repasse lançado **abate** o saldo retido, quitando os títulos mais antigos primeiro (FIFO).

Regras:
1. Receita com forma `retem_saldo`: nasce SEMPRE `Pendente`, `valor_recebido = 0` (o BACK força, mesmo que o front mande Pago).
2. **Saldo retido** de uma forma = Σ (`valor_liquido - valor_recebido`) das receitas `Pendente` dessa forma.
3. `registrarRepasse({forma, dataPagamento, valor, observacao})`:
   - valida: forma com `retem_saldo`, data obrigatória, `valor > 0`, e `valor <= saldo retido da forma` (senão erro informando o saldo disponível);
   - cria o repasse e distribui o valor em FIFO (ordem: `competencia` asc, depois `id` asc) entre os títulos pendentes da forma, gravando uma linha em `repasse_baixas` por título atingido e somando em `valor_recebido`;
   - título cujo `valor_recebido` alcança o `valor_liquido` (tolerância 0,005) vira `Pago` com `data_pagamento` = data do repasse; título parcialmente coberto continua `Pendente`;
   - tudo ATÔMICO: implementar como função Postgres `registrar_repasse(p_forma text, p_data date, p_valor numeric, p_obs text, p_usuario text) returns text` (plpgsql, `security invoker`, com `for update` nos títulos) chamada via `supabase.rpc`. Retorna o id `REP-<epoch ms>`.
4. `estornarRepasse(id, motivo)`: motivo obrigatório; função Postgres `estornar_repasse(p_id text)` desfaz as baixas (subtrai de `valor_recebido`; título volta a `Pendente` com `data_pagamento = null` se deixou de estar quitado; se continuar com outras baixas, permanece Pendente) e apaga o repasse (cascade). Atômico.
5. Títulos de forma `retem_saldo` NÃO aceitam `baixarPagamento` nem mudança manual de status na edição → erro "Use a tela Retenção para registrar o repasse". Título com `valor_recebido > 0` não pode ser editado nem excluído → erro "Estorne o repasse antes".
6. **Fluxo de Caixa (regime de caixa, data real do dinheiro):**
   - receitas de forma SEM retenção: `valor_liquido` na `data_pagamento`, só `Pago` (igual v1);
   - receitas de forma COM retenção: entram pelos **repasses** — cada linha de `repasse_baixas` entra pelo seu `valor` na `data_pagamento` do repasse (assim o pagamento parcial já aparece no caixa); essas receitas NÃO são contadas de novo pelo `valor_liquido`;
   - despesas: `valor_bruto` na `data_pagamento`, só `Pago`;
   - `saldoAcumulado` segue a mesma regra, sem filtro de período.
7. DRE não muda: a venda iFood entra pela Competência com bruto e taxa, independente dos repasses.

## 7. window.API — funções de dados
Iguais à v1 em nome, parâmetros e retorno (ver assinaturas no `codigo.js` atual), com estes ajustes:
- `buscarListasIniciais()` → `formasPagamento: [{nome, taxa, prazo, statusSugerido, retemSaldo}]`
- `salvarNovaFormaPagamento({nome, taxa, prazo, statusSugerido, retemSaldo})`
- `buscarLancamentoPorId(id)` → acrescenta `valorRecebido`, `retemSaldo`
- `buscarPendentes()` → cada item acrescenta `valorRecebido`, `retemSaldo`; `valor` = o que ainda falta mover o caixa (Receita: `valorLiquido - valorRecebido`; Despesa: `valorBruto`)
- `gerarDadosBI(filtros)` → mesmo objeto da v1 (`dre`, `caixa`, `cards`, `categoriasDespesa`, `formasPagamento`, `alertas`) mais:
  - `cards.saldoRetido` (Number, total retido em todas as plataformas, ignora filtros)
  - `retencao: { total, porForma: { "iFood": Number, ... } }`
  - em `alertas`, `receberAtrasadas[].valor` e `totalAReceber` usam o saldo restante (`liquido - recebido`).
- Demais sem mudança: `salvarCliente`, `excluirCliente`, `salvarNovaCategoria`, `excluirCategoria`, `excluirFormaPagamento`, `guardarLancamento`, `atualizarLancamentoEdicao`, `excluirLancamentoReal`, `baixarPagamento`, `buscarHistorico`.

Novas:
```js
API.buscarRetencao() → {
  plataformas: [{ forma, saldoRetido, qtdTitulos, proximoVencimento /*dd/MM/yyyy ou ""*/ }],
  titulos:  [{ id, forma, cliente, competencia /*dd/MM/yyyy*/, vencimento /*dd/MM/yyyy*/, valorBruto, taxa,
               valorLiquido, valorRecebido, saldo }],              // só pendentes, ordem FIFO
  repasses: [{ id, forma, data /*dd/MM/yyyy*/, valor, observacao, usuario,
               baixas: [{ lancamentoId, valor }] }]                // mais recentes primeiro, máx. 100
}
API.registrarRepasse({ forma, dataPagamento /*yyyy-MM-dd*/, valor, observacao }) → string
API.estornarRepasse(id, motivo) → string
```

## 8. Desempenho (requisito do mapa: bem mais rápido que a v1)
BACK:
- Um único cliente Supabase. Cache em memória de `lancamentos`, `repasse_baixas`+`repasses` e listas; invalidado em toda escrita. `gerarDadosBI`, `buscarPendentes` e `buscarRetencao` calculam a partir do cache: trocar filtro ou tela não gera nova ida ao servidor.
- Leitura de `lancamentos` selecionando só as colunas necessárias e PAGINADA com `.range()` em blocos de 1000 (o PostgREST corta em 1000 linhas por requisição) até acabar.
- Cargas independentes em paralelo com `Promise.all`.
FRONT:
- Nunca bloquear a tela: indicadores de carregamento leves; renderizar só a tela visível; montar tabelas com uma única atribuição de `innerHTML`; debounce (≈200 ms) nos campos de busca; Google Charts carregado uma vez e gráficos desenhados só quando a tela está visível.

## 9. Interface (FRONT)
- Tema da marca: fundo escuro com detalhes em amarelo `#F2A900` (use `data-bs-theme="dark"` do Bootstrap 5.3; negativo `#E5484D`, positivo `#30A46C`); gráficos com fundo transparente e textos claros. `logo.png` na tela de login e no topo da sidebar.
- Telas: Login (nova) · Lançar & Histórico · Baixa de Títulos · **Retenção iFood (nova, `telaRetencao`)** · Cadastros · Visão Geral · DRE · Fluxo de Caixa.
- `telaRetencao`: cards por plataforma (saldo retido, qtd. de títulos, próximo vencimento); formulário "Registrar Repasse" (plataforma, data, valor, observação) mostrando o saldo antes e depois do abatimento e bloqueando valor maior que o saldo; tabela de títulos retidos em ordem FIFO (líquido, já recebido, saldo, barra de progresso); histórico de repasses com as baixas de cada um e botão Estornar (pede motivo).
- Lançamento: ao escolher forma com `retemSaldo` em uma Receita, travar Status em Pendente e mostrar aviso "O líquido de R$ X ficará retido na plataforma. Saldo retido atual: R$ Y → após este lançamento: R$ Z".
- Baixa de Títulos: para título com `retemSaldo`, no lugar do botão Baixar, link "Registrar repasse" que leva à `telaRetencao`; mostrar "recebido R$ X de R$ Y" quando parcial.
- Cadastro de forma de pagamento: checkbox "Retém saldo na plataforma (repasses fracionados)".
- Visão Geral: 5º card "Retido em plataformas" (`cards.saldoRetido`).
