import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MfaError } from './types.js';

// Stub VERIFY_TENANT_HOST before the module under test imports it.
process.env.VERIFY_TENANT_HOST = 'tenant.example.com';
process.env.VERIFY_TE_CLIENT_ID = 'test-client-id';
process.env.VERIFY_TE_CLIENT_SECRET = 'test-client-secret';
process.env.MFA_POLL_INTERVAL_MS = '10'; // fast poll for tests

const { triggerOAuthMfaPush, pollOAuthMfaStatus, exchangeMfaAssertionWithRAR } = await import(
  './token-exchange.js'
);

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => handler(url, init)));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('triggerOAuthMfaPush', () => {
  it('fetches factors, picks userPresence, posts a verification, returns the transactionUri', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    mockFetch((url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/v2.0/factors')) {
        return new Response(
          JSON.stringify({
            factors: [
              {
                id: 'factor-1',
                type: 'signature',
                subType: 'userPresence',
                created: '2026-01-01T00:00:00Z',
                references: { authenticatorId: 'auth-1' },
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/v1.0/authenticators/auth-1/verifications')) {
        return new Response(
          JSON.stringify({ transactionUri: 'https://tenant.example.com/txns/T-123' }),
          { status: 200 },
        );
      }
      return new Response('unexpected URL', { status: 500 });
    });

    const result = await triggerOAuthMfaPush('challenge-token');

    expect(result).toBe('https://tenant.example.com/txns/T-123');
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain('/v2.0/factors');
    expect(calls[0].init?.headers).toMatchObject({ Authorization: 'Bearer challenge-token' });
    expect(calls[1].url).toContain('/v1.0/authenticators/auth-1/verifications');
    const body = JSON.parse(calls[1].init?.body as string);
    expect(body.pushNotification.send).toBe(true);
    expect(body.authenticationMethods[0]).toMatchObject({ id: 'factor-1', methodType: 'signature' });
  });

  it('throws MfaError(mfa_no_factor) when the user has no userPresence factor', async () => {
    mockFetch(() =>
      new Response(JSON.stringify({ factors: [] }), { status: 200 }),
    );

    await expect(triggerOAuthMfaPush('challenge-token')).rejects.toBeInstanceOf(MfaError);
    try {
      await triggerOAuthMfaPush('challenge-token');
    } catch (err) {
      expect((err as MfaError).code).toBe('mfa_no_factor');
    }
  });
});

describe('pollOAuthMfaStatus', () => {
  it('returns approved with the assertion JWT on VERIFY_SUCCESS', async () => {
    mockFetch(() =>
      new Response(
        JSON.stringify({ state: 'VERIFY_SUCCESS', assertion: 'eyJ.aA.bB' }),
        { status: 200 },
      ),
    );

    const result = await pollOAuthMfaStatus('https://tenant.example.com/txns/T-123', 'ct');

    expect(result).toEqual({ state: 'approved', assertion: 'eyJ.aA.bB' });
  });

  it('returns denied with the state name when USER_DENIED', async () => {
    mockFetch(() =>
      new Response(JSON.stringify({ state: 'USER_DENIED' }), { status: 200 }),
    );

    const result = await pollOAuthMfaStatus('https://tenant.example.com/txns/T-123', 'ct');

    expect(result).toEqual({ state: 'denied', reason: 'USER_DENIED' });
  });

  it('returns timeout when no terminal state arrives within the deadline', async () => {
    mockFetch(() =>
      new Response(JSON.stringify({ state: 'PENDING' }), { status: 200 }),
    );

    const result = await pollOAuthMfaStatus(
      'https://tenant.example.com/txns/T-123',
      'ct',
      { intervalMs: 5, timeoutMs: 25 },
    );

    expect(result).toEqual({ state: 'timeout' });
  });

  it('appends ?returnJwt=true to the URI', async () => {
    const seen: string[] = [];
    mockFetch((url) => {
      seen.push(url);
      return new Response(
        JSON.stringify({ state: 'VERIFY_SUCCESS', assertion: 'eyJ' }),
        { status: 200 },
      );
    });

    await pollOAuthMfaStatus('https://tenant.example.com/txns/T-123', 'ct');

    expect(seen[0]).toContain('?returnJwt=true');
  });
});

describe('exchangeMfaAssertionWithRAR', () => {
  it('posts the assertion + RAR to /oauth2/token and returns the JSON body', async () => {
    let posted: { url: string; init?: RequestInit } | undefined;
    mockFetch((url, init) => {
      posted = { url, init };
      return new Response(
        JSON.stringify({ access_token: 'obo-jwt', expires_in: 3600, scope: 'healthcare:patient:read' }),
        { status: 200 },
      );
    });

    const result = await exchangeMfaAssertionWithRAR(
      'mfa-assertion-jwt',
      'healthcare:patient:read',
      [{ type: 'urn:smt:agent:healthcare', operationDetails: { action: 'patient_read_vip' } }],
      'test-client-secret',
    );

    expect(result.access_token).toBe('obo-jwt');
    expect(posted?.url).toContain('/oauth2/token');
    const body = new URLSearchParams(posted?.init?.body as string);
    expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(body.get('assertion')).toBe('mfa-assertion-jwt');
    expect(body.get('client_secret')).toBe('test-client-secret');
    expect(JSON.parse(body.get('authorization_details') ?? '[]')[0].operationDetails.action).toBe('patient_read_vip');
  });

  it('throws on non-2xx response', async () => {
    mockFetch(() => new Response('{"error":"invalid_grant"}', { status: 400 }));

    await expect(
      exchangeMfaAssertionWithRAR('a', 's', [], 'secret'),
    ).rejects.toThrow(/jwt_bearer failed \(400\)/);
  });
});
