import { Hono } from 'hono';
import { handleCall } from '~/wrapper/engine';

const app = new Hono();

// Main proxy: /v1/call/:slug/:endpoint
// `:endpoint` accepts a single path segment by default in Hono, but real
// upstream APIs use multi-segment endpoints (e.g. OpenAI's
// `chat/completions`, Anthropic's `messages`, etc). We register both the
// single-segment and a wildcard pattern so /v1/call/groq/chat works AND
// /v1/call/openai/chat/completions works without surprising the caller.
app.all('/:slug/:endpoint{.+}', async (c) => handleCall(c));
app.all('/:slug/:endpoint', async (c) => handleCall(c));

export default app;
