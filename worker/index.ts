import { Hono } from 'hono';
import type { AppEnv } from './lib/auth.ts';
import { RelayError } from './lib/errors.ts';
import { requireRelayKey } from './lib/auth.ts';
import { runScheduler } from './lib/scheduler.ts';
import { sweepRefresh } from './lib/tokens.ts';
import { health } from './routes/health.ts';
import { admin } from './routes/admin.ts';
import { oauth } from './routes/oauth.ts';
import { post } from './routes/post.ts';
import { queue } from './routes/queue.ts';
import { approve } from './routes/approve.ts';
import { debug } from './routes/debug.ts';

const app = new Hono<AppEnv>();

// The /x/queue routes need the same bearer auth as /x/post. That middleware is registered
// on `post`'s own router, which does not cover a sibling, so apply it here too — mounting
// order alone would not authenticate them.
app.use('/x/queue', requireRelayKey);
app.use('/x/queue/*', requireRelayKey);

app.route('/', health);
app.route('/', debug);
app.route('/', admin);
app.route('/', oauth);
app.route('/', queue);
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
   * Every 5 minutes: keep tokens fresh, then run the posting schedule.
   *
   * The sweep goes first and its failure must not stop the scheduler — a token error for
   * one account should not mean nobody posts. It keeps /x/post off the refresh path,
   * which matters because HTTP_Execute's timeout budget is undocumented.
   */
  async scheduled(_event: ScheduledController, env: AppEnv['Bindings'], _ctx: ExecutionContext) {
    try {
      const sweep = await sweepRefresh(env);
      console.log(
        `[sweep] checked=${sweep.checked} refreshed=${sweep.refreshed} failed=${sweep.failed}`,
      );
    } catch (err) {
      console.error('[sweep] failed', err);
    }

    try {
      const s = await runScheduler(env, Math.floor(Date.now() / 1000));
      console.log(
        `[scheduler] bound=${s.bound} posted=${s.posted} failed=${s.failed} ` +
          `skipped=${s.skipped} expired=${s.expired}`,
      );
    } catch (err) {
      console.error('[scheduler] failed', err);
    }
  },
};
