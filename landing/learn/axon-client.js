/**
 * Axon Browser Client — standalone JS, zero dependencies.
 * Handles signup, API calls, key storage, and balance checking.
 *
 * Usage in any page:
 *   <script src="/learn/axon-client.js"></script>
 *   <script>
 *     const client = new AxonClient();
 *     const { key } = await client.signup('user@example.com');
 *     const result = await client.call('brasilapi', 'cnpj/00000000000191');
 *   </script>
 */
(function (global) {
  'use strict';

  const STORAGE_KEY = 'axon.apiKey';
  const BASE_KEY = 'axon.baseUrl';
  const DEFAULT_BASE = 'https://axon-kedb.onrender.com';

  class AxonClient {
    constructor(opts = {}) {
      this.baseUrl = opts.baseUrl || localStorage.getItem(BASE_KEY) || DEFAULT_BASE;
      this._listeners = new Set();
    }

    // ─── Key management ──────────────────────────────
    getKey() { return localStorage.getItem(STORAGE_KEY); }
    hasKey() { return !!this.getKey(); }

    setKey(key) {
      localStorage.setItem(STORAGE_KEY, key);
      this._emit('key-change', { key });
    }

    clearKey() {
      localStorage.removeItem(STORAGE_KEY);
      this._emit('key-change', { key: null });
    }

    onKeyChange(cb) {
      this._listeners.add(cb);
      return () => this._listeners.delete(cb);
    }

    _emit(event, data) {
      this._listeners.forEach(cb => {
        try { cb(event, data); } catch (e) { console.error(e); }
      });
      window.dispatchEvent(new CustomEvent(`axon:${event}`, { detail: data }));
    }

    // ─── Signup ──────────────────────────────────────
    async signup(email) {
      const res = await fetch(`${this.baseUrl}/v1/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });

      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new AxonError(json.error || `Signup failed (${res.status})`, res.status, json);
      }

      if (json.api_key) {
        this.setKey(json.api_key);
      }

      // Signup returns balance_usdc in MICRO units (e.g. "500000" = $0.50)
      // balance_display has the friendly string (e.g. "$0.5 USDC")
      const balanceMicro = parseInt(json.balance_usdc || '0', 10);
      return {
        key: json.api_key,
        userId: json.user_id,
        depositAddress: json.deposit_address,
        balanceUsdc: balanceMicro / 1_000_000,
        balanceDisplay: json.balance_display || `$${(balanceMicro / 1_000_000).toFixed(2)}`,
        raw: json,
      };
    }

    // ─── API call ────────────────────────────────────
    async call(api, endpoint, options = {}) {
      const key = this.getKey();
      if (!key) throw new AxonError('No API key. Sign up first.', 401);

      const {
        method = 'GET',
        params = {},
        body = null,
        paramStyle = 'query',
      } = options;

      let url = `${this.baseUrl}/v1/call/${api}/${endpoint}`;

      if (paramStyle === 'query' && Object.keys(params).length > 0) {
        const qs = new URLSearchParams(params).toString();
        url += (url.includes('?') ? '&' : '?') + qs;
      }

      const fetchOpts = {
        method,
        headers: {
          'Authorization': `Bearer ${key}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
      };
      if (body) fetchOpts.body = JSON.stringify(body);

      const started = performance.now();
      const res = await fetch(url, fetchOpts);
      const elapsed = Math.round(performance.now() - started);

      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = text; }

      const cost = res.headers.get('x-axon-cost-usdc') || '0';
      const cache = res.headers.get('x-axon-cache') || 'miss';
      const requestId = res.headers.get('x-request-id') || '';

      if (!res.ok) {
        throw new AxonError(
          typeof data === 'object' ? (data.error || `Request failed (${res.status})`) : data,
          res.status,
          data,
        );
      }

      // Notify listeners (KeyBanner, other widgets) that a call just happened
      // so they refresh balance without waiting for next polling interval
      this._emit('call-success', { api, endpoint, cost: parseFloat(cost), cacheHit: cache === 'hit' });

      return {
        data,
        cost: parseFloat(cost),
        cacheHit: cache === 'hit',
        latencyMs: elapsed,
        requestId,
        raw: res,
      };
    }

    // ─── Get wallet balance ──────────────────────────
    async getBalance() {
      const key = this.getKey();
      if (!key) throw new AxonError('No API key.', 401);

      const res = await fetch(`${this.baseUrl}/v1/wallet/balance`, {
        headers: { 'Authorization': `Bearer ${key}` },
      });

      if (!res.ok) {
        throw new AxonError(`Balance check failed (${res.status})`, res.status);
      }

      const json = await res.json();
      return {
        balanceUsdc: parseFloat(json.balance_usdc || '0'),
        reservedUsdc: parseFloat(json.reserved_usdc || '0'),
        availableUsdc: parseFloat(json.available_usdc || '0'),
        address: json.address || '',
        raw: json,
      };
    }

    // ─── Get usage stats ─────────────────────────────
    async getUsage() {
      const key = this.getKey();
      if (!key) throw new AxonError('No API key.', 401);

      const res = await fetch(`${this.baseUrl}/v1/usage`, {
        headers: { 'Authorization': `Bearer ${key}` },
      });

      if (!res.ok) throw new AxonError(`Usage check failed (${res.status})`, res.status);

      const json = await res.json();
      return {
        totalRequests: json.total_requests || 0,
        cacheHits: json.cache_hits || 0,
        cacheHitRate: json.cache_hit_rate || 0,
        totalSpent: parseFloat(json.total_spent_usdc || '0'),
        raw: json,
      };
    }

    // ─── Catalog ─────────────────────────────────────
    async getCatalog() {
      const res = await fetch(`${this.baseUrl}/v1/apis`);
      if (!res.ok) throw new AxonError(`Catalog fetch failed (${res.status})`, res.status);
      const json = await res.json();
      return { apis: json.data || [] };
    }
  }

  class AxonError extends Error {
    constructor(message, status, details) {
      super(message);
      this.name = 'AxonError';
      this.status = status;
      this.details = details;
    }
  }

  // ─── Expose globals ──────────────────────────────
  global.AxonClient = AxonClient;
  global.AxonError = AxonError;
  global.AXON_DEFAULT_BASE = DEFAULT_BASE;
})(typeof window !== 'undefined' ? window : globalThis);
