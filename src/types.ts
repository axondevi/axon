/**
 * Hono context variable declarations.
 *
 * Merging ambient types so `c.get('user')` / `c.get('axon:x402_paid')`
 * are typed and auto-completable throughout the codebase.
 */
import type { User } from '~/db/schema';

declare module 'hono' {
  interface ContextVariableMap {
    user: User;
    'axon:x402_paid': boolean;
    'axon:agent_id': string;
    request_id: string;
  }
}

export {};
