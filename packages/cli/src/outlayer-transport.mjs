import { randomBytes } from 'node:crypto';
import { Aes256Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from '@hpke/core';

const suite = new CipherSuite({ kem: new DhkemP256HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm() });
const requestInfo = Buffer.from('remora.transport.request.v1'), responseInfo = Buffer.from('remora.transport.response.v1');
export const transportProtocol = 'remora.hpke-p256-sha256-aes256gcm.v1';
const encode = value => Buffer.from(value).toString('base64');
function decode(text, max) {
  if (typeof text !== 'string' || text.length > Math.ceil(max / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new Error('OUTLAYER_ENCRYPTED_RESPONSE_INVALID');
  const bytes = Buffer.from(text, 'base64');
  if (bytes.length > max || encode(bytes) !== text) throw new Error('OUTLAYER_ENCRYPTED_RESPONSE_INVALID');
  return bytes;
}

export async function encryptOutlayerInput(publicKey, input) {
  const recipientPublicKey = await suite.kem.deserializePublicKey(decode(publicKey, 65));
  const reply = await suite.kem.generateKeyPair();
  const nonce = randomBytes(32).toString('hex');
  const sender = await suite.createSenderContext({ recipientPublicKey, info: requestInfo });
  const plain = JSON.stringify({ input, at: Date.now(), nonce, replyKey: encode(await suite.kem.serializePublicKey(reply.publicKey)) });
  if (Buffer.byteLength(plain) > 262000) throw new Error('OUTLAYER_ENCRYPTED_INPUT_TOO_LARGE');
  const ciphertext = await sender.seal(Buffer.from(plain));
  return { input: { operation: 'encrypted', enc: encode(sender.enc), ciphertext: encode(ciphertext) },
    async decrypt(envelope) {
      const recipient = await suite.createRecipientContext({ recipientKey: reply.privateKey, enc: decode(envelope?.enc, 65), info: responseInfo });
      let body;
      try { body = JSON.parse(Buffer.from(await recipient.open(decode(envelope.ciphertext, 262144), Buffer.from(nonce))).toString('utf8')); }
      catch { throw new Error('OUTLAYER_ENCRYPTED_RESPONSE_INVALID'); }
      if (body.nonce !== nonce || !body.output || typeof body.output !== 'object') throw new Error('OUTLAYER_ENCRYPTED_RESPONSE_INVALID');
      return body.output;
    },
  };
}
