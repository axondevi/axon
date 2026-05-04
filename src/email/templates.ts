/**
 * Transactional email templates — PT-BR.
 *
 * Each template returns { subject, html, text } so the caller can pass
 * straight into sendEmail(). Inline CSS only (Gmail strips <style> blocks
 * in some contexts). Dark-mode tested — uses dark surfaces with light text
 * for the gradient header, neutral middle, distinct CTA buttons.
 *
 * Design constraints kept in mind:
 *  - 600px max-width body (every webmail renders that natively)
 *  - System font stack only (no @import — strips on iOS Mail)
 *  - One <table> wrapper for Outlook compatibility
 *  - Plaintext fallback for clients that block HTML
 */

const FRONTEND = process.env.FRONTEND_BASE_URL || 'https://nexusinovation.com.br';

/** Standard wrapper to keep all templates visually consistent. */
function wrap(opts: { preheader: string; bodyHtml: string }): string {
  return `<!doctype html>
<html lang="pt-br">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<title>Axon</title>
</head>
<body style="margin:0;padding:0;background:#0a0a0b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:#eeeef0;">
<!-- Preheader (hidden, shows in inbox preview) -->
<div style="display:none;font-size:1px;color:#0a0a0b;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeHtml(opts.preheader)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#0a0a0b;">
  <tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;background:#16161a;border:1px solid #25252b;border-radius:14px;overflow:hidden;">
      <!-- Brand header -->
      <tr><td style="padding:28px 32px 22px;background:linear-gradient(135deg,rgba(124,92,255,0.15),rgba(25,213,198,0.1));border-bottom:1px solid #25252b;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0">
          <tr>
            <td style="vertical-align:middle;">
              <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:linear-gradient(135deg,#7c5cff,#19d5c6);vertical-align:middle;"></span>
              <span style="display:inline-block;font-weight:800;font-size:18px;color:#eeeef0;margin-left:8px;vertical-align:middle;">Axon</span>
            </td>
          </tr>
        </table>
      </td></tr>
      <!-- Body slot -->
      <tr><td style="padding:32px;">${opts.bodyHtml}</td></tr>
      <!-- Footer -->
      <tr><td style="padding:18px 32px 28px;border-top:1px solid #25252b;color:#6a6a76;font-size:12px;line-height:1.6;">
        Axon · plataforma de agentes de IA com WhatsApp + NFT.<br/>
        Este email foi enviado automaticamente. Não responda — fala com a gente em <a href="${FRONTEND}" style="color:#19d5c6;text-decoration:none;">${FRONTEND.replace(/^https?:\/\//, '')}</a>.
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Pretty-format USDC string with grouping (5.000000 → "5,00"). */
function fmtUsdc(s: string | number): string {
  const n = typeof s === 'string' ? parseFloat(s) : s;
  if (!Number.isFinite(n)) return String(s);
  return n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

/** Pretty-format BRL with R$ prefix. */
function fmtBrl(s: string | number): string {
  const n = typeof s === 'string' ? parseFloat(s) : s;
  if (!Number.isFinite(n)) return String(s);
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// ─── Template 1: Welcome ────────────────────────────────────
export function welcomeEmail(opts: {
  email: string;
  apiKey: string;
  bonusUsdc: string;
  depositAddress: string;
}): { subject: string; html: string; text: string } {
  const subject = '🎉 Bem-vindo ao Axon — sua wallet já está ativa';
  const dashUrl = `${FRONTEND}/dashboard`;
  const buildUrl = `${FRONTEND}/build?welcome=1`;

  const bodyHtml = `
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#eeeef0;">Pronto, ${escapeHtml(opts.email.split('@')[0])}!</h1>
    <p style="margin:0 0 22px;color:#9a9aa4;font-size:14px;line-height:1.6;">
      Sua conta foi criada e tem <strong style="color:#19d5c6;">$${escapeHtml(fmtUsdc(opts.bonusUsdc))} USDC</strong>
      de saldo bônus pra você testar de graça.
    </p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#0a0a0b;border:1px solid #25252b;border-radius:8px;margin-bottom:18px;">
      <tr><td style="padding:14px 16px;">
        <div style="font-size:11px;color:#6a6a76;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">Sua API Key</div>
        <code style="display:block;font-family:'JetBrains Mono',Consolas,monospace;font-size:12px;color:#19d5c6;word-break:break-all;">${escapeHtml(opts.apiKey)}</code>
      </td></tr>
    </table>
    <p style="margin:0 0 6px;color:#9a9aa4;font-size:13px;">⚠️ Guarde com você — esta é a única vez que mostramos a chave completa.</p>
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:24px 0;">
      <tr><td>
        <a href="${buildUrl}" style="display:inline-block;background:#7c5cff;color:#fff;padding:12px 24px;border-radius:8px;font-weight:600;text-decoration:none;font-size:14px;">Criar meu primeiro agente →</a>
      </td></tr>
      <tr><td style="padding-top:8px;">
        <a href="${dashUrl}" style="display:inline-block;color:#9a9aa4;font-size:12px;text-decoration:underline;">ou abrir o painel direto</a>
      </td></tr>
    </table>
    <h2 style="margin:28px 0 10px;font-size:15px;font-weight:600;color:#eeeef0;">Próximos passos</h2>
    <ol style="margin:0;padding-left:20px;color:#9a9aa4;font-size:13px;line-height:1.8;">
      <li><strong style="color:#eeeef0;">Crie um agente</strong> — escolha um template (atendente, recepcionista, vendedor) e personalize em 30s.</li>
      <li><strong style="color:#eeeef0;">Conecte WhatsApp</strong> — escaneie um QR ou use código de pareamento. Bot responde em segundos.</li>
      <li><strong style="color:#eeeef0;">Recarregue via Pix</strong> quando o saldo bônus acabar — instantâneo, qualquer banco.</li>
    </ol>
  `;
  const html = wrap({
    preheader: `Sua wallet Axon está ativa. R$${escapeHtml(opts.bonusUsdc)} USDC de saldo bônus + API key.`,
    bodyHtml,
  });
  const text = [
    `Pronto, ${opts.email.split('@')[0]}!`,
    '',
    `Sua conta Axon está ativa com $${fmtUsdc(opts.bonusUsdc)} USDC de saldo bônus.`,
    '',
    `API Key: ${opts.apiKey}`,
    '⚠️ Esta é a única vez que mostramos a chave completa — guarde-a!',
    '',
    `Criar meu primeiro agente: ${buildUrl}`,
    `Painel: ${dashUrl}`,
    '',
    'Próximos passos:',
    '1. Crie um agente (template + personalização em 30s)',
    '2. Conecte WhatsApp (QR ou código de pareamento)',
    '3. Recarregue via Pix quando o saldo bônus acabar',
  ].join('\n');
  return { subject, html, text };
}

// ─── Template 2: Pix Approved ───────────────────────────────
export function pixApprovedEmail(opts: {
  amountBrl: string | number;
  amountUsdc: string;
  newBalanceUsdc: string;
  mpId: string;
}): { subject: string; html: string; text: string } {
  const subject = `✅ Pix confirmado — ${fmtBrl(opts.amountBrl)} creditado`;
  const dashUrl = `${FRONTEND}/dashboard`;

  const bodyHtml = `
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#eeeef0;">Saldo recarregado!</h1>
    <p style="margin:0 0 22px;color:#9a9aa4;font-size:14px;line-height:1.6;">
      Seu Pix de <strong style="color:#19d5c6;">${escapeHtml(fmtBrl(opts.amountBrl))}</strong> foi confirmado pelo MercadoPago e
      <strong style="color:#19d5c6;">$${escapeHtml(fmtUsdc(opts.amountUsdc))} USDC</strong> caíram na sua wallet.
    </p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#0a0a0b;border:1px solid #25252b;border-radius:8px;margin-bottom:18px;">
      <tr><td style="padding:14px 16px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
          <tr>
            <td style="font-size:12px;color:#6a6a76;text-transform:uppercase;letter-spacing:0.05em;">Novo saldo</td>
            <td style="font-size:12px;color:#6a6a76;text-transform:uppercase;letter-spacing:0.05em;text-align:right;">ID MercadoPago</td>
          </tr>
          <tr>
            <td style="padding-top:4px;font-size:18px;font-weight:700;color:#eeeef0;">$${escapeHtml(fmtUsdc(opts.newBalanceUsdc))} USDC</td>
            <td style="padding-top:4px;font-size:11px;color:#9a9aa4;font-family:'JetBrains Mono',Consolas,monospace;text-align:right;">${escapeHtml(opts.mpId)}</td>
          </tr>
        </table>
      </td></tr>
    </table>
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:14px 0;">
      <tr><td>
        <a href="${dashUrl}" style="display:inline-block;background:#7c5cff;color:#fff;padding:12px 24px;border-radius:8px;font-weight:600;text-decoration:none;font-size:14px;">Ver painel →</a>
      </td></tr>
    </table>
    <p style="margin:18px 0 0;color:#6a6a76;font-size:12px;">
      Cada chamada de API debita micro-frações automaticamente. Saldo dura na ordem de centenas a milhares de chamadas dependendo do uso.
    </p>
  `;
  const html = wrap({
    preheader: `Pix de ${fmtBrl(opts.amountBrl)} confirmado. Novo saldo: $${fmtUsdc(opts.newBalanceUsdc)} USDC.`,
    bodyHtml,
  });
  const text = [
    `Saldo recarregado!`,
    '',
    `Pix de ${fmtBrl(opts.amountBrl)} confirmado pelo MercadoPago.`,
    `Crédito: $${fmtUsdc(opts.amountUsdc)} USDC`,
    `Novo saldo: $${fmtUsdc(opts.newBalanceUsdc)} USDC`,
    `ID MercadoPago: ${opts.mpId}`,
    '',
    `Painel: ${dashUrl}`,
  ].join('\n');
  return { subject, html, text };
}

// ─── Template 3: Agent Created ──────────────────────────────
export function agentCreatedEmail(opts: {
  agentName: string;
  agentSlug: string;
  nftUrl?: string | null;
}): { subject: string; html: string; text: string } {
  const subject = `🤖 Agente "${opts.agentName}" pronto`;
  const dashUrl = `${FRONTEND}/dashboard`;
  const whatsappUrl = `${FRONTEND}/whatsapp`;
  const agentUrl = `${FRONTEND}/agent/${opts.agentSlug}`;

  const bodyHtml = `
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#eeeef0;">Seu agente está no ar 🚀</h1>
    <p style="margin:0 0 22px;color:#9a9aa4;font-size:14px;line-height:1.6;">
      <strong style="color:#eeeef0;">${escapeHtml(opts.agentName)}</strong> foi criado e já pode ser conversado em <code style="background:#0a0a0b;border:1px solid #25252b;padding:2px 6px;border-radius:4px;font-size:12px;color:#19d5c6;">/agent/${escapeHtml(opts.agentSlug)}</code>.
      ${opts.nftUrl ? 'Cada agente também é um NFT verificável na blockchain Base.' : ''}
    </p>
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:14px 0;">
      <tr>
        <td style="padding-right:8px;">
          <a href="${whatsappUrl}" style="display:inline-block;background:#7c5cff;color:#fff;padding:11px 20px;border-radius:8px;font-weight:600;text-decoration:none;font-size:13px;">Conectar WhatsApp →</a>
        </td>
        <td style="padding-right:8px;">
          <a href="${agentUrl}" style="display:inline-block;background:transparent;border:1px solid #25252b;color:#9a9aa4;padding:10px 20px;border-radius:8px;font-weight:600;text-decoration:none;font-size:13px;">Testar no chat</a>
        </td>
        ${opts.nftUrl ? `<td><a href="${opts.nftUrl}" style="display:inline-block;background:transparent;border:1px solid #25252b;color:#ffb800;padding:10px 20px;border-radius:8px;font-weight:600;text-decoration:none;font-size:13px;">🪙 Ver NFT</a></td>` : ''}
      </tr>
    </table>
    <h2 style="margin:28px 0 10px;font-size:15px;font-weight:600;color:#eeeef0;">3 jeitos de usar</h2>
    <ol style="margin:0;padding-left:20px;color:#9a9aa4;font-size:13px;line-height:1.8;">
      <li><strong style="color:#eeeef0;">WhatsApp Bot</strong> — conecte uma instância Evolution API e o agente atende clientes 24/7. Suporta multi-bolha, memória por contato, geração de imagem.</li>
      <li><strong style="color:#eeeef0;">Embed no seu site</strong> — copie o snippet em <a href="${dashUrl}" style="color:#19d5c6;text-decoration:none;">${escapeHtml(dashUrl.replace(/^https?:\/\//, ''))}</a> e cole no HTML do site.</li>
      <li><strong style="color:#eeeef0;">API direto</strong> — POST /v1/run/${escapeHtml(opts.agentSlug)}/chat pra integrar onde você quiser (n8n, Make, Python, etc).</li>
    </ol>
  `;
  const html = wrap({
    preheader: `${opts.agentName} foi criado e já pode receber mensagens. Próximo passo: conectar WhatsApp.`,
    bodyHtml,
  });
  const text = [
    `Seu agente "${opts.agentName}" está no ar!`,
    '',
    `URL pública: ${agentUrl}`,
    `Conectar WhatsApp: ${whatsappUrl}`,
    `Painel: ${dashUrl}`,
    opts.nftUrl ? `NFT na blockchain: ${opts.nftUrl}` : '',
    '',
    '3 jeitos de usar:',
    '1. WhatsApp Bot via Evolution',
    '2. Embed no site (snippet no painel)',
    `3. API direto: POST /v1/run/${opts.agentSlug}/chat`,
  ].filter(Boolean).join('\n');
  return { subject, html, text };
}
