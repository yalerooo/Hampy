# Hampy — Registro de cambios y tareas pendientes

Documento de referencia para desarrolladores. Registra las mejoras planificadas
ordenadas **de dentro hacia afuera** (núcleo → persistencia → protocolo → IPC →
frontera TS → store → UI), con estado, capa afectada y archivos involucrados.

---

## Cómo usar este documento

- **Estado:** `✅ Hecho` · `🔲 Pendiente` · `🚧 En progreso`
- Cada tarea incluye los archivos que hay que tocar y una nota técnica breve.
- Antes de empezar una tarea, marcarla `🚧 En progreso` y añadir la fecha.
- Al completarla, moverla a `✅ Hecho` con fecha y un resumen del cambio.

---

## Capa 1 — `hampy-core` (modelos de dominio)

### ✅ `Folder` definida en el modelo de dominio
**Archivo:** `crates/core/src/model.rs`
`Folder { id: Uuid, name: String, parent_id: Option<Uuid> }` ya existe como
tipo de dominio. No requiere cambios en esta capa — la entidad es correcta.

### 🔲 Emitir `SessionStatus::Reconnecting` desde los crates de protocolo
**Archivos:** `crates/ssh/src/client.rs`, `crates/rdp/src/lib.rs`, `crates/vnc/src/lib.rs`
El enum `SessionStatus` ya incluye `Reconnecting` y `Failed` pero ningún crate
los publica al `EventBus` cuando cae la conexión. El bus simplemente cierra el
canal. Añadir lógica de retry con backoff exponencial y publicar los cambios de
estado para que el UI pueda mostrar el indicador de reconexión.

---

## Capa 2 — `hampy-settings` (persistencia)

### ✅ Carpeta de logs creada automáticamente en primer arranque
**Archivo:** `crates/settings/src/paths.rs:29`
`AppPaths::resolve()` llama a `std::fs::create_dir_all` sobre `config_dir`,
`data_dir` y `log_dir` antes de que `logging::init()` sea invocado. El directorio
de logs existe garantizadamente en el dispositivo desde el primer arranque, en las
rutas estándar por OS:
- **Windows:** `%APPDATA%\Hampy\data\logs\`
- **macOS:** `~/Library/Application Support/dev.Hampy.Hampy/data/logs/`
- **Linux:** `~/.local/share/hampy/logs/`

El log rota diariamente con nombre `hampy.log.YYYY-MM-DD` (via `tracing-appender`).
Variable de entorno `VOLTAIC_LOG` controla el nivel (default: `info`).

### ✅ Persistir carpetas en SQLite (2026-06-23)
**Archivos:** `crates/settings/src/store.rs`, `crates/settings/src/lib.rs`
`FolderRecord { name, color }` añadido como struct serializable. 4 métodos
implementados: `upsert_folder`, `list_folders`, `delete_folder`, `rename_folder`.
`rename_folder` actualiza además la columna indexada y el campo `$.folder_id` del
payload JSON de cada sesión relacionada con `json_set`. 3 tests cubren el ciclo
completo incluyendo la propagación del rename a sesiones.

### ✅ Persistir colores de carpeta en SQLite (2026-06-23)
**Archivos:** `crates/settings/src/store.rs`, migración v2
Columna `color TEXT` añadida via migración v2 (`ALTER TABLE folders ADD COLUMN color TEXT`).
Sistema de migraciones basado en `user_version` pragma — la migración se aplica
automáticamente al primer arranque con la versión actualizada.

---

## Capa 3 — Crates de protocolo

### 🔲 `machine_telemetry` solo funciona en hosts Linux
**Archivo:** `app/src-tauri/src/commands.rs` (~línea 913)
La probe PROBE lee `/proc/meminfo`, `/proc/stat` y `df -kP /` — solo disponibles
en Linux. En macOS/BSD remotos retorna silenciosamente valores a cero sin error
visible. Añadir un probe alternativo con `vm_stat` y `sysctl` para macOS, con
detección automática via `uname`.

### 🔲 Cola de transferencias paralelas en SFTP
**Archivos:** `crates/sftp/src/lib.rs`, `app/src-tauri/src/commands.rs`
Actualmente `sftp_download` y `sftp_upload` son secuenciales: bloquean la sesión
hasta completar. Implementar una cola de transferencias con concurrencia limitada
(e.g. 4 simultáneas) y progreso agregado.

---

## Capa 4 — Tauri shell (`commands.rs` / `state.rs`)

### ✅ Exponer comandos IPC para carpetas (2026-06-23)
**Archivo:** `app/src-tauri/src/commands.rs`, `app/src-tauri/src/lib.rs`
4 comandos Tauri registrados: `list_folders`, `save_folder`, `delete_folder`,
`rename_folder`. Todos delegan en los métodos de `Store` via `AppState`.

### 🔲 Reemplazar broadcast global por canales punto-a-punto (Tauri `Channel`)
**Archivo:** `app/src-tauri/src/commands.rs`, `app/src/lib/ipc.ts`
El evento `hampy://terminal-output` es un broadcast global: con N pestañas
abiertas, cada chunk llega a N listeners y N-1 lo descartan. Tauri 2 provee
`tauri::ipc::Channel` — un canal point-to-point que el frontend crea y pasa como
parámetro al comando. Aplicar primero a `open_terminal`, luego a `open_ssh`.

---

## Capa 5 — Frontera IPC (`ipc.ts` / `types.ts`)

### 🔲 Auto-generar `types.ts` desde structs Rust con `ts-rs`
**Archivos:** todos los crates de protocolo, `app/src/lib/types.ts`
`types.ts` es una copia manual de los structs Rust. Si se añade un campo en
`RdpConfig` en Rust y se olvida actualizar TypeScript, la app compila pero falla
en runtime. Con `#[derive(TS)]` de `ts-rs`, cada `cargo build` regenera los tipos
automáticamente. Si el tipo Rust cambia y el frontend lo usa mal, TypeScript falla
la compilación.

### ✅ Añadir bindings de carpetas en `ipc.ts` (2026-06-23)
**Archivos:** `app/src/lib/ipc.ts`, `app/src/lib/types.ts`
`FolderRecord` añadido a `types.ts`. 4 bindings tipados en `ipc.ts`:
`listFolders`, `saveFolder`, `deleteFolder`, `renameFolder`.

---

## Capa 6 — Store (`appStore.ts`)

### ✅ Eliminar estado de carpetas de `localStorage` (2026-06-23)
**Archivo:** `app/src/components/Sidebar.tsx`
`FOLDERS_KEY`, `COLORS_KEY`, `loadExtraFolders`, `saveExtraFolders`,
`loadFolderColors`, `saveFolderColors` eliminados. Estado `extraFolders: string[]`
+ `folderColors: Record<string,string>` reemplazado por `folderRecords: FolderRecord[]`.
`refreshFolders` carga desde IPC en mount y tras cada mutación. Las 3 líneas de
`localStorage` restantes (para `WIDTH_KEY` de ancho del sidebar) son correctas y
se mantienen.

### 🔲 Arreglar `tabSeq` contra hot-reload de Vite
**Archivo:** `app/src/store/appStore.ts:13`
`let tabSeq = 0` se resetea en cada HMR. En desarrollo puede generar colisiones
de IDs de pestaña tras recargas parciales. Reemplazar por un valor inicializado
desde `Date.now()` o usar `crypto.randomUUID()` directamente para los IDs de tab.

---

## Capa 7 — Componentes UI

### ✅ Reemplazar `window.prompt()` por modales inline (2026-06-23)
**Archivo:** `app/src/components/Sidebar.tsx`
Estado `newFolderDraft: string | null` controla visibilidad del input. Cuando es
`!= null` se muestra un input inline con las mismas clases CSS del rename de carpetas
(`sb-folder__row--editing`, `sb-folder__edit`). Enter confirma, Escape cancela, blur
confirma. El estado `newFolderMoveSession` permite que "Move to new folder" reutilice
el mismo input y mueva la sesión tras crear la carpeta.

### 🔲 Corregir bitmask de protocolos en el fallback `<ComingSoon>`
**Archivo:** `app/src/App.tsx` (líneas 81–91)
La lista de exclusiones para el fallback `ComingSoon` se actualiza manualmente con
cada nuevo protocolo. Si alguien añade `mosh` al backend y olvida añadirlo aquí,
aparecerá como "Coming Soon". Invertir la lógica:
```typescript
const IMPLEMENTED_PROTOCOLS = new Set([
  "ssh", "sftp", "serial", "rdp", "vnc", "ftp", "docker", "kubernetes", "local_shell"
]);
// ...
{tab.kind === "session" && !IMPLEMENTED_PROTOCOLS.has(tab.protocol ?? "") && (
  <ComingSoon protocol={tab.protocol} />
)}
```

### 🔲 Reemplazar drag & drop manual por `@dnd-kit`
**Archivo:** `app/src/components/Sidebar.tsx` (líneas 514–573)
El drag de sesiones está implementado a mano con ~80 líneas de pointer events
porque HTML5 DnD no funciona bien dentro de WebView2. Funciona, pero es frágil
ante cambios de layout. `@dnd-kit/core` usa el mismo modelo de pointer events
internamente pero con soporte de accesibilidad y detección de colisiones robusta.

---

## Historial de cambios completados

### Cambio 1 — Carpetas migradas de localStorage a SQLite (2026-06-23)
Migración completa de 6 capas. Los datos de carpetas ahora sobreviven a limpiezas
de WebView, son accesibles desde múltiples ventanas, y `rename_folder` propaga el
cambio a todas las sesiones en una sola operación atómica SQL.

**Archivos tocados:**
- `crates/settings/src/store.rs` — `FolderRecord`, migraciones v1+v2, 4 métodos, 3 tests
- `crates/settings/src/lib.rs` — re-export de `FolderRecord`
- `app/src-tauri/src/commands.rs` — 4 comandos `#[tauri::command]`
- `app/src-tauri/src/lib.rs` — registro en `invoke_handler!`
- `app/src/lib/types.ts` — interfaz `FolderRecord`
- `app/src/lib/ipc.ts` — 4 bindings tipados
- `app/src/components/Sidebar.tsx` — eliminar localStorage, estado `folderRecords`