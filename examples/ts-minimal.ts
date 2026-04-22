// Minimal Axon TypeScript example — 3 things:
//   1) make a call, 2) read cost, 3) read balance.
//
// Run:  AXON_KEY=ax_live_... bun ts-minimal.ts
import { Axon } from '@axon/client';

const axon = new Axon({ apiKey: process.env.AXON_KEY! });

const res = await axon.call('openweather', 'current', {
  lat: 38.72,
  lon: -9.14,
});
console.log('temp (K):', (res.data as any).main?.temp);
console.log('paid:', res.costUsdc, 'USDC', res.cacheHit ? '(cache hit)' : '');

const bal = await axon.wallet.balance();
console.log('wallet:', bal.available_usdc, 'USDC available');
