import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { canonicalizeCatalogJson } from "@/lib/integrations/catalog/contract";
import { testPool } from "../setup/test-db";
import { superuserPool } from "../setup/superuser-db";

const ATTESTATION_SHA256 =
  "4511413a407acc4c073184ecbb127b449b13c72db28fe8b1682ba17cced1b4f8";

const requiredMappingFields = [
  "internalSku",
  "componentType",
  "displayName",
  "manufacturer",
  "model",
  "unit",
  "technicalSourceKind",
  "technicalReference",
  "technicalObservedOn",
  "technicalRightsBasis",
  "purchasePriceNet",
  "purchaseSourceKind",
  "purchaseReference",
  "purchaseObservedOn",
  "purchaseRightsBasis",
  "salesPriceNet",
  "salesSourceKind",
  "salesReference",
  "salesObservedOn",
  "salesRightsBasis",
] as const;

const mapping = {
  schemaVersion: "catalog-csv-column-mapping.v1",
  columns: requiredMappingFields.map((field, index) => ({
    field,
    sourceHeader: `h${index}`,
  })),
};
const mappingBody = canonicalizeCatalogJson(mapping);
const mappingSha256 = sha256(mappingBody);
const fileSha256 = sha256("synthetische CSV ohne Kundendaten");

const purchaseProvenance = {
  sourceKind: "supplier_price_list",
  reference: "Eigene Testpreisliste",
  observedOn: "2026-08-31",
  rightsBasis: "supplier_authorized",
  sourceDocumentSha256: null,
} as const;
const salesProvenance = {
  sourceKind: "workspace_pricing",
  reference: "Eigene Kalkulation",
  observedOn: "2026-08-31",
  rightsBasis: "workspace_owned",
  sourceDocumentSha256: null,
} as const;
const technicalProvenance = {
  sourceKind: "manufacturer_datasheet",
  reference: "Datenblatt S440",
  observedOn: "2026-08-31",
  rightsBasis: "manufacturer_published",
  sourceDocumentSha256: null,
} as const;
const sourceCommand = {
  schemaVersion: "catalog-component-create-command.v1",
  internalSku: "PV-440-BLK",
  componentType: "module",
  presentation: {
    displayName: "440-Watt-Modul",
    manufacturer: "WMEE Testwerk",
    model: "S440",
    unit: "piece",
    keyPoints: ["synthetisch", "schwarz"],
    image: null,
    datasheet: null,
  },
  technicalData: { schemaVersion: "module.v1", nominalPowerWatts: 440 },
  commercial: {
    currency: "EUR",
    basis: "net",
    purchasePriceNetCents: 7_900,
    salesPriceNetCents: 12_900,
    purchaseProvenance,
    salesProvenance,
  },
  technicalProvenance,
} as const;

type Fixture = {
  workspaceId: string;
  actorId: string;
  jobId: string;
  valid: boolean;
};

type RowCommandEnvelope = {
  command: Record<string, unknown>;
  previewBody: Buffer;
  sourceBody: Buffer;
  rowBody: Buffer;
  targetBody: Buffer;
  targetSnapshot: Record<string, unknown>;
  componentId: string;
  rowSha256: string;
  sourceSha256: string;
  rowCommandSha256: string;
  targetSha256: string;
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function validRowCommand(workspaceId: string): RowCommandEnvelope {
  const componentId = randomUUID();
  const sourceBodyText = canonicalizeCatalogJson(sourceCommand);
  const sourceSha256 = sha256(sourceBodyText);
  const previewBodyText = canonicalizeCatalogJson({
    status: "valid",
    rowNumber: 2,
    normalizedSku: sourceCommand.internalSku,
    commandSha256: sourceSha256,
    command: sourceCommand,
  });
  const rowSha256 = sha256(previewBodyText);
  const targetBodyValue = {
    schemaVersion: "catalog-component-revision.v1",
    canonicalizationVersion: "catalog-jcs.v1",
    identity: {
      workspaceId,
      componentId,
      revision: 1,
      internalSku: sourceCommand.internalSku,
      componentType: sourceCommand.componentType,
    },
    presentation: sourceCommand.presentation,
    technicalData: sourceCommand.technicalData,
    commercial: sourceCommand.commercial,
    technicalProvenance: sourceCommand.technicalProvenance,
  };
  const targetBodyText = canonicalizeCatalogJson(targetBodyValue);
  const targetSha256 = sha256(targetBodyText);
  const targetSnapshot = { ...targetBodyValue, snapshotSha256: targetSha256 };
  const commandBody = {
    schemaVersion: "catalog-import-row-command.v1",
    source: {
      fileSha256,
      mappingSha256,
      rowNumber: 2,
      rowSha256,
      sourceCommandSha256: sourceSha256,
    },
    operation: "create",
    targetComponentId: componentId,
    expected: null,
    sourceCommand,
    sealedTarget: {
      snapshot: targetSnapshot,
      bodyCanonicalBase64: Buffer.from(targetBodyText, "utf8").toString("base64"),
      snapshotSha256: targetSha256,
    },
  };
  const rowBodyText = canonicalizeCatalogJson(commandBody);
  const rowCommandSha256 = sha256(rowBodyText);
  return {
    command: { ...commandBody, rowCommandSha256 },
    previewBody: Buffer.from(previewBodyText, "utf8"),
    sourceBody: Buffer.from(sourceBodyText, "utf8"),
    rowBody: Buffer.from(rowBodyText, "utf8"),
    targetBody: Buffer.from(targetBodyText, "utf8"),
    targetSnapshot,
    componentId,
    rowSha256,
    sourceSha256,
    rowCommandSha256,
    targetSha256,
  };
}

function existingRowCommand(
  workspaceId: string,
  expectedRevision: RowCommandEnvelope,
  operation: "revise" | "unchanged",
  displayName: string,
): RowCommandEnvelope {
  const commandSource = {
    ...sourceCommand,
    presentation: { ...sourceCommand.presentation, displayName },
  };
  const sourceBodyText = canonicalizeCatalogJson(commandSource);
  const sourceSha256 = sha256(sourceBodyText);
  const previewBodyText = canonicalizeCatalogJson({
    status: "valid",
    rowNumber: 2,
    normalizedSku: commandSource.internalSku,
    commandSha256: sourceSha256,
    command: commandSource,
  });
  const rowSha256 = sha256(previewBodyText);
  const targetBodyValue = {
    schemaVersion: "catalog-component-revision.v1",
    canonicalizationVersion: "catalog-jcs.v1",
    identity: {
      workspaceId,
      componentId: expectedRevision.componentId,
      revision: 2,
      internalSku: commandSource.internalSku,
      componentType: commandSource.componentType,
    },
    presentation: commandSource.presentation,
    technicalData: commandSource.technicalData,
    commercial: commandSource.commercial,
    technicalProvenance: commandSource.technicalProvenance,
  };
  const targetBodyText = canonicalizeCatalogJson(targetBodyValue);
  const revisedTargetSha256 = sha256(targetBodyText);
  const revisedTargetSnapshot = {
    ...targetBodyValue,
    snapshotSha256: revisedTargetSha256,
  };
  const expected = {
    componentId: expectedRevision.componentId,
    revision: 1,
    status: "draft",
    snapshotSha256: expectedRevision.targetSha256,
    internalSku: commandSource.internalSku,
    componentType: commandSource.componentType,
  };
  const commandBody = {
    schemaVersion: "catalog-import-row-command.v1",
    source: {
      fileSha256,
      mappingSha256,
      rowNumber: 2,
      rowSha256,
      sourceCommandSha256: sourceSha256,
    },
    operation,
    targetComponentId: expectedRevision.componentId,
    expected,
    sourceCommand: commandSource,
    sealedTarget: operation === "unchanged" ? null : {
      snapshot: revisedTargetSnapshot,
      bodyCanonicalBase64: Buffer.from(targetBodyText, "utf8").toString("base64"),
      snapshotSha256: revisedTargetSha256,
    },
  };
  const rowBodyText = canonicalizeCatalogJson(commandBody);
  const rowCommandSha256 = sha256(rowBodyText);
  return {
    command: { ...commandBody, rowCommandSha256 },
    previewBody: Buffer.from(previewBodyText, "utf8"),
    sourceBody: Buffer.from(sourceBodyText, "utf8"),
    rowBody: Buffer.from(rowBodyText, "utf8"),
    targetBody: operation === "unchanged"
      ? expectedRevision.targetBody
      : Buffer.from(targetBodyText, "utf8"),
    targetSnapshot: operation === "unchanged"
      ? expectedRevision.targetSnapshot
      : revisedTargetSnapshot,
    componentId: expectedRevision.componentId,
    rowSha256,
    sourceSha256,
    rowCommandSha256,
    targetSha256: operation === "unchanged"
      ? expectedRevision.targetSha256
      : revisedTargetSha256,
  };
}

async function tenantTransaction<T>(
  workspaceId: string,
  action: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await testPool.connect();
  try {
    await client.query("begin");
    await client.query(
      "select set_config('app.workspace_id', $1, true), set_config('app.actor_id', '', true)",
      [workspaceId],
    );
    const result = await action(client);
    await client.query("set constraints all immediate");
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function captureRejected(
  workspaceId: string,
  action: (client: PoolClient) => Promise<void>,
): Promise<unknown | null> {
  const client = await testPool.connect();
  try {
    await client.query("begin");
    await client.query(
      "select set_config('app.workspace_id', $1, true), set_config('app.actor_id', '', true)",
      [workspaceId],
    );
    await action(client);
    await client.query("set constraints all immediate");
    await client.query("rollback");
    return null;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    return error;
  } finally {
    client.release();
  }
}

async function waitForBlocking(
  observer: PoolClient,
  blockedPid: number,
  blockerPid: number,
  expectedWaitEvent?: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = await observer.query<{
      blocked: boolean;
      waitEventType: string | null;
      waitEvent: string | null;
    }>(`
      select $2::integer = any(pg_catalog.pg_blocking_pids($1::integer))
               as blocked,
             activity.wait_event_type as "waitEventType",
             activity.wait_event as "waitEvent"
        from pg_catalog.pg_stat_activity as activity
       where activity.pid = $1::integer
    `, [blockedPid, blockerPid]);
    const row = state.rows[0];
    if (
      row?.blocked && row.waitEventType === "Lock" &&
      (expectedWaitEvent === undefined || row.waitEvent === expectedWaitEvent)
    ) {
      return;
    }
    await observer.query("select pg_catalog.pg_sleep(0.02)");
  }
  throw new Error(
    `PID ${blockedPid} wurde nicht wie erwartet von PID ${blockerPid} blockiert.`,
  );
}

async function createFixture(options: {
  valid: boolean;
  oldEnough?: boolean;
  nonCanonicalPreviewBody?: boolean;
  initialLeaseGeneration?: number;
  rowNumber?: number;
  duplicateInvalidSku?: boolean;
}): Promise<Fixture> {
  const workspaceId = randomUUID();
  const actorId = randomUUID();
  const jobId = randomUUID();
  const intentId = randomUUID();
  const requestedCreatedAt = new Date("2001-01-01T00:00:00.000Z");
  const historicalCreatedAt = new Date(Date.now() - 31 * 86_400_000);
  const validEnvelope = options.valid ? validRowCommand(workspaceId) : null;
  const errorSnapshot = [{
    field: "internalSku",
    sourceHeader: "h0",
    code: "missing_value",
    message: "Ein benoetigter Wert fehlt.",
  }];
  const invalidPreviewValue = {
    status: "invalid",
    rowNumber: options.rowNumber ?? 2,
    normalizedSku: null,
    errors: errorSnapshot,
  };
  const invalidPreviewBody = Buffer.from(
    options.nonCanonicalPreviewBody
      ? JSON.stringify(invalidPreviewValue, null, 2)
      : canonicalizeCatalogJson(invalidPreviewValue),
    "utf8",
  );
  const duplicateErrorSnapshot = [{
    field: "internalSku",
    sourceHeader: "h0",
    code: "duplicate_sku_in_file",
    message: "Die normalisierte SKU kommt in der Datei mehrfach vor.",
  }];
  const duplicatePreviewBody = Buffer.from(canonicalizeCatalogJson({
    status: "invalid",
    rowNumber: 3,
    normalizedSku: sourceCommand.internalSku,
    errors: duplicateErrorSnapshot,
  }), "utf8");
  const hasDuplicateInvalidSku = options.valid && options.duplicateInvalidSku === true;

  await tenantTransaction(workspaceId, async (client) => {
    await client.query(
      "insert into public.workspace (id, name) values ($1::uuid, 'M1-08b Guard')",
      [workspaceId],
    );
    await client.query(
      "insert into public.user_identity (id, email) values ($1::uuid, $2)",
      [actorId, `${actorId}@m108b-guard.test`],
    );
    await client.query(`
      insert into public.membership (
        workspace_id, user_id, role, capabilities
      ) values ($1::uuid, $2::uuid, 'admin', '{}'::jsonb)
    `, [workspaceId, actorId]);

    let rowSensitiveBytes: number;
    if (validEnvelope) {
      const measured = await client.query<{ bytes: number }>(`
        select (
          pg_catalog.octet_length(pg_catalog.convert_to($1, 'UTF8'))
          + pg_catalog.octet_length(pg_catalog.convert_to($2::jsonb::text, 'UTF8'))
          + pg_catalog.octet_length($3::bytea)
          + pg_catalog.octet_length($4::bytea)
          + pg_catalog.octet_length($5::bytea)
          + pg_catalog.octet_length(pg_catalog.convert_to($6::jsonb::text, 'UTF8'))
          + pg_catalog.octet_length($7::bytea)
        )::integer as bytes
      `, [
        sourceCommand.internalSku,
        validEnvelope.command,
        validEnvelope.previewBody,
        validEnvelope.sourceBody,
        validEnvelope.rowBody,
        validEnvelope.targetSnapshot,
        validEnvelope.targetBody,
      ]);
      rowSensitiveBytes = (measured.rows[0]?.bytes ?? -1)
        + (hasDuplicateInvalidSku
          ? duplicatePreviewBody.byteLength + Buffer.byteLength("h0", "utf8")
          : 0);
    } else {
      rowSensitiveBytes = invalidPreviewBody.byteLength
        + Buffer.byteLength("h0", "utf8");
    }
    const measuredMapping = await client.query<{ bytes: number }>(`
      select pg_catalog.octet_length(
        pg_catalog.convert_to($1::jsonb::text, 'UTF8')
      )::integer as bytes
    `, [mapping]);
    const sensitivePayloadBytes = Buffer.byteLength("fixture.csv", "utf8")
      + (measuredMapping.rows[0]?.bytes ?? -1)
      + Buffer.byteLength(mappingBody, "utf8")
      + rowSensitiveBytes;

    await client.query(`
      insert into public.catalog_import_job (
        id, workspace_id, intent_id, reservation_key,
        file_name, file_size_bytes, file_sha256, encoding, delimiter,
        contract_version, parser_version, mapping_version,
        mapping_snapshot, mapping_body_canonical, mapping_sha256,
        total_count, valid_count, invalid_count, sensitive_payload_bytes,
        state, lease_generation, created_by,
        created_at, preview_expires_at, updated_at
      ) values (
        $1::uuid, $2::uuid, $3::uuid, $4::bytea,
        'fixture.csv', 128, $5::bytea, 'utf-8', ';',
        'catalog-csv-import.v1', 'papaparse-5.7.0-wmee.v1',
        'catalog-csv-column-mapping.v1',
        $6::jsonb, $7::bytea, $8::bytea,
        ($9::integer + $10::integer), $9::integer, $10::integer, $11::integer,
        'ready_for_review', $12::bigint, $13::uuid, $14::timestamptz,
        $14::timestamptz + interval '7 days', $14::timestamptz
      )
    `, [
      jobId,
      workspaceId,
      intentId,
      Buffer.from(sha256(`reservation:${jobId}`), "hex"),
      Buffer.from(fileSha256, "hex"),
      mapping,
      Buffer.from(mappingBody, "utf8"),
      Buffer.from(mappingSha256, "hex"),
      options.valid ? 1 : 0,
      options.valid ? (hasDuplicateInvalidSku ? 1 : 0) : 1,
      sensitivePayloadBytes,
      options.initialLeaseGeneration ?? 0,
      actorId,
      requestedCreatedAt,
    ]);

    if (validEnvelope) {
      await client.query(`
        insert into public.catalog_import_row (
          workspace_id, job_id, row_number, validation_status,
          normalized_sku, operation, command_snapshot,
          preview_row_body_canonical, source_command_body_canonical,
          row_command_body_canonical,
          row_sha256, source_command_sha256, row_command_sha256,
          target_component_id, sealed_target_snapshot,
          sealed_target_body_canonical, target_snapshot_sha256,
          sensitive_payload_bytes, created_at
        ) values (
          $1::uuid, $2::uuid, 2, 'valid',
          $3, 'create', $4::jsonb, $5::bytea, $6::bytea, $7::bytea,
          $8::bytea, $9::bytea, $10::bytea,
          $11::uuid, $12::jsonb, $13::bytea, $14::bytea, 0,
          $15::timestamptz
        )
      `, [
        workspaceId,
        jobId,
        sourceCommand.internalSku,
        validEnvelope.command,
        validEnvelope.previewBody,
        validEnvelope.sourceBody,
        validEnvelope.rowBody,
        Buffer.from(validEnvelope.rowSha256, "hex"),
        Buffer.from(validEnvelope.sourceSha256, "hex"),
        Buffer.from(validEnvelope.rowCommandSha256, "hex"),
        validEnvelope.componentId,
        validEnvelope.targetSnapshot,
        validEnvelope.targetBody,
        Buffer.from(validEnvelope.targetSha256, "hex"),
        requestedCreatedAt,
      ]);
      if (hasDuplicateInvalidSku) {
        await client.query(`
          insert into public.catalog_import_row (
            workspace_id, job_id, row_number, validation_status,
            normalized_sku, preview_row_body_canonical, row_sha256,
            error_snapshot, sensitive_payload_bytes, created_at
          ) values (
            $1::uuid, $2::uuid, 3, 'invalid', $3,
            $4::bytea, pg_catalog.sha256($4::bytea), $5::jsonb, 0,
            $6::timestamptz
          )
        `, [
          workspaceId,
          jobId,
          sourceCommand.internalSku,
          duplicatePreviewBody,
          JSON.stringify(duplicateErrorSnapshot),
          requestedCreatedAt,
        ]);
      }
    } else {
      await client.query(`
        insert into public.catalog_import_row (
          workspace_id, job_id, row_number, validation_status,
          preview_row_body_canonical, row_sha256,
          error_snapshot, sensitive_payload_bytes, created_at
        ) values (
          $1::uuid, $2::uuid, $3::integer, 'invalid',
          $4::bytea, pg_catalog.sha256($4::bytea), $5::jsonb, 0,
          $6::timestamptz
        )
      `, [
        workspaceId,
        jobId,
        options.rowNumber ?? 2,
        invalidPreviewBody,
        JSON.stringify(errorSnapshot),
        requestedCreatedAt,
      ]);
    }
    await client.query(`
      with derived as (
        select job.workspace_id, job.id,
          (
           pg_catalog.octet_length(pg_catalog.convert_to(job.file_name, 'UTF8'))
           + pg_catalog.octet_length(pg_catalog.convert_to(
             job.mapping_snapshot::text,
             'UTF8'
           ))
           + pg_catalog.octet_length(job.mapping_body_canonical)
           + (
             select pg_catalog.sum(import_row.sensitive_payload_bytes)::integer
               from public.catalog_import_row as import_row
              where import_row.workspace_id = job.workspace_id
                and import_row.job_id = job.id
           )
          )::integer as payload_bytes
          from public.catalog_import_job as job
         where job.workspace_id = $1::uuid and job.id = $2::uuid
      )
      update public.catalog_import_job as job
         set sensitive_payload_bytes = derived.payload_bytes
        from derived
       where job.workspace_id = derived.workspace_id
         and job.id = derived.id
         and job.sensitive_payload_bytes is distinct from derived.payload_bytes
    `, [workspaceId, jobId]);
  });
  if (options.oldEnough) {
    const client = await superuserPool().connect();
    try {
      await client.query("begin");
      await client.query(
        "select set_config('app.workspace_id', $1, true)",
        [workspaceId],
      );
      // Test-only historical seed: production INSERT/UPDATE guards stay active
      // for the behavior exercised after this transaction.
      await client.query("set local session_replication_role = replica");
      await client.query(`
        update public.catalog_import_job
           set created_at = $3::timestamptz,
               updated_at = $3::timestamptz,
               preview_expires_at = $3::timestamptz + interval '7 days'
         where workspace_id = $1::uuid and id = $2::uuid
      `, [workspaceId, jobId, historicalCreatedAt]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  return { workspaceId, actorId, jobId, valid: options.valid };
}

async function queueJob(fixture: Fixture): Promise<void> {
  await tenantTransaction(fixture.workspaceId, async (client) => {
    await client.query(`
      update public.catalog_import_job
         set state = 'queued',
             execution_actor_id = $3::uuid,
             attestation_version = 'catalog-import-rights-attestation.v1',
             attestation_text_sha256 = decode($4, 'hex'),
             attested_by = $3::uuid,
             attested_at = pg_catalog.transaction_timestamp(),
             started_at = pg_catalog.transaction_timestamp(),
             next_attempt_at = pg_catalog.transaction_timestamp(),
             updated_at = pg_catalog.transaction_timestamp()
       where workspace_id = $1::uuid and id = $2::uuid
    `, [fixture.workspaceId, fixture.jobId, fixture.actorId, ATTESTATION_SHA256]);
  });
}

async function claimJob(fixture: Fixture): Promise<void> {
  await tenantTransaction(fixture.workspaceId, async (client) => {
    await client.query(`
      update public.catalog_import_job
         set state = 'running',
             lease_generation = lease_generation + 1,
             lease_token = $3::uuid,
             lease_row_numbers = ARRAY[2]::integer[],
             lease_expires_at = pg_catalog.transaction_timestamp() + interval '3 minutes',
             next_attempt_at = null,
             updated_at = pg_catalog.transaction_timestamp()
       where workspace_id = $1::uuid and id = $2::uuid
    `, [fixture.workspaceId, fixture.jobId, randomUUID()]);
  });
}

async function startJobViaGateway(
  fixture: Fixture,
): Promise<Record<string, unknown>> {
  const result = await tenantTransaction(fixture.workspaceId, async (client) => {
    await client.query(
      "select set_config('app.actor_id', $1, true)",
      [fixture.actorId],
    );
    return client.query<{ result: Record<string, unknown> }>(`
      select public.start_catalog_import_v1(
        $1::uuid,
        $2::uuid,
        'catalog-import-rights-attestation.v1'
      ) as result
    `, [fixture.workspaceId, fixture.jobId]);
  });
  const gatewayResult = result.rows[0]?.result;
  if (!gatewayResult) throw new Error("Start-Gateway lieferte kein Ergebnis.");
  return gatewayResult;
}

async function probeStartJobViaGateway(
  fixture: Fixture,
): Promise<Record<string, unknown>> {
  const client = await testPool.connect();
  try {
    await client.query("begin");
    await client.query(
      "select set_config('app.workspace_id', $1, true), set_config('app.actor_id', $2, true)",
      [fixture.workspaceId, fixture.actorId],
    );
    const result = await client.query<{ result: Record<string, unknown> }>(`
      select public.start_catalog_import_v1(
        $1::uuid,
        $2::uuid,
        'catalog-import-rights-attestation.v1'
      ) as result
    `, [fixture.workspaceId, fixture.jobId]);
    await client.query("set constraints all immediate");
    await client.query("rollback");
    const gatewayResult = result.rows[0]?.result;
    if (!gatewayResult) throw new Error("Start-Probe lieferte kein Ergebnis.");
    return gatewayResult;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function claimJobViaGateway(
  fixture: Fixture,
  dispatchId: string,
): Promise<Record<string, unknown>> {
  const result = await tenantTransaction(
    fixture.workspaceId,
    (client) => client.query<{ result: Record<string, unknown> }>(`
      select public.claim_catalog_import_v1(
        $1::uuid, $2::uuid, $3::uuid, 25
      ) as result
    `, [fixture.workspaceId, fixture.jobId, dispatchId]),
  );
  const gatewayResult = result.rows[0]?.result;
  if (!gatewayResult) throw new Error("Claim-Gateway lieferte kein Ergebnis.");
  return gatewayResult;
}

async function cancelJob(fixture: Fixture): Promise<Date> {
  return tenantTransaction(fixture.workspaceId, async (client) => {
    const result = await client.query<{ due: Date }>(`
      update public.catalog_import_job
         set state = 'cancelled_before_start',
             terminal_at = pg_catalog.transaction_timestamp(),
             snapshot_cleanup_due_at = greatest(
               created_at + interval '30 days',
               pg_catalog.transaction_timestamp()
             ),
             updated_at = pg_catalog.transaction_timestamp()
       where workspace_id = $1::uuid and id = $2::uuid
       returning snapshot_cleanup_due_at as due
    `, [fixture.workspaceId, fixture.jobId]);
    const due = result.rows[0]?.due;
    if (!due) throw new Error("Cleanup-Due fehlt.");
    return due;
  });
}

async function redactInvalidJob(
  client: PoolClient,
  fixture: Fixture,
  redactionTime: Date,
  mutateError: boolean,
  mutateMetadata: boolean,
): Promise<void> {
  const redactedError = mutateError
    ? [{
        field: "internalSku",
        sourceHeader: null,
        code: "invalid_value",
        message: "Der Wert entspricht nicht dem Importvertrag.",
      }]
    : [{
        field: "internalSku",
        sourceHeader: null,
        code: "missing_value",
        message: "Ein benoetigter Wert fehlt.",
      }];
  await client.query(`
    update public.catalog_import_row
       set preview_row_body_canonical = null,
           error_snapshot = $3::jsonb,
           snapshot_redacted_at = $4::timestamptz
     where workspace_id = $1::uuid and job_id = $2::uuid
  `, [fixture.workspaceId, fixture.jobId, JSON.stringify(redactedError), redactionTime]);
  await client.query(`
    update public.catalog_import_job
       set file_name = null,
           mapping_snapshot = null,
           mapping_body_canonical = null,
           sensitive_payload_bytes = 0,
           snapshot_redacted_at = $3::timestamptz,
           lease_generation = lease_generation + $4::bigint
     where workspace_id = $1::uuid and id = $2::uuid
  `, [fixture.workspaceId, fixture.jobId, redactionTime, mutateMetadata ? 1 : 0]);
}

describe("M1-08b catalog-import WORM and lease guards", () => {
  it("weist semantisch gleiches, aber nicht katalogkanonisches Preview-JavaScript ab", async () => {
    await expect(createFixture({
      valid: false,
      nonCanonicalPreviewBody: true,
    })).rejects.toThrow();
  });

  it("weist mehrdimensionale oder nicht kanonisch indizierte Leasearrays ab", async () => {
    const result = await testPool.query<{
      matrix: boolean;
      shifted: boolean;
      canonical: boolean;
    }>(`
      select public._m108b_valid_catalog_import_lease_rows(
               ARRAY[[2, 3]]::integer[]
             ) as matrix,
             public._m108b_valid_catalog_import_lease_rows(
               '[0:1]={2,3}'::integer[]
             ) as shifted,
             public._m108b_valid_catalog_import_lease_rows(
               ARRAY[2, 3]::integer[]
             ) as canonical
    `);
    expect(result.rows[0]).toEqual({
      matrix: false,
      shifted: false,
      canonical: true,
    });
  });

  it("weist nicht-normalisierte Mappingheader DB-seitig zurück", async () => {
    const fullwidth = structuredClone(mapping);
    fullwidth.columns[0]!.sourceHeader = "Ａ";
    const leadingTab = structuredClone(mapping);
    leadingTab.columns[0]!.sourceHeader = "\tHeader";
    const result = await testPool.query<{
      canonical: boolean;
      fullwidth: boolean;
      leadingTab: boolean;
    }>(`
      select public._m108b_valid_catalog_import_mapping($1::jsonb) as canonical,
             public._m108b_valid_catalog_import_mapping($2::jsonb) as fullwidth,
             public._m108b_valid_catalog_import_mapping($3::jsonb) as "leadingTab"
    `, [mapping, fullwidth, leadingTab]);
    expect(result.rows[0]).toEqual({
      canonical: true,
      fullwidth: false,
      leadingTab: false,
    });
  });

  it("weist nicht lueckenlose Preview-Row-Nummern deferred zurück", async () => {
    await expect(createFixture({ valid: false, rowNumber: 4 })).rejects.toThrow();
  });

  it("weist valid-plus-invalid fuer dieselbe Datei-SKU deferred zurück", async () => {
    await expect(createFixture({
      valid: true,
      duplicateInvalidSku: true,
    })).rejects.toThrow();
  });

  it("ersetzt callergewaehlte Insertzeiten durch eine DB-Zeitbindung", async () => {
    const earliest = Date.now();
    const fixture = await createFixture({ valid: false });
    const result = await tenantTransaction(fixture.workspaceId, (client) => client.query<{
      createdAt: Date;
      updatedAt: Date;
      previewExpiresAt: Date;
      rowCreatedAt: Date;
    }>(`
      select job.created_at as "createdAt", job.updated_at as "updatedAt",
             job.preview_expires_at as "previewExpiresAt",
             import_row.created_at as "rowCreatedAt"
        from public.catalog_import_job as job
        join public.catalog_import_row as import_row
          on import_row.workspace_id = job.workspace_id
         and import_row.job_id = job.id
       where job.workspace_id = $1::uuid and job.id = $2::uuid
    `, [fixture.workspaceId, fixture.jobId]));
    const row = result.rows[0];
    expect(row?.createdAt.getTime()).toBeGreaterThanOrEqual(earliest);
    expect(row?.updatedAt.getTime()).toBe(row?.createdAt.getTime());
    expect(row?.rowCreatedAt.getTime()).toBe(row?.createdAt.getTime());
    expect((row?.previewExpiresAt.getTime() ?? 0) - (row?.createdAt.getTime() ?? 0))
      .toBe(7 * 86_400_000);
  });

  it("weist nicht-initiale Executionmetadaten schon beim Preview-Insert ab", async () => {
    await expect(createFixture({
      valid: false,
      initialLeaseGeneration: 7,
    })).rejects.toThrow();
  });

  it("isoliert reale Reads und Writes fail-closed nach Workspace", async () => {
    const own = await createFixture({ valid: false });
    const foreign = await createFixture({ valid: false });
    const ownView = await tenantTransaction(own.workspaceId, (client) => client.query<{
      id: string;
    }>(`
      select id
        from public.catalog_import_job
       where id = any($1::uuid[])
       order by id
    `, [[own.jobId, foreign.jobId]]));
    expect(ownView.rows).toEqual([{ id: own.jobId }]);

    const foreignUpdate = await tenantTransaction(own.workspaceId, (client) => client.query(`
      update public.catalog_import_job
         set lease_generation = lease_generation + 1
       where id = $1::uuid
    `, [foreign.jobId]));
    expect(foreignUpdate.rowCount).toBe(0);

    const noTenant = await testPool.connect();
    try {
      await noTenant.query("begin");
      await noTenant.query("select set_config('app.workspace_id', '', true)");
      const hidden = await noTenant.query<{ count: number }>(`
        select pg_catalog.count(*)::integer as count
          from public.catalog_import_job
         where id = any($1::uuid[])
      `, [[own.jobId, foreign.jobId]]);
      expect(hidden.rows[0]?.count).toBe(0);
      await noTenant.query("rollback");
    } finally {
      await noTenant.query("rollback").catch(() => undefined);
      noTenant.release();
    }
  });

  it("weist Same-State-Metadatenmutation ab", async () => {
    const fixture = await createFixture({ valid: false });
    const error = await captureRejected(fixture.workspaceId, async (client) => {
      await client.query(`
        update public.catalog_import_job
           set lease_generation = lease_generation + 5
         where workspace_id = $1::uuid and id = $2::uuid
      `, [fixture.workspaceId, fixture.jobId]);
    });
    expect(error).not.toBeNull();
  });

  it("weist Generation-Spruenge und doppelte Leasezeilen beim Claim ab", async () => {
    const fixture = await createFixture({ valid: true });
    await queueJob(fixture);
    const error = await captureRejected(fixture.workspaceId, async (client) => {
      await client.query(`
        update public.catalog_import_job
           set state = 'running',
               lease_generation = lease_generation + 2,
               lease_token = $3::uuid,
               lease_row_numbers = ARRAY[2, 2]::integer[],
               lease_expires_at = pg_catalog.transaction_timestamp() + interval '3 minutes',
               next_attempt_at = null,
               updated_at = pg_catalog.transaction_timestamp()
         where workspace_id = $1::uuid and id = $2::uuid
      `, [fixture.workspaceId, fixture.jobId, randomUUID()]);
    });
    expect(error).not.toBeNull();
  });

  it("weist callerbehauptete Erfolgs- und Teilzustände ohne DB-Resultate ab", async () => {
    for (const state of ["succeeded", "partial"] as const) {
      const fixture = await createFixture({ valid: true });
      await queueJob(fixture);
      await claimJob(fixture);
      const error = await captureRejected(fixture.workspaceId, async (client) => {
        await client.query(`
          update public.catalog_import_job
             set state = $3,
                 lease_token = null,
                 lease_row_numbers = null,
                 lease_expires_at = null,
                 consecutive_failure_count = 0,
                 next_attempt_at = null,
                 updated_at = pg_catalog.transaction_timestamp()
           where workspace_id = $1::uuid and id = $2::uuid
        `, [fixture.workspaceId, fixture.jobId, state]);
      });
      expect(error).not.toBeNull();
    }
  });

  it("erlaubt all_rows_conflicted nur mit genau allen DB-Conflictresultaten", async () => {
    const fixture = await createFixture({ valid: true });
    await queueJob(fixture);
    await claimJob(fixture);
    const missingResultError = await captureRejected(
      fixture.workspaceId,
      async (client) => {
        await client.query(`
          update public.catalog_import_job
             set state = 'failed_final', error_code = 'all_rows_conflicted',
                 lease_token = null, lease_row_numbers = null,
                 lease_expires_at = null, consecutive_failure_count = 0,
                 next_attempt_at = null,
                 updated_at = pg_catalog.transaction_timestamp()
           where workspace_id = $1::uuid and id = $2::uuid
        `, [fixture.workspaceId, fixture.jobId]);
      },
    );
    expect(missingResultError).not.toBeNull();

    const earliestResultTime = Date.now();
    await tenantTransaction(fixture.workspaceId, async (client) => {
      await client.query(`
        insert into public.catalog_import_row_result (
          workspace_id, job_id, row_number, result_state, error_code, created_at
        ) values (
          $1::uuid, $2::uuid, 2, 'conflict', 'status_drift',
          '2001-01-01T00:00:00.000Z'::timestamptz
        )
      `, [fixture.workspaceId, fixture.jobId]);
      await client.query(`
        update public.catalog_import_job
           set state = 'failed_final', error_code = 'all_rows_conflicted',
               lease_token = null, lease_row_numbers = null,
               lease_expires_at = null, consecutive_failure_count = 0,
               next_attempt_at = null,
               updated_at = pg_catalog.transaction_timestamp()
         where workspace_id = $1::uuid and id = $2::uuid
      `, [fixture.workspaceId, fixture.jobId]);
    });
    const result = await tenantTransaction(
      fixture.workspaceId,
      (client) => client.query<{
        state: string;
        errorCode: string;
        resultCreatedAt: Date;
      }>(`
        select job.state, job.error_code as "errorCode",
               result.created_at as "resultCreatedAt"
          from public.catalog_import_job as job
          join public.catalog_import_row_result as result
            on result.workspace_id = job.workspace_id
           and result.job_id = job.id
         where job.workspace_id = $1::uuid and job.id = $2::uuid
      `, [fixture.workspaceId, fixture.jobId]),
    );
    expect(result.rows[0]).toMatchObject({
      state: "failed_final",
      errorCode: "all_rows_conflicted",
    });
    expect(result.rows[0]?.resultCreatedAt.getTime()).toBeGreaterThanOrEqual(
      earliestResultTime,
    );
  });

  it("weist Resultate fuer invalid Previewzeilen ab", async () => {
    const fixture = await createFixture({ valid: false });
    const error = await captureRejected(fixture.workspaceId, async (client) => {
      await client.query(`
        insert into public.catalog_import_row_result (
          workspace_id, job_id, row_number, result_state, error_code
        ) values ($1::uuid, $2::uuid, 2, 'conflict', 'status_drift')
      `, [fixture.workspaceId, fixture.jobId]);
    });
    expect(error).not.toBeNull();
  });

  it("weist callergewaehlte Zukunftszeit fuer vorzeitige Redaction ab", async () => {
    const fixture = await createFixture({ valid: false });
    const due = await cancelJob(fixture);
    const error = await captureRejected(fixture.workspaceId, (client) => (
      redactInvalidJob(client, fixture, due, false, false)
    ));
    expect(error).not.toBeNull();
  });

  it("weist Fehlerhistorien- und Terminalmetadatenmutation bei Redaction ab", async () => {
    const fixture = await createFixture({ valid: false, oldEnough: true });
    await cancelJob(fixture);
    const error = await captureRejected(fixture.workspaceId, (client) => (
      redactInvalidJob(client, fixture, new Date(), true, true)
    ));
    expect(error).not.toBeNull();
  });

  it("erlaubt nach Due ausschließlich die deterministische Vollredaction", async () => {
    const fixture = await createFixture({ valid: false, oldEnough: true });
    await cancelJob(fixture);
    await tenantTransaction(fixture.workspaceId, (client) => (
      redactInvalidJob(client, fixture, new Date(), false, false)
    ));
    const result = await tenantTransaction(fixture.workspaceId, (client) => client.query<{
      jobRedactedAt: Date;
      rowRedactedAt: Date;
      sourceHeader: string | null;
      code: string;
    }>(`
      select job.snapshot_redacted_at as "jobRedactedAt",
             import_row.snapshot_redacted_at as "rowRedactedAt",
             import_row.error_snapshot#>>'{0,sourceHeader}' as "sourceHeader",
             import_row.error_snapshot#>>'{0,code}' as code
        from public.catalog_import_job as job
        join public.catalog_import_row as import_row
          on import_row.workspace_id = job.workspace_id
         and import_row.job_id = job.id
       where job.workspace_id = $1::uuid and job.id = $2::uuid
    `, [fixture.workspaceId, fixture.jobId]));
    expect(result.rows[0]).toMatchObject({
      sourceHeader: null,
      code: "missing_value",
    });
    expect(result.rows[0]?.jobRedactedAt.getTime())
      .toBe(result.rows[0]?.rowRedactedAt.getTime());
  });

  it("führt den Gateway-Lebenszyklus idempotent bis zum versiegelten Katalogeintrag aus", async () => {
    const fixture = await createFixture({ valid: true });
    const dispatchId = randomUUID();

    const start = await tenantTransaction(fixture.workspaceId, async (client) => {
      await client.query(
        "select set_config('app.actor_id', $1, true)",
        [fixture.actorId],
      );
      return client.query<{ result: Record<string, unknown> }>(`
        select public.start_catalog_import_v1(
          $1::uuid,
          $2::uuid,
          'catalog-import-rights-attestation.v1'
        ) as result
      `, [fixture.workspaceId, fixture.jobId]);
    });
    expect(start.rows[0]?.result).toMatchObject({
      status: "queued",
      importId: fixture.jobId,
      replayed: false,
      dispatchRequired: true,
    });

    const startReplay = await tenantTransaction(
      fixture.workspaceId,
      async (client) => {
        await client.query(
          "select set_config('app.actor_id', $1, true)",
          [fixture.actorId],
        );
        return client.query<{ result: Record<string, unknown> }>(`
          select public.start_catalog_import_v1(
            $1::uuid,
            $2::uuid,
            'catalog-import-rights-attestation.v1'
          ) as result
        `, [fixture.workspaceId, fixture.jobId]);
      },
    );
    expect(startReplay.rows[0]?.result).toMatchObject({
      status: "replayed",
      state: "queued",
      importId: fixture.jobId,
      dispatchRequired: true,
    });

    const claim = await tenantTransaction(
      fixture.workspaceId,
      (client) => client.query<{ result: Record<string, unknown> }>(`
        select public.claim_catalog_import_v1(
          $1::uuid, $2::uuid, $3::uuid, 25
        ) as result
      `, [fixture.workspaceId, fixture.jobId, dispatchId]),
    );
    expect(claim.rows[0]?.result).toMatchObject({
      status: "claimed",
      importId: fixture.jobId,
      leaseToken: dispatchId,
      leaseGeneration: "1",
      rowNumbers: [2],
      replayed: false,
    });

    const applied = await tenantTransaction(
      fixture.workspaceId,
      (client) => client.query<{ result: Record<string, unknown> }>(`
        select public.apply_catalog_import_row_v1(
          $1::uuid, $2::uuid, 2, $3::uuid, 1::bigint
        ) as result
      `, [fixture.workspaceId, fixture.jobId, dispatchId]),
    );
    expect(applied.rows[0]?.result).toMatchObject({
      status: "created",
      importId: fixture.jobId,
      rowNumber: 2,
      revision: 1,
      replayed: false,
    });

    const appliedReplay = await tenantTransaction(
      fixture.workspaceId,
      (client) => client.query<{ result: Record<string, unknown> }>(`
        select public.apply_catalog_import_row_v1(
          $1::uuid, $2::uuid, 2, $3::uuid, 1::bigint
        ) as result
      `, [fixture.workspaceId, fixture.jobId, dispatchId]),
    );
    expect(appliedReplay.rows[0]?.result).toMatchObject({
      status: "created",
      importId: fixture.jobId,
      rowNumber: 2,
      revision: 1,
      replayed: true,
    });

    const completed = await tenantTransaction(
      fixture.workspaceId,
      (client) => client.query<{ result: Record<string, unknown> }>(`
        select public.complete_catalog_import_batch_v1(
          $1::uuid, $2::uuid, $3::uuid, 1::bigint
        ) as result
      `, [fixture.workspaceId, fixture.jobId, dispatchId]),
    );
    expect(completed.rows[0]?.result).toMatchObject({
      status: "succeeded",
      importId: fixture.jobId,
      leaseGeneration: "1",
      resultCount: 1,
      successCount: 1,
      conflictCount: 0,
      replayed: false,
    });

    const completionReplay = await tenantTransaction(
      fixture.workspaceId,
      (client) => client.query<{ result: Record<string, unknown> }>(`
        select public.complete_catalog_import_batch_v1(
          $1::uuid, $2::uuid, $3::uuid, 1::bigint
        ) as result
      `, [fixture.workspaceId, fixture.jobId, dispatchId]),
    );
    expect(completionReplay.rows[0]?.result).toMatchObject({
      status: "succeeded",
      importId: fixture.jobId,
      leaseGeneration: "1",
      replayed: true,
    });

    const persisted = await tenantTransaction(
      fixture.workspaceId,
      (client) => client.query<{
        jobState: string;
        resultState: string;
        currentRevision: number;
        eventCount: number;
        auditCount: number;
      }>(`
        select job.state as "jobState",
               result.result_state as "resultState",
               component.current_revision as "currentRevision",
               (
                 select pg_catalog.count(*)::integer
                   from public.domain_events as event
                  where event.workspace_id = job.workspace_id
                    and event.aggregate_id = component.id
                    and event.event_type = 'catalog.component_created'
               ) as "eventCount",
               (
                 select pg_catalog.count(*)::integer
                   from public.audit_log as audit
                  where audit.workspace_id = job.workspace_id
                    and audit.action = 'catalog.import'
                    and audit.details->>'importId' = job.id::text
               ) as "auditCount"
          from public.catalog_import_job as job
          join public.catalog_import_row_result as result
            on result.workspace_id = job.workspace_id
           and result.job_id = job.id
          join public.catalog_component as component
            on component.workspace_id = result.workspace_id
           and component.id = result.component_id
         where job.workspace_id = $1::uuid and job.id = $2::uuid
      `, [fixture.workspaceId, fixture.jobId]),
    );
    expect(persisted.rows[0]).toEqual({
      jobState: "succeeded",
      resultState: "created",
      currentRevision: 1,
      eventCount: 1,
      auditCount: 1,
    });
  });

  it("reserviert ein validiertes Prepare-Image idempotent und sperrt Intent-Drift", async () => {
    const actorFixture = await createFixture({ valid: false });
    const intentId = randomUUID();
    const envelope = validRowCommand(actorFixture.workspaceId);
    const prepare = {
      schemaVersion: "catalog-import-prepare.v1",
      file: {
        filename: "synthetischer-katalog.csv",
        sizeBytes: 128,
        sha256: fileSha256,
        encoding: "utf-8",
        delimiter: ";",
        parserVersion: "papaparse-5.7.0-wmee.v1",
        rowCount: 1,
      },
      mapping,
      rows: [{ status: "valid", command: envelope.command }],
    };
    const invokePrepare = (value: Record<string, unknown>) => tenantTransaction(
      actorFixture.workspaceId,
      async (client) => {
        await client.query(
          "select set_config('app.actor_id', $1, true)",
          [actorFixture.actorId],
        );
        return client.query<{ result: Record<string, unknown> }>(`
          select public.prepare_catalog_import_v1(
            $1::uuid, $2::uuid, $3::jsonb
          ) as result
        `, [actorFixture.workspaceId, intentId, JSON.stringify(value)]);
      },
    );

    const prepared = await invokePrepare(prepare);
    expect(prepared.rows[0]?.result).toMatchObject({
      status: "ready_for_review",
      intentId,
      totalCount: 1,
      validCount: 1,
      invalidCount: 0,
      replayed: false,
    });
    const importId = prepared.rows[0]?.result.importId;
    expect(importId).toEqual(expect.any(String));

    const replay = await invokePrepare(prepare);
    expect(replay.rows[0]?.result).toMatchObject({
      status: "ready_for_review",
      importId,
      intentId,
      totalCount: 1,
      validCount: 1,
      invalidCount: 0,
      replayed: true,
    });

    const driftedPrepare = structuredClone(prepare);
    driftedPrepare.file.sizeBytes += 1;
    const conflict = await invokePrepare(driftedPrepare);
    expect(conflict.rows[0]?.result).toEqual({
      status: "conflict",
      code: "intent_reused",
    });

    const persisted = await tenantTransaction(
      actorFixture.workspaceId,
      (client) => client.query<{
        jobCount: number;
        rowCount: number;
        sensitivePayloadBytes: number;
      }>(`
        select pg_catalog.count(distinct job.id)::integer as "jobCount",
               pg_catalog.count(import_row.row_number)::integer as "rowCount",
               pg_catalog.max(job.sensitive_payload_bytes)::integer
                 as "sensitivePayloadBytes"
          from public.catalog_import_job as job
          join public.catalog_import_row as import_row
            on import_row.workspace_id = job.workspace_id
           and import_row.job_id = job.id
         where job.workspace_id = $1::uuid
           and job.intent_id = $2::uuid
      `, [actorFixture.workspaceId, intentId]),
    );
    expect(persisted.rows[0]).toMatchObject({ jobCount: 1, rowCount: 1 });
    expect(persisted.rows[0]?.sensitivePayloadBytes).toBeGreaterThan(0);
  });

  it("weist manipulierte Datei-Metadaten kontrolliert mit 22023 ab", async () => {
    const actorFixture = await createFixture({ valid: false });
    const envelope = validRowCommand(actorFixture.workspaceId);
    const prepare = {
      schemaVersion: "catalog-import-prepare.v1",
      file: {
        filename: "synthetischer-katalog.csv",
        sizeBytes: 128,
        sha256: fileSha256,
        encoding: "utf-8",
        delimiter: ";",
        parserVersion: "papaparse-5.7.0-wmee.v1",
        rowCount: 1,
      },
      mapping,
      rows: [{ status: "valid", command: envelope.command }],
    };
    const invokePrepare = (value: Record<string, unknown>) => tenantTransaction(
      actorFixture.workspaceId,
      async (client) => {
        await client.query(
          "select set_config('app.actor_id', $1, true)",
          [actorFixture.actorId],
        );
        return client.query(`
          select public.prepare_catalog_import_v1(
            $1::uuid, $2::uuid, $3::jsonb
          )
        `, [actorFixture.workspaceId, randomUUID(), JSON.stringify(value)]);
      },
    );
    const bidiCodePoints = [
      0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
      0x2066, 0x2067, 0x2068, 0x2069,
    ];
    const invalidFilePatches: Array<Record<string, unknown>> = [
      { encoding: null },
      { delimiter: null },
      { filename: "x\n.csv" },
      { filename: "x\u007f.csv" },
      { filename: `${String.fromCodePoint(0x1680)}x.csv` },
      ...bidiCodePoints.map((codePoint) => ({
        filename: `x${String.fromCodePoint(codePoint)}.csv`,
      })),
    ];

    for (const filePatch of invalidFilePatches) {
      const candidate = structuredClone(prepare) as Record<string, unknown> & {
        file: Record<string, unknown>;
      };
      Object.assign(candidate.file, filePatch);
      await expect(invokePrepare(candidate)).rejects.toMatchObject({
        code: "22023",
      });
    }
  });

  it("weist korrupte Unchanged- und Revise-Wahrheit beim Start ab", async () => {
    const actorFixture = await createFixture({ valid: false });
    const expectedRevision = validRowCommand(actorFixture.workspaceId);
    await tenantTransaction(actorFixture.workspaceId, async (client) => {
      await client.query(
        "select set_config('app.actor_id', $1, true)",
        [actorFixture.actorId],
      );
      await client.query(`
        insert into public.catalog_component (
          id, workspace_id, internal_sku, component_type, created_by
        ) values ($1::uuid, $2::uuid, $3::text, $4::text, $5::uuid)
      `, [
        expectedRevision.componentId,
        actorFixture.workspaceId,
        sourceCommand.internalSku,
        sourceCommand.componentType,
        actorFixture.actorId,
      ]);
      await client.query(`
        insert into public.catalog_component_revision (
          id, workspace_id, component_id, revision, component_type,
          schema_version, canonicalization_version, revision_snapshot,
          snapshot_sha256, created_by
        ) values (
          $1::uuid, $2::uuid, $3::uuid, 1, $4::text,
          'catalog-component-revision.v1', 'catalog-jcs.v1', $5::jsonb,
          $6::bytea, $7::uuid
        )
      `, [
        randomUUID(),
        actorFixture.workspaceId,
        expectedRevision.componentId,
        sourceCommand.componentType,
        expectedRevision.targetSnapshot,
        Buffer.from(expectedRevision.targetSha256, "hex"),
        actorFixture.actorId,
      ]);
    });

    const cases = [
      {
        valid: existingRowCommand(
          actorFixture.workspaceId,
          expectedRevision,
          "unchanged",
          sourceCommand.presentation.displayName,
        ),
        corrupt: existingRowCommand(
          actorFixture.workspaceId,
          expectedRevision,
          "unchanged",
          "Semantisch abweichender Unchanged-Stand",
        ),
        operation: "unchanged" as const,
      },
      {
        valid: existingRowCommand(
          actorFixture.workspaceId,
          expectedRevision,
          "revise",
          "Legitime Revision",
        ),
        corrupt: existingRowCommand(
          actorFixture.workspaceId,
          expectedRevision,
          "revise",
          sourceCommand.presentation.displayName,
        ),
        operation: "revise" as const,
      },
    ];

    for (const candidate of cases) {
      const prepared = await tenantTransaction(
        actorFixture.workspaceId,
        async (client) => {
          await client.query(
            "select set_config('app.actor_id', $1, true)",
            [actorFixture.actorId],
          );
          return client.query<{ result: Record<string, unknown> }>(`
            select public.prepare_catalog_import_v1(
              $1::uuid, $2::uuid, $3::jsonb
            ) as result
          `, [
            actorFixture.workspaceId,
            randomUUID(),
            JSON.stringify({
              schemaVersion: "catalog-import-prepare.v1",
              file: {
                filename: `${candidate.operation}.csv`,
                sizeBytes: 128,
                sha256: fileSha256,
                encoding: "utf-8",
                delimiter: ";",
                parserVersion: "papaparse-5.7.0-wmee.v1",
                rowCount: 1,
              },
              mapping,
              rows: [{ status: "valid", command: candidate.valid.command }],
            }),
          ]);
        },
      );
      const importId = prepared.rows[0]?.result.importId;
      expect(importId).toEqual(expect.any(String));
      const preparedFixture = {
        workspaceId: actorFixture.workspaceId,
        actorId: actorFixture.actorId,
        jobId: String(importId),
        valid: true,
      };
      expect(await probeStartJobViaGateway(preparedFixture)).toMatchObject({
        status: "queued",
        importId,
        replayed: false,
        dispatchRequired: true,
      });

      const adminClient = await superuserPool().connect();
      try {
        await adminClient.query("begin");
        await adminClient.query("set local session_replication_role = replica");
        await adminClient.query(`
          update public.catalog_import_row
             set command_snapshot = $3::jsonb,
                 preview_row_body_canonical = $4::bytea,
                 source_command_body_canonical = $5::bytea,
                 row_command_body_canonical = $6::bytea,
                 row_sha256 = $7::bytea,
                 source_command_sha256 = $8::bytea,
                 row_command_sha256 = $9::bytea,
                 sealed_target_snapshot = $10::jsonb,
                 sealed_target_body_canonical = $11::bytea,
                 target_snapshot_sha256 = $12::bytea
           where workspace_id = $1::uuid and job_id = $2::uuid
        `, [
          actorFixture.workspaceId,
          importId,
          JSON.stringify(candidate.corrupt.command),
          candidate.corrupt.previewBody,
          candidate.corrupt.sourceBody,
          candidate.corrupt.rowBody,
          Buffer.from(candidate.corrupt.rowSha256, "hex"),
          Buffer.from(candidate.corrupt.sourceSha256, "hex"),
          Buffer.from(candidate.corrupt.rowCommandSha256, "hex"),
          candidate.operation === "unchanged"
            ? null
            : JSON.stringify(candidate.corrupt.targetSnapshot),
          candidate.operation === "unchanged" ? null : candidate.corrupt.targetBody,
          Buffer.from(candidate.corrupt.targetSha256, "hex"),
        ]);
        await adminClient.query(`
          update public.catalog_import_row
             set sensitive_payload_bytes = (
               coalesce(pg_catalog.octet_length(pg_catalog.convert_to(
                 normalized_sku, 'UTF8'
               )), 0)
               + coalesce(pg_catalog.octet_length(pg_catalog.convert_to(
                 command_snapshot::text, 'UTF8'
               )), 0)
               + coalesce(pg_catalog.octet_length(preview_row_body_canonical), 0)
               + coalesce(pg_catalog.octet_length(source_command_body_canonical), 0)
               + coalesce(pg_catalog.octet_length(row_command_body_canonical), 0)
               + public._m108b_catalog_import_error_source_header_bytes(
                   error_snapshot
                 )
               + coalesce(pg_catalog.octet_length(pg_catalog.convert_to(
                 sealed_target_snapshot::text, 'UTF8'
               )), 0)
               + coalesce(pg_catalog.octet_length(
                 sealed_target_body_canonical
               ), 0)
             )::integer
           where workspace_id = $1::uuid and job_id = $2::uuid
        `, [actorFixture.workspaceId, importId]);
        await adminClient.query(`
          update public.catalog_import_job as job
             set sensitive_payload_bytes = (
               coalesce(pg_catalog.octet_length(pg_catalog.convert_to(
                 job.file_name, 'UTF8'
               )), 0)
               + coalesce(pg_catalog.octet_length(pg_catalog.convert_to(
                 job.mapping_snapshot::text, 'UTF8'
               )), 0)
               + coalesce(pg_catalog.octet_length(job.mapping_body_canonical), 0)
               + coalesce((
                   select pg_catalog.sum(import_row.sensitive_payload_bytes)
                     from public.catalog_import_row as import_row
                    where import_row.workspace_id = job.workspace_id
                      and import_row.job_id = job.id
                 ), 0)
             )::integer
           where job.workspace_id = $1::uuid and job.id = $2::uuid
        `, [actorFixture.workspaceId, importId]);
        await adminClient.query("commit");
      } catch (error) {
        await adminClient.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        adminClient.release();
      }

      const started = await startJobViaGateway(preparedFixture);
      expect(started).toEqual({
        status: "conflict",
        code: "invalid_persisted_input",
      });
    }
  });

  it("belegt Preclaim-Backoff, Replay und Dispatch-Missbrauch", async () => {
    const fixture = await createFixture({ valid: true });
    const dispatchId = randomUUID();
    expect(await startJobViaGateway(fixture)).toMatchObject({ status: "queued" });

    const invokeFailure = (fixedCode: string) => tenantTransaction(
      fixture.workspaceId,
      (client) => client.query<{ result: Record<string, unknown> }>(`
        select public.record_catalog_import_preclaim_failure_v1(
          $1::uuid, $2::uuid, $3::uuid, $4::text
        ) as result
      `, [fixture.workspaceId, fixture.jobId, dispatchId, fixedCode]),
    );
    const failed = await invokeFailure("enqueue_failed");
    expect(failed.rows[0]?.result).toMatchObject({
      status: "retry_wait",
      importId: fixture.jobId,
      failureCount: 1,
      errorCode: "enqueue_failed",
      replayed: false,
    });

    const replay = await invokeFailure("enqueue_failed");
    expect(replay.rows[0]?.result).toMatchObject({
      status: "retry_wait",
      importId: fixture.jobId,
      leaseGeneration: "0",
      failureCount: 1,
      errorCode: "enqueue_failed",
      replayed: true,
    });
    const dispatchReuse = await invokeFailure("queue_locator_invalid");
    expect(dispatchReuse.rows[0]?.result).toEqual({
      status: "conflict",
      code: "dispatch_reused",
      replayed: true,
    });

    const timing = await tenantTransaction(
      fixture.workspaceId,
      (client) => client.query<{ delaySeconds: string }>(`
        select extract(
                 epoch from (next_attempt_at - updated_at)
               )::text as "delaySeconds"
          from public.catalog_import_job
         where workspace_id = $1::uuid and id = $2::uuid
      `, [fixture.workspaceId, fixture.jobId]),
    );
    expect(timing.rows[0]?.delaySeconds).toBe("30.000000");
  });

  it("faengt einen fehlgeschlagenen Folge-Dispatch nach dem Claim zustandsbewusst ab", async () => {
    const fixture = await createFixture({ valid: true });
    const leaseToken = randomUUID();
    expect(await startJobViaGateway(fixture)).toMatchObject({ status: "queued" });
    expect(await claimJobViaGateway(fixture, leaseToken)).toMatchObject({
      status: "claimed",
      leaseGeneration: "1",
    });

    const invokeDispatchFailure = () => tenantTransaction(
      fixture.workspaceId,
      (client) => client.query<{ result: Record<string, unknown> }>(`
        select public.record_catalog_import_dispatch_failure_v1(
          $1::uuid, $2::uuid, $3::uuid, 'enqueue_failed'
        ) as result
      `, [fixture.workspaceId, fixture.jobId, leaseToken]),
    );

    const failed = await invokeDispatchFailure();
    expect(failed.rows[0]?.result).toMatchObject({
      status: "retry_wait",
      importId: fixture.jobId,
      leaseGeneration: "1",
      failureCount: 1,
      errorCode: "enqueue_failed",
      dispatchRequired: true,
      replayed: false,
    });

    const replay = await invokeDispatchFailure();
    expect(replay.rows[0]?.result).toMatchObject({
      status: "retry_wait",
      importId: fixture.jobId,
      leaseGeneration: "1",
      failureCount: 1,
      errorCode: "enqueue_failed",
      dispatchRequired: true,
      replayed: true,
    });

    const reused = await tenantTransaction(
      fixture.workspaceId,
      (client) => client.query<{ result: Record<string, unknown> }>(`
        select public.record_catalog_import_dispatch_failure_v1(
          $1::uuid, $2::uuid, $3::uuid, 'queue_locator_invalid'
        ) as result
      `, [fixture.workspaceId, fixture.jobId, leaseToken]),
    );
    expect(reused.rows[0]?.result).toEqual({
      status: "conflict",
      code: "dispatch_reused",
      replayed: true,
    });

    const persisted = await tenantTransaction(
      fixture.workspaceId,
      (client) => client.query<{
        state: string;
        leaseToken: string | null;
        leaseRowNumbers: number[] | null;
        leaseExpiresAt: Date | null;
        failureCount: number;
        errorCode: string | null;
        nextAttemptAt: Date | null;
      }>(`
        select state,
               lease_token::text as "leaseToken",
               lease_row_numbers as "leaseRowNumbers",
               lease_expires_at as "leaseExpiresAt",
               consecutive_failure_count as "failureCount",
               error_code as "errorCode",
               next_attempt_at as "nextAttemptAt"
          from public.catalog_import_job
         where workspace_id = $1::uuid and id = $2::uuid
      `, [fixture.workspaceId, fixture.jobId]),
    );
    expect(persisted.rows[0]).toEqual({
      state: "retry_wait",
      leaseToken: null,
      leaseRowNumbers: null,
      leaseExpiresAt: null,
      failureCount: 1,
      errorCode: "enqueue_failed",
      nextAttemptAt: expect.any(Date),
    });
    expect(persisted.rows[0]?.nextAttemptAt?.toISOString()).toBe(
      new Date(String(failed.rows[0]?.result.nextAttemptAt)).toISOString(),
    );

    const receipts = await tenantTransaction(
      fixture.workspaceId,
      (client) => client.query<{
        dispatchId: string;
        receiptKind: string;
        leaseGeneration: string;
        causeCode: string;
      }>(`
        select dispatch_id::text as "dispatchId",
               receipt_kind as "receiptKind",
               lease_generation::text as "leaseGeneration",
               cause_code as "causeCode"
          from public.catalog_import_dispatch_receipt
         where workspace_id = $1::uuid
           and job_id = $2::uuid
           and dispatch_id = $3::uuid
      `, [fixture.workspaceId, fixture.jobId, leaseToken]),
    );
    expect(receipts.rows).toEqual([{
      dispatchId: leaseToken,
      receiptKind: "lease_failure",
      leaseGeneration: "1",
      causeCode: "enqueue_failed",
    }]);
  });

  it("bindet einen abgelaufenen Fremd-Locator an denselben Lease-Failure-Entscheid", async () => {
    const fixture = await createFixture({ valid: true });
    const leaseToken = randomUUID();
    const locatorJobId = randomUUID();
    expect(await startJobViaGateway(fixture)).toMatchObject({ status: "queued" });
    expect(await claimJobViaGateway(fixture, leaseToken)).toMatchObject({
      status: "claimed",
      leaseGeneration: "1",
    });

    const adminClient = await superuserPool().connect();
    try {
      await adminClient.query("begin");
      await adminClient.query("set local session_replication_role = replica");
      await adminClient.query(`
        update public.catalog_import_job
           set lease_expires_at = pg_catalog.clock_timestamp() - interval '1 second'
         where workspace_id = $1::uuid and id = $2::uuid
      `, [fixture.workspaceId, fixture.jobId]);
      await adminClient.query("commit");
    } catch (error) {
      await adminClient.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      adminClient.release();
    }

    const invokeLocatorFailure = (fixedCode: string) => tenantTransaction(
      fixture.workspaceId,
      (client) => client.query<{ result: Record<string, unknown> }>(`
        select public.record_catalog_import_dispatch_failure_v1(
          $1::uuid, $2::uuid, $3::uuid, $4::text
        ) as result
      `, [fixture.workspaceId, fixture.jobId, locatorJobId, fixedCode]),
    );

    const failed = await invokeLocatorFailure("queue_locator_invalid");
    expect(failed.rows[0]?.result).toMatchObject({
      status: "retry_wait",
      importId: fixture.jobId,
      leaseGeneration: "1",
      failureCount: 1,
      errorCode: "queue_locator_invalid",
      dispatchRequired: true,
      replayed: false,
    });

    // Simuliert einen Prozessabbruch nach Domain-Commit, aber vor Quarantaene.
    const replay = await invokeLocatorFailure("queue_locator_invalid");
    expect(replay.rows[0]?.result).toMatchObject({
      status: "retry_wait",
      importId: fixture.jobId,
      leaseGeneration: "1",
      failureCount: 1,
      errorCode: "queue_locator_invalid",
      dispatchRequired: true,
      replayed: true,
    });
    expect(replay.rows[0]?.result.nextAttemptAt).toBe(
      failed.rows[0]?.result.nextAttemptAt,
    );
    const locatorAsLease = await tenantTransaction(
      fixture.workspaceId,
      (client) => client.query<{ result: Record<string, unknown> }>(`
        select public.finalize_catalog_import_failure_v1(
          $1::uuid, $2::uuid, $3::uuid, 1::bigint, 'queue_locator_invalid'
        ) as result
      `, [fixture.workspaceId, fixture.jobId, locatorJobId]),
    );
    expect(locatorAsLease.rows[0]?.result).toEqual({
      status: "conflict",
      code: "dispatch_reused",
      replayed: true,
    });
    const reused = await invokeLocatorFailure("enqueue_failed");
    expect(reused.rows[0]?.result).toEqual({
      status: "conflict",
      code: "dispatch_reused",
      replayed: true,
    });

    const receipts = await tenantTransaction(
      fixture.workspaceId,
      (client) => client.query<{
        dispatchId: string;
        receiptKind: string;
        leaseGeneration: string;
        causeCode: string;
        failureCount: number;
      }>(`
        select dispatch_id::text as "dispatchId",
               receipt_kind as "receiptKind",
               lease_generation::text as "leaseGeneration",
               cause_code as "causeCode",
               outcome_failure_count as "failureCount"
          from public.catalog_import_dispatch_receipt
         where workspace_id = $1::uuid
           and job_id = $2::uuid
         order by dispatch_id
      `, [fixture.workspaceId, fixture.jobId]),
    );
    expect(receipts.rows).toHaveLength(2);
    expect(receipts.rows.map((row) => row.dispatchId).sort()).toEqual(
      [leaseToken, locatorJobId].sort(),
    );
    expect(receipts.rows).toEqual(expect.arrayContaining([
      {
        dispatchId: leaseToken,
        receiptKind: "lease_failure",
        leaseGeneration: "1",
        causeCode: "queue_locator_invalid",
        failureCount: 1,
      },
      {
        dispatchId: locatorJobId,
        receiptKind: "preclaim_failure",
        leaseGeneration: "1",
        causeCode: "queue_locator_invalid",
        failureCount: 1,
      },
    ]));
  });

  it("entscheidet Lease-Failure und Completion-Race genau einmal", async () => {
    const fixture = await createFixture({ valid: true });
    const leaseToken = randomUUID();
    expect(await startJobViaGateway(fixture)).toMatchObject({ status: "queued" });
    expect(await claimJobViaGateway(fixture, leaseToken)).toMatchObject({
      status: "claimed",
      leaseGeneration: "1",
    });

    const invokeFailure = () => tenantTransaction(
      fixture.workspaceId,
      (client) => client.query<{ result: Record<string, unknown> }>(`
        select public.finalize_catalog_import_failure_v1(
          $1::uuid, $2::uuid, $3::uuid, 1::bigint, 'lease_lost'
        ) as result
      `, [fixture.workspaceId, fixture.jobId, leaseToken]),
    );
    const failed = await invokeFailure();
    expect(failed.rows[0]?.result).toMatchObject({
      status: "retry_wait",
      importId: fixture.jobId,
      leaseGeneration: "1",
      failureCount: 1,
      errorCode: "lease_lost",
      replayed: false,
    });
    const replay = await invokeFailure();
    expect(replay.rows[0]?.result).toMatchObject({
      status: "retry_wait",
      leaseGeneration: "1",
      failureCount: 1,
      errorCode: "lease_lost",
      replayed: true,
    });

    const losingCompletion = await tenantTransaction(
      fixture.workspaceId,
      (client) => client.query<{ result: Record<string, unknown> }>(`
        select public.complete_catalog_import_batch_v1(
          $1::uuid, $2::uuid, $3::uuid, 1::bigint
        ) as result
      `, [fixture.workspaceId, fixture.jobId, leaseToken]),
    );
    expect(losingCompletion.rows[0]?.result).toEqual({
      status: "conflict",
      code: "dispatch_reused",
      replayed: true,
    });
  });

  it("weist einen waehrend der Transaktion abgelaufenen Lease ohne Schreibeffekt ab", async () => {
    const fixture = await createFixture({ valid: true });
    const leaseToken = randomUUID();
    expect(await startJobViaGateway(fixture)).toMatchObject({ status: "queued" });
    expect(await claimJobViaGateway(fixture, leaseToken)).toMatchObject({
      status: "claimed",
      leaseGeneration: "1",
    });

    const adminClient = await superuserPool().connect();
    try {
      await adminClient.query("begin");
      await adminClient.query("set local session_replication_role = replica");
      await adminClient.query(`
        update public.catalog_import_job
           set lease_expires_at = pg_catalog.clock_timestamp() + interval '2 seconds'
         where workspace_id = $1::uuid and id = $2::uuid
      `, [fixture.workspaceId, fixture.jobId]);
      await adminClient.query("commit");
    } catch (error) {
      await adminClient.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      adminClient.release();
    }

    const applied = await tenantTransaction(
      fixture.workspaceId,
      async (client) => {
        const timing = await client.query<{ startedBeforeExpiry: boolean }>(`
          select pg_catalog.transaction_timestamp() < lease_expires_at
                   as "startedBeforeExpiry"
            from public.catalog_import_job
           where workspace_id = $1::uuid and id = $2::uuid
        `, [fixture.workspaceId, fixture.jobId]);
        expect(timing.rows[0]?.startedBeforeExpiry).toBe(true);
        await client.query(`
          select pg_catalog.pg_sleep(
                   greatest(
                     pg_catalog.date_part(
                       'epoch', lease_expires_at - pg_catalog.clock_timestamp()
                     ),
                     0::double precision
                   ) + 0.15::double precision
                 )
            from public.catalog_import_job
           where workspace_id = $1::uuid and id = $2::uuid
        `, [fixture.workspaceId, fixture.jobId]);
        return client.query<{ result: Record<string, unknown> }>(`
          select public.apply_catalog_import_row_v1(
            $1::uuid, $2::uuid, 2, $3::uuid, 1::bigint
          ) as result
        `, [fixture.workspaceId, fixture.jobId, leaseToken]);
      },
    );
    expect(applied.rows[0]?.result).toEqual({
      status: "conflict",
      code: "stale_lease",
    });

    const persisted = await tenantTransaction(
      fixture.workspaceId,
      (client) => client.query<{
        jobState: string;
        resultExists: boolean;
        componentExists: boolean;
      }>(`
        select job.state as "jobState",
               exists(
                 select 1
                   from public.catalog_import_row_result as result
                  where result.workspace_id = job.workspace_id
                    and result.job_id = job.id
               ) as "resultExists",
               exists(
                 select 1
                   from public.catalog_component as component
                   join public.catalog_import_row as import_row
                     on import_row.workspace_id = component.workspace_id
                    and import_row.target_component_id = component.id
                  where import_row.workspace_id = job.workspace_id
                    and import_row.job_id = job.id
               ) as "componentExists"
          from public.catalog_import_job as job
         where job.workspace_id = $1::uuid and job.id = $2::uuid
      `, [fixture.workspaceId, fixture.jobId]),
    );
    expect(persisted.rows[0]).toEqual({
      jobState: "running",
      resultExists: false,
      componentExists: false,
    });
  });

  it("vermeidet die inverse Workspace-Component-Sperrreihenfolge", async () => {
    const fixture = await createFixture({ valid: true });
    const leaseToken = randomUUID();
    expect(await startJobViaGateway(fixture)).toMatchObject({ status: "queued" });
    expect(await claimJobViaGateway(fixture, leaseToken)).toMatchObject({
      status: "claimed",
      leaseGeneration: "1",
    });
    const applied = await tenantTransaction(
      fixture.workspaceId,
      (client) => client.query<{ result: Record<string, unknown> }>(`
        select public.apply_catalog_import_row_v1(
          $1::uuid, $2::uuid, 2, $3::uuid, 1::bigint
        ) as result
      `, [fixture.workspaceId, fixture.jobId, leaseToken]),
    );
    const componentId = applied.rows[0]?.result.componentId;
    expect(componentId).toEqual(expect.any(String));

    const importClient = await superuserPool().connect();
    const manualClient = await superuserPool().connect();
    let waitingForComponent: Promise<unknown> | undefined;
    try {
      await importClient.query("begin");
      await importClient.query(
        "select set_config('app.workspace_id', $1, true)",
        [fixture.workspaceId],
      );
      await importClient.query(
        "select public._m108b_lock_catalog_import_workspace($1::uuid)",
        [fixture.workspaceId],
      );

      await manualClient.query("begin");
      await manualClient.query(
        "select set_config('app.workspace_id', $1, true)",
        [fixture.workspaceId],
      );
      await manualClient.query(`
        select id
          from public.catalog_component
         where workspace_id = $1::uuid and id = $2::uuid
         for update
      `, [fixture.workspaceId, componentId]);

      const importPid = await importClient.query<{ pid: number }>(
        "select pg_catalog.pg_backend_pid() as pid",
      );
      const manualPid = await manualClient.query<{ pid: number }>(
        "select pg_catalog.pg_backend_pid() as pid",
      );
      waitingForComponent = importClient.query(`
        select id
          from public.catalog_component
         where workspace_id = $1::uuid and id = $2::uuid
         for update
      `, [fixture.workspaceId, componentId]);
      await waitForBlocking(
        manualClient,
        importPid.rows[0]!.pid,
        manualPid.rows[0]!.pid,
      );

      await manualClient.query("set local lock_timeout = '2s'");
      await manualClient.query(`
        select id
          from public.workspace
         where id = $1::uuid
         for key share
      `, [fixture.workspaceId]);
      await manualClient.query("commit");
      await waitingForComponent;
      waitingForComponent = undefined;
      await importClient.query("rollback");
    } finally {
      await manualClient.query("rollback").catch(() => undefined);
      if (waitingForComponent) {
        await waitingForComponent.catch(() => undefined);
      }
      await importClient.query("rollback").catch(() => undefined);
      manualClient.release();
      importClient.release();
    }
  });

  it("serialisiert parallele Import-Gateways weiterhin pro Workspace", async () => {
    const fixture = await createFixture({ valid: false });
    const firstClient = await superuserPool().connect();
    const secondClient = await superuserPool().connect();
    let secondLock: Promise<unknown> | undefined;
    try {
      await firstClient.query("begin");
      await secondClient.query("begin");
      await firstClient.query(
        "select set_config('app.workspace_id', $1, true)",
        [fixture.workspaceId],
      );
      await secondClient.query(
        "select set_config('app.workspace_id', $1, true)",
        [fixture.workspaceId],
      );
      await firstClient.query(
        "select public._m108b_lock_catalog_import_workspace($1::uuid)",
        [fixture.workspaceId],
      );
      const firstPid = await firstClient.query<{ pid: number }>(
        "select pg_catalog.pg_backend_pid() as pid",
      );
      const secondPid = await secondClient.query<{ pid: number }>(
        "select pg_catalog.pg_backend_pid() as pid",
      );
      secondLock = secondClient.query(
        "select public._m108b_lock_catalog_import_workspace($1::uuid)",
        [fixture.workspaceId],
      );
      await waitForBlocking(
        firstClient,
        secondPid.rows[0]!.pid,
        firstPid.rows[0]!.pid,
        "advisory",
      );

      await firstClient.query("commit");
      await secondLock;
      secondLock = undefined;
      await secondClient.query("rollback");
    } finally {
      await firstClient.query("rollback").catch(() => undefined);
      if (secondLock) await secondLock.catch(() => undefined);
      await secondClient.query("rollback").catch(() => undefined);
      secondClient.release();
      firstClient.release();
    }
  });

  it("redigiert fällige Snapshots ausschließlich über das Cleanup-Gateway", async () => {
    const fixture = await createFixture({ valid: false, oldEnough: true });
    await cancelJob(fixture);
    const cleanup = await tenantTransaction(
      fixture.workspaceId,
      (client) => client.query<{ importId: string; redactedAt: Date }>(`
        select import_id as "importId", redacted_at as "redactedAt"
          from public.cleanup_catalog_import_snapshots_v1($1::uuid, 100)
      `, [fixture.workspaceId]),
    );
    expect(cleanup.rows).toHaveLength(1);
    expect(cleanup.rows[0]).toMatchObject({ importId: fixture.jobId });

    const redacted = await tenantTransaction(
      fixture.workspaceId,
      (client) => client.query<{
        jobRedactedAt: Date;
        rowRedactedAt: Date;
        fileName: string | null;
        mappingSnapshot: unknown | null;
        normalizedSku: string | null;
        sourceHeader: string | null;
        jobBytes: number;
        rowBytes: number;
      }>(`
        select job.snapshot_redacted_at as "jobRedactedAt",
               import_row.snapshot_redacted_at as "rowRedactedAt",
               job.file_name as "fileName",
               job.mapping_snapshot as "mappingSnapshot",
               import_row.normalized_sku as "normalizedSku",
               import_row.error_snapshot#>>'{0,sourceHeader}' as "sourceHeader",
               job.sensitive_payload_bytes as "jobBytes",
               import_row.sensitive_payload_bytes as "rowBytes"
          from public.catalog_import_job as job
          join public.catalog_import_row as import_row
            on import_row.workspace_id = job.workspace_id
           and import_row.job_id = job.id
         where job.workspace_id = $1::uuid and job.id = $2::uuid
      `, [fixture.workspaceId, fixture.jobId]),
    );
    expect(redacted.rows[0]).toMatchObject({
      fileName: null,
      mappingSnapshot: null,
      normalizedSku: null,
      sourceHeader: null,
      jobBytes: 0,
      rowBytes: 0,
    });
    expect(redacted.rows[0]?.jobRedactedAt.getTime())
      .toBe(redacted.rows[0]?.rowRedactedAt.getTime());
    expect(redacted.rows[0]?.jobRedactedAt.getTime())
      .toBe(cleanup.rows[0]?.redactedAt.getTime());
  });
});
