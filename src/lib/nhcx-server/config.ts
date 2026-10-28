// NHCX settings for the server routes, from Vercel environment variables.
// The private key never leaves the server; nothing here is logged.
import { NHCX_ENVIRONMENTS, type NhcxConfig } from '@/lib/nhcx';

export interface NhcxServerConfig {
  client: NhcxConfig;
  privateKeyPem: string;
  callbackSecret: string;
}

const pem = (s: string) => s.replace(/\\n/g, '\n').trim();

/** Null until every NHCX setting is present — the screens then fall back to "sent on the website". */
export function nhcxServerConfig(): NhcxServerConfig | null {
  const e = process.env;
  const need = ['NHCX_PARTICIPANT_CODE', 'NHCX_HFR_ID', 'NHCX_PROVIDER_NAME', 'NHCX_CLIENT_ID', 'NHCX_CLIENT_SECRET', 'NHCX_PRIVATE_KEY', 'NHCX_CALLBACK_SECRET'];
  if (need.some((k) => !e[k])) return null;
  const env = e.NHCX_ENV === 'production' ? NHCX_ENVIRONMENTS.production : NHCX_ENVIRONMENTS.sandbox;
  return {
    client: {
      participantCode: e.NHCX_PARTICIPANT_CODE!,
      hfrId: e.NHCX_HFR_ID!,
      providerName: e.NHCX_PROVIDER_NAME!,
      gatewayBaseUrl: env.gatewayBaseUrl,
      registryBaseUrl: env.registryBaseUrl,
      auth: { kind: 'abdm-sessions', url: env.sessionsUrl, clientId: e.NHCX_CLIENT_ID!, clientSecret: e.NHCX_CLIENT_SECRET!, cmId: env.cmId },
      // ids, codes and counts only — the library never passes payloads to the logger
      logger: { info: () => {}, warn: (m, d) => console.warn(m, d), error: (m, d) => console.error(m, d) },
    },
    privateKeyPem: pem(e.NHCX_PRIVATE_KEY!),
    callbackSecret: e.NHCX_CALLBACK_SECRET!,
  };
}
