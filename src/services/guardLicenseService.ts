import SequelizeRepository from '../database/repositories/sequelizeRepository';
import GuardLicenseRepository from '../database/repositories/guardLicenseRepository';

class GuardLicenseService {
  options: any;

  constructor(options) {
    this.options = options;
  }

  async create(data) {
    const transaction = await SequelizeRepository.createTransaction(this.options.database);
    try {
      const record = await GuardLicenseRepository.create(data, this.options);
      await SequelizeRepository.commitTransaction(transaction);
      return record;
    } catch (err) {
      await SequelizeRepository.rollbackTransaction(transaction);
      throw err;
    }
  }

  async update(id, data) {
    const transaction = await SequelizeRepository.createTransaction(this.options.database);
    try {
      const record = await GuardLicenseRepository.update(id, data, this.options);
      await SequelizeRepository.commitTransaction(transaction);
      return record;
    } catch (err) {
      await SequelizeRepository.rollbackTransaction(transaction);
      throw err;
    }
  }

  async destroyAll(ids) {
    const transaction = await SequelizeRepository.createTransaction(this.options.database);
    try {
      await GuardLicenseRepository.destroyAll(ids, this.options);
      await SequelizeRepository.commitTransaction(transaction);
    } catch (err) {
      await SequelizeRepository.rollbackTransaction(transaction);
      throw err;
    }
  }

  async findById(id) {
    return GuardLicenseRepository.findById(id, this.options);
  }

  async findAndCountAll(params) {
    return GuardLicenseRepository.findAndCountAll(params, this.options);
  }

  async exportToFile(id, format = 'pdf') {
    const record = await this.findById(id);

    if (!record) {
      throw new Error('Not found');
    }

    if (format === 'pdf') {
      return this._generatePDF(record);
    }

    throw new Error('Formato no soportado');
  }

  async _generatePDF(record) {
    const PDFDocument = require('pdfkit');
    const http = require('http');
    const https = require('https');

    const fetchBuffer = (url) => new Promise((resolve) => {
      try {
        const client = url.startsWith('https') ? https : http;
        client.get(url, (res) => {
          const chunks: any[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks)));
        }).on('error', () => resolve(null));
      } catch (e) {
        resolve(null);
      }
    });

    return new Promise(async (resolve, reject) => {
      try {
        const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
        const chunks: Buffer[] = [];
        doc.on('data', (c) => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));

        // Header
        doc.fontSize(18).font('Helvetica-Bold').text('License Report', { align: 'center' });
        doc.moveDown(0.5);

        // Basic fields
        doc.fontSize(10).font('Helvetica');
        const addRow = (label, value) => {
          doc.font('Helvetica-Bold').text(`${label}: `, { continued: true }).font('Helvetica').text(value || '-');
        };

        addRow('Tipo', record.licenseType?.name || record.customName || '-');
        addRow('Número', record.number || '-');
        addRow('Emitido', record.issueDate ? new Date(record.issueDate).toLocaleDateString() : '-');
        addRow('Vence', record.expiryDate ? new Date(record.expiryDate).toLocaleDateString() : '-');
        addRow('Añadido por', record.createdBy?.fullName || record.createdBy?.email || '-');

        doc.moveDown(0.5);

        // Images - front
        doc.font('Helvetica-Bold').text('Imagen frontal:');
        if (record.frontImage && record.frontImage.length) {
          const f = record.frontImage[0];
          const url = f.privateUrl || f.publicUrl || null;
          if (url) {
            const buf = await fetchBuffer(url);
            if (buf) {
              try {
                doc.image(buf, { fit: [420, 300], align: 'center' });
              } catch (e) {
                doc.font('Helvetica').text('No se pudo renderizar la imagen.');
              }
            } else {
              doc.font('Helvetica').text('Imagen no disponible para descargar.');
            }
          } else {
            doc.font('Helvetica').text('Sin imagen.');
          }
        } else {
          doc.font('Helvetica').text('-');
        }

        doc.moveDown(0.5);

        // Images - back
        doc.font('Helvetica-Bold').text('Imagen trasera:');
        if (record.backImage && record.backImage.length) {
          const f = record.backImage[0];
          const url = f.privateUrl || f.publicUrl || null;
          if (url) {
            const buf = await fetchBuffer(url);
            if (buf) {
              try {
                doc.image(buf, { fit: [420, 300], align: 'center' });
              } catch (e) {
                doc.font('Helvetica').text('No se pudo renderizar la imagen.');
              }
            } else {
              doc.font('Helvetica').text('Imagen no disponible para descargar.');
            }
          } else {
            doc.font('Helvetica').text('Sin imagen.');
          }
        } else {
          doc.font('Helvetica').text('-');
        }

        doc.end();
      } catch (err) {
        reject(err);
      }
    });
  }
}

export default GuardLicenseService;
