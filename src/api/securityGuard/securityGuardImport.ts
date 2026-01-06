import PermissionChecker from '../../services/user/permissionChecker';
import ApiResponseHandler from '../apiResponseHandler';
import Permissions from '../../security/permissions';
import SecurityGuardService from '../../services/securityGuardService';
import crypto from 'crypto';

export default async (req, res, next) => {
  try {
    new PermissionChecker(req).validateHas(
      Permissions.values.securityGuardImport,
    );

    const importHash = req.body.importHash || crypto.randomBytes(8).toString('hex');
    if (!req.body.importHash) {
      console.log('🔔 [securityGuardImport] generated importHash:', importHash);
    }

    // If the client sent FormData, `data` may arrive as a JSON string.
    let data: any = req.body.data;

    // If a file was uploaded (CSV), parse it into an array of objects
    const files = (req as any).files;
    const csvFile = files && files.length ? files.find((f) => f.mimetype && f.mimetype.includes('csv') || (f.originalname && f.originalname.toLowerCase().endsWith('.csv'))) : null;
    if (csvFile && csvFile.buffer) {
      try {
        const csv = csvFile.buffer.toString('utf8');
        const parseLine = (line: string) => {
          const result: string[] = [];
          let cur = '';
          let inQuotes = false;
          for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (ch === '"') {
              if (inQuotes && line[i + 1] === '"') {
                cur += '"';
                i++;
              } else {
                inQuotes = !inQuotes;
              }
            } else if (ch === ',' && !inQuotes) {
              result.push(cur);
              cur = '';
            } else {
              cur += ch;
            }
          }
          result.push(cur);
          return result.map((s) => s.trim());
        };

        const lines = csv.split(/\r?\n/).filter((l) => l.trim() !== '');
        if (lines.length > 0) {
          const headers = parseLine(lines.shift() || '');

          const normalizeHeader = (h: string) => h.toLowerCase().replace(/\s+/g, '').replace(/\./g, '').normalize('NFD').replace(/\p{Diacritic}/gu, '');

          const mapHeaderToKey: any = {
            nombre: 'fullName',
            correo: 'email',
            telefono: 'phoneNumber',
            estado: 'status',
            cedula: 'governmentId',
            fechacontrato: 'hiringContractDate',
            genero: 'gender',
            tiposangre: 'bloodType',
            credenciales: 'guardCredentials',
            fechanac: 'birthDate',
            lugarnac: 'birthPlace',
            estadociv: 'maritalStatus',
            educacion: 'academicInstruction',
            direccion: 'address',
            dni: 'governmentId',
            cedulaidentidad: 'governmentId',
          };

          const keys = headers.map((h) => mapHeaderToKey[normalizeHeader(h)] || normalizeHeader(h));

          const rows: any[] = [];

          const parseDateToISO = (value: string) => {
            if (!value) return null;
            const raw = String(value).trim();
            if (!raw) return null;

            // Try ISO or parseable format first
            const direct = new Date(raw);
            if (!isNaN(direct.getTime())) {
              return direct.toISOString().slice(0, 10);
            }

            // Handle dd/mm/yyyy or d/m/yyyy or dd-mm-yyyy
            const m = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
            if (m) {
              let day = parseInt(m[1], 10);
              let month = parseInt(m[2], 10);
              let year = parseInt(m[3], 10);
              if (year < 100) {
                year += year > 50 ? 1900 : 2000;
              }
              // Basic range checks
              if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
                const mm = String(month).padStart(2, '0');
                const dd = String(day).padStart(2, '0');
                return `${year}-${mm}-${dd}`;
              }
            }

            return null;
          };

          for (const line of lines) {
            const vals = parseLine(line);
            const obj: any = {};
            for (let i = 0; i < keys.length; i++) {
              if (!keys[i]) continue;
              let v = vals[i] !== undefined ? vals[i] : null;
              if (v === '') v = null;

              // Normalize date-like fields
              if (v && (keys[i] === 'hiringContractDate' || keys[i] === 'birthDate')) {
                const iso = parseDateToISO(v);
                v = iso || v;
              }

              obj[keys[i]] = v;
            }
            rows.push(obj);
          }

          data = rows;
          console.log('🔔 [securityGuardImport] parsed CSV rows:', rows.length);
        }
      } catch (e) {
        console.warn('⚠️ [securityGuardImport] error parsing CSV file:', e && (e as any).message ? (e as any).message : e);
      }
    }

    // If data is a JSON string, attempt parse
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch (e) {
        // leave as string if not JSON
      }
    }

    await new SecurityGuardService(req).import(
      data,
      importHash,
    );

    const payload = true;

    await ApiResponseHandler.success(req, res, payload);
  } catch (error) {
    await ApiResponseHandler.error(req, res, error);
  }
};
