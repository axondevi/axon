# Privy Embedded Wallets — Setup (5 minutos)

Privy permite que visitantes façam login com email/Google/Apple e ganhem
**uma wallet automática invisível** — sem MetaMask, sem seed phrase, sem
zero conhecimento de cripto.

Ao terminar este setup, sua landing terá um botão "Sign in with email"
que substitui o atual fluxo "paste API key" (que afasta leigos).

## Pré-requisitos

- Você tem acesso ao Render (onde Axon roda)
- Você tem ~5 minutos

## Passo a passo

### 1. Criar conta Privy (free tier)

- Acesse: https://dashboard.privy.io
- Sign up com seu email
- Crie um novo App
  - Name: `Axon Agent Factory`
  - Type: `Web`
  - Login methods: Email, Google, External wallet
  - Embedded wallets: enable for "All users"
  - Chain: Base (mainnet)

### 2. Copiar credenciais

No Privy dashboard, vá em **Settings → API Keys**:
- Copie o **App ID** (formato: `clxxx...`)
- Copie o **App Secret** (botão "Show secret")

### 3. Configurar no Render (backend Axon)

- Acesse: https://dashboard.render.com
- Selecione o serviço `axon`
- Vá em **Environment** → **Add Environment Variable**
- Adicione:
  ```
  PRIVY_APP_ID = clxxx... (copiado acima)
  PRIVY_APP_SECRET = (copiado acima)
  ```
- Salve. Render vai reiniciar automaticamente (~2 min).

### 4. Configurar domínios autorizados no Privy

De volta ao Privy dashboard, vá em **Settings → Allowed Origins**:
- Adicione: `https://axon-5zf.pages.dev`
- Adicione: `http://localhost:8000` (para dev local)
- Salve.

### 5. Validar

Acesse https://axon-5zf.pages.dev/build (sem estar logado).
Você deve ver botão verde "✉️ Sign in with email — wallet created automatically".

Clicar abre modal Privy. Email + código de verificação (1 min) → wallet
criada automaticamente, conta Axon ligada, key salvo no localStorage.

## O que acontece tecnicamente

1. Visitante clica "Sign in with email"
2. Privy modal abre, usuário insere email
3. Privy envia código por email (6 dígitos)
4. Usuário cola código → Privy cria embedded wallet (chave privada
   criptografada com password do usuário, armazenada no Privy)
5. Frontend Axon recebe `access_token` + `wallet_address`
6. Frontend POST `/v1/auth/privy` com token
7. Backend Axon verifica token via Privy API
8. Se primeiro login: cria user + wallet em PostgreSQL Axon, retorna `api_key`
9. Se já existe: retorna confirmação de login
10. Frontend salva `api_key` em localStorage e recarrega
11. Usuário vê dashboard logado, com $0.50 de bonus

## Custo

- Free tier Privy: 1.000 MAU (Monthly Active Users) grátis
- $99/mês depois (10k MAU)
- Custo do Axon (gas pagos): ~$0 enquanto wallets são só ler/auth
  (custo só quando minta NFT ou faz transação on-chain)

## Camuflagem

O usuário **nunca vê**:
- "Wallet"
- "Blockchain"
- "0x..."
- "Seed phrase"
- "Sign transaction"

O usuário **sempre vê**:
- "Sign in with email"
- "Saldo: R$ 5,00"
- "Login com Google"
- Interface SaaS normal

A camada Web3 fica 100% invisível na superfície, ativa por baixo.

## Troubleshooting

**Botão "Sign in with email" não aparece?**
- Endpoint `/v1/auth/privy/config` deve retornar `{"enabled": true}`
- Se retornar `{"enabled": false}`, o env var não foi setado ou Render
  não reiniciou. Force redeploy no Render.

**Modal Privy abre mas falha após código?**
- Verifique que o domínio (axon-5zf.pages.dev) está em "Allowed Origins" no Privy
- Verifique que App ID está correto no env

**Login funciona mas API key vem null?**
- Significa retorno de usuário existente. Eles precisam recuperar key
  do localStorage anterior, ou via fluxo de signup tradicional uma vez.

## Próximos passos depois de Privy

Com embedded wallets funcionando, você desbloqueia:

1. **NFT silencioso de agentes** (próximo doc: setup-nft-agents.md)
   - Cada agente criado vira NFT na Base, mintado automaticamente
   - Usuário não vê, mas tem ownership on-chain real

2. **Marketplace de agentes**
   - Listar/comprar/vender agentes
   - Pagamento on-chain via embedded wallet
   - Royalties automáticas pra criador original

3. **Knowledge Cache compartilhado** (já implementado)
   - Conversações deduplicam entre agentes
   - Reduz custo 70%+

4. **$AXN token**
   - Token utility da plataforma
   - Stake pra desconto + governance

Tudo isso ativa GRATIS pro usuário (UX SaaS) mas roda em Web3 por baixo.
