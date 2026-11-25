import type { PlayerProfile } from '../shared/types';

export interface AccountSession {
  playerId: string;
  email: string;
  moderator?: boolean;
  profile?: PlayerProfile;
  sessionToken?: string;
}

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

let inMemorySessionToken: string | null = null;

export function setSessionToken(token?: string | null): void {
  inMemorySessionToken = typeof token === 'string' && token.length > 0 ? token : null;
}

export function getSessionToken(): string | null {
  return inMemorySessionToken;
}

export function clearSessionToken(): void {
  inMemorySessionToken = null;
}

export async function requestJson<T>(path: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  if (inMemorySessionToken && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${inMemorySessionToken}`);
  }
  const response = await fetch(path, {
    cache: 'no-store',
    credentials: 'same-origin',
    ...options,
    headers,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, typeof data.error === 'string' ? data.error : '');
  return data as T;
}

export async function postJson<T>(path: string, body: object = {}, headers?: HeadersInit): Promise<T> {
  const merged = new Headers(headers);
  merged.set('Content-Type', 'application/json');
  return requestJson<T>(path, { method: 'POST', headers: merged, body: JSON.stringify(body) });
}
