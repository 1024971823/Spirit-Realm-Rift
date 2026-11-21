export interface AccountSession {
  playerId: string;
  email: string;
  moderator?: boolean;
}

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

export async function requestJson<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { cache: 'no-store', ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, typeof data.error === 'string' ? data.error : '');
  return data as T;
}

export async function postJson<T>(path: string, body: object = {}, headers?: HeadersInit): Promise<T> {
  return requestJson<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
}
