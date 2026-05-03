/**
 * Privy Embedded Wallet Auth — drop-in script for any Axon page.
 *
 * Use:
 *   <script src="/privy-login.js"></script>
 *   <button onclick="axonPrivyLogin()">Sign in</button>
 *
 * What happens:
 *   1. Loads Privy SDK if not already
 *   2. Fetches /v1/auth/privy/config to get APP_ID
 *   3. Opens Privy modal (email / Google / wallet)
 *   4. After user authenticates, exchanges Privy token for Axon API key
 *   5. Stores api_key in localStorage as 'axon.apiKey'
 *   6. Reloads page (existing flows pick up the key automatically)
 *
 * Requires (operator setup):
 *   - Render env: PRIVY_APP_ID, PRIVY_APP_SECRET (free tier at privy.io)
 */

(function () {
  'use strict';
  const API_BASE = window.location.host.includes('pages.dev') || window.location.protocol === 'file:'
    ? 'https://api.nexusinovation.com.br'
    : window.location.origin;

  let privyClient = null;
  let configCache = null;

  async function getConfig() {
    if (configCache) return configCache;
    try {
      const r = await fetch(API_BASE + '/v1/auth/privy/config');
      if (!r.ok) return { enabled: false };
      configCache = await r.json();
      return configCache;
    } catch {
      return { enabled: false };
    }
  }

  async function loadPrivySdk(appId) {
    if (window.Privy) return window.Privy;
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://auth.privy.io/sdks/privy-js-sdk-v2.js';
      s.async = true;
      s.onload = () => resolve(window.Privy);
      s.onerror = () => reject(new Error('Failed to load Privy SDK'));
      document.head.appendChild(s);
    });
  }

  async function getPrivyClient() {
    if (privyClient) return privyClient;
    const cfg = await getConfig();
    if (!cfg.enabled || !cfg.app_id) {
      throw new Error('Privy not configured on this server. Operator: set PRIVY_APP_ID + PRIVY_APP_SECRET.');
    }
    const PrivySDK = await loadPrivySdk(cfg.app_id);
    privyClient = await PrivySDK.init({
      appId: cfg.app_id,
      embeddedWallets: {
        createOnLogin: 'all-users',  // every signup auto-gets a wallet
        noPromptOnSignature: false,
      },
      loginMethods: ['email', 'google', 'wallet'],
      appearance: {
        theme: 'dark',
        accentColor: '#7c5cff',
        logo: '/favicon.svg',
        showWalletLoginFirst: false,  // surface email/social first (camouflage)
      },
    });
    return privyClient;
  }

  async function exchangeForAxonKey(privyToken, walletAddr, email) {
    const r = await fetch(API_BASE + '/v1/auth/privy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: privyToken,
        wallet_address: walletAddr,
        email,
      }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      throw new Error('Axon auth failed: ' + (t || r.status));
    }
    return r.json();
  }

  /**
   * Public API: opens Privy modal and completes Axon login.
   * On success, stores api_key in localStorage and reloads page.
   */
  window.axonPrivyLogin = async function () {
    try {
      const client = await getPrivyClient();
      // Open Privy modal — handles email/google/wallet flow
      await client.login();
      const user = client.user;
      if (!user) throw new Error('Login canceled');
      const wallet = user.wallet || (user.linkedAccounts || []).find((a) => a.type === 'wallet');
      const email = (user.linkedAccounts || []).find((a) => a.type === 'email')?.address || user.email?.address;
      const token = await client.getAccessToken();
      if (!token) throw new Error('No Privy access token');
      const result = await exchangeForAxonKey(token, wallet?.address, email);
      if (result.api_key) {
        localStorage.setItem('axon.apiKey', result.api_key);
        if (result.wallet_address) localStorage.setItem('axon.wallet', result.wallet_address);
        if (email) localStorage.setItem('axon.email', email);
        // Trigger custom event for SPAs that listen instead of reloading
        window.dispatchEvent(new CustomEvent('axon-login', { detail: result }));
        // Default behavior: reload so existing pages pick up the new key
        if (!window.AXON_PRIVY_NO_RELOAD) {
          location.reload();
        }
      } else if (result.is_new === false) {
        // Returning user — they should already have api_key in localStorage
        // If not, they need to recover it via signup flow
        alert('Welcome back! Your account was found. If you previously saved your API key, you can use it directly. Otherwise, contact support to recover it.');
      }
    } catch (e) {
      console.error('[axonPrivyLogin]', e);
      alert('Login error: ' + (e.message || e));
    }
  };

  /**
   * Public API: check if Privy is configured + ready (use to show/hide button).
   */
  window.axonPrivyAvailable = async function () {
    const cfg = await getConfig();
    return cfg.enabled === true;
  };

  /**
   * Public API: log out current Axon session (clears localStorage + reloads).
   */
  window.axonLogout = function () {
    localStorage.removeItem('axon.apiKey');
    localStorage.removeItem('axon.wallet');
    localStorage.removeItem('axon.email');
    if (privyClient && privyClient.logout) privyClient.logout();
    location.reload();
  };
})();
