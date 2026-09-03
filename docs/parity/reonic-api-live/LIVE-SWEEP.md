# Reonic API v3 — Live-Sweep (READ-ONLY)

Stand: 2026-09-03T18:40:50.303Z · OBSERVED (Live-Key, nur GET) · 63 Aufrufe

## Zusammenfassung je Tag

| Tag | GETs | 200 | 200+Data | 200 leer | Fehler |
|---|---|---|---|---|---|
| (me) | 1 | 1 | 0 | 1 | 0 |
| Activities | 3 | 1 | 1 | 0 | 2 |
| Appointments | 2 | 1 | 0 | 1 | 1 |
| Calendar Categories | 1 | 1 | 0 | 1 | 0 |
| Calendars | 1 | 1 | 1 | 0 | 0 |
| Checklist Templates | 2 | 1 | 1 | 0 | 1 |
| Checklists | 1 | 0 | 0 | 0 | 1 |
| Commercial Projects | 2 | 0 | 0 | 0 | 2 |
| Components | 4 | 1 | 1 | 0 | 3 |
| Contacts | 2 | 1 | 1 | 0 | 1 |
| File Folders | 2 | 0 | 0 | 0 | 2 |
| Files | 2 | 1 | 1 | 0 | 1 |
| Kanban Boards | 2 | 1 | 1 | 0 | 1 |
| Kanban Columns | 2 | 1 | 1 | 0 | 1 |
| Lead Sources | 2 | 1 | 1 | 0 | 1 |
| Links | 1 | 0 | 0 | 0 | 1 |
| Notes | 2 | 1 | 1 | 0 | 1 |
| Offer Templates | 2 | 1 | 1 | 0 | 1 |
| Photogrammetry | 2 | 1 | 1 | 0 | 1 |
| Planning Packages | 2 | 1 | 1 | 0 | 1 |
| Planning Templates | 2 | 1 | 1 | 0 | 1 |
| Residential Project Offer Variants | 2 | 0 | 0 | 0 | 2 |
| Residential Project Payment Options | 1 | 0 | 0 | 0 | 1 |
| Residential Project Signature Requests | 1 | 0 | 0 | 0 | 1 |
| Residential Project Subsidies | 1 | 0 | 0 | 0 | 1 |
| Residential Projects | 3 | 1 | 1 | 0 | 2 |
| Tags | 2 | 1 | 1 | 0 | 1 |
| Tasks | 4 | 2 | 1 | 1 | 2 |
| Teams | 2 | 1 | 0 | 1 | 1 |
| Time Tracking | 2 | 2 | 1 | 1 | 0 |
| Users | 2 | 1 | 1 | 0 | 1 |
| Wiki | 3 | 1 | 1 | 0 | 2 |

## Einzelaufrufe

| Pfad | Status | total | n | Sample-Keys |
|---|---|---|---|---|
| me | 200 | — | — | data |
| /checklists/{projectId} | 400 | — | — |  |
| /users | 200 | — | 3 | id, fullName, firstName, lastName, email, phone, role, isExternal, imageUrl, archivedAt, deletedAt |
| /users/{userId} | 400 | — | — |  |
| /tasks/tags | 200 | — | 0 |  |
| /tasks/count | 400 | — | — |  |
| /tasks | 200 | 1 | 1 | id, title, description, parent, checklist, createdAt, createdById, dueAt, reminderAt, completedAt, completedById, completionNote, assignedUserIds, assignedTeamIds, tagIds |
| /tasks/{taskId} | 400 | — | — |  |
| /residentialProjects | 200 | 93 | 50 | id, name, stage, latLng, address, customerContact, customerNumber, customerMessage, keyAccountManagerId, kanbanPlacements, kanbanBoardId, kanbanColumnId, primaryOfferVariantId, leadSourceId, tagIds, deal, projectCreatedAt, requestCreatedAt, offerCreatedAt, installationCreatedAt, updatedAt, archivedAt, primaryOfferVariant |
| /residentialProjects/{projectId} | 400 | — | — |  |
| /residentialProjects/{projectId}/heatingLoad/roomWise | 400 | — | — |  |
| /residentialProjects/{projectId}/variants | 400 | — | — |  |
| /residentialProjects/{projectId}/variants/{variantId} | 400 | — | — |  |
| /residentialProjects/{projectId}/paymentOptions | 400 | — | — |  |
| /residentialProjects/{projectId}/subsidies | 400 | — | — |  |
| /residentialProjects/{projectId}/signatureRequests | 400 | — | — |  |
| /commercialProjects | 403 | — | — |  |
| /commercialProjects/{projectId} | 400 | — | — |  |
| /tags | 200 | — | 2 | id, label, parentType, textColor, backgroundColor, createdAt, updatedAt, archivedAt |
| /tags/{tagId} | 400 | — | — |  |
| /leadSources | 200 | — | 8 | id, name, projectDomain, createdAt, updatedAt, archivedAt |
| /leadSources/{leadSourceId} | 400 | — | — |  |
| /notes | 200 | 161 | 50 | id, parent, text, createdAt, createdById, editedAt, editedById, pinnedAt, pinnedById |
| /notes/{noteId} | 400 | — | — |  |
| /files | 200 | 2 | 2 | id, name, type, url, parent, folderId, sharedWithTeamIds, sharedWithUserIds, position, visibleInCustomerPortal, createdAt, createdById |
| /fileFolders | 400 | — | — |  |
| /fileFolders/{folderId} | 400 | — | — |  |
| /files/{fileId} | 400 | — | — |  |
| /appointments | 200 | 0 | 0 |  |
| /appointments/{appointmentId} | 400 | — | — |  |
| /calendars | 200 | — | 3 | id, name, color, categoryId, userId, teamId, type, active |
| /calendarCategories | 200 | — | 0 |  |
| /timetracking/eventTypes | 200 | — | 4 | id, name, position, textColor, backgroundColor, archivedAt |
| /timetracking | 200 | 0 | 0 |  |
| /components | 200 | — | 337 | id, versionId, name, description, brand, articleNumber, gtin, salesPrice, vatRate, purchasePrice, quantityUnit, imageUrl, datasheetUrl, warrantyUrl, instructionsUrl, createdAt, updatedAt, archivedAt, componentType, attributes |
| /components/{componentId} | 400 | — | — |  |
| /components/{componentId}/versions | 400 | — | — |  |
| /components/{componentId}/versions/{versionId} | 400 | — | — |  |
| /activities | 200 | 3010 | 50 | id, type, associatedType, associatedId, parentId, parentType, createdAt, createdById |
| /activities/manual | 400 | — | — |  |
| /activities/manual/{activityId} | 400 | — | — |  |
| /kanbanColumns | 200 | — | 47 | id, name, boardId, position, archivedAt |
| /kanbanColumns/{columnId} | 400 | — | — |  |
| /kanbanBoards | 200 | — | 6 | id, name, description, projectDomain, projectStage, columns, archivedAt |
| /kanbanBoards/{boardId} | 400 | — | — |  |
| /contacts | 200 | 188 | 50 | id, fullName, firstName, lastName, salutation, primaryEmail, secondaryEmail, mobile, phone, phoneReachability, address, createdAt, updatedAt, deletedAt |
| /contacts/{contactId} | 400 | — | — |  |
| /teams | 200 | — | 0 |  |
| /teams/{teamId} | 400 | — | — |  |
| /planningTemplates | 200 | — | 1 | id, name, description, active, targets, items, createdAt, createdById, updatedAt, updatedById |
| /planningTemplates/{templateId} | 400 | — | — |  |
| /planningPackages | 200 | 3 | 3 | id, name, description, active, projectDomains, target, items |
| /planningPackages/{packageId} | 400 | — | — |  |
| /offerTemplates | 200 | — | 1 | id, name, description, position, active, targets, solarPackageId, batteryStoragePackageId, evChargerPackageId, heatPumpPackageId, optionalPackageId, additionalPackageId, updatedAt |
| /offerTemplates/{offerTemplateId} | 400 | — | — |  |
| /checklistTemplates | 200 | — | 1 | id, name, description, active, position, targets, items, createdAt, createdById, updatedAt, updatedById |
| /checklistTemplates/{checklistId} | 400 | — | — |  |
| /wiki | 200 | — | 1 | id, name, position, pages, type |
| /wiki/pages/{pageId} | 400 | — | — |  |
| /wiki/search | 400 | — | — |  |
| /links | 400 | — | — |  |
| /photogrammetry/jobs | 200 | 2 | 2 | id, name, status, gltfFileUrl, orthophotoFileUrl, coordinateFileUrl, createdAt, createdById, updatedAt, updatedById, startedAt, startedById, stoppedAt, preRenderCompletedAt, archivedAt |
| /photogrammetry/jobs/{jobId} | 400 | — | — |  |

*(Nur GETs; keine Mutationen; Fehlertexte ggf. bereinigt.)*