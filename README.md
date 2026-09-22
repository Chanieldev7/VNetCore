# VNetCore

Aplicacion web estatica para documentar equipos, puertos y conexiones de una infraestructura de red. Funciona sin backend ni dependencias de produccion.

## Ejecutar

Abre el proyecto mediante un servidor HTTP local; no se recomienda abrir `index.html` directamente con `file://`.

```powershell
npx --yes serve .
```

Luego visita la URL indicada por el comando.

## Datos y respaldos

- Los datos se guardan localmente en el navegador bajo `vnetcore.project.v9`.
- Antes de cada escritura se conserva la version anterior en `vnetcore.project.v9.backup`.
- La aplicacion migra automaticamente los datos existentes de `vnetcore.project.v7` y `vnetcore.project.v8`.
- Un error de lectura nunca reemplaza automaticamente los datos originales.
- JSON es el formato recomendado para respaldos completos.
- CSV v9 conserva proyectos, dispositivos sin puertos, disposiciones e identificadores estables.
- Las importaciones se validan y muestran un resumen antes de reemplazar el proyecto.
- Cada archivo importado puede tener como maximo 5 MB, 500 dispositivos y 512 puertos por dispositivo.

No guardes contrasenas, claves privadas o tokens. Consulta `SECURITY.md` para las consideraciones de privacidad y despliegue.

## Funciones

- Edicion, duplicado, eliminacion y reordenamiento de dispositivos.
- Ajuste de cantidades de puertos LAN y WAN sin recrear el equipo.
- Busqueda por equipo, ubicacion, VLAN, direccion, conexion o notas.
- Historial de deshacer para los ultimos diez cambios estructurados.
- Indicador visible del estado de guardado y exportacion de emergencia.
- Importacion y exportacion JSON/CSV versionada.
- Informe PDF tabular con todos los campos de cada puerto.
- Navegacion por teclado, controles ARIA y movimiento reducido.
- Panel lateral colapsable y diseno adaptable.

## Formatos

El JSON contiene `schemaVersion`, metadatos del proyecto y una lista de dispositivos con IDs estables. El CSV usa registros `PROJECT`, `DEVICE` y `PORT`; tambien se admite la importacion del CSV plano generado por la version anterior.

Los valores CSV que podrian interpretarse como formulas de hoja de calculo se neutralizan anteponiendo una comilla simple.

## Calidad

Requiere Node.js 18 o posterior solamente para verificaciones de desarrollo:

```powershell
npm test
```

Las pruebas cubren normalizacion, validacion, migraciones, CSV reversible, CSV heredado y proteccion contra formulas.

## Despliegue

Publica el directorio como sitio estatico bajo HTTPS y en un origen dedicado. `netlify.toml` incluye cabeceras seguras para Netlify; configura sus equivalentes si utilizas otro proveedor.

Navegadores objetivo: versiones actuales de Chrome, Edge, Firefox y Safari con soporte para `dialog`, módulos web basicos y `localStorage`.
