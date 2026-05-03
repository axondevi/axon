---
subject: Sua assinatura {{tier_label}} venceu — conta caiu pra free
preheader: Saldo insuficiente pra renovar. Reative em 1 minuto.
vars: [name, tier_label, reason, deposit_address, upgrade_url]
---

Oi {{name}},

Sua assinatura **{{tier_label}}** venceu hoje e não conseguimos renovar.

**Motivo:** {{reason}}

Sua conta foi reduzida pra **free** automaticamente — agentes seguem rodando, mas com os limites do free tier (10 req/min, sem desconto de markup).

### Reativar

1. Deposite USDC no seu wallet:

```
{{deposit_address}}
```

(1 bloco de confirmação na rede Base.)

2. Reative a assinatura no painel:

[Reativar agora]({{upgrade_url}})

Cancela quando quiser, sem multa.

— Nexus Inovation
