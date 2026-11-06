// App Runner sends responses as they leave the app, with no CDN in front to compress them.
import { brotliCompressSync, constants } from 'node:zlib';

export function acceptsBrotli(header: string | string[] | undefined): boolean {
  const value = Array.isArray(header) ? header.join(',') : (header ?? '');
  return value.split(',').some((part) => {
    const [coding, ...params] = part.toLowerCase().split(';').map((piece) => piece.trim());
    if (coding !== 'br') return false;
    const weight = params.find((param) => param.startsWith('q='));
    return weight === undefined || Number(weight.slice(2)) > 0;
  });
}

export function brotli(body: string | Uint8Array, quality: number): Buffer {
  return brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: quality } });
}
