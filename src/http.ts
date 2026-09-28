// JSON responses and the one error type the Worker throws. No cloudflare:* imports, so the pure
// modules (and `node --test`) can use it.

export class HttpError extends Error {
  status: number;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined; // replaces the usual { error: message } when set
  constructor(status: number, message: string, headers: Record<string, string> = {}, body?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.headers = headers;
    this.body = body;
  }
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}
