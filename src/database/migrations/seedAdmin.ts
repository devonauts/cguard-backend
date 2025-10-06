/**
 * Seeder para crear un usuario administrador en la base de datos.
 * Ejecuta este archivo con: npx ts-node src/database/migrations/seedAdmin.ts
 */
require('dotenv').config();

import models from '../models';
import bcrypt from 'bcryptjs';

async function seedAdmin() {
    const db = models();
    await db.sequelize.sync();

    const adminEmail = 'admin@cguard.com';
    const adminPassword = 'admin123'; // Cambia esta contraseña después de crear el usuario


    // Verifica si ya existe un usuario admin
    const existing = await db.user.findOne({ where: { email: adminEmail } });
    if (existing) {
        console.log('El usuario administrador ya existe.');
        process.exit(0);
    }

    // Busca o crea un tenant genérico
    let tenant = await db.tenant.findOne({ where: { name: 'Empresa Admin' } });
    if (!tenant) {
        tenant = await db.tenant.create({
            name: 'Empresa Admin',
            url: 'admin',
            plan: 'free',
            planStatus: 'active',
        });
    }

    // Crea el usuario admin
    const adminUser = await db.user.create({
        email: adminEmail,
        password: bcrypt.hashSync(adminPassword, 8),
        fullName: 'Administrador',
        emailVerified: true,
    });

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

seedAdmin().catch((err) => {
    console.error(err);
    process.exit(1);
});
