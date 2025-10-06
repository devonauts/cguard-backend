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

### Desarrollo

Para iniciar el servidor en modo desarrollo:
```sh
npm run dev
```

### Producción

Para compilar y ejecutar en producción:
```sh
npm run build
npm start
```

## Scripts útiles

- `npm run dev`: Ejecuta el servidor con hot reload (usando nodemon o ts-node-dev)
- `npm run build`: Compila el código TypeScript a JavaScript
- `npm start`: Ejecuta el servidor compilado

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
