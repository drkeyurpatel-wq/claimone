// Test harness: an NhcxClient and a callback handler wired to a FakeNhcx, with a
// controllable clock, recorded backoff sleeps and a capturing logger.

import { createCallbackHandler } from '../callback';
import { NhcxClient } from '../client';
import type { CallbackConfig, NhcxConfig, NhcxLogger } from '../types';
import { FakeNhcx, type FakeNhcxOptions } from './fake-gateway';
import { PROVIDER_CODE, provider } from './fixtures';
import { generateTestKeyPair } from './keys';

export interface Harness {
  fake: FakeNhcx;
  client: NhcxClient;
  handle: ReturnType<typeof createCallbackHandler>;
  providerKeys: ReturnType<typeof generateTestKeyPair>;
  clock: { now: Date; advance(ms: number): void };
  sleeps: number[];
  logs: string[];
  logger: NhcxLogger;
  storedApiCallIds: Set<string>;
}

export function createHarness(opts: {
  client?: Partial<NhcxConfig>;
  callback?: Partial<CallbackConfig>;
  fake?: Partial<FakeNhcxOptions>;
} = {}): Harness {
  const clock = {
    now: new Date('2026-10-28T08:00:00Z'),
    advance(ms: number) { this.now = new Date(this.now.getTime() + ms); },
  };
  const providerKeys = generateTestKeyPair('provider');
  const fake = new FakeNhcx({ providerCode: PROVIDER_CODE, providerCertificatePem: providerKeys.certificatePem, now: () => clock.now, ...opts.fake });
  const logs: string[] = [];
  const logger: NhcxLogger = {
    info: (m, meta) => logs.push(`info ${m} ${JSON.stringify(meta ?? {})}`),
    warn: (m, meta) => logs.push(`warn ${m} ${JSON.stringify(meta ?? {})}`),
    error: (m, meta) => logs.push(`error ${m} ${JSON.stringify(meta ?? {})}`),
  };
  const sleeps: number[] = [];
  const client = new NhcxClient({
    participantCode: PROVIDER_CODE,
    hfrId: provider.hfrId,
    providerName: provider.name,
    gatewayBaseUrl: fake.gatewayBaseUrl,
    registryBaseUrl: fake.registryBaseUrl,
    auth: { kind: 'abdm-sessions', url: fake.sessionsUrl, clientId: fake.clientId, clientSecret: fake.clientSecret, cmId: 'sbx' },
    fetch: fake.fetch,
    now: () => clock.now,
    sleep: async (ms) => { sleeps.push(ms); },
    random: () => 0.5,
    logger,
    ...opts.client,
  });
  const storedApiCallIds = new Set<string>();
  const handle = createCallbackHandler({
    participantCode: PROVIDER_CODE,
    privateKeyPem: providerKeys.privateKeyPem,
    now: () => clock.now,
    isDuplicate: (id) => storedApiCallIds.has(id),
    logger,
    ...opts.callback,
  });
  return { fake, client, handle, providerKeys, clock, sleeps, logs, logger, storedApiCallIds };
}
