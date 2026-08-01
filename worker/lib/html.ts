/**
 * The one HTML shell used by every human-facing page: OAuth callback, approval, veto.
 *
 * These pages are seen at exactly the moment someone is deciding whether a post should go
 * out, often on a phone from a Slack notification. They get one style and one voice so
 * that "is this the real page" is never a question.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function page(title: string, inner: string, status = 200): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
 body{font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:36rem;margin:4rem auto;padding:0 1.5rem;color:#111}
 .draft{border:1px solid #e4e4e7;border-left:3px solid #71717a;border-radius:6px;padding:1rem 1.15rem;margin:1.25rem 0;white-space:pre-wrap;background:#fafafa}
 .meta{color:#71717a;font-size:.85rem;margin-bottom:1.5rem}
 button{font:inherit;padding:.6rem 1.4rem;border-radius:6px;border:1px solid transparent;cursor:pointer;margin-right:.6rem}
 .go{background:#111;color:#fff}.no{background:#fff;color:#b3261e;border-color:#e4e4e7}
 code{background:#f4f4f5;padding:.15em .4em;border-radius:4px;font-size:.9em}
 .ok{color:#0a7d32}.bad{color:#b3261e}
 h1{font-size:1.3rem}
</style>
${inner}`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}
