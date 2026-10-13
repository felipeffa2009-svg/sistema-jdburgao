Mapa do Projeto: JD Burgão - Sistema Financeiro Web
1. Arquitetura e Tecnologias

Front-end: HTML5, CSS3 e Vanilla JavaScript (Interface responsiva).

Back-end/Banco de Dados: Supabase (PostgreSQL).

Autenticação: Sistema obrigatório de Login e Senha (e-mail/senha) na tela inicial, utilizando o módulo de Auth nativo do Supabase. Nenhuma tela do sistema pode ser acessada sem login.

2. Credenciais de Acesso (Supabase)

As chaves de API (SUPABASE_URL e SUPABASE_ANON_KEY) estão salvas no arquivo oculto .env neste diretório. O código JavaScript deve consumir essas variáveis para conectar ao banco.

3. Identidade Visual e UI

Utilize o arquivo logo.png presente nesta pasta no cabeçalho do sistema.

Padrão visual focado nas cores da marca (fundo escuro com detalhes em amarelo).

A interface deve ser significativamente mais rápida que a versão anterior. O carregamento dos relatórios (Dashboard, DRE e Fluxo de Caixa) deve ser otimizado para não travar a tela.

4. Regras de Negócio e Escopo Financeiro (CRÍTICO)

DRE vs Fluxo de Caixa: Separação rigorosa de DRE por Regime de Competência e Fluxo de Caixa por Regime de Caixa (data real do pagamento).

Gestão de Retenção (iFood/Delivery): O sistema deve possuir uma lógica específica para lidar com valores retidos (ex: repasses do iFood). Quando houver o lançamento de uma receita de delivery, o sistema deve permitir abater esse valor do montante que está "retido" na plataforma, facilitando o controle dos pagamentos fracionados que caem ao longo das semanas.

Nota: Consulte o arquivo escopo_de_neg_cios_jd_burg_o para a matemática detalhada de taxas, prazos e natureza das contas. O projeto deve evoluir além da referência "Madeireira Ype", adaptando-se à realidade da hamburgueria.

5. Instruções de Orquestração

A equipe de desenvolvimento deve se dividir: um agente cuida do Front-end (HTML/CSS) focando na interface e login, e outro cuida do Back-end (JS) implementando a lógica de retenção de saldo e requisições ao Supabase.

Revisão Obrigatória: Os códigos só estarão finalizados após passarem por revisão rigorosa cruzada (front-end vs back-end).