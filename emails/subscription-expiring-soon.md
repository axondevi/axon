---
subject: Sua assinatura {{tier_label}} vence em {{days_remaining}} dias
preheader: Confirme saldo pra renovar automaticamente.
vars: [name, tier_label, amount_usdc, balance_usdc, expires_at, deposit_address, dashboard_url]
---

Oi {{name}},

Aviso amigo: sua assinatura **{{tier_label}}** vence em **{{days_remaining}} dias** ({{expires_at}}).

- Renovação cobra: {{amount_usdc}} USDC
- Saldo atual: {{balance_usdc}} USDC

{{#if low_balance}}
⚠️ **Saldo abaixo do necessário pra renovar.** Se não topar, sua conta vai cair pra free no vencimento.

Deposite USDC na rede Base:

```
{{deposit_address}}
```
{{/if}}

Renovação é automática — você não precisa clicar em nada. Pra cancelar:

[Abrir painel]({{dashboard_url}}/account)

— Nexus Inovation
