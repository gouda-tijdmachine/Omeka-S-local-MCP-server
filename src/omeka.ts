/**
 * Minimal Omeka S REST API client.
 *
 * Every request carries the API key, also reads: anonymous responses are
 * rewritten by the RdfDispatch setup on this installation (no `o:` keys) and
 * private resources are hidden from them.
 */

export type Json = any;

export type QueryValue = string | number | boolean | null | undefined | QueryValue[] | { [key: string]: QueryValue };
export type Query = Record<string, QueryValue>;

export class OmekaError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: Json,
  ) {
    super(message);
    this.name = 'OmekaError';
  }
}

export interface OmekaConfig {
  apiUrl: string;
  keyIdentity?: string;
  keyCredential?: string;
}

export interface ListResult {
  total: number | null;
  items: Json[];
}

/**
 * Serialise nested query objects the PHP way:
 * {property: [{property: 1, type: 'eq', text: 'x'}]} ->
 * property[0][property]=1&property[0][type]=eq&property[0][text]=x
 */
export function buildQuery(query: Query, prefix = '', params = new URLSearchParams()): URLSearchParams {
  for (const [key, value] of Object.entries(query)) {
    const name = prefix ? `${prefix}[${key}]` : key;
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      value.forEach((v, i) => {
        if (v !== null && typeof v === 'object') buildQuery(v as Query, `${name}[${i}]`, params);
        else if (v !== undefined && v !== null) params.append(`${name}[]`, String(v));
      });
    } else if (typeof value === 'object') {
      buildQuery(value as Query, name, params);
    } else {
      params.append(name, typeof value === 'boolean' ? (value ? '1' : '0') : String(value));
    }
  }
  return params;
}

export class OmekaClient {
  readonly apiUrl: string;

  constructor(private readonly config: OmekaConfig) {
    this.apiUrl = config.apiUrl.replace(/\/+$/, '');
  }

  get hasKey(): boolean {
    return Boolean(this.config.keyIdentity && this.config.keyCredential);
  }

  private url(path: string, query: Query = {}): string {
    const params = buildQuery(query);
    if (this.hasKey) {
      params.set('key_identity', this.config.keyIdentity!);
      params.set('key_credential', this.config.keyCredential!);
    }
    const qs = params.toString();
    return `${this.apiUrl}/${path.replace(/^\/+/, '')}${qs ? `?${qs}` : ''}`;
  }

  async request(method: string, path: string, query: Query = {}, body?: Json): Promise<{ status: number; headers: Headers; data: Json }> {
    const res = await fetch(this.url(path, query), {
      method,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data: Json = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!res.ok) {
      throw new OmekaError(`${method} ${path} failed: HTTP ${res.status} ${describeErrors(data)}`.trim(), res.status, data);
    }
    return { status: res.status, headers: res.headers, data };
  }

  async list(resource: string, query: Query = {}): Promise<ListResult> {
    const { headers, data } = await this.request('GET', resource, query);
    const total = headers.get('Omeka-S-Total-Results');
    return { total: total === null ? null : Number(total), items: Array.isArray(data) ? data : [] };
  }

  /** Fetch every page of a (small) resource list, e.g. properties. */
  async listAll(resource: string, query: Query = {}, perPage = 500): Promise<Json[]> {
    const all: Json[] = [];
    for (let page = 1; ; page++) {
      const { items, total } = await this.list(resource, { ...query, per_page: perPage, page });
      all.push(...items);
      if (items.length < perPage || (total !== null && all.length >= total)) break;
    }
    return all;
  }

  async get(resource: string, id: number): Promise<Json> {
    return (await this.request('GET', `${resource}/${id}`)).data;
  }

  async create(resource: string, body: Json): Promise<Json> {
    return (await this.request('POST', resource, {}, body)).data;
  }

  /** Full replacement. There is deliberately no patch(): see README. */
  async replace(resource: string, id: number, body: Json): Promise<Json> {
    return (await this.request('PUT', `${resource}/${id}`, {}, body)).data;
  }

  async delete(resource: string, id: number): Promise<Json> {
    return (await this.request('DELETE', `${resource}/${id}`)).data;
  }
}

/** Flatten an Omeka `errors` payload into one readable line. */
export function describeErrors(data: Json): string {
  if (!data || typeof data !== 'object') return typeof data === 'string' ? data.slice(0, 300) : '';
  const errors = data.errors ?? data;
  const parts: string[] = [];
  const walk = (value: Json, path: string) => {
    if (value === null || value === undefined) return;
    if (typeof value !== 'object') parts.push(path ? `${path}: ${value}` : String(value));
    else for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k);
  };
  walk(errors, '');
  return parts.join('; ').slice(0, 1000);
}
