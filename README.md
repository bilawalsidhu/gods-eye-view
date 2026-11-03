# 🌐 God's Eye View - Edição Brasileira (pt-BR) 🇧🇷

> **Integração prioritária deste fork — Habblaud:** um painel opcional abre o laboratório de agentes do Habblaud. O Habblaud consulta ferramentas públicas por MCP local; a comunicação ponta a ponta está em homologação. Leia [manual de integração e responsabilidades](docs/HABBLAUD-INTEGRACAO.md) e [Geo Mission cinematográfica](docs/HABBLAUD-GEO-MISSION.md). O acesso a cada fonte depende de autorização, termos, cotas e leis aplicáveis; o usuário responde por seu uso, sem excluir as obrigações dos desenvolvedores e operadores.

Este é o meu fork do projeto original [God's Eye View](https://github.com/bilawalsidhu/gods-eye-view), um simulador de satélite espião que roda no navegador com dados reais e open-source.

## O que eu mudei/adicionei neste fork:
- **Tradução completa para Português (pt-BR):** Criei os arquivos de tradução e configurei o sistema de internacionalização (i18n) para aceitar o português.
- **Documentação Mastigada:** Este Readme explica passo a passo como configurar as chaves de API, que foi a parte mais difícil do processo.

---

## 🛠️ Pré-requisitos
Antes de começar, você vai precisar ter instalado no seu computador:
1. **[Node.js](https://nodejs.org/)** (Recomendo a versão **24.x** ou superior).
2. **Git** (para clonar o repositório).
3. Um editor de código (recomendo o **[VS Code](https://code.visualstudio.com/)**).

---

## 🚀 Passo a Passo para Rodar o Projeto

### 1. Clonar e Instalar
Abra o seu terminal (CMD ou terminal do VS Code) e rode os comandos:
    git clone https://github.com/WalneyNF/gods-eye-view.git
    cd gods-eye-view
    npm install

### 2. Configurar o arquivo .env (A PARTE MAIS IMPORTANTE)
O projeto precisa de chaves de API para puxar os dados reais. O arquivo onde essas chaves ficam guardadas é o **.env** (que não vai para o GitHub por segurança).

1. Na raiz do projeto, procure o arquivo chamado **.env.example**.
2. Faça uma cópia dele e renomeie a cópia para **.env** (sem o .example).
3. Abra o arquivo .env no VS Code e preencha as chaves conforme o tutorial abaixo.

#### 🔑 Onde conseguir cada chave:

**1. Cesium ion (Para o mapa 3D fotorrealista)**
- **Onde pegar:** Acesse [cesium.com/ion](https://cesium.com/ion/), crie uma conta gratuita e vá em "Access Tokens".
- **No .env:** Cole o token na linha `CESIUM_ION_TOKEN=`.
- *Nota: O plano gratuito é para uso pessoal e não comercial.*

**2. TomTom (Para o trânsito real)**
- **Onde pegar:** Acesse [my.tomtom.com/keys](https://my.tomtom.com/keys), crie uma conta gratuita e gere uma API Key.
- **No .env:** Cole na linha `TOMTOM_API_KEY=`.
- *Importante: O plano gratuito tem um limite de 200.000 requisições por mês.*

**3. OpenSky Network (Para os aviões)**
- **Onde pegar:** Acesse [opensky-network.org](https://opensky-network.org/), crie uma conta e, no painel, crie um "API Client". Ele vai te dar um **Client ID** e um **Client Secret** (ou baixar um credentials.json).
- **No .env:** Configure assim:
  `OPENSKY_AUTH_MODE=oauth`
  `OPENSKY_CLIENT_ID=seu_client_id_aqui`
  `OPENSKY_CLIENT_SECRET=seu_client_secret_aqui`
- *Aviso: Sem o OAuth, o app usa a cota anônima (400 créditos/dia), que esgota em minutos.*

**4. Gemini (Para a IA de voz - Opcional)**
- **Onde pegar:** Acesse o [Google AI Studio](https://aistudio.google.com/), faça login com sua conta Google e clique em "Get API key".
- **No .env:** Cole na linha `GEMINI_API_KEY=`.
- *Nota: O Gemini tem um plano gratuito para testes.*

**5. Outras chaves (Opcionais)**
- **AISStream:** Para ver os navios (grátis em [aisstream.io](https://aisstream.io)).
- **NASA FIRMS:** Para ver focos de incêndio (grátis em [firms.modaps.eosdis.nasa.gov](https://firms.modaps.eosdis.nasa.gov/api/map_key/)).
- **OpenAI:** Para usar o ChatGPT como voz (Pago, em [platform.openai.com](https://platform.openai.com)).

*(Após preencher o .env, salve o arquivo).*

### 3. Rodar o Servidor
No terminal, rode:
    npm run dev

Abra o navegador no endereço mostrado (geralmente http://localhost:4173).

---

## 🕹️ Como usar a Interface (Tradutor de Comandos)

- **POWER UP:** Botão no canto inferior direito onde você cola as chaves de API (se preferir colar pelo app em vez de editar o .env).
- **DATA LAYERS (Camadas de Dados):** Onde você liga os Aviões, Trânsito, Satélites e Câmeras.
- **Teclado:**
  - **1 a 7:** Muda o filtro visual (Normal, CRT, NVG, FLIR, Anime, Noir, Snow).
  - **M:** Liga/Desliga o Modo Matrix.
  - **C:** Entra no Cockpit do avião selecionado.
  - **Esc:** Sai do Cockpit ou fecha menus.

---

## 🤝 Créditos
- Projeto original criado por **[Bilawal Sidhu](https://github.com/bilawalsidhu)** e **[Sameh Khamis](https://github.com/samehkhamis)**.
- Tradução e documentação deste fork feita por **[Walney Moreira Klein](https://github.com/WalneyNF)**.
### Integração experimental: Habblaud Geo Mission

Este fork brasileiro integra a Central de Missões e favoritos geográficos com o Habblaud. A posição da câmera do globo pode ser usada para criar presets sem coletar automaticamente a localização pessoal do usuário. Consulte [o manual de presets](docs/HABBLAUD-PRESETS.md).


### 🌍 Roadmap público da integração Geo Mission BR

[Explore o roadmap HTML](roadmap.html) com os dez módulos e seus critérios de aceite. O fork também responde às mensagens `gev:cinema-fly` e `gev:cinema-stop` enviadas pela Central de Missões para animações experimentais de câmera Cesium. [Manual da integração](docs/HABBLAUD-ROADMAP-GEO-CINEMA.md). Nenhum módulo planejado deve ser confundido com implementação concluída.
