import { Hono } from 'hono';
import { handleCall } from '~/wrapper/engine';

const app = new Hono();

// Main proxy: /v1/call/:slug/:endpoint
app.all('/:slug/:endpoint', async (c) => handleCall(c));

export default app;
