# cguard-backend

Este proyecto es el backend para la plataforma CGuard, desarrollado en Node.js y TypeScript.

## Requisitos previos

- **Node.js**: versión recomendada 18.x o superior
- **npm**: versión recomendada 9.x o superior

## Instalación

1. Clona el repositorio:
   ```sh
   git clone https://github.com/devonauts/cguard-backend.git
   ```
2. Ingresa al directorio del proyecto:
   ```sh
   cd cguard-backend
   ```
3. Instala las dependencias:
   ```sh
   npm install
   ```


## Ejecución

Para iniciar el servidor en modo desarrollo:
```sh
npm start
```

Para compilar el proyecto TypeScript y copiar la documentación:
```sh
npm run build
```


## Scripts útiles

- `npm start`: Ejecuta el servidor en modo desarrollo usando nodemon y ts-node
- `npm run build`: Compila el código TypeScript y copia la documentación
- `npm test`: Ejecuta los tests con mocha
- `npm run db:create`: Ejecuta migraciones de base de datos
- `npm run stripe:login`: Inicia sesión en Stripe CLI
- `npm run stripe:start`: Inicia Stripe webhook listener

## Estructura del proyecto

- `src/`: Código fuente principal
- `config/`: Archivos de configuración
- `database/`: Conexión y modelos de base de datos
- `services/`: Lógica de negocio y servicios
- `middlewares/`: Middlewares personalizados
- `errors/`: Manejo de errores
- `i18n/`: Internacionalización
- `documentation/`: Documentación OpenAPI

## Variables de entorno

Crea un archivo `.env` en la raíz del proyecto y configura las variables necesarias, por ejemplo:
```
PORT=3000
DATABASE_URL=...
JWT_SECRET=...
```

## Documentación

La documentación de la API se encuentra en `documentation/openapi.json`.

## Licencia

Este proyecto está bajo la licencia MIT.
