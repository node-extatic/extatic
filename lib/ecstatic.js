#! /usr/bin/env node

'use strict';

const path = require('path');
const fs = require('fs');
const url = require('url');
const mime = require('./ecstatic/mime');
const urlJoin = require('url-join');
const showDir = require('./ecstatic/show-dir');
const version = require('../package.json').version;
const status = require('./ecstatic/status-handlers');
const generateEtag = require('./ecstatic/etag');
const optsParser = require('./ecstatic/opts');
const onFinished = require('on-finished');

let ecstatic = null;

// See: https://github.com/jesusabdullah/node-ecstatic/issues/109
function decodePathname(pathname) {
  const pieces = pathname.replace(/\\/g, '/').split('/');

  return path.normalize(pieces.map((rawPiece) => {
    const piece = decodeURIComponent(rawPiece);

    if (process.platform === 'win32' && /\\/.test(piece)) {
      throw new Error('Invalid forward slash character');
    }

    return piece;
  }).join('/')).replace(/\\/g, '/');
}


// Check to see if we should try to compress a file with gzip.
function shouldCompressGzip(req) {
  const headers = req.headers;

  return headers && headers['accept-encoding'] &&
    headers['accept-encoding']
      .split(',')
      .some(el => ['*', 'compress', 'gzip', 'deflate'].indexOf(el.trim()) !== -1)
  ;
}

function shouldCompressBrotli(req) {
  const headers = req.headers;

  return headers && headers['accept-encoding'] &&
    headers['accept-encoding']
      .split(',')
      .some(el => ['*', 'br'].indexOf(el.trim()) !== -1)
  ;
}

function hasGzipId12(gzipped, cb) {
  const stream = fs.createReadStream(gzipped, { start: 0, end: 1 });
  let buffer = Buffer.from('');
  let hasBeenCalled = false;

  stream.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk], 2);
  });

  stream.on('error', (err) => {
    if (hasBeenCalled) {
      throw err;
    }

    hasBeenCalled = true;
    cb(err);
  });

  stream.on('close', () => {
    if (hasBeenCalled) {
      return;
    }

    hasBeenCalled = true;
    cb(null, buffer[0] === 31 && buffer[1] === 139);
  });
}


module.exports = function createMiddleware(_dir, _options) {
  let dir;
  let options;

  if (typeof _dir === 'string') {
    dir = _dir;
    options = _options;
  } else {
    options = _dir;
    dir = options.root;
  }

  const root = path.join(path.resolve(dir), '/');
  const opts = optsParser(options);
  const cache = opts.cache;
  const autoIndex = opts.autoIndex;
  const baseDir = opts.baseDir;
  let defaultExt = opts.defaultExt;
  const handleError = opts.handleError;
  const headers = opts.headers;
  const serverHeader = opts.serverHeader;
  const weakEtags = opts.weakEtags;
  const handleOptionsMethod = opts.handleOptionsMethod;

  opts.root = dir;
  if (defaultExt && /^\./.test(defaultExt)) {
    defaultExt = defaultExt.replace(/^\./, '');
  }

  if (opts.mimeTypes) {
    try {
      // You can pass a JSON blob here---useful for CLI use
      opts.mimeTypes = JSON.parse(opts.mimeTypes);
    } catch (e) {
      // swallow parse errors, treat this as a string mimetype input
    }
    if (typeof opts.mimeTypes === 'object') {
      mime.define(opts.mimeTypes);
    }
    if (typeof opts.mimeTypes === 'function') {
      mime.setCustomGetType(opts.mimeTypes);
    }
  }

  function shouldReturn304(req, serverLastModified, serverEtag) {
    if (!req || !req.headers) {
      return false;
    }

    const clientModifiedSince = req.headers['if-modified-since'];
    const clientEtag = req.headers['if-none-match'];
    let clientModifiedDate;

    if (!clientModifiedSince && !clientEtag) {
      // Client did not provide any conditional caching headers
      return false;
    }

    if (clientModifiedSince) {
      // Catch "illegal access" dates that will crash v8
      // https://github.com/jfhbrook/node-ecstatic/pull/179
      try {
        clientModifiedDate = new Date(Date.parse(clientModifiedSince));
      } catch (err) {
        return false;
      }

      if (clientModifiedDate.toString() === 'Invalid Date') {
        return false;
      }
      // If the client's copy is older than the server's, don't return 304
      if (clientModifiedDate < new Date(serverLastModified)) {
        return false;
      }
    }

    if (clientEtag) {
      // Do a strong or weak etag comparison based on setting
      // https://www.ietf.org/rfc/rfc2616.txt Section 13.3.3
      if (opts.weakCompare && clientEtag !== serverEtag
        && clientEtag !== `W/${serverEtag}` && `W/${clientEtag}` !== serverEtag) {
        return false;
      } else if (!opts.weakCompare && (clientEtag !== serverEtag || clientEtag.indexOf('W/') === 0)) {
        return false;
      }
    }

    return true;
  }

  return function middleware(req, res, next) {
    // Figure out the path for the file from the given url
    const parsed = url.parse(req.url);
    let pathname = null;
    let file = null;
    let gzippedFile = null;
    let brotliFile = null;

    // Strip any null bytes from the url
    // This was at one point necessary because of an old bug in url.parse
    //
    // See: https://github.com/jfhbrook/node-ecstatic/issues/16#issuecomment-3039914
    // See: https://github.com/jfhbrook/node-ecstatic/commit/43f7e72a31524f88f47e367c3cc3af710e67c9f4
    //
    // But this opens up a regex dos attack vector! D:
    //
    // Based on some research (ie asking #node-dev if this is still an issue),
    // it's *probably* not an issue. :)
    /*
    while (req.url.indexOf('%00') !== -1) {
      req.url = req.url.replace(/\%00/g, '');
    }
    */

    try {
      decodeURIComponent(req.url); // check validity of url
      pathname = decodePathname(parsed.pathname);
    } catch (err) {
      status[400](res, next, { error: err });
      return;
    }

    file = path.normalize(
      path.join(
        root,
        path.relative(path.join('/', baseDir), pathname)
      )
    );
    // determine compressed forms if they were to exist
    gzippedFile = `${file}.gz`;
    brotliFile = `${file}.br`;

    if (serverHeader !== false) {
      // Set common headers.
      res.setHeader('server', `ecstatic-${version}`);
    }

    Object.keys(headers).forEach((key) => {
      res.setHeader(key, headers[key]);
    });

    if (req.method === 'OPTIONS' && handleOptionsMethod) {
      res.end();
      return;
    }

    // TODO: This check is broken, which causes the 403 on the
    // expected 404.
    if (file.slice(0, root.length) !== root) {
      status[403](res, next);
      return;
    }

    if (req.method && (req.method !== 'GET' && req.method !== 'HEAD')) {
      status[405](res, next);
      return;
    }


    function serve(stat) {
      if (onFinished.isFinished(res)) {
        return;
      }

      // Do a MIME lookup, fall back to octet-stream and handle gzip
      // and brotli special case.
      const defaultType = opts.contentType || 'application/octet-stream';

      let contentType = mime.getType(file, defaultType);
      let charSet;
      const range = (req.headers && req.headers.range);
      const lastModified = (new Date(stat.mtime)).toUTCString();
      const etag = generateEtag(stat, weakEtags);
      let cacheControl = cache;
      if (contentType) {
        charSet = mime.lookupCharset(contentType);
        if (charSet) {
          contentType += `; charset=${charSet}`;
        }
      }

      if (file === gzippedFile) { // is .gz picked up
        res.setHeader('Content-Encoding', 'gzip');
        // strip gz ending and lookup mime type
        contentType = mime.getType(path.basename(file, '.gz'), defaultType);
      } else if (file === brotliFile) { // is .br picked up
        res.setHeader('Content-Encoding', 'br');
        // strip br ending and lookup mime type
        contentType = mime.getType(path.basename(file, '.br'), defaultType);
      }

      if (typeof cacheControl === 'function') {
        cacheControl = cache(pathname);
      }
      if (typeof cacheControl === 'number') {
        cacheControl = `max-age=${cacheControl}`;
      }

      if (range) {
        const total = stat.size;
        const parts = range.trim().replace(/bytes=/, '').split('-');
        const partialstart = parts[0];
        const partialend = parts[1];
        const start = parseInt(partialstart, 10);
        const end = Math.min(
          total - 1,
          partialend ? parseInt(partialend, 10) : total - 1
        );
        const chunksize = (end - start) + 1;

        if (start > end || isNaN(start) || isNaN(end)) {
          status['416'](res, next);
          return;
        }

        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunksize,
          'Content-Type': contentType,
          'cache-control': cacheControl,
          'last-modified': lastModified,
          etag,
        });

        const stream = fs
          .createReadStream(file, { start, end })
          .on('error', (err) => {
            status['500'](res, next, { error: err });
          })
          .pipe(res);
        onFinished(res, () => {
          stream.destroy();
        });
        return;
      }

      // TODO: Helper for this, with default headers.
      res.setHeader('cache-control', cacheControl);
      res.setHeader('last-modified', lastModified);
      res.setHeader('etag', etag);

      // Return a 304 if necessary
      if (shouldReturn304(req, lastModified, etag)) {
        status[304](res, next);
        return;
      }

      res.setHeader('content-length', stat.size);
      res.setHeader('content-type', contentType);

      // set the response statusCode if we have a request statusCode.
      // This only can happen if we have a 404 with some kind of 404.html
      // In all other cases where we have a file we serve the 200
      res.statusCode = req.statusCode || 200;

      if (req.method === 'HEAD') {
        res.end();
        return;
      }

      const stream = fs
        .createReadStream(file)
        .on('error', (err) => {
          status['500'](res, next, { error: err });
        })
        .pipe(res);
      onFinished(res, () => {
        stream.destroy();
      });
      res.on('close', () => {
        stream.destroy();
      });
    }


    function statFile() {
      fs.stat(file, (err, stat) => {
        if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
          if (req.statusCode === 404) {
            // This means we're already trying ./404.html and can not find it.
            // So send plain text response with 404 status code
            status[404](res, next);
          } else if (!path.extname(parsed.pathname).length && defaultExt) {
            // If there is no file extension in the path and we have a default
            // extension try filename and default extension combination before rendering 404.html.
            middleware({
              url: `${parsed.pathname}.${defaultExt}${(parsed.search) ? parsed.search : ''}`,
              headers: req.headers,
            }, res, next);
          } else {
            // Try to serve default ./404.html
            middleware({
              url: (handleError ? `/${path.join(baseDir, `404.${defaultExt}`)}` : req.url),
              headers: req.headers,
              statusCode: 404,
            }, res, next);
          }
        } else if (err) {
          status[500](res, next, { error: err });
        } else if (stat.isDirectory()) {
          if (!autoIndex && !opts.showDir) {
            status[404](res, next);
            return;
          }


          // 302 to / if necessary
          if (!pathname.match(/\/$/)) {
            res.statusCode = 302;
            const q = parsed.query ? `?${parsed.query}` : '';
            res.setHeader('location', `${parsed.pathname}/${q}`);
            res.end();
            return;
          }

          if (autoIndex) {
            middleware({
              url: urlJoin(
                encodeURIComponent(pathname),
                `/index.${defaultExt}`
              ),
              headers: req.headers,
            }, res, (autoIndexError) => {
              if (autoIndexError) {
                status[500](res, next, { error: autoIndexError });
                return;
              }
              if (opts.showDir) {
                showDir(opts, stat)(req, res);
                return;
              }

              status[403](res, next);
            });
            return;
          }

          if (opts.showDir) {
            showDir(opts, stat)(req, res);
          }
        } else {
          serve(stat);
        }
      });
    }

    // serve gzip file if exists and is valid
    function tryServeWithGzip() {
      fs.stat(gzippedFile, (err, stat) => {
        if (!err && stat.isFile()) {
          hasGzipId12(gzippedFile, (gzipErr, isGzip) => {
            if (!gzipErr && isGzip) {
              file = gzippedFile;
              serve(stat);
            } else {
              statFile();
            }
          });
        } else {
          statFile();
        }
      });
    }

    // serve brotli file if exists, otherwise try gzip
    function tryServeWithBrotli(shouldTryGzip) {
      fs.stat(brotliFile, (err, stat) => {
        if (!err && stat.isFile()) {
          file = brotliFile;
          serve(stat);
        } else if (shouldTryGzip) {
          tryServeWithGzip();
        } else {
          statFile();
        }
      });
    }

    const shouldTryBrotli = opts.brotli && shouldCompressBrotli(req);
    const shouldTryGzip = opts.gzip && shouldCompressGzip(req);
    // always try brotli first, next try gzip, finally serve without compression
    if (shouldTryBrotli) {
      tryServeWithBrotli(shouldTryGzip);
    } else if (shouldTryGzip) {
      tryServeWithGzip();
    } else {
      statFile();
    }
  };
};


ecstatic = module.exports;
ecstatic.version = version;
ecstatic.showDir = showDir;
ecstatic.mime = mime;
