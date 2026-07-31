import { Hono } from 'hono';
import type { AppEnv } from './lib/auth.ts';
import { RelayError } from './lib/errors.ts';
import { sweepRefresh } from './lib/tokens.ts';
import { health } from './routes/health.ts';
import { admin } from './routes/admin.ts';
import { oauth } from './routes/oauth.ts';
import { post } from './routes/post.ts';
import { approve } from './routes/approve.ts';
import { debug } from './routes/debug.ts';

const app = new Hono<AppEnv>();

app.route('/', health);
app.route('/', debug);
app.route('/', admin);
app.route('/', oauth);
app.route('/', post);
app.route('/', approve);

app.notFound((c) =>
  c.json(
    { ok: false, error: { code: 'relay_not_found', message: `No route for ${c.req.method} ${new URL(c.req.url).pathname}`, retryable: false } },
    404,
  ),
);

/** Single error boundary, so every failure reaches the Mind in the same envelope. */
app.onError((err, c) => {
  if (err instanceof RelayError) {
    const headers: Record<string, string> = {};
    if (err.extra.retryAfterSec !== undefined) {
      headers['retry-after'] = String(err.extra.retryAfterSec);
    }
    return c.json(err.toBody(), err.httpStatus as 400, headers);
  }
  console.error('[unhandled]', err);
  return c.json(
    {
      ok: false,
      error: {
        code: 'relay_internal',
        message: err instanceof Error ? err.message : 'Internal error.',
        retryable: true,
      },
    },
    500,
  );
});

export default {
  fetch: app.fetch,

  /**
   * Token health sweep. Keeps /x/post off the refresh path, which matters because the
   * Minds HTTP_Execute primitive's timeout budget is undocumented.
   */
  async scheduled(_event: ScheduledController, env: AppEnv['Bindings'], _ctx: ExecutionContext) {
    const result = await sweepRefresh(env);
    console.log(
      `[sweep] checked=${result.checked} refreshed=${result.refreshed} failed=${result.failed}`,
    );
  },
};
