-- ==============================================================================
-- SISTEMA FINANCEIRO JD BURGÃO — SCHEMA DO BANCO DE DADOS (SUPABASE / POSTGRES)
-- Idempotente: pode ser executado múltiplas vezes sem erros.
-- ==============================================================================

-- 1. TABELAS
-- ------------------------------------------------------------------------------

-- Clientes e Fornecedores
create table if not exists clientes (
  id text primary key,
  nome text not null,
  classificacao text default 'Ambos',
  tipo_pessoa text,
  documento text,
  telefone text,
  cidade text,
  status text default 'Ativo'
);

-- Categorias do DRE
create table if not exists categorias (
  nome text primary key,
  tipo text not null -- 'Receita' | 'Despesa'
);

-- Formas de Pagamento e Regras de Retenção
create table if not exists formas_pagamento (
  nome text primary key,
  taxa numeric not null default 0,
  prazo int not null default 0,
  status_sugerido text not null default 'Pendente',
  retem_saldo boolean not null default false
);

-- Lançamentos Financeiros
create table if not exists lancamentos (
  id text primary key,
  competencia date not null,
  vencimento date not null,
  data_pagamento date,
  tipo text not null, -- 'Receita' | 'Despesa'
  categoria text not null,
  pessoa text not null,
  forma_pagamento text not null,
  valor_bruto numeric(14,2) not null,
  taxa_retida numeric(14,2) not null default 0,
  valor_liquido numeric(14,2) not null,
  valor_recebido numeric(14,2) not null default 0,
  status text not null default 'Pendente', -- 'Pago' | 'Pendente'
  descricao text,
  criado_em timestamptz default now()
);

-- Repasses de Plataformas com Retenção (ex: iFood)
create table if not exists repasses (
  id text primary key,
  forma text not null,
  data_pagamento date not null,
  valor numeric(14,2) not null,
  observacao text,
  criado_por text,
  criado_em timestamptz default now()
);

-- Baixas Parciais/Totais vinculadas a cada Repasse
create table if not exists repasse_baixas (
  id bigserial primary key,
  repasse_id text not null references repasses(id) on delete cascade,
  lancamento_id text not null references lancamentos(id),
  valor numeric(14,2) not null
);

-- Histórico e Auditoria de Ações
create table if not exists historico (
  id bigserial primary key,
  data_hora timestamptz default now(),
  usuario text,
  acao text not null,
  id_registro text,
  detalhes text
);

-- 2. ÍNDICES DE PERFORMANCE
-- ------------------------------------------------------------------------------
create index if not exists idx_lancamentos_competencia on lancamentos(competencia);
create index if not exists idx_lancamentos_data_pagamento on lancamentos(data_pagamento);
create index if not exists idx_lancamentos_status on lancamentos(status);
create index if not exists idx_repasse_baixas_lancamento_id on repasse_baixas(lancamento_id);
create index if not exists idx_repasse_baixas_repasse_id on repasse_baixas(repasse_id);

-- 3. ROW LEVEL SECURITY (RLS) — EXCLUSIVO PARA USUÁRIOS AUTENTICADOS
-- ------------------------------------------------------------------------------

alter table clientes enable row level security;
drop policy if exists "authenticated_all" on clientes;
create policy "authenticated_all" on clientes for all to authenticated using (true) with check (true);

alter table categorias enable row level security;
drop policy if exists "authenticated_all" on categorias;
create policy "authenticated_all" on categorias for all to authenticated using (true) with check (true);

alter table formas_pagamento enable row level security;
drop policy if exists "authenticated_all" on formas_pagamento;
create policy "authenticated_all" on formas_pagamento for all to authenticated using (true) with check (true);

alter table lancamentos enable row level security;
drop policy if exists "authenticated_all" on lancamentos;
create policy "authenticated_all" on lancamentos for all to authenticated using (true) with check (true);

alter table repasses enable row level security;
drop policy if exists "authenticated_all" on repasses;
create policy "authenticated_all" on repasses for all to authenticated using (true) with check (true);

alter table repasse_baixas enable row level security;
drop policy if exists "authenticated_all" on repasse_baixas;
create policy "authenticated_all" on repasse_baixas for all to authenticated using (true) with check (true);

alter table historico enable row level security;
drop policy if exists "authenticated_all" on historico;
create policy "authenticated_all" on historico for all to authenticated using (true) with check (true);

-- 4. SEMENTES INICIAIS (SEEDS)
-- ------------------------------------------------------------------------------

-- Categorias do DRE (21 obrigatórias)
insert into categorias (nome, tipo) values
  ('Receita Operacional - Salão/Balcão', 'Receita'),
  ('Receita Operacional - Delivery iFood', 'Receita'),
  ('Receita Operacional - Delivery Próprio/WhatsApp', 'Receita'),
  ('CMV - Carnes e Proteínas', 'Despesa'),
  ('CMV - Pães', 'Despesa'),
  ('CMV - Queijos e Laticínios', 'Despesa'),
  ('CMV - Hortifruti', 'Despesa'),
  ('CMV - Bebidas', 'Despesa'),
  ('CMV - Embalagens', 'Despesa'),
  ('Fixa - Aluguel e Condomínio', 'Despesa'),
  ('Fixa - Folha de Pagamento e Encargos', 'Despesa'),
  ('Fixa - Pró-labore (Retirada dos Sócios)', 'Despesa'),
  ('Fixa - Energia Elétrica e Água', 'Despesa'),
  ('Fixa - Internet e Sistemas (Software, Anota AI, etc)', 'Despesa'),
  ('Fixa - Contador', 'Despesa'),
  ('Variável - Gás de Cozinha', 'Despesa'),
  ('Variável - Manutenção de Equipamentos', 'Despesa'),
  ('Variável - Material de Limpeza', 'Despesa'),
  ('Variável - Marketing e Tráfego Pago', 'Despesa'),
  ('Impostos - Simples Nacional / DAS', 'Despesa'),
  ('Taxas Financeiras - iFood e Maquininhas', 'Despesa')
on conflict (nome) do nothing;

-- Formas de Pagamento iniciais (retem_saldo = true apenas para iFood)
insert into formas_pagamento (nome, taxa, prazo, status_sugerido, retem_saldo) values
  ('Pix', 0, 0, 'Pago', false),
  ('Dinheiro', 0, 0, 'Pago', false),
  ('Cartão de Débito', 1.5, 1, 'Pendente', false),
  ('Cartão de Crédito', 3.5, 30, 'Pendente', false),
  ('iFood', 15.2, 30, 'Pendente', true),
  ('Voucher (VR/VA/Ticket)', 3.5, 15, 'Pendente', false)
on conflict (nome) do nothing;

-- 5. FUNÇÕES PL/PGSQL (RPC ATÔMICAS)
-- ------------------------------------------------------------------------------

-- Função para registrar repasse com abatimento FIFO
create or replace function registrar_repasse(
  p_forma text,
  p_data date,
  p_valor numeric,
  p_obs text,
  p_usuario text
) returns text
language plpgsql
security invoker
as $$
declare
  v_retem boolean;
  v_saldo_retido numeric(14,2) := 0;
  v_valor_restante numeric(14,2);
  v_repasse_id text;
  v_rec record;
  v_abater numeric(14,2);
  v_novo_recebido numeric(14,2);
begin
  if p_data is null then
    raise exception 'Data de pagamento do repasse é obrigatória.';
  end if;

  if p_valor is null or p_valor <= 0 then
    raise exception 'Valor do repasse deve ser maior que zero.';
  end if;

  -- Verifica se a forma existe e retém saldo
  select retem_saldo into v_retem
  from formas_pagamento
  where nome = p_forma;

  if v_retem is null then
    raise exception 'Forma de pagamento "%" não encontrada.', p_forma;
  end if;

  if v_retem is not true then
    raise exception 'Forma de pagamento "%" não retém saldo.', p_forma;
  end if;

  -- Calcula o saldo retido pendente da forma
  select coalesce(sum(valor_liquido - valor_recebido), 0)
  into v_saldo_retido
  from lancamentos
  where tipo = 'Receita'
    and status = 'Pendente'
    and forma_pagamento = p_forma;

  if p_valor > (v_saldo_retido + 0.005) then
    raise exception 'Valor do repasse (R$ %) excede o saldo retido disponível (R$ %).',
      to_char(p_valor, 'FM999G999D00'), to_char(v_saldo_retido, 'FM999G999D00');
  end if;

  -- Gera identificador com timestamp em milissegundos
  v_repasse_id := 'REP-' || (extract(epoch from clock_timestamp()) * 1000)::bigint;

  insert into repasses(id, forma, data_pagamento, valor, observacao, criado_por)
  values (v_repasse_id, p_forma, p_data, round(p_valor, 2), coalesce(p_obs, ''), coalesce(p_usuario, ''));

  v_valor_restante := round(p_valor, 2);

  -- Percorre os lançamentos pendentes em ordem FIFO com FOR UPDATE
  for v_rec in
    select id, valor_liquido, valor_recebido
    from lancamentos
    where tipo = 'Receita'
      and status = 'Pendente'
      and forma_pagamento = p_forma
    order by competencia asc, id asc
    for update
  loop
    exit when v_valor_restante <= 0;

    v_abater := least(v_valor_restante, round(v_rec.valor_liquido - v_rec.valor_recebido, 2));

    if v_abater > 0 then
      v_novo_recebido := round(v_rec.valor_recebido + v_abater, 2);
      v_valor_restante := round(v_valor_restante - v_abater, 2);

      insert into repasse_baixas(repasse_id, lancamento_id, valor)
      values (v_repasse_id, v_rec.id, v_abater);

      -- Se quitou (com tolerância de 0.005), vira Pago e define a data do repasse
      if v_novo_recebido >= round(v_rec.valor_liquido - 0.005, 2) then
        update lancamentos
        set valor_recebido = v_novo_recebido,
            status = 'Pago',
            data_pagamento = p_data
        where id = v_rec.id;
      else
        update lancamentos
        set valor_recebido = v_novo_recebido
        where id = v_rec.id;
      end if;
    end if;
  end loop;

  return v_repasse_id;
end;
$$;

-- Função para estornar repasse (desfaz baixas e remove o repasse)
create or replace function estornar_repasse(
  p_id text
) returns text
language plpgsql
security invoker
as $$
declare
  v_baixa record;
  v_novo_recebido numeric(14,2);
  v_repasse_existe boolean;
begin
  select exists(select 1 from repasses where id = p_id) into v_repasse_existe;
  if not v_repasse_existe then
    raise exception 'Repasse % não encontrado.', p_id;
  end if;

  -- Desfaz os abatimentos em cada lançamento atingido
  for v_baixa in
    select rb.lancamento_id, rb.valor, l.valor_liquido, l.valor_recebido
    from repasse_baixas rb
    join lancamentos l on l.id = rb.lancamento_id
    where rb.repasse_id = p_id
    for update of l
  loop
    v_novo_recebido := greatest(0::numeric, round(v_baixa.valor_recebido - v_baixa.valor, 2));

    -- Se não estiver mais quitado, volta para Pendente e limpa a data_pagamento
    if v_novo_recebido < round(v_baixa.valor_liquido - 0.005, 2) then
      update lancamentos
      set valor_recebido = v_novo_recebido,
          status = 'Pendente',
          data_pagamento = null
      where id = v_baixa.lancamento_id;
    else
      update lancamentos
      set valor_recebido = v_novo_recebido
      where id = v_baixa.lancamento_id;
    end if;
  end loop;

  -- Exclui o repasse (o cascade remove as linhas de repasse_baixas)
  delete from repasses where id = p_id;

  return 'Repasse estornado com sucesso.';
end;
$$;
