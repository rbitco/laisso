/** A refused or failed request: the server's own error message, its status, and the body it sent. */
export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/** One JSON request against Lasso's /api. A non-2xx answer throws ApiError with the server's error message. */
export async function api<T>(route: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(route, { headers: { "content-type": "application/json" }, ...init });
  const text = await res.text();
  const body: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const error = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : `${res.status} ${route}`;
    throw new ApiError(error, res.status, body);
  }
  return body as T;
}
