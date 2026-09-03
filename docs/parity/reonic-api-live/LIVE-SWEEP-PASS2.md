# Reonic API v3 — Pass 2: Detail-Endpunkte (READ-ONLY, echte IDs)

Stand: 2026-09-03T18:42:49.377Z · 23/24 Details live beobachtet

| Pfad | Status | Struktur-Keys (Typ-Map gekürzt) |
|---|---|---|
| /residentialProjects/{id} | 200 | id, name, stage, latLng, address, customerContact, customerNumber, customerMessage, keyAccountManagerId, kanbanPlacements, kanbanBoardId, kanbanColumnId, primaryOfferVariantId, leadSourceId, tagIds, deal, projectCreatedAt, requestCreatedAt, offerCreatedAt, installationCreatedAt, updatedAt, archivedAt, primaryOfferVariant, offerVariantIds, assignedUserIds, assignedTeamIds, customerPortalUrl, closedAt, requestedPackages, existingSystems, building, heatLoad, offerNumber, meterNumber, targetSignatureDate, subsidies, variantIds, signatureRequests, integrations |
| /residentialProjects/{id}/variants | 200 | data |
| /residentialProjects/{id}/paymentOptions | 200 | data |
| /residentialProjects/{id}/subsidies | 200 | data |
| /residentialProjects/{id}/signatureRequests | 200 | data |
| /residentialProjects/{id}/heatingLoad/roomWise | 200 | results, warnings, errors |
| /checklists/{id} | 200 | version, updatedAt, updatedById, blocks |
| /users/{id} | 200 | id, fullName, firstName, lastName, email, phone, role, isExternal, imageUrl, archivedAt, deletedAt |
| /tasks/{id} | 200 | data |
| /tags/{id} | 200 | id, label, parentType, textColor, backgroundColor, createdAt, updatedAt, archivedAt |
| /leadSources/{id} | 200 | id, name, projectDomain, createdAt, updatedAt, archivedAt |
| /notes/{id} | 200 | data |
| /files/{id} | 200 | id, name, type, url, parent, folderId, sharedWithTeamIds, sharedWithUserIds, position, visibleInCustomerPortal, createdAt, createdById |
| /components/{id} | 200 | id, versionId, name, description, brand, articleNumber, gtin, salesPrice, vatRate, purchasePrice, quantityUnit, imageUrl, datasheetUrl, warrantyUrl, instructionsUrl, createdAt, updatedAt, archivedAt, componentType, attributes |
| /components/{id}/versions | 200 | data |
| /kanbanColumns/{id} | 200 | id, name, boardId, position, archivedAt |
| /kanbanBoards/{id} | 200 | id, name, description, projectDomain, projectStage, columns, archivedAt |
| /contacts/{id} | 200 | id, fullName, firstName, lastName, salutation, primaryEmail, secondaryEmail, mobile, phone, phoneReachability, address, createdAt, updatedAt, deletedAt, commercialProjectIds, residentialProjectIds, marketingConsent, marketingConsentText, marketingConsentDataProtectionLink, utm, integrations |
| /planningTemplates/{id} | 200 | id, name, description, active, targets, items, createdAt, createdById, updatedAt, updatedById |
| /planningPackages/{id} | 200 | id, name, description, active, projectDomains, target, items |
| /offerTemplates/{id} | 200 | id, name, description, position, active, targets, solarPackageId, batteryStoragePackageId, evChargerPackageId, heatPumpPackageId, optionalPackageId, additionalPackageId, updatedAt |
| /checklistTemplates/{id} | 200 | id, name, description, active, position, targets, items, createdAt, createdById, updatedAt, updatedById |
| /wiki/pages/{id} | 404 |  |
| /photogrammetry/jobs/{id} | 200 | id, name, status, assets, gltfFileUrl, orthophotoFileUrl, coordinateFileUrl, createdAt, createdById, updatedAt, updatedById, startedAt, startedById, stoppedAt, preRenderCompletedAt, archivedAt |

*(Struktur-Evidenz nur; keine Feldwerte, keine Reonic-Daten übernommen.)*