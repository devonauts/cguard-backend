# Auditoría de consistencia de datos — 2026-07-18

5 agentes en paralelo buscando la clase de bug "páginas que se contradicen porque leen
fuentes de verdad distintas (pivote legado, recomputación client-side, vivo-vs-asignado)
+ UI muerta/fabricada". Disparador: cliente demo mostraba guardias fantasma en Sedes,
"Sin asignar" en cobertura con 2 asignados, y Personal asignado correcto.

Total: 85 hallazgos confirmados (todos verificados leyendo el código, con file:line).
Ya corregidos el mismo día, antes de la auditoría: sedes/operation pivote muerto,
cobertura "sin marcar", personnel assignmentId, DST en el grid del Horario.

Prioridad sugerida:
- P0 (fabrican datos falsos hoy): §Backend 1-5, §Equipo 1-5, §Scheduling 1, §Cliente 1-4.
- P1 (inconsistencias visibles): resto de §Scheduling, §Cliente, fechas/timezone (§Backend 15-20).
- P2 (UI muerta/fabricada): §Dashboards 1-2 y todos los "dead UI".

---

## 1) BACKEND — fuentes de verdad (20 hallazgos)

Agente: backend completo. Referencias correctas: clientAccountOperation.ts:48-68 (guardAssignment) y scheduleCoverageService.ts.

A. Pivote legado stationAssignedGuardsUser / station.assignedGuards:
1. ESCRITOR + sin guardAssignment: securityGuardCreate.ts:639-645,672-678 — crear vigilante con stationIds escribe SOLO el pivote (via StationService.update assignedGuards) y NUNCA crea guardAssignment. Fabrica de fantasmas. Fix: usar createAssignment (como postSiteAssignGuard.ts:137).
2. ESCRITOR: stationRepository.ts:56,208 (via stationService.ts:29,74) — station.create/update llama setAssignedGuards. Fix: eliminar (y assignedGuardsIds del audit log :680).
3. GATE duro worker: guard/guardMeOrders.ts:24-32 y guardMeOrderComplete.ts:27-31 — consignas solo si el guardia esta en el pivote; guardAssignment-only no ve/completa consignas. Fix: resolver por guardAssignment activo.
4. guard/guardMe.ts:39-53 — dashboard worker "stations assigned" + geofence + clockInStationIds fallback (:201) solo pivote.
5. server.ts:418-423 — push de consignas vencidas ruteado por pivote (llega a guardias stale o a nadie).
6. stationRepository.ts:731-786,811-905 — _fillForList/_fillWithRelations: assignedGuards/Count del pivote y guardsCount = pivote UNION guardias de TODOS los shifts de la historia (sin ventana). Lista/detalle Puestos del CRM contradice el roster real.
7. visitorLogRepository.ts:489-511 (+127-148) — ACL de control de visitas por pivote: filtra/filtra-de-mas.
8. guardPerformanceService.ts:761-773 — score de consignas cuenta "due" solo en estaciones del pivote (100% inmerecido para guardias nuevos).
9. Lectores fallback menores: radioCheckService.ts:59,89,166,564-572; guardMeTasks.ts:38-46; guardMeTeam.ts:48-59; guardMeRondaSettings.ts:39-51; guardMeIncidentCreate.ts:39-52; guardMeQuiz.ts:21-33 (quiz sole-source). Nota: clientProject.assignedGuards es columna JSON, NO el pivote.

B. Formulas de cobertura divergentes:
10. clientAccountGuardsCount.ts:25-63 y clientAccountGuards.ts:25-56 — "guardias del cliente" desde tenant_user_client_accounts (pivote de acceso app cliente). Fix: guardAssignment o retirar.
11. clientAccountReportActions.ts:71-79 — CSV cobertura: Requeridos = suma de TODOS los fijos del dia vs marcados AHORA (24h siempre "Parcial"). Fix: coversNow como clientAccountCoverage.ts:259-267.
12. postSiteCoverageGaps.ts:107-254 — 1 shift = cobertura total (ignora guardsNeeded/halfCounts) + ventana casera + mezcla UTC/local. Fix: computeCoverage/stationReqFromPositions.
13. clientAccountContract.ts:114-134,215 — derived.guardsCount = quienes marcaron este mes (tercera definicion de "guardias" en la misma pagina). Fix: renombrar o guardAssignment.
14. Menor: aiSchedulingService.ts:213 hardcodea 24h?2:1; customerAccountMe.ts:142,164 manda numberOfGuardsInStation como verdad.

C. Bugs de calendario (regla: ymd(now, tenantTz), nunca UTC/local floor):
15. postSiteAssignGuard.ts:108,134 — startDate = hoy UTC (asignar >19:00 local = empieza manana).
16. schedulingEndpoints.ts:273,459-460,855,885 — endDate al remover, ventana default del grid, startDates rotacion: hoy UTC.
17. supervisor/helpers.ts:14-21 — todayDateStr() UTC vs dayKeyFor() local del server: dia y weekday divergen.
18. routeRun/index.ts:31,52 — run completado 20:00 local queda fechado manana.
19. guard/guardMe.ts:24-25 — ventana shiftsToday con midnight local del SERVER.
20. Menor: supervisorPosition/index.ts:130; lib/opsDigest.ts:17-18.

## 2) CLIENTE — detalle (14 hallazgos)

1. KPI "Vigilantes asignados" (clientAccountOverview.ts:75-98 + ClientsLayout.tsx:99) = guardias distintos sobre TODOS los shifts de la historia (y acepta tenantId null). El tab /staff usa guardAssignment. Fix: guardAssignment activo.
2. KPI "En turno ahora" (overview:100-125) = shifts PROGRAMADOS que contienen now, no marcaciones. Inverso del bug "Sin asignar". Fix: guardShift abiertos o renombrar "Turnos programados ahora".
3. KPI "Rondas (7 dias)" (overview:131-152) cuenta siteTourTag (definiciones de QR) por createdAt y duplica postSiteId+siteTourId; Reports usa tagScan bien. Fix: tagScan sesiones 7d.
4. clientAccountIncidents.ts:24-60 — 2 queries referencian stations.clientAccountId (columna inexistente) -> SIEMPRE caen al fallback stationOriginId-only: overview "Sin actividad"/0 incidentes mientras el tab Incidentes lista muchos. Fix: Op.or stationOriginId + postSiteId in sites (como el board :60-70).
5. ClientOverview.tsx:51,78-81 — "Estado de sedes" cuenta incidentes dentro de los ultimos 8 y matchea por NOMBRE de sede. Fix: agregado real por postSiteId.
6. KPI "Horas (7 dias)" = horas PROGRAMADAS (overview:100-129); staff usa guardShift.hoursWorked. Fix: horas reales o renombrar.
7. KPI "Estaciones" (overview:47-50) excluye estaciones sueltas stationOriginId que todos los demas incluyen.
8. ClientPostSites.tsx:74-87 — "Cobertura" de Sedes = asignados/estaciones (required=stations.length, ignora guardsNeeded); el tab Cobertura es vivo-por-marcacion. Mismo nombre, dos formulas. Fix: reutilizar endpoint coverage o renombrar "Asignacion".
9. ClientPortal.tsx:47-48 — client.portalUsers NO EXISTE en backend: "Usuarios con acceso" siempre titular-only; Accesos muestra el roster real. Fix: getClientAccessUsers. (mismo campo muerto en ClientEmailReports.tsx:14 y PostsiteIncidents/Incidents.tsx:411)
10. clientAccountGuards/GuardsCount — pivote de acceso app como roster de guardias; /guards ni siquiera registrado; sin llamadores. Fix: borrar o reescribir.
11. ClientContract.tsx:212-219 — "Documentos del contrato" EmptyState hardcodeado, nunca consulta. Fix: getClientDocuments(category Contratos).
12. ClientCoverage.tsx:461 — "Ver calendario" navega a /scheduler (no existe); la ruta es /schedule. Fix: cambiar.
13. ClientPostSites.tsx:262-270 — paginador falso (disabled fijo, pagina "1"); :82 codigo SDE-001 fabricado por indice. Fix: quitar.
14. KPI "Sedes activas" (overview:42-45) cuenta inactivas tambien. Fix: filtrar active o renombrar.
Menores: overview acepta tenantId null en shifts/incidentes; vocabulario vivo en tarjetas por-asignacion; filtro rol "Operador" que el endpoint nunca produce; "de 100 GB" hardcodeado; componentes muertos ClientEmailReports/ClientFiles/ClientProfile + import ClientTabPlaceholder sin uso.

## 3) EQUIPO / NOMINA (13 hallazgos)

1. securityGuardCreate.ts:633-651,666-684 — crear vigilante con stationIds escribe SOLO pivote muerto, sin guardAssignment (confirma Backend#1). Aparece "asignado" en lectores de pivote pero NO en Horario/estacion/personal; Vigilantes lista muestra "Ninguna".
2. Lectores restantes del pivote (lista verificada, coincide con Backend#A) — destacado: guardPerformanceService (factor rondas del KPI del guardia) y StationOverview.tsx:160,389 + StationCardsGrid.tsx:50 (conteos de tarjetas de estacion).
3. SecurityGuardsPage.tsx:332-351 + GuardCardsGrid.tsx:66-67 — columna "Asignacion" desde /shift?limit=1000 global sin fecha, primer station visto por guardia; truncamiento => "Ninguna" falsos. Fix: batch guardAssignment (endpoint card-meta).
4. GuardOverviewPage.tsx:108 assignedSitesCount ?? 1 (campo inexistente => SIEMPRE "1 sitio"); GuardSummarypage.tsx:87-105 8 tarjetas con campos que el backend nunca devuelve (0s permanentes), comparativo hardcodeado 0%, DateRangePicker sin fetch, numero de guardia fabricado '100447' (:169), fecha fabricada 'Oct 07, 2025' (:179), boton Filter sin onClick (:280). GuardKPIspage.tsx:427-433 computa lo real. Fix: borrar o cablear Resumen.
5. GuardAsignarSitiosPage.tsx:91,327,707 — lista y BORRA shifts pero asigna via guardAssignment: el delete no des-asigna (scheduler/estacion siguen mostrando al guardia). Fix: DELETE guard-assignment.
6. GuardAsignarSitiosPage.tsx:254-256 — fila semilla fabricada 'Jose Pasante' visible durante carga/error. Fix: [].
7. GuardAsignarSitiosPage.tsx:494-499 — buscador con value='' onChange vacio. Muerto.
8. SecurityGuardsPage.tsx:362-366 + securityGuardRepository.ts:961-1263 — filtros categoria/cliente/puesto se envian pero el repo NO los maneja; Habilidades/Departamento sin opciones; boton "Filtro" solo cierra; "Limpiar" salta a activos. Fix: implementar o quitar.
9. GuardSkillsPage.tsx:89-96,33-41 — habilidades demo hardcodeadas, estado local no persistido, fetch duplicado.
10. GuardFilesPage.tsx:252-258 — Upload solo agrega a estado local (DocumentUpload del editor si sube de verdad).
11. GuardRemindersPage.tsx:126-144,435 — recordatorios solo en memoria; Apply = TODO.
12. AdminOfficeUsersPage.tsx:604-611 — filtro Sectores muerto (solo "Todas", nunca referenciado).
13. SecurityGuardsPage.tsx:133 — sin status: isOnDuty=false => "Pendiente" (confunde turno con activacion de cuenta).
Limpios: Supervisores (isOnDuty real de supervisorShift), toda Nomina, tabs Licencias/Notas/Memos/Dispositivo/Disponibilidad/Departamento.

## 4) SCHEDULING (17 hallazgos)

1. timeOffRequestService.ts:54-78 — APROBAR time-off NO toca el horario (ni override V ni borra shifts); Horario sigue pintando D/N, cobertura lo cuenta, worker ve el turno. Fix: al aprobar, upsert overrides V por dia (misma propagacion de scheduleOverrideCreate).
2. Schedule.tsx:420-453,1601-1650 — el Mes pinta matematica de rotacion, no shifts reales: borras el turno del dia (clic derecho) y el Mes sigue mostrando D mientras Dia/Semana (shifts) muestran nada. Fix: pintar desde shiftByGuardDate primero, rotacion como fallback.
3. isWorkDay ignora assignment.startDate/endDate — asignacion temporal "hasta el 31" pintada todo el ano; futura pintada hoy. Fix: 'rest' fuera de vigencia.
4. StationShifts.tsx:147-181,294-301 — 24h: ambos fijos comparten bloque 07-19 => UNA jornada "Diurno"; noches invisibles, "Cobertura completa 1/1" mientras Programador reporta gap. Fix: 24h emite Diurno+Nocturno siempre.
5. schedulingEndpoints.ts:583-601 — stationAlerts backend usa assignment.rotationStyle (SIEMPRE null por diseno) => todo 'work', sfUncoveredDays siempre 0; el fallback correcto del frontend es codigo muerto. Fix: resolver rotacion por station + SF desde shifts reales.
6. Novedades D/N/24 cosmeticas — Schedule.tsx pinta trabajo pero el backend no crea shift (schedulingEndpoints.ts:963-967): Mes dice D, Dia/cobertura/worker dicen nada. Fix: crear shift ad-hoc o estilo "novedad sin turno".
7. Schedule.tsx:695-711 — el guard del drop SF bloquea por rotacion aunque el shift del dia fue BORRADO (contradice su propio mensaje "elimina el turno y luego arrastra"). Fix: dia sin shift = libre.
8. Copys de SF prometen auto-cobertura que el manual-SF ya no genera: SacafrancoAssignModal.tsx:107,125; ShiftAssignModal.tsx:189; StationGuards.tsx:328. Fix: actualizar textos.
9. Dos formulas de "sacafrancos necesarios": staffing usa 6-1 (schedulingEndpoints.ts:539-553), optimizador 4-4-2 (shiftGenerationService.ts:928-969). Sidebar dice 3, optimizar crea 2. Fix: mismo planner/rotacion.
10. StationShifts.tsx:54-59 — dateKey en tz del NAVEGADOR mientras clasifica horas en tenant tz; contradice Programador y su propio roster. Fix: Intl en tenant tz.
11. StationRoster.tsx:51-56 y SacafrancoAssignModal.tsx:42-47 — tiras 14d con setHours(0,0,0,0)+i*86400000+toISOString: corridas un dia al este de UTC / DST. Fix: generar keys con formatter tenant-tz.
12. StationGuards.tsx:103,48-70 — SF global mostrado "descansa" cuando cubre OTRA estacion (fetch solo shifts locales). Fix: shifts por guardId tenant-wide para isRelief.
13. ShiftStatus.tsx:43-74 — estado por reloj (no-show = "Completado"); "Cancelado" = pasado sin guardia; formatDate browser-tz + formatTime tenant-tz (mismo par en OpenShifts.tsx:44-61, ShiftExchange.tsx:53). Fix: join asistencia + renombrar + timeZone.
14. Menus Exportar muertos en 4 paginas: ShiftStatus:314-327, OpenShifts:326-339, TimeOff:421-431, ShiftExchange:369-379 (+checkbox/expander inertes).
15. TimeOff.tsx:51-58 — DATEONLY parseado como UTC => vacaciones listadas un dia antes en UTC-5. Fix: s+'T00:00:00'.
16. Epoch de rotacion definido 3 formas en backend: shiftGenerationService.ts:79-82 local, assignmentService.ts:184 UTC, rephase schedulingEndpoints.ts:339-344 local+floor. Solo coinciden en server UTC sin DST. Fix: Date.UTC(2024,0,1) + diff UTC en todos (rephase incluido).
17. StationOverview.tsx:262-268 — "Fijos requeridos" mapa hardcodeado por scheduleType (no posiciones reales); numberOfGuardsInStation solo se sincroniza en custom. Fix: derivar de /station/:id/positions.

## 5) DASHBOARDS / MONITOREO / REPORTES (21 hallazgos)

1. PostsiteChecklists/Checklists.tsx:20-23,63-100 — pagina FALSA: guardias demo (Juan Perez/Maria Lopez), CRUD local con toasts de exito, nada persiste. Ruta viva /post-sites/:id/checklists. Fix: cablear o quitar.
2. PostsiteFiles/Files.tsx:25,178-184 — fecha fabricada (hoy) y addedBy 'System' en filas reales; Upload no sube (estado local); buscador no filtra; Action->Delete solo cambia el label. Fix: file service real o quitar ruta.
3. DispatcherPage.tsx:195-213 — lista sin limit/offset, totalCount = filas de la primera pagina; incidentes mas alla inaccesibles y "1-N de N" miente. Fix: paginacion server + count del API.
4. PostSiteKPIs.tsx:332-342 — "Actual" bucketea por stationId pero busca por postSite.id => siempre 0/"Not Achieved". Fix: bucket por postSiteId.
5. PostSiteKPIs.tsx:554-568,653-656 — mismo Actual copiado a todos los tipos; targets diario/semanal vs actual mensual.
6. PostsiteOverview/Overview.tsx:249-315 — "Ultima actividad" EmptyState incondicional con sheet de filtros de 26 checkboxes que no hace nada. Fix: alimentar de /events o quitar.
7. Overview.tsx:84-170 — fallback nunca setea assignedCount => "Vigilantes asignados 0" con guardias asignados.
8. reports-config.ts:92-93 + Reports.tsx:172-181 — badges "0/0" abiertos/cerrados hardcodeados en la tarjeta de incidentes.
9. ControlCenter.tsx:36,69-70 — selector Hoy/7d/30d/12m NO alimenta nada (solo highlight). Fix: threading a useControlCenter o quitar.
10. useControlCenter.ts:58,116 — "Incidentes abiertos" filtrado client-side entre los ultimos 50.
11. ControlCenter.tsx:37-48 + demoData.ts:117,145-162 — modo Demo persistente (localStorage cc_demo), KPIs fabricados deep-linkean a paginas reales, alerta de panico FALSA en el feed. Fix: watermark DEMO + no persistir.
12. navigation.ts:14 + App.tsx:557 — "Puestos activos" navega a /post-sites que redirige a /clients (numero y destino no cuadran).
13. useControlCenter.ts:117-120 + navigation.ts:15 — KPI "Supervisores" cuenta operationsmanager+dispatcher y enlaza a /back-office (no /supervisors).
14. Overview.tsx:104-121,207 — "ultimos 7 dias" cubre tarjetas point-in-time y horas PROGRAMADAS futuras.
15. Overview.tsx:124-135,164 — "Recorridos completados" = tags creados (proxy); tareas completadas por updatedAt.
16. StationOverview.tsx:94,270-272 — "De turno ahora"/"Marcaciones hoy" limitados por fetch de 15 filas.
17. Reports/Incident.tsx:51-52 — filtro de fechas con bordes UTC (ventana corrida 5h). Fix: local como DataReport.ymd.
18. ReportPageShell.tsx:180-188,22-49 — paginador falso "25 por pagina" con chevrons siempre disabled; DefaultFilters sin funcion.
19. reports-config.ts:84,166-167 — settingsHref/viewAllHref a rutas inexistentes (el 404 "Extraviado").
20. PostSiteKPIs.tsx:529,446,627 — "Email Report" toast de exito diciendo not implemented; sort muerto; edit movil abre modal vacio y GUARDA en blanco (pisa el KPI).
21. Codigo muerto: dashboard/dasboard.tsx, WidgetsBoard.tsx, RevenuePanel.tsx sin imports.
Limpios: analytics/Reporting, AlarmAnalytics, reportes DataReport, visitor-management, Activities, plumbing SSE del control center.
