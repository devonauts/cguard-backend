/**
 * Seeder para crear un usuario superadmin en la base de datos.
 * Ejecuta este archivo con: npx ts-node src/database/migrations/seedSuperadmin.ts
 */
require('dotenv').config();

import models from '../models';
import bcrypt from 'bcryptjs';

async function seedSuperadmin() {
    const db = models();

    const email = process.env.SUPERADMIN_EMAIL || 'superadmin@cguard.com';
    const password = process.env.SUPERADMIN_PASSWORD || 'SuperAdmin123!'; // Cambia después

    // Verifica si ya existe (seleccionando sólo campos básicos)
    const existing = await db.user.findOne({ where: { email }, attributes: ['id', 'email'] });
    if (existing) {
        console.log('El usuario superadmin ya existe.');
        process.exit(0);
    }

    // Busca o crea un tenant genérico (idempotente)
    const tenantDefaults = {
        name: 'Empresa Admin',
        url: 'admin',
        plan: 'free',
        planStatus: 'active',
        address: process.env.SEED_TENANT_ADDRESS || 'Sin dirección',
        phone: process.env.SEED_TENANT_PHONE || '+0000000000',
        email: process.env.SEED_TENANT_CONTACT_EMAIL || 'admin-tenant@cguard.com',
        taxNumber: process.env.SEED_TENANT_TAX_NUMBER || 'N/A',
        businessTitle: process.env.SEED_TENANT_BUSINESS_TITLE || 'Empresa Admin',
    };

    // Intentar buscar por `url` (clave única) primero, si no existe usar findOrCreate
    let tenant = await db.tenant.findOne({ where: { url: tenantDefaults.url } });
    if (!tenant) {
        const [t, created] = await db.tenant.findOrCreate({ where: { url: tenantDefaults.url }, defaults: tenantDefaults });
        tenant = t;
    }

    // Crea el usuario superadmin. Si la columna `isSuperadmin` aún no existe
    // en la BD, intentamos un fallback sin ese campo para no romper seeds.
    let superUser;
    try {
        superUser = await db.user.create({
            email,
            password: bcrypt.hashSync(password, 8),
            fullName: 'Super Administrator',
            emailVerified: true,
            isSuperadmin: true,
        });
    } catch (err) {
        const e: any = err;
        console.warn('Warning: could not set isSuperadmin during create, retrying without that field:', e && e.message ? e.message : String(e));
        superUser = await db.user.create({
            email,
            password: bcrypt.hashSync(password, 8),
            fullName: 'Super Administrator',
            emailVerified: true,
        });
    }

    // Nota: no asociamos este usuario a ningún tenant — será una cuenta
    // de plataforma (global). Dependiendo de tu configuración, algunas
    // partes del frontend esperan `superadmin` en el perfil (tenant-scoped)
    // para otorgar privilegios. Si tras ejecutar el seed el usuario no
    // ve privilegios de superadmin, ejecuta manualmente la creación de un
    // `tenantUser` con rol `superadmin` para que el backend lo promocione
    // a superadmin global al iniciar sesión (o usa la API de administración).

    console.log('Usuario superadmin creado (sin asociación a tenant):');
    console.log('Email:', email);
    console.log('Password:', password);
    process.exit(0);
}

seedSuperadmin().catch((err) => {
    const e: any = err;
    const code = e && e.original && e.original.code;
    if (code === 'ER_MULTIPLE_PRI_KEY') {
        console.warn('Ignored ER_MULTIPLE_PRI_KEY during seedSuperadmin:', e && e.original && e.original.sqlMessage ? e.original.sqlMessage : e.message || e);
        process.exit(0);
    }
    console.error(e);
    process.exit(1);
});
