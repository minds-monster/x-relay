/**
 * Outbound alerts to the operator, via a Slack-shaped `{text}` webhook.
 *
 * This is the only channel by which an unattended relay can tell a human anything, so it
 * is used for exactly two classes of event: something needs your attention and cannot fix
 * itself (re-auth, rejected credentials, a failed dispatch), and something is about to
 * happen that you may want to stop (a held draft, with its veto link).
 *
 * Never throws and never blocks the caller's outcome: an alert that fails must not turn a
 * successful post into an error, and a token refresh must not be undone because Slack was
 * down. Failures go to the Worker log.
 */
import type { Env } from '../types.ts';

export async function notify(env: Env, message: string): Promise<void> {
  if (!env.ALERT_WEBHOOK_URL) return;
  try {
    await fetch(env.ALERT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: message }),
    });
  } catch (err) {
    console.error('[notify] failed', err);
  }
}
