/**
 * Seeder para crear un usuario administrador en la base de datos.
 * Ejecuta este archivo con: npx ts-node src/database/migrations/seedAdmin.ts
 */
require('dotenv').config();

import models from '../models';
import bcrypt from 'bcryptjs';

async function seedAdmin() {
    const db = models();
    // Do not call `sync()` here — migrations should handle schema creation.
    // Calling `sync()` can attempt to modify existing tables (add primary keys)
    // which causes errors in partially-migrated DBs. Rely on migrations instead.

    const adminEmail = 'demo1@cguardpro.com';
    const adminPassword = 'Admindemo1234@'; // Cambia esta contraseña después de crear el usuario


    // Verifica si ya existe un usuario admin
    const existing = await db.user.findOne({ where: { email: adminEmail }, attributes: ['id', 'email'] });
    if (existing) {
        console.log('El usuario administrador ya existe.');
        process.exit(0);
    }

    // Busca o crea un tenant genérico
    let tenant = await db.tenant.findOne({ where: { name: 'Empresa Demo' } });
    if (!tenant) {
        const tenantDefaults = {
            name: 'Empresa Demo',
            url: 'demo',
            plan: 'free',
            planStatus: 'active',
            // Campos obligatorios en el modelo Tenant — puede sobreescribir vía ENV
            address: process.env.SEED_TENANT_ADDRESS || 'Sin dirección',
            phone: process.env.SEED_TENANT_PHONE || '+0000000000',
            email: process.env.SEED_TENANT_CONTACT_EMAIL || 'demo-admin-tenant@cguard.com',
            taxNumber: process.env.SEED_TENANT_TAX_NUMBER || 'N/A',
            businessTitle: process.env.SEED_TENANT_BUSINESS_TITLE || 'Empresa Demo',
        };

        tenant = await db.tenant.create(tenantDefaults);
    }

    // Crea el usuario admin — pasar explícitamente sólo los campos deseados
    const adminData = {
        email: adminEmail,
        password: bcrypt.hashSync(adminPassword, 8),
        fullName: 'demo',
        emailVerified: true,
    };

    const adminUser = await db.user.create(adminData, { fields: Object.keys(adminData) });

    // Asocia el usuario al tenant con rol admin
    await db.tenantUser.create({
        userId: adminUser.id,
        tenantId: tenant.id,
        roles: ['admin'],
        status: 'active',
    });

    console.log('Usuario administrador creado y asociado al tenant con rol admin:');
    console.log('Email:', adminEmail);
    console.log('Password:', adminPassword);
    process.exit(0);
}

seedAdmin().catch((err: any) => {
    const e: any = err;
    const code = e && e.original && e.original.code;
    if (code === 'ER_MULTIPLE_PRI_KEY') {
        console.warn('Ignored ER_MULTIPLE_PRI_KEY during seedAdmin:', e && e.original && e.original.sqlMessage ? e.original.sqlMessage : e.message || e);
        process.exit(0);
    }
    console.error(e);
    process.exit(1);
});
