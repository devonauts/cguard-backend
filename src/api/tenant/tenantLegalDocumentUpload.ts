/** @openapi { "summary": "Upload tenant legal document", "description": "Upload a legal document file for a tenant. Uses multipart/form-data with a single `file` field.", "requestBody": { "content": { "multipart/form-data": { "schema": { "type": "object", "properties": { "file": { "type": "string", "format": "binary" }, "name": { "type": "string" } }, "required": ["file"] } } } }, "responses": { "200": { "description": "Uploaded file metadata" }, "400": { "description": "Validation error" }, "403": { "description": "Forbidden" } } } */

import formidable from 'formidable-serverless';
import ApiResponseHandler from '../apiResponseHandler';
import Error403 from '../../errors/Error403';
import FileRepository from '../../database/repositories/fileRepository';
import TenantRepository from '../../database/repositories/tenantRepository';

// POST /tenant/:tenantId/legal-documents/upload
export default async function uploadLegalDocument(req, res) {
  try {
    const { tenantId } = req.params;
    if (!req.currentUser || !tenantId) {
      throw new Error403(req.language);
    }

    // Verifica que el usuario tenga permisos sobre el tenant
    const tenant = await TenantRepository.findById(tenantId, {
      currentUser: req.currentUser,
      database: req.database,
      language: req.language,
      currentTenant: { id: tenantId },
    });
    if (!tenant) throw new Error403(req.language);

    // Procesa el archivo con formidable
    const form = new formidable.IncomingForm();
    form.parse(req, async (err, fields, files) => {
      if (err) return ApiResponseHandler.error(req, res, err);
      const file = files.file;
      if (!file) return ApiResponseHandler.error(req, res, new Error('Archivo no encontrado'));

      // Guarda el archivo usando FileRepository
      const fileRecord = await FileRepository.createLegalDocument({
        file,
        tenantId,
        uploadedBy: req.currentUser.id,
        name: file.name,
        sizeInBytes: file.size,
        mimeType: file.type,
        database: req.database,
      });

      ApiResponseHandler.success(req, res, fileRecord);
    });
  } catch (error) {
    ApiResponseHandler.error(req, res, error);
  }
}
