export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public meta?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Errors = {
  unauthorized: () => new AppError(401, 'unauthorized', 'Missing or invalid API key'),
  forbidden: () => new AppError(403, 'forbidden', 'Not allowed'),
  notFound: (what: string) =>
    new AppError(404, 'not_found', `${what} not found`),
  insufficientFunds: (needed: bigint, have: bigint) =>
    new AppError(402, 'insufficient_funds', 'Insufficient wallet balance', {
      needed: needed.toString(),
      have: have.toString(),
    }),
  upstreamFailed: (slug: string, status: number) =>
    new AppError(502, 'upstream_failed', `Upstream ${slug} returned ${status}`),
  upstreamMisconfigured: (slug: string, envVar: string) =>
    new AppError(
      500,
      'upstream_misconfigured',
      `API '${slug}' is missing its upstream credential. Set ${envVar} in the server environment.`,
      { slug, missing_env: envVar },
    ),
  badRequest: (msg: string) => new AppError(400, 'bad_request', msg),
};
