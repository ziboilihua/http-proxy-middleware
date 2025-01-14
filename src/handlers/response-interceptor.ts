import type * as http from 'http';
import * as zlib from 'zlib';
import { Debug } from '../debug';
import { getFunctionName } from '../utils/function';

const debug = Debug.extend('response-interceptor');

type Interceptor = (
  buffer: Buffer,
  proxyRes: http.IncomingMessage,
  req: http.IncomingMessage,
  res: http.ServerResponse
) => Promise<Buffer | string>;

/**
 * Disallow headers when response contains trailer
 * source: https://developer.mozilla.org/docs/Web/HTTP/Headers/Trailer
 */
const TrailerDisallowHeaders: string[] = [
  'content-length',
  'host',
  'content-type',
  'authorization',
  'cache-control',
  'max-forwards',
  'te',
  'set-cookie',
  'content-encoding',
  'content-range',
];

/**
 * Intercept responses from upstream.
 * Automatically decompress (deflate, gzip, brotli).
 * Give developer the opportunity to modify intercepted Buffer and http.ServerResponse
 *
 * NOTE: must set options.selfHandleResponse=true (prevent automatic call of res.end())
 */
export function responseInterceptor(interceptor: Interceptor) {
  return async function proxyResResponseInterceptor(
    proxyRes: http.IncomingMessage,
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    debug('intercept proxy response');
    const originalProxyRes = proxyRes;
    let buffer = Buffer.from('', 'utf8');

    // decompress proxy response
    const _proxyRes = decompress(proxyRes, proxyRes.headers['content-encoding']);

    // concat data stream
    _proxyRes.on('data', (chunk) => (buffer = Buffer.concat([buffer, chunk])));

    _proxyRes.on('end', async () => {
      // copy original headers
      copyHeaders(proxyRes, res);

      // call interceptor with intercepted response (buffer)
      debug('call interceptor function: %s', getFunctionName(interceptor));
      const interceptedBuffer = Buffer.from(await interceptor(buffer, originalProxyRes, req, res));

      // set correct content-length (with double byte character support)
      debug('set content-length: %s', Buffer.byteLength(interceptedBuffer, 'utf8'));
      // some headers are disallowed when response headers contains trailer
      if (proxyRes.headers.trailer === undefined) {
        res.setHeader('content-length', Buffer.byteLength(interceptedBuffer, 'utf8'));
      } else {
        TrailerDisallowHeaders.forEach((value) => {
          res.removeHeader(value);
        });
      }
      debug('write intercepted response');
      res.write(interceptedBuffer);
      res.end();
    });

    _proxyRes.on('error', (error) => {
      res.end(`Error fetching proxied request: ${error.message}`);
    });
  };
}

/**
 * Streaming decompression of proxy response
 * source: https://github.com/apache/superset/blob/9773aba522e957ed9423045ca153219638a85d2f/superset-frontend/webpack.proxy-config.js#L116
 */
function decompress(proxyRes: http.IncomingMessage, contentEncoding: string) {
  let _proxyRes = proxyRes;
  let decompress;

  switch (contentEncoding) {
    case 'gzip':
      decompress = zlib.createGunzip();
      break;
    case 'br':
      decompress = zlib.createBrotliDecompress();
      break;
    case 'deflate':
      decompress = zlib.createInflate();
      break;
    default:
      break;
  }

  if (decompress) {
    debug(`decompress proxy response with 'content-encoding': %s`, contentEncoding);
    _proxyRes.pipe(decompress);
    _proxyRes = decompress;
  }

  return _proxyRes;
}

/**
 * Copy original headers
 * https://github.com/apache/superset/blob/9773aba522e957ed9423045ca153219638a85d2f/superset-frontend/webpack.proxy-config.js#L78
 */
function copyHeaders(originalResponse, response) {
  debug('copy original response headers');

  response.statusCode = originalResponse.statusCode;
  response.statusMessage = originalResponse.statusMessage;

  if (response.setHeader) {
    let keys = Object.keys(originalResponse.headers);

    // ignore chunked, brotli, gzip, deflate headers
    keys = keys.filter((key) => !['content-encoding', 'transfer-encoding'].includes(key));

    keys.forEach((key) => {
      let value = originalResponse.headers[key];

      if (key === 'set-cookie') {
        // remove cookie domain
        value = Array.isArray(value) ? value : [value];
        value = value.map((x) => x.replace(/Domain=[^;]+?/i, ''));
      }

      response.setHeader(key, value);
    });
  } else {
    response.headers = originalResponse.headers;
  }
}
