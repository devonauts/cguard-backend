import path from 'path';
import fs from 'fs';
import os from 'os';
import jwt from 'jsonwebtoken';
import { getConfig } from '../../config';
import mv from 'mv';
import Error403 from '../../errors/Error403';

/**
 * The directory where the files should be uploaded.
 * Now set to a persistent 'uploads' folder in the project root.
 */
const UPLOAD_DIR = path.resolve(__dirname, '../../../uploads');

// Crea la carpeta uploads si no existe al iniciar el módulo
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

export default class LocalFileStorage {
  /**
   * Creates a signed upload URL that enables
   * the frontend to upload directly to the server in a
   * secure way.
   */
  static async uploadCredentials(
    privateUrl,
    maxSizeInBytes,
    publicRead,
    tokenExpiresAt,
    baseUrl?: string,
  ) {
    const expires =
      tokenExpiresAt || Date.now() + 10 * 60 * 1000;

    const token = jwt.sign(
      { privateUrl, maxSizeInBytes },
      getConfig().AUTH_JWT_SECRET,
      { expiresIn: expires },
    );

    const backendUrl = baseUrl || getConfig().BACKEND_URL;

    return {
      url: `${backendUrl}/file/upload?token=${token}`,
    };
  }

  /**
   * Handles the upload to the server.
   */
  static async upload(fileTempUrl, privateUrl) {
    const internalUrl = path.join(UPLOAD_DIR, privateUrl);
    if (!isPathInsideUploadDir(internalUrl)) {
      throw new Error403();
    }
    ensureDirectoryExistence(internalUrl);
    return new Promise((resolve, reject) => {
      mv(fileTempUrl, internalUrl, (err) => {
        if (err) {
          reject(err);
          return;
        }

        return this.downloadUrl(privateUrl)
          .then(resolve)
          .catch(reject);
      });
    });
  }

  /**
   * Return the download URL of the file from this server.
   */
  static async downloadUrl(privateUrl, baseUrl?: string) {
    const backendUrl = (baseUrl || getConfig().BACKEND_URL).replace(/\/+$|^\s+|\s+$/g, '');
    const downloadPath = backendUrl.endsWith('/api')
      ? '/file/download'
      : '/api/file/download';
    return `${backendUrl}${downloadPath}?privateUrl=${encodeURIComponent(privateUrl)}`;
  }

  /**
   * Downloads the file.
   */
  static async download(privateUrl) {
    let finalPath = path.join(UPLOAD_DIR, privateUrl);
    if (!isPathInsideUploadDir(finalPath)) {
      throw new Error403();
    }
    return finalPath;
  }

  /**
   * Delete a file from local storage
   */
  static async delete(privateUrl) {
    const finalPath = path.join(UPLOAD_DIR, privateUrl);
    if (!fs.existsSync(finalPath)) return true;
    if (!isPathInsideUploadDir(finalPath)) {
      throw new Error403();
    }
    return new Promise((resolve, reject) => {
      fs.unlink(finalPath, (err) => {
        if (err) return reject(err);
        resolve(true);
      });
    });
  }
}

function ensureDirectoryExistence(filePath: string): boolean {
  var dirname = path.dirname(filePath);

  if (fs.existsSync(dirname)) {
    return true;
  }

  ensureDirectoryExistence(dirname);
  fs.mkdirSync(dirname);
  return true;
}

function isPathInsideUploadDir(privateUrl) {
  const uploadUrlWithSlash = UPLOAD_DIR.endsWith(path.sep) ? UPLOAD_DIR : `${UPLOAD_DIR}${path.sep}`;
  return privateUrl.indexOf(uploadUrlWithSlash) === 0;
}