/** @openapi { "summary": "Local file upload (signed token)", "description": "Upload a file to local storage using a signed `token` query param. Expects multipart/form-data with `file` and optional `filename` fields.", "requestBody": { "content": { "multipart/form-data": { "schema": { "type": "object", "properties": { "file": { "type": "string", "format": "binary" }, "filename": { "type": "string" } }, "required": ["file"] } } } }, "responses": { "200": { "description": "Upload result (downloadUrl)" }, "400": { "description": "Upload error" }, "403": { "description": "Forbidden" } } } */

import formidable from 'formidable-serverless';
import fs from 'fs';
import ApiResponseHandler from '../../apiResponseHandler';
import Error403 from '../../../errors/Error403';
import jwt from 'jsonwebtoken';
import { getConfig } from '../../../config';
import FileStorage from '../../../services/file/fileStorage';

/**
 * Uploads a file to the localhost.
 */
export default function upload(req, res): void {
  if (!req.query.token) {
    ApiResponseHandler.error(
      req,
      res,
      new Error403(),
    );
    return;
  }

  let storage: {
    privateUrl: string;
    maxSizeInBytes: number;
  };

  try {
    const decoded = jwt.verify(
      req.query.token as string,
      getConfig().AUTH_JWT_SECRET,
    );
    storage = decoded as {
      privateUrl: string;
      maxSizeInBytes: number;
    };
  } catch (error) {
    console.error(error);
    ApiResponseHandler.error(
      req,
      res,
      new Error403(),
    );
    return;
  }

  let { privateUrl, maxSizeInBytes } = storage;

  const form = new formidable.IncomingForm();

  // The signed token carries the storage config's max size; fall back to the
  // largest configured storage cap so a malformed token never means "no limit"
  // (Number(undefined) is NaN, which disables formidable's size check).
  form.maxFileSize =
    Number(maxSizeInBytes) > 0
      ? Number(maxSizeInBytes)
      : 100 * 1024 * 1024;

  form.parse(req, function (err, fields, files): void {
    // This callback runs inside formidable's event emitter, OUTSIDE Express's
    // try/catch — anything thrown here is an uncaughtException that kills the
    // whole PM2 instance. Every path must respond (or bail) and never throw.
    try {
      const uploaded = files && files.file;
      const fileTempUrl = uploaded && uploaded.path;

      // Best-effort cleanup so failed/aborted uploads never leak formidable
      // temp files onto the single prod disk (success path is `mv`ed away by
      // FileStorage.upload).
      const cleanupTemp = () => {
        if (fileTempUrl) {
          fs.promises.unlink(fileTempUrl).catch(() => undefined);
        }
      };

      // formidable invokes the callback with err on client abort, parser
      // errors, and maxFileSize exceeded — with `files` still empty. The
      // separate form.on('error') below may already have responded.
      if (err) {
        cleanupTemp();
        if (!res.headersSent) {
          const tooLarge = /maxFileSize/i.test(String(err.message || ''));
          res.status(tooLarge ? 413 : 400).json({
            message: tooLarge
              ? 'File too large'
              : 'Upload failed',
            code: tooLarge ? 413 : 400,
          });
        }
        return;
      }

      // Well-formed multipart body without a `file` part.
      if (!uploaded || !fileTempUrl) {
        if (!res.headersSent) {
          res.status(400).json({
            message: 'File not found',
            code: 400,
          });
        }
        return;
      }

      if (res.headersSent) {
        cleanupTemp();
        return;
      }

      FileStorage.upload(fileTempUrl, privateUrl)
        .then((downloadUrl) => {
          ApiResponseHandler.success(
            req,
            res,
            downloadUrl,
          );
        })
        .catch((error) => {
          cleanupTemp();
          ApiResponseHandler.error(req, res, error);
        });
    } catch (error) {
      // Last-resort: never let an exception escape into the event emitter.
      console.error('file/upload handler error:', error);
      try {
        if (!res.headersSent) {
          res.status(400).json({
            message: 'Upload failed',
            code: 400,
          });
        }
      } catch {
        /* nothing left to do */
      }
    }
  });

  // Fallback: parse errors normally respond via the callback above (its internal
  // error listener runs first); this only fires if that path somehow didn't.
  // These are client-side failures (abort/malformed multipart) → 400, not 500.
  form.on('error', function (error) {
    if (res.headersSent) {
      return;
    }
    res.status(400).json({
      message: 'Upload failed',
      code: 400,
    });
  });

  return;
};
