# NFT Silencioso de Agentes — Setup (15 minutos)

Cada agente criado vira um **NFT na Base** automaticamente, mintado em
nome do usuário. Usuário **não vê** nada disso — só vê "criei meu agente".
Mas tem ownership on-chain real, pode transferir, vender, ou compor com
outros DApps no futuro.

## O que isso desbloqueia

- ✅ **Ownership verificável** on-chain (provável quem é dono original)
- ✅ **Transferibilidade** — usuário pode vender o agente como ativo
- ✅ **Marketplace futuro** — listar agentes em OpenSea, Rodeo, Blur, etc
- ✅ **Royalties automáticas** — Axon ganha 5% em revendas (EIP-2981)
- ✅ **Composability** — outros DApps podem ler/usar agentes Axon
- ✅ **Provenance** — proof matemático de quando foi criado

## Pré-requisitos

- Privy embedded wallets já configurado (`docs/setup-privy.md`)
- Conta com ETH em Base mainnet (~$30 valor pra gas)
- 15 minutos

## Passo 1 — Criar wallet "minter" (paymaster)

Esta é a wallet que vai ASSINAR os mints em nome dos usuários.
Vai pagar o gas (~$0.005 por mint = $50 pra 10.000 agentes).

1. Crie nova wallet MetaMask (ou use existente que você controla 100%)
   - **CRÍTICO**: anote a seed phrase em PAPEL. Esta wallet vai ter
     poder de mintar tokens no contrato.
2. Adicione rede Base Mainnet:
   - Network Name: Base
   - RPC URL: https://mainnet.base.org
   - Chain ID: 8453
   - Currency Symbol: ETH
3. Funde com **0.01 ETH** (~$30) na Base mainnet
   - Use bridge oficial: https://bridge.base.org
   - Ou compre direto Base ETH na Coinbase
4. Anote o endereço público da wallet (`0x...`)
5. Anote a chave privada (Account Settings → Show Private Key)
   - **NUNCA cole isso publicamente**. Só vai pro env do Render.

## Passo 2 — Deploy do contrato AxonAgent.sol

### Opção A — Foundry (recomendado se você manja CLI)

```bash
# Instala foundry
curl -L https://foundry.paradigm.xyz | bash
foundryup

cd contracts/

# Deploy na Base mainnet
forge create AxonAgent.sol:AxonAgent \
  --rpc-url https://mainnet.base.org \
  --private-key 0xSUA_CHAVE_PRIVADA_DA_MINTER \
  --constructor-args 0xENDERECO_MINTER 0xENDERECO_ROYALTY_RECEIVER \
  --etherscan-api-key SEU_BASESCAN_KEY \
  --verify
```

Onde:
- `0xENDERECO_MINTER` = endereço da wallet do passo 1
- `0xENDERECO_ROYALTY_RECEIVER` = endereço pra receber 5% das revendas
  (pode ser sua wallet pessoal de tesouraria, ou multisig)

Saída esperada:
```
Deployer: 0x...
Deployed to: 0xCONTRATO_AXON_AGENT  ← anota isso!
Transaction hash: 0x...
```

### Opção B — Remix IDE (sem CLI)

1. Acesse https://remix.ethereum.org
2. New File → cole o conteúdo de `contracts/AxonAgent.sol`
3. Compile (Solidity Compiler tab)
4. Deploy (Deploy tab):
   - Environment: "Injected Provider - MetaMask" (com Base selecionada)
   - Constructor args: minter address + royalty receiver
   - Deploy → confirma transação no MetaMask
5. Anote o endereço do contrato (`0x...`)

### Opção C — Thirdweb (sem código)

1. https://thirdweb.com → Connect Wallet → Base mainnet
2. Deploy → Contracts → "NFT Collection" template
3. Customize: name="Axon Agent", symbol="AXNA"
4. Royalty: 5% pra seu endereço
5. Deploy → confirma
6. Custom permission: adicione minter address como "MINTER_ROLE"

(Thirdweb usa contrato deles, não o `AxonAgent.sol` que escrevi —
funciona mas com features extras desnecessárias. Use Foundry/Remix
se quiser o contrato exato deste repo.)

## Passo 3 — Configurar env no Render

Acesse https://dashboard.render.com → serviço `axon` → Environment.

Adicione:

```
NFT_CONTRACT_ADDRESS = 0xCONTRATO_DO_PASSO_2
NFT_MINTER_PRIVATE_KEY = 0xCHAVE_PRIVADA_DA_MINTER_DO_PASSO_1
NFT_RPC_URL = https://mainnet.base.org
NFT_METADATA_BASE_URL = https://axon-5zf.pages.dev/agent-meta
```

⚠️ **`NFT_MINTER_PRIVATE_KEY` é segredo!** Nunca compartilhe, nunca commit
no Git. Só no Render env (que é seguro).

Salve. Render reinicia automaticamente.

## Passo 4 — Adicionar dependência viem

```bash
cd /caminho/pro/axon
bun add viem
git add package.json bun.lockb
git commit -m "chore: add viem for NFT minting"
git push
```

Render vai redeploy com viem instalado.

## Passo 5 — Validar

1. Abra o painel: https://axon-5zf.pages.dev/build
2. Faça login (Privy email)
3. Crie um agente novo (qualquer template)
4. Após criar, aguarde 5-10s
5. Verifique no Basescan:
   - https://basescan.org/address/0xCONTRATO_DO_PASSO_2
   - Deve aparecer 1 nova transação `mint()`
   - Token transferido pra wallet do user
6. **Usuário não vê NADA disso**. A criação funciona como sempre.

## Como o usuário acaba sendo dono do NFT (sem saber)

```
Visitante → "Sign in with email" (Privy)
   ↓
Privy cria embedded wallet (chave privada criptografada com password do user)
   ↓
Usuário clica "Criar agente" → preenche form → "Save"
   ↓
Backend Axon: salva no PostgreSQL
   ↓
Backend Axon: chama mintAgentNft(walletDoUser, agentId, slug, metadataUrl)
   ↓
Minter wallet (paymaster) assina tx que minta NFT pra walletDoUser
   ↓
NFT aparece on-chain. Usuário é dono. Usuário NÃO SABE.
```

Quando usuário decidir vender (futuro feature):
- "Listar à venda por R$500" → backend chama transfer do NFT
- Comprador paga em USDC → vendedor recebe → 5% royalty pra Axon
- Tudo invisível pra ambos os lados — só veem R$/PIX

## Custos operacionais

```
Deploy do contrato (one-time):     ~$15 em gas
Mint por agente:                   ~$0.005
1.000 agentes/mês:                 ~$5 de gas
10.000 agentes/mês:                ~$50

Royalty 5% das revendas → receita pura pra Axon
```

## Página de metadata (agent-meta)

NFT precisa de metadata pra OpenSea/marketplaces mostrarem corretamente.
Crie endpoint estático em `/landing/agent-meta/{slug}.json`:

```json
{
  "name": "Atendente E-commerce BR",
  "description": "Agente de atendimento para loja online brasileira...",
  "image": "https://axon-5zf.pages.dev/agent-thumb/{slug}.png",
  "external_url": "https://axon-5zf.pages.dev/agent/{slug}",
  "attributes": [
    {"trait_type": "Template", "value": "ecommerce-br"},
    {"trait_type": "Category", "value": "E-commerce"},
    {"trait_type": "Language", "value": "PT-BR"}
  ]
}
```

Pode ser gerado dinamicamente via Cloudflare Worker, ou estaticamente
no build do landing.

## Camuflagem total

Em momento algum o usuário vê:
- ❌ "NFT" / "Token" / "Mint"
- ❌ Endereços `0x...`
- ❌ Etherscan / Basescan
- ❌ Gas fees
- ❌ "Confirme assinatura"

O que ele vê:
- ✅ "Agente criado!"
- ✅ "Agente publicado"
- ✅ "Compartilhe o link"
- ✅ (futuro) "Vender este agente por R$"

Web3 invisível. Web2 UX. Network effect ativado.

## Troubleshooting

**Mint não acontece (logs do Render mostram "nft_disabled")**
- Confira que TODOS os 3 envs estão setados: NFT_CONTRACT_ADDRESS,
  NFT_MINTER_PRIVATE_KEY, NFT_RPC_URL
- Render precisa reiniciar (force redeploy se necessário)

**Mint falha com "insufficient funds"**
- Wallet minter precisa de ETH na Base. Adicione mais.
- Cada mint custa ~$0.005, então 0.01 ETH (~$30) cobre 6.000 mints.

**Mint falha com "viem_missing"**
- Rode `bun add viem` no projeto e push novamente.

**Mint falha com "AlreadyMinted"**
- O agentId já foi mintado. Isso só acontece se você re-deployou o
  contrato (mesmo agentId reapropriado). Em produção real, não acontece.

**Usuário sem wallet (apareceu sem Privy)**
- Mint pula silenciosamente. Agente ainda funciona via Axon backend.
- Quando usuário fizer login Privy depois, wallet é criada e próximos
  agentes ganham NFT.

## Próximas evoluções

Depois de NFT funcionando:

1. **Marketplace interno** — UI pra listar/comprar agentes
2. **Templates como NFT** — cada template oficial = NFT verificado
3. **NFT-gated agents** — agente só responde se visitante tem certo NFT
4. **Knowledge contributors NFT** — quem mais contribui pro cache, ganha
   NFT especial + share de receita
5. **Cross-chain** — replicar pra Solana (via Wormhole) pra alcançar
   Phantom users

Tudo isso DESBLOQUEADO pelo simples fato de cada agente já ser NFT
desde o nascimento.
