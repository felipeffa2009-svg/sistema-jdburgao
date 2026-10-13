# Documento de Arquitetura e Regras de Negócio: Sistema Financeiro - JD Burgão

## Visão Geral
Este documento define o escopo, regras de negócio e lógica matemática para a criação do sistema financeiro da hamburgueria **JD Burgão**. O back-end será estruturado em Google Apps Script (usando Google Sheets como banco de dados) e o front-end em HTML/JS/CSS.

---

## 1. Estrutura do Banco de Dados (Aba: Lançamentos)
A estrutura baseia-se no modelo "Madeireira Ype", mas adaptada para as necessidades de food service (inclusão de controle de taxas automáticas).

**Colunas Obrigatórias:**
1. **ID:** Identificador único (ex: `LANC-1698754`).
2. **Competência:** Data em que a venda/compra de fato ocorreu.
3. **Vencimento:** Data prevista para o dinheiro cair na conta (ou boleto vencer).
4. **Data de Pagamento:** Data real da efetivação na conta bancária.
5. **Tipo:** `Receita` ou `Despesa`.
6. **Categoria Financeira:** Classificação no DRE (ver tópico 3).
7. **Cliente/Fornecedor:** Nome do cliente, iFood ou fornecedor.
8. **Forma de Pagamento:** Cartão, Pix, iFood, etc.
9. **Valor Bruto (R$):** Valor total da nota/pedido.
10. **Taxa Retida (R$):** Valor descontado pela adquirente/iFood.
11. **Valor Líquido (R$):** `Valor Bruto - Taxa Retida`.
12. **Status:** `Pago` ou `Pendente`.
13. **Descrição:** Observações do lançamento.

---

## 2. Contas a Receber e Regras de Meios de Pagamento
No setor de restaurantes, descasar a "Competência" do "Caixa" é vital. O sistema deve calcular o **Vencimento** e o **Valor Líquido** automaticamente no momento em que o usuário escolhe a "Forma de Pagamento" no formulário de Lançamento.

### 2.1. Mapa de Regras de Pagamento (Gatilhos do Front-end/Back-end)
Os agentes de código devem programar um dicionário de taxas e prazos. Ao selecionar a forma, o sistema aplica a seguinte matemática:

*   **Pix / Dinheiro:**
    *   **Taxa:** 0%
    *   **Vencimento:** `Competência + 0 dias` (D+0)
    *   **Status Sugerido:** `Pago` (pois entra na hora)
*   **Cartão de Débito:**
    *   **Taxa:** 1.5% (Exemplo configurável)
    *   **Vencimento:** `Competência + 1 dia` (D+1)
    *   **Status Sugerido:** `Pendente`
*   **Cartão de Crédito (Sem Antecipação):**
    *   **Taxa:** 3.5%
    *   **Vencimento:** `Competência + 30 dias` (D+30)
    *   **Status Sugerido:** `Pendente`
*   **iFood (Plano Básico):**
    *   **Taxa:** 15.2% (12% comissão + 3.2% pagto online)
    *   **Vencimento:** `Competência + 30 dias` (D+30)
    *   **Status Sugerido:** `Pendente`
*   **Vouchers (VR/VA/Ticket):**
    *   **Taxa:** 3.5%
    *   **Vencimento:** `Competência + 15 dias` (D+15)
    *   **Status Sugerido:** `Pendente`

**Lógica Matemática do Back-end (Receitas):**
`Taxa Retida = Valor Bruto * (Percentual da Taxa / 100)`
`Valor Líquido = Valor Bruto - Taxa Retida`
*Nota:* No DRE, o *Valor Bruto* entra como Receita, e a *Taxa Retida* entra como Despesa Financeira. No Fluxo de Caixa, entra apenas o *Valor Líquido*.

---

## 3. Contas a Pagar e Estrutura de Categorias
Para que o restaurante saiba exatamente se está tendo lucro, as categorias devem espelhar a estrutura de um DRE de food service. 

### 3.1. Dicionário de Categorias Obrigatórias
O select de categorias no sistema deve conter:

**RECEITAS:**
*   Receita Operacional - Salão/Balcão
*   Receita Operacional - Delivery iFood
*   Receita Operacional - Delivery Próprio/WhatsApp

**DESPESAS (Variáveis - CMV - Custo da Mercadoria Vendida):**
*   CMV - Carnes e Proteínas
*   CMV - Pães
*   CMV - Queijos e Laticínios
*   CMV - Hortifruti
*   CMV - Bebidas
*   CMV - Embalagens

**DESPESAS (Operacionais Fixas):**
*   Fixa - Aluguel e Condomínio
*   Fixa - Folha de Pagamento e Encargos
*   Fixa - Pró-labore (Retirada dos Sócios)
*   Fixa - Energia Elétrica e Água
*   Fixa - Internet e Sistemas (Software, Anota AI, etc)
*   Fixa - Contador

**DESPESAS (Operacionais Variáveis & Impostos):**
*   Variável - Gás de Cozinha
*   Variável - Manutenção de Equipamentos
*   Variável - Material de Limpeza
*   Variável - Marketing e Tráfego Pago
*   Impostos - Simples Nacional / DAS
*   Taxas Financeiras - iFood e Maquininhas *(Calculado automaticamente pelas vendas)*

### 3.2. Regra de Baixa de Pagamento (Contas a Pagar)
*   A data de **Competência** é o dia da emissão da nota do pão/carne, ou o mês de referência do aluguel.
*   O **Status** deve nascer como `Pendente`.
*   O sistema só pode alterar o Status para `Pago` se o usuário informar obrigatoriamente a **Data de Pagamento** real.

---

## 4. Geração de Relatórios (O Motor do Google Apps Script)
Esta é a instrução vital para os agentes de código. O back-end em Apps Script deve conter duas rotinas matemáticas distintas para analisar a mesma base de dados.

### 4.1. Fluxo de Caixa (Regime de Caixa)
Responde à pergunta: *"Quanto dinheiro efetivamente entrou e saiu da minha conta bancária este mês?"*

**Lógica Matemática (Apps Script):**
*   **Filtro Base:** Iterar as linhas onde `Status == 'Pago'`. Ignorar os Pendentes.
*   **Data de Agrupamento:** Agrupar estritamente pela coluna `Data de Pagamento`. Ignorar a Competência.
*   **Total de Entradas:** Soma da coluna `Valor Líquido` onde `Tipo == 'Receita'`.
*   **Total de Saídas:** Soma da coluna `Valor Bruto` onde `Tipo == 'Despesa'`.
*   **Saldo do Caixa:** `Total Entradas - Total Saídas`.

### 4.2. DRE - Demonstração do Resultado do Exercício (Regime de Competência)
Responde à pergunta: *"O meu negócio está dando lucro de verdade, independentemente de quando o iFood vai me pagar ou de quando o boleto vence?"*

**Lógica Matemática (Apps Script):**
*   **Filtro Base:** Iterar TODAS as linhas do mês selecionado, **independentemente do Status** (Pendente ou Pago entra na conta).
*   **Data de Agrupamento:** Agrupar estritamente pela coluna `Competência`. Ignorar Data de Pagamento ou Vencimento.
*   **Estrutura de Cálculo (Cascata do DRE):**

    1. **Receita Bruta:** Soma do `Valor Bruto` de todos os lançamentos de `Tipo == 'Receita'`.
    2. **Deduções (Taxas):** Soma da `Taxa Retida` das receitas + Soma do `Valor Bruto` de lançamentos com Categoria `Impostos - Simples Nacional`.
    3. **Receita Líquida:** `[1. Receita Bruta] - [2. Deduções]`.
    4. **CMV (Custos Insumos):** Soma do `Valor Bruto` de lançamentos cujas Categorias começam com `CMV - ...`.
    5. **Lucro Bruto:** `[3. Receita Líquida] - [4. CMV]`. *(KPI: O CMV saudável em hamburguerias deve representar entre 28% e 35% da Receita Bruta).*
    6. **Despesas Operacionais:** Soma do `Valor Bruto` de lançamentos cujas Categorias começam com `Fixa - ...` e `Variável - ...`.
    7. **LUCRO LÍQUIDO (Resultado do Exercício):** `[5. Lucro Bruto] - [6. Despesas Operacionais]`.

### 4.3. Dashboards Esperados no Front-end
A partir dos dados do Apps Script, o dashboard principal da Hamburgueria deve exibir:
*   **Card 1:** Faturamento Bruto (Competência)
*   **Card 2:** CMV em % (O termômetro do restaurante)
*   **Card 3:** Lucro Líquido em %
*   **Card 4:** Saldo em Caixa (O dinheiro que realmente existe na conta)
*   **Avisos de Alerta:** Tabela de Contas a Pagar Atrasadas e Contas a Receber Atrasadas.