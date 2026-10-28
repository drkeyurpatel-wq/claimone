// Test-only key material: RSA key pairs and a self-signed X.509 certificate,
// generated at runtime (nothing is checked in). The certificate is DER-encoded by
// hand so tests exercise the same "registry returns a certificate" path as production.

import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';

function derLen(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag: number, body: Buffer) => Buffer.concat([Buffer.from([tag]), derLen(body.length), body]);
const seq = (...parts: Buffer[]) => tlv(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]) => tlv(0x31, Buffer.concat(parts));

const OID_SHA256_RSA = Buffer.from('06092a864886f70d01010b', 'hex');
const OID_CN = Buffer.from('0603550403', 'hex');
const NULL = Buffer.from('0500', 'hex');

function utcTime(d: Date): Buffer {
  const s = d.toISOString(); // YYYY-MM-DDTHH:mm:ss.sssZ
  const t = `${s.slice(2, 4)}${s.slice(5, 7)}${s.slice(8, 10)}${s.slice(11, 13)}${s.slice(14, 16)}${s.slice(17, 19)}Z`;
  return tlv(0x17, Buffer.from(t, 'ascii'));
}

export interface TestKeyPair {
  privateKeyPem: string;
  publicKeyPem: string;
  certificatePem: string;
}

/** Fresh 2048-bit RSA pair plus a one-year self-signed certificate for `commonName`. */
export function generateTestKeyPair(commonName: string): TestKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const algId = seq(OID_SHA256_RSA, NULL);
  const name = seq(set(seq(OID_CN, tlv(0x0c, Buffer.from(commonName, 'utf8')))));
  const serial = randomBytes(8);
  serial[0] = (serial[0] & 0x3f) | 0x40; // positive and minimal DER (a leading 0x00 would be rejected)
  const now = new Date();
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))),
    tlv(0x02, serial),
    algId,
    name,
    seq(utcTime(new Date(now.getTime() - 60_000)), utcTime(new Date(now.getTime() + 365 * 86_400_000))),
    name,
    spki,
  );
  const signature = sign('sha256', tbs, privateKey);
  const cert = seq(tbs, algId, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const b64 = cert.toString('base64').match(/.{1,64}/g)!.join('\n');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    certificatePem: `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`,
  };
}
