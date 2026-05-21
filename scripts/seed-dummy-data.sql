-- Seed script: 50 clients, 80+ stations, 120 guards, 5 supervisors
-- Tenant: Seguridad B.A.S. = 306a49da-c2d9-4c72-b288-0d3ba3e89ab9
-- Admin user (createdById): 189f16dd-c3eb-43c8-bebc-eea849fc6e7a

SET @tenant = '306a49da-c2d9-4c72-b288-0d3ba3e89ab9';
SET @admin = '189f16dd-c3eb-43c8-bebc-eea849fc6e7a';
SET @now = NOW();

-- ═══════════════════════════════════════════════════════════════
-- 50 CLIENT ACCOUNTS (Quito addresses)
-- ═══════════════════════════════════════════════════════════════
INSERT INTO clientAccounts (id, name, lastName, email, phoneNumber, address, city, country, latitude, longitude, active, tenantId, createdAt, updatedAt) VALUES
(UUID(),'Corporación Favorita','S.A.','corporacion.favorita@test.com','0991001001','Av. General Enríquez, Sangolquí','Quito','Ecuador',-0.3142,-78.4438,1,@tenant,@now,@now),
(UUID(),'Banco Pichincha','','banco.pichincha@test.com','0991001002','Av. Amazonas N36-152','Quito','Ecuador',-0.1807,-78.4836,1,@tenant,@now,@now),
(UUID(),'Hospital Metropolitano','','hospital.metro@test.com','0991001003','Av. Mariana de Jesús s/n','Quito','Ecuador',-0.1890,-78.4920,1,@tenant,@now,@now),
(UUID(),'Centro Comercial Quicentro','','quicentro@test.com','0991001004','Av. Naciones Unidas E2-50','Quito','Ecuador',-0.1751,-78.4780,1,@tenant,@now,@now),
(UUID(),'Universidad San Francisco','de Quito','usfq@test.com','0991001005','Cumbayá, Diego de Robles s/n','Quito','Ecuador',-0.1963,-78.4351,1,@tenant,@now,@now),
(UUID(),'Mall El Jardín','','mall.jardin@test.com','0991001006','Av. Amazonas N44-37','Quito','Ecuador',-0.1710,-78.4850,1,@tenant,@now,@now),
(UUID(),'Produbanco','','produbanco@test.com','0991001007','Av. Amazonas 4545 y Pereira','Quito','Ecuador',-0.1725,-78.4845,1,@tenant,@now,@now),
(UUID(),'Clínica Pasteur','','clinica.pasteur@test.com','0991001008','Av. Italia N30-36','Quito','Ecuador',-0.1650,-78.4870,1,@tenant,@now,@now),
(UUID(),'Hotel Hilton Colón','','hilton.quito@test.com','0991001009','Av. Amazonas N19-14','Quito','Ecuador',-0.2020,-78.4937,1,@tenant,@now,@now),
(UUID(),'Swissotel Quito','','swissotel@test.com','0991001010','Av. 12 de Octubre 1820','Quito','Ecuador',-0.1932,-78.4878,1,@tenant,@now,@now),
(UUID(),'Centro Comercial CCI','','cci.quito@test.com','0991001011','Av. Amazonas N36-152','Quito','Ecuador',-0.1810,-78.4838,1,@tenant,@now,@now),
(UUID(),'Edificio Titanium','','titanium@test.com','0991001012','Av. República del Salvador N35-67','Quito','Ecuador',-0.1790,-78.4810,1,@tenant,@now,@now),
(UUID(),'Colegio Americano','de Quito','colegio.americano@test.com','0991001013','Manuel Benigno Cueva N80-190','Quito','Ecuador',-0.1320,-78.4980,1,@tenant,@now,@now),
(UUID(),'Novaclinica','','novaclinica@test.com','0991001014','Av. de la Prensa N55-126','Quito','Ecuador',-0.1470,-78.4940,1,@tenant,@now,@now),
(UUID(),'Fundeporte','','fundeporte@test.com','0991001015','Parque Bicentenario s/n','Quito','Ecuador',-0.1510,-78.4880,1,@tenant,@now,@now),
(UUID(),'Empresa Eléctrica Quito','','eeq@test.com','0991001016','Av. 10 de Agosto N33-28','Quito','Ecuador',-0.1860,-78.4930,1,@tenant,@now,@now),
(UUID(),'Condado Shopping','','condado.shopping@test.com','0991001017','Av. La Prensa N70-25','Quito','Ecuador',-0.1220,-78.4960,1,@tenant,@now,@now),
(UUID(),'Scala Shopping','','scala@test.com','0991001018','Av. República del Salvador N35-183','Quito','Ecuador',-0.1780,-78.4808,1,@tenant,@now,@now),
(UUID(),'Plaza de las Américas','','plaza.americas@test.com','0991001019','Av. de la República y Ulloa','Quito','Ecuador',-0.1950,-78.4980,1,@tenant,@now,@now),
(UUID(),'Conjunto Residencial Los Ceibos','','ceibos@test.com','0991001020','Los Ceibos Alto, calle E5','Quito','Ecuador',-0.2340,-78.5210,1,@tenant,@now,@now),
(UUID(),'Urbanización La Armenia','','armenia.urb@test.com','0991001021','Valle de los Chillos, La Armenia','Quito','Ecuador',-0.3010,-78.4550,1,@tenant,@now,@now),
(UUID(),'Edificio Centrum','','centrum@test.com','0991001022','Av. Naciones Unidas E7-95','Quito','Ecuador',-0.1756,-78.4790,1,@tenant,@now,@now),
(UUID(),'Hotel JW Marriott','','marriott.quito@test.com','0991001023','Av. Orellana 1172','Quito','Ecuador',-0.1875,-78.4870,1,@tenant,@now,@now),
(UUID(),'Supermaxi Cumbayá','','supermaxi.cumbaya@test.com','0991001024','Av. Interoceánica, Cumbayá','Quito','Ecuador',-0.1925,-78.4360,1,@tenant,@now,@now),
(UUID(),'Paseo San Francisco','','paseo.sf@test.com','0991001025','Cumbayá, vía Interoceánica km 12','Quito','Ecuador',-0.1940,-78.4340,1,@tenant,@now,@now),
(UUID(),'Edificio World Trade Center','','wtc.quito@test.com','0991001026','Av. 12 de Octubre y Luis Cordero','Quito','Ecuador',-0.1950,-78.4880,1,@tenant,@now,@now),
(UUID(),'Plaza Foch','','plaza.foch@test.com','0991001027','Reina Victoria y Foch','Quito','Ecuador',-0.2010,-78.4910,1,@tenant,@now,@now),
(UUID(),'Centro Histórico Municipal','','centro.historico@test.com','0991001028','García Moreno y Sucre','Quito','Ecuador',-0.2200,-78.5130,1,@tenant,@now,@now),
(UUID(),'Quicentro Sur','','quicentro.sur@test.com','0991001029','Av. Morán Valverde s/n','Quito','Ecuador',-0.2870,-78.5400,1,@tenant,@now,@now),
(UUID(),'Hospital de los Valles','','hospital.valles@test.com','0991001030','Cumbayá, Av. Interoceánica km 12.5','Quito','Ecuador',-0.1930,-78.4330,1,@tenant,@now,@now),
(UUID(),'Corporación GPF','','gpf@test.com','0991001031','Av. Granados E12-41','Quito','Ecuador',-0.1700,-78.4670,1,@tenant,@now,@now),
(UUID(),'Edificio Metropoli','','metropoli@test.com','0991001032','Av. República y Eloy Alfaro','Quito','Ecuador',-0.1830,-78.4900,1,@tenant,@now,@now),
(UUID(),'Colegio SEK','','colegio.sek@test.com','0991001033','Cumbayá, calle San Juan','Quito','Ecuador',-0.1915,-78.4380,1,@tenant,@now,@now),
(UUID(),'Banco Guayaquil Matriz','','bguayaquil@test.com','0991001034','Av. Amazonas N39-123','Quito','Ecuador',-0.1790,-78.4840,1,@tenant,@now,@now),
(UUID(),'Parque Empresarial Colón','','parque.colon@test.com','0991001035','Av. Colón E4-105','Quito','Ecuador',-0.1990,-78.4950,1,@tenant,@now,@now),
(UUID(),'Residencial Miravalle','','miravalle@test.com','0991001036','Miravalle Alto, lote 15','Quito','Ecuador',-0.2150,-78.4750,1,@tenant,@now,@now),
(UUID(),'Condominio Portón del Valle','','porton.valle@test.com','0991001037','Valle de los Chillos, San Rafael','Quito','Ecuador',-0.3090,-78.4510,1,@tenant,@now,@now),
(UUID(),'Torre Bolívar','','torre.bolivar@test.com','0991001038','Av. Bolívar y González Suárez','Quito','Ecuador',-0.1970,-78.4850,1,@tenant,@now,@now),
(UUID(),'Club Rancho San Francisco','','rancho.sf@test.com','0991001039','Cumbayá, vía a Lumbisí','Quito','Ecuador',-0.1980,-78.4300,1,@tenant,@now,@now),
(UUID(),'Edificio Cosmopolitan Parc','','cosmopolitan@test.com','0991001040','González Suárez N27-142','Quito','Ecuador',-0.1960,-78.4830,1,@tenant,@now,@now),
(UUID(),'Centro Comercial El Recreo','','recreo@test.com','0991001041','Av. Pedro Vicente Maldonado','Quito','Ecuador',-0.2620,-78.5290,1,@tenant,@now,@now),
(UUID(),'Fábrica Pronaca','','pronaca@test.com','0991001042','Panamericana Norte km 5.5','Quito','Ecuador',-0.1150,-78.4870,1,@tenant,@now,@now),
(UUID(),'Bodega Industrial Norte','','bodega.norte@test.com','0991001043','Parque Industrial del Norte','Quito','Ecuador',-0.1080,-78.4920,1,@tenant,@now,@now),
(UUID(),'Conjunto Alcázar de Cumbayá','','alcazar@test.com','0991001044','Cumbayá, Av. Pampite','Quito','Ecuador',-0.1890,-78.4290,1,@tenant,@now,@now),
(UUID(),'Edificio Blue Towers','','blue.towers@test.com','0991001045','Av. República del Salvador N34-399','Quito','Ecuador',-0.1785,-78.4805,1,@tenant,@now,@now),
(UUID(),'Centro Empresarial EKOPARK','','ekopark@test.com','0991001046','Av. De los Shyris N36-188','Quito','Ecuador',-0.1810,-78.4820,1,@tenant,@now,@now),
(UUID(),'Mall San Rafael','','mall.sanrafael@test.com','0991001047','Av. General Rumiñahui, San Rafael','Quito','Ecuador',-0.3050,-78.4530,1,@tenant,@now,@now),
(UUID(),'Plaza del Rancho','','plaza.rancho@test.com','0991001048','Sangolquí, vía Amaguaña','Quito','Ecuador',-0.3200,-78.4480,1,@tenant,@now,@now),
(UUID(),'Urbanización Jardines del Este','','jardines.este@test.com','0991001049','Tumbaco, Ruta Viva km 8','Quito','Ecuador',-0.1870,-78.4250,1,@tenant,@now,@now),
(UUID(),'Edificio Torino','','torino@test.com','0991001050','Av. Portugal E10-33 y Shyris','Quito','Ecuador',-0.1820,-78.4790,1,@tenant,@now,@now);

-- ═══════════════════════════════════════════════════════════════
-- 100 NEW SECURITY GUARDS (users + securityGuards + tenantUsers)
-- ═══════════════════════════════════════════════════════════════

-- We'll use a procedure to batch-create guards
DELIMITER //
DROP PROCEDURE IF EXISTS seed_guards//
CREATE PROCEDURE seed_guards()
BEGIN
  DECLARE i INT DEFAULT 1;
  DECLARE uid CHAR(36);
  DECLARE gid CHAR(36);
  DECLARE fname VARCHAR(80);
  DECLARE lname VARCHAR(175);
  DECLARE govid VARCHAR(50);
  
  DECLARE fnames TEXT DEFAULT 'Juan,Pedro,Diego,Marcos,Santiago,Andrés,Roberto,Sebastián,Víctor,Alejandro,Gabriel,Emilio,Patricio,Cristian,Edison,Wilson,Omar,Héctor,Raúl,Jorge,Manuel,Ángel,Byron,Darwin,Iván,Gustavo,Fabián,Nelson,Freddy,Walter,Arturo,Julio,Enrique,Segundo,Bladimir,Paul,Esteban,Jaime,Gonzalo,Danilo,Ramiro,Mauricio,Geovanny,Xavier,Fausto,Renato,Bolívar,Klever,Vinicio,César,Alberto,Ernesto,Oswaldo,Rodrigo,Leonardo,Franklin,Hugo,Guillermo,Armando,Marcelo,Silvio,Tito,Efrén,Eloy,Homero,Joel,Milton,Néstor,Saúl,Abel,Bayron,Camilo,Danny,Édgar,Flavio,Gilberto,Hernán,Ismael,Jhon,Kevin,Leandro,Mario,Nicolás,Óscar,Pablo,Rafael,Simón,Tomás,Ulises,Wladimir,Alexis,Brayan,Cristopher,Dario,Elvis,Fabricio,Galo,Henry,Isaac,Jefferson';
  DECLARE lnames TEXT DEFAULT 'Guamán,Toapanta,Chimborazo,Quishpe,Pilataxi,Caiza,Tipán,Cóndor,Llumiquinga,Simbaña,Morales,Salazar,Paredes,Cárdenas,Vega,Narváez,López,Flores,Mendoza,Ruiz,Pinto,Calderón,Espinoza,Molina,Vargas,Rojas,Castillo,Acosta,Guerrero,Rivera,Delgado,Ramírez,Benítez,Suárez,Aguirre,Zambrano,Vera,Cevallos,Andrade,Bravo,Córdova,Montoya,Peña,Hidalgo,Jácome,Villacís,Proaño,Yánez,Herrera,Cabrera,Tapia,Muñoz,Reyes,Sánchez,Chávez,Ortiz,Lara,Bautista,Fonseca,Granda,Iza,Jaramillo,Lema,Mena,Noboa,Ojeda,Pozo,Quintero,Rosero,Solano,Tenorio,Unda,Vinueza,Yépez,Zúñiga,Albán,Barros,Calle,Dávila,Escobar,Franco,Gómez,Haro,Intriago,Jara,Loor,Moreira,Navas,Ponce,Quito,Ramos,Silva,Torres,Uribe,Valencia,Yaguachi,Zamora,Arévalo,Bonilla';
  
  WHILE i <= 100 DO
    SET uid = UUID();
    SET gid = UUID();
    SET fname = SUBSTRING_INDEX(SUBSTRING_INDEX(fnames, ',', 1 + ((i-1) % 99)), ',', -1);
    SET lname = CONCAT(
      SUBSTRING_INDEX(SUBSTRING_INDEX(lnames, ',', 1 + ((i-1) % 99)), ',', -1),
      ' ',
      SUBSTRING_INDEX(SUBSTRING_INDEX(lnames, ',', 1 + ((i+30) % 99)), ',', -1)
    );
    SET govid = CONCAT('17', LPAD(FLOOR(RAND()*100000000), 8, '0'), '1');
    
    INSERT INTO users (id, email, firstName, lastName, fullName, phoneNumber, emailVerified, createdAt, updatedAt)
    VALUES (uid, CONCAT(LOWER(REPLACE(fname,'í','i')), '.', LOWER(SUBSTRING_INDEX(lname,' ',1)), i, '@guardia.cguardpro.com'), fname, lname, CONCAT(fname, ' ', lname), CONCAT('09', LPAD(FLOOR(RAND()*100000000), 8, '0')), 1, @now, @now);
    
    INSERT INTO tenantUsers (id, roles, status, tenantId, userId, createdById, updatedById, createdAt, updatedAt)
    VALUES (UUID(), '["securityGuard"]', 'active', @tenant, uid, @admin, @admin, @now, @now);
    
    INSERT INTO securityGuards (id, governmentId, fullName, gender, birthDate, bloodType, maritalStatus, academicInstruction, address, guardType, isOnDuty, guardId, tenantId, createdById, updatedById, createdAt, updatedAt)
    VALUES (gid, govid, CONCAT(fname, ' ', lname),
      IF(i % 8 = 0, 'Femenino', 'Masculino'),
      DATE_SUB(CURDATE(), INTERVAL (22 + FLOOR(RAND()*20)) YEAR),
      ELT(1 + (i % 6), 'O+', 'A+', 'B+', 'AB+', 'O-', 'A-'),
      ELT(1 + (i % 4), 'Soltero', 'Casado', 'Unión libre', 'Divorciado'),
      ELT(1 + (i % 3), 'Secundaria', 'Universitaria', 'Especial'),
      CONCAT('Quito, sector ', ELT(1 + (i % 10), 'Norte', 'Sur', 'Centro', 'Cumbayá', 'Tumbaco', 'Calderón', 'Carapungo', 'Conocoto', 'San Rafael', 'Sangolquí')),
      IF(i % 7 = 0, 'sacafranco', 'titular'),
      0, uid, @tenant, @admin, @admin, @now, @now);
    
    SET i = i + 1;
  END WHILE;
END//
DELIMITER ;

CALL seed_guards();
DROP PROCEDURE IF EXISTS seed_guards;

-- ═══════════════════════════════════════════════════════════════
-- 5 SUPERVISORS
-- ═══════════════════════════════════════════════════════════════
INSERT INTO users (id, email, firstName, lastName, fullName, phoneNumber, emailVerified, createdAt, updatedAt) VALUES
('aaa00001-0000-4000-a000-000000000001','supervisor.norte@cguardpro.com','Carlos','Miño Rojas','Carlos Miño Rojas','0998001001',1,@now,@now),
('aaa00001-0000-4000-a000-000000000002','supervisor.sur@cguardpro.com','Roberto','Villacís Granda','Roberto Villacís Granda','0998001002',1,@now,@now),
('aaa00001-0000-4000-a000-000000000003','supervisor.valles@cguardpro.com','Patricio','Herrera Solano','Patricio Herrera Solano','0998001003',1,@now,@now),
('aaa00001-0000-4000-a000-000000000004','supervisor.centro@cguardpro.com','Gonzalo','Andrade Peña','Gonzalo Andrade Peña','0998001004',1,@now,@now),
('aaa00001-0000-4000-a000-000000000005','supervisor.cumbaya@cguardpro.com','Esteban','Jácome Bravo','Esteban Jácome Bravo','0998001005',1,@now,@now);

INSERT INTO tenantUsers (id, roles, status, tenantId, userId, createdById, updatedById, createdAt, updatedAt) VALUES
(UUID(), '["securitySupervisor"]', 'active', @tenant, 'aaa00001-0000-4000-a000-000000000001', @admin, @admin, @now, @now),
(UUID(), '["securitySupervisor"]', 'active', @tenant, 'aaa00001-0000-4000-a000-000000000002', @admin, @admin, @now, @now),
(UUID(), '["securitySupervisor"]', 'active', @tenant, 'aaa00001-0000-4000-a000-000000000003', @admin, @admin, @now, @now),
(UUID(), '["securitySupervisor"]', 'active', @tenant, 'aaa00001-0000-4000-a000-000000000004', @admin, @admin, @now, @now),
(UUID(), '["securitySupervisor"]', 'active', @tenant, 'aaa00001-0000-4000-a000-000000000005', @admin, @admin, @now, @now);

-- ═══════════════════════════════════════════════════════════════
-- POST SITES (businessInfos) - one per client, then stations
-- We need the client IDs. Let's create postSites + stations in bulk.
-- ═══════════════════════════════════════════════════════════════

-- Create a procedure to generate postSites and stations from clients
DELIMITER //
DROP PROCEDURE IF EXISTS seed_stations//
CREATE PROCEDURE seed_stations()
BEGIN
  DECLARE done INT DEFAULT FALSE;
  DECLARE cid CHAR(36);
  DECLARE cname VARCHAR(200);
  DECLARE caddr VARCHAR(200);
  DECLARE clat DECIMAL(10,8);
  DECLARE clng DECIMAL(11,8);
  DECLARE pid CHAR(36);
  DECLARE sid CHAR(36);
  DECLARE station_count INT;
  DECLARE j INT;
  DECLARE stype VARCHAR(20);
  DECLARE rotid CHAR(36);
  
  DECLARE cur CURSOR FOR 
    SELECT id, name, address, latitude, longitude FROM clientAccounts 
    WHERE tenantId = @tenant AND deletedAt IS NULL
    ORDER BY createdAt DESC LIMIT 50;
  DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = TRUE;
  
  OPEN cur;
  read_loop: LOOP
    FETCH cur INTO cid, cname, caddr, clat, clng;
    IF done THEN LEAVE read_loop; END IF;
    
    -- Create 1 postSite per client
    SET pid = UUID();
    INSERT INTO businessInfos (id, companyName, address, city, country, latitud, longitud, contactEmail, serviceType, chargeRate, payRate, active, clientAccountId, tenantId, createdById, updatedById, createdAt, updatedAt)
    VALUES (pid, cname, caddr, 'Quito', 'Ecuador', CAST(clat AS CHAR), CAST(clng AS CHAR), CONCAT(LOWER(REPLACE(REPLACE(cname,' ','.'),'á','a')), '@test.com'), 
      ELT(1 + FLOOR(RAND()*3), 'manned', 'manned', 'patrol'),
      ROUND(800 + RAND()*1200, 2), ROUND(450 + RAND()*200, 2),
      1, cid, @tenant, @admin, @admin, @now, @now);
    
    -- Create 1-3 stations per postSite
    SET station_count = 1 + FLOOR(RAND() * 2.5);
    SET j = 1;
    WHILE j <= station_count DO
      SET sid = UUID();
      SET stype = ELT(1 + FLOOR(RAND()*3), '24h', '12h-day', '12h-night');
      SET rotid = CASE 
        WHEN stype = '24h' THEN ELT(1 + FLOOR(RAND()*3), '00000000-0000-4000-a000-000000000004', '00000000-0000-4000-a000-000000000005', '00000000-0000-4000-a000-000000000006')
        ELSE ELT(1 + FLOOR(RAND()*3), '00000000-0000-4000-a000-000000000001', '00000000-0000-4000-a000-000000000002', '00000000-0000-4000-a000-000000000003')
      END;
      
      INSERT INTO stations (id, stationName, latitud, longitud, numberOfGuardsInStation, geofenceRadius, postSiteId, scheduleType, rotationStyleId, tenantId, createdById, updatedById, createdAt, updatedAt)
      VALUES (sid,
        CASE j 
          WHEN 1 THEN CONCAT(SUBSTRING(cname, 1, 20), ' - Principal')
          WHEN 2 THEN CONCAT(SUBSTRING(cname, 1, 20), ' - Acceso Sur')
          ELSE CONCAT(SUBSTRING(cname, 1, 20), ' - Parqueadero')
        END,
        CAST(clat + (RAND()-0.5)*0.002 AS CHAR),
        CAST(clng + (RAND()-0.5)*0.002 AS CHAR),
        '2', 100, pid, stype, rotid, @tenant, @admin, @admin, @now, @now);
      
      SET j = j + 1;
    END WHILE;
  END LOOP;
  CLOSE cur;
END//
DELIMITER ;

CALL seed_stations();
DROP PROCEDURE IF EXISTS seed_stations;

-- ═══════════════════════════════════════════════════════════════
-- AUTO-CREATE POSITIONS for all new stations
-- ═══════════════════════════════════════════════════════════════
DELIMITER //
DROP PROCEDURE IF EXISTS seed_positions//
CREATE PROCEDURE seed_positions()
BEGIN
  DECLARE done INT DEFAULT FALSE;
  DECLARE sid CHAR(36);
  DECLARE stype VARCHAR(20);
  
  DECLARE cur CURSOR FOR 
    SELECT s.id, s.scheduleType FROM stations s 
    LEFT JOIN stationPositions sp ON sp.stationId = s.id AND sp.deletedAt IS NULL
    WHERE s.tenantId = @tenant AND s.deletedAt IS NULL AND sp.id IS NULL;
  DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = TRUE;
  
  OPEN cur;
  read_loop: LOOP
    FETCH cur INTO sid, stype;
    IF done THEN LEAVE read_loop; END IF;
    
    IF stype = '24h' OR stype IS NULL THEN
      INSERT INTO stationPositions (id, name, type, startTime, endTime, guardsNeeded, sortOrder, stationId, tenantId, createdById, updatedById, createdAt, updatedAt) VALUES
      (UUID(), 'Diurno', 'day', '07:00', '19:00', 1, 0, sid, @tenant, @admin, @admin, @now, @now),
      (UUID(), 'Nocturno', 'night', '19:00', '07:00', 1, 1, sid, @tenant, @admin, @admin, @now, @now),
      (UUID(), 'Sacafranco', 'relief', '07:00', '19:00', 1, 2, sid, @tenant, @admin, @admin, @now, @now);
    ELSEIF stype = '12h-day' THEN
      INSERT INTO stationPositions (id, name, type, startTime, endTime, guardsNeeded, sortOrder, stationId, tenantId, createdById, updatedById, createdAt, updatedAt) VALUES
      (UUID(), 'Diurno', 'day', '07:00', '19:00', 1, 0, sid, @tenant, @admin, @admin, @now, @now),
      (UUID(), 'Sacafranco', 'relief', '07:00', '19:00', 1, 1, sid, @tenant, @admin, @admin, @now, @now);
    ELSEIF stype = '12h-night' THEN
      INSERT INTO stationPositions (id, name, type, startTime, endTime, guardsNeeded, sortOrder, stationId, tenantId, createdById, updatedById, createdAt, updatedAt) VALUES
      (UUID(), 'Nocturno', 'night', '19:00', '07:00', 1, 0, sid, @tenant, @admin, @admin, @now, @now),
      (UUID(), 'Sacafranco', 'relief', '19:00', '07:00', 1, 1, sid, @tenant, @admin, @admin, @now, @now);
    END IF;
  END LOOP;
  CLOSE cur;
END//
DELIMITER ;

CALL seed_positions();
DROP PROCEDURE IF EXISTS seed_positions;

SELECT 'SEED COMPLETE' AS status,
  (SELECT COUNT(*) FROM clientAccounts WHERE tenantId=@tenant) AS clients,
  (SELECT COUNT(*) FROM businessInfos WHERE tenantId=@tenant) AS postSites,
  (SELECT COUNT(*) FROM stations WHERE tenantId=@tenant) AS stations,
  (SELECT COUNT(*) FROM stationPositions WHERE tenantId=@tenant) AS positions,
  (SELECT COUNT(*) FROM securityGuards WHERE tenantId=@tenant) AS guards,
  (SELECT COUNT(*) FROM tenantUsers WHERE tenantId=@tenant AND roles LIKE '%Supervisor%') AS supervisors;
