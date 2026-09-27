import { resolveHome } from "../server/home.ts";
import { loadConfig } from "../server/config.ts";

export class NotRunning extends Error {
  constructor() {
    super("lasso is not running");
  }
}

export interface Client {
  url: string;
  get<T>(route: string): Promise<T>;
  post<T>(route: string, body?: unknown): Promise<T>;
}

/** A thin client over the localhost API; every CLI command except `lasso` itself goes through it. */
export function createClient(portFlag?: number): Client {
  const config = loadConfig(resolveHome(), { port: portFlag });
  const url = `http://localhost:${config.port}`;
  const request = async <T>(route: string, init: RequestInit): Promise<T> => {
    let res: Response;
    try {
      res = await fetch(url + route, { ...init, headers: { "content-type": "application/json" } });
    } catch {
      throw new NotRunning();
    }
    if (!res.headers.has("x-lasso-version")) throw new NotRunning();
    const text = await res.text();
    const body = text ? JSON.parse(text) : undefined;
    if (!res.ok) throw new Error(typeof body?.error === "string" ? body.error : `${res.status} ${route}`);
    return body as T;
  };
  return {
    url,
    get: (route) => request(route, { method: "GET" }),
    post: (route, body) => request(route, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }),
  };
}
