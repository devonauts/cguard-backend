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

  form.maxFileSize = Number(maxSizeInBytes);

  form.parse(req, function (err, fields, files): void {
    const filename = String(fields.filename);
    const fileTempUrl = files.file.path;

    if (!filename) {
      fs.unlinkSync(fileTempUrl);
      ApiResponseHandler.error(
        req,
        res,
        new Error(`File not found`),
      );
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
        ApiResponseHandler.error(req, res, error);
      });
  });

  form.on('error', function (error) {
    return ApiResponseHandler.error(req, res, error);
  });
  
  return;
};
